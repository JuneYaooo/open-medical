import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { configureLocalOcrService, imageTextWithFallback, localOcrLines } from '../server/core/image-text.mjs';
import { extractDocument } from '../server/medical/knowledge-media.mjs';
import { recognizeViaService } from '../server/core/paddle-ocr.mjs';

// 1x1 纯色 PNG：本机 OCR 读不出文字，链路必然落到识别模型，转录内容由
// 假上游脚本化，保证断言确定性。
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TRANSCRIPT = '检验报告单：空腹血糖 6.1 mmol/L，工作台文字识别基准 2026。';

// OpenAI 兼容 SSE 上游：记录请求头与请求体，固定返回一份转录文本。
async function upstream(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 12_000_000) req.destroy(); });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(raw || '{}') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: TRANSCRIPT }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, seen, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

const ocrModel = (up) => ({
  provider: 'openai-compatible',
  baseUrl: up.baseUrl,
  model: 'ocr-fixture',
  apiKey: 'secret-ocr-key',
});

// 仿 medagent-gpu-worker 的 PaddleOCR 服务：/v1/ocr/records 带置信度行，
// /v1/ocr 纯文本兜底，/health 探活；records 端点可关（模拟旧版 worker）。
async function paddleWorker(t, { records = true, status = 200 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({
        auth: req.headers.authorization || '',
        url: req.url,
        bytes: body.length,
        hasPng: body.includes(0x89) && body.includes(Buffer.from('PNG')),
      });
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ paddle_version: '3.0-fixture' }));
        return;
      }
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'fixture rejection' }));
        return;
      }
      if (req.url === '/v1/ocr/records') {
        if (!records) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: 'Not Found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ records: [
          { text: '检验报告单（测试样张）', box: [[0, 0]], score: 0.97 },
          { text: '空腹血糖 6.1 mmol/L', box: [[0, 9]], score: 0.93 },
        ] }));
        return;
      }
      if (req.url === '/v1/ocr') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: '检验报告单\n空腹血糖 6.1 mmol/L' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, seen, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

const putService = (f, baseUrl, apiKey) =>
  f.json('/api/ocr-settings', 'PUT', { service: { baseUrl, ...(apiKey ? { apiKey } : {}) } });

async function sessionWithImage(f, name = 'scan.png') {
  const session = await f.session('OCR 设置测试');
  const r = await f.json(`/api/sessions/${session.id}/files`, 'POST', { name, image: PNG_1PX });
  assert.equal(r.status, 201);
  return { session, file: r.data };
}

test('OCR 设置：默认智能策略，保存专用识别模型与策略并可回读、可清除', async (t) => {
  const f = await fixture(t);
  const initial = (await f.json('/api/ocr-settings')).data;
  assert.equal(initial.strategy, 'auto');
  assert.equal(initial.model, null);
  assert.equal(typeof initial.localAvailable, 'boolean');
  assert.equal(initial.imageCapable, false);
  assert.ok(initial.strategies.auto && initial.strategies.model && initial.strategies.local);

  assert.equal((await f.json('/api/ocr-settings', 'PUT', { strategy: 'bogus' })).status, 400);
  assert.equal((await f.json('/api/ocr-settings', 'PUT', { strategy: 'auto' })).status, 200);

  const up = await upstream(t);
  const saved = await f.json('/api/ocr-settings', 'PUT', {
    strategy: 'model',
    model: ocrModel(up),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.strategy, 'model');
  assert.equal(saved.data.model.model, 'ocr-fixture');
  assert.equal(saved.data.model.hasKey, true);
  assert.equal(saved.data.imageCapable, true, '配置专用模型后即具备图片识别能力');
  assert.equal(JSON.stringify(saved).includes('secret-ocr-key'), false, '密钥绝不回显');

  // 之后只切策略不动模型；清除专用模型后 imageCapable 回落。
  assert.equal((await f.json('/api/ocr-settings', 'PUT', { strategy: 'auto' })).data.model.model, 'ocr-fixture');
  const cleared = await f.json('/api/ocr-settings', 'PUT', { clearModel: true });
  assert.equal(cleared.data.model, null);
  assert.equal(cleared.data.imageCapable, false);
});

test('专用识别模型接管图片材料转录，主模型无需支持图片', async (t) => {
  const up = await upstream(t);
  const f = await fixture(t);
  const put = await f.json('/api/ocr-settings', 'PUT', { model: ocrModel(up) });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const { session, file } = await sessionWithImage(f);
  const prepared = await f.json(`/api/sessions/${session.id}/files/${file.id}/prepare`, 'POST', {});
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  assert.equal(prepared.data.file.extraction.ocr.method, 'vision');
  assert.ok(prepared.data.file.text.includes('空腹血糖 6.1'));
  assert.equal(up.seen.length, 1, '只有专用识别模型被调用');
  assert.equal(up.seen[0].auth, 'Bearer secret-ocr-key');
  assert.equal(up.seen[0].body.model, 'ocr-fixture');
  assert.ok(JSON.stringify(up.seen[0].body).includes('image_url'), '图片发给了专用识别模型');
});

test('仅本机策略：图片字节不发给任何模型，重新识别按钮视为明确同意', async (t) => {
  const up = await upstream(t);
  const f = await fixture(t);
  const put = await f.json('/api/ocr-settings', 'PUT', { strategy: 'local', model: ocrModel(up) });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const { session, file } = await sessionWithImage(f);
  const prepared = await f.json(`/api/sessions/${session.id}/files/${file.id}/prepare`, 'POST', {});
  assert.equal(up.seen.length, 0, '「仅本机」下模型绝不被调用');
  assert.ok([422, 503].includes(prepared.status), JSON.stringify(prepared.data));
  assert.match(prepared.data.error, /本机/);
  const forced = await f.json(`/api/sessions/${session.id}/files/${file.id}/prepare`, 'POST', { force: true, preferVision: true });
  assert.equal(forced.status, 200, JSON.stringify(forced.data));
  assert.equal(up.seen.length, 1, 'preferVision 是医生的明确选择，可以越过「仅本机」');
  assert.equal(forced.data.file.extraction.ocr.method, 'vision');
});

test('模型优先策略由共享识别链实现：模型先行，失败才回本机', async () => {
  const png = Buffer.from(PNG_1PX, 'base64');
  const ok = await imageTextWithFallback(png, undefined, async () => TRANSCRIPT, { strategy: 'model' });
  assert.equal(ok.kind, 'vision');
  await assert.rejects(
    imageTextWithFallback(png, undefined, async () => { throw new Error('模型不可达'); }, { strategy: 'model' }),
    (e) => e.code === 'OCR_UNAVAILABLE' && /识别模型转录失败/.test(e.message),
  );
});

test('知识库图片导入遵循 OCR 策略', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-knowledge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const broken = join(dir, 'broken.jpg');
  await writeFile(broken, Buffer.from('not-an-image'));
  // 仅本机：即使给了识别模型也不外发；本机也读不出时直接报可行动错误。
  await assert.rejects(
    extractDocument(broken, 'broken.jpg', undefined, { analyzeImage: async () => '不该被用到', ocrStrategy: 'local' }),
    (e) => ['OCR_UNAVAILABLE', 'OCR_EMPTY'].includes(e.code),
  );
  // 默认智能策略保持既有行为：本机不可用 → 识别模型兜底。
  const parts = await extractDocument(broken, 'broken.jpg', undefined, { analyzeImage: async () => '视觉转录结果' });
  assert.equal(parts[0].kind, 'vision');
});

test('OCR 测试端点用内置基准样张实测识别模型', async (t) => {
  const up = await upstream(t);
  const f = await fixture(t);
  const result = await f.json('/api/ocr-settings/test', 'POST', { model: ocrModel(up) });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.ok, true);
  assert.ok(result.data.matched.includes('检验报告单'));
  assert.ok(result.data.message.includes('识别模型可用'));
  assert.equal(up.seen.length, 1, '测试恰好发出一次样张请求');
  // 没有任何配置时给出可行动的错误，而不是 500。
  const missing = await f.json('/api/ocr-settings/test', 'POST', {});
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /识别模型/);
});

test('inspect_image 在纯文本主模型下改由专用识别模型读图', async (t) => {
  const up = await upstream(t);
  const f = await fixture(t);
  const put = await f.json('/api/ocr-settings', 'PUT', { model: ocrModel(up) });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const session = await f.session('inspect 专用模型测试');
  const upload = await f.json(`/api/workspaces/${session.id}/images`, 'POST', { name: 'page.jpg', data: PNG_1PX });
  assert.equal(upload.status, 201);
  // 伪造一个已授权运行以满足 inspect_image 的同意门；结束前必须清掉，
  // 否则 shutdown 中断这个假记录会因缺 controller 崩溃。
  f.server.workspaces.active.set(session.id, { controller: new AbortController() });
  t.after(() => f.server.workspaces.active.delete(session.id));
  const { PermissionEngine } = await import('../server/core/permissions.mjs');
  const registry = f.server.workspaces.registry(session.id, 'test-run');
  const output = await registry.execute(
    'inspect_image',
    { artifactId: upload.data.id, question: '读取图片中的文字' },
    {},
    new PermissionEngine({ profile: 'standard', grants: {} }),
  );
  assert.equal(output.method, 'ocr-model');
  assert.ok(output.analysis.includes('空腹血糖 6.1'));
  assert.match(output.note, /核对/);
  assert.equal(up.seen.length, 1);
  assert.equal(up.seen[0].body.model, 'ocr-fixture');
});

test('PaddleOCR 服务配置：校验、策略合并保存、密钥不回显', async (t) => {
  const f = await fixture(t);
  await f.json('/api/ocr-settings', 'PUT', { strategy: 'local' });
  // 非 https 且非回环的 http 地址拒绝。
  assert.equal((await putService(f, 'http://192.168.1.10:18090')).status, 400);
  const worker = await paddleWorker(t);
  const saved = await putService(f, `${worker.baseUrl}/`, 'worker-key-1');
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.service.baseUrl, worker.baseUrl, '规范掉尾部斜杠');
  assert.equal(saved.data.service.hasKey, true);
  assert.equal(saved.data.strategy, 'local', '只保存服务不丢策略（同一 vault 键合并写入）');
  assert.equal(JSON.stringify(saved).includes('worker-key-1'), false, '密钥绝不回显');
  // 换策略不丢服务；清除服务后回归 null。
  assert.equal((await f.json('/api/ocr-settings', 'PUT', { strategy: 'auto' })).data.service.baseUrl, worker.baseUrl);
  const cleared = await f.json('/api/ocr-settings', 'PUT', { clearService: true });
  assert.equal(cleared.data.service, null);
  assert.equal(cleared.data.localAvailable, typeof cleared.data.localAvailable === 'boolean');
});

test('本机识别层优先走 PaddleOCR 服务，置信度直接可用', async (t) => {
  const worker = await paddleWorker(t);
  configureLocalOcrService(() => ({ baseUrl: worker.baseUrl, apiKey: 'worker-key-1', timeoutMs: 30000 }));
  t.after(() => configureLocalOcrService(null));
  const result = await localOcrLines(Buffer.from(PNG_1PX, 'base64'), undefined);
  assert.equal(result.engine, 'paddle-service');
  assert.equal(result.available, true);
  assert.equal(result.lines[0].text, '检验报告单（测试样张）');
  assert.equal(result.lines[0].confidence, 0.97, '真实置信度进入行结构');
  assert.equal(worker.seen[0].url, '/v1/ocr/records');
  assert.equal(worker.seen[0].auth, 'Bearer worker-key-1');
  assert.equal(worker.seen[0].hasPng, true, '图片字节以 multipart 发给服务');
});

test('旧版 worker 没有 records 端点时回退 /v1/ocr 纯文本', async (t) => {
  const worker = await paddleWorker(t, { records: false });
  const lines = await recognizeViaService(
    { baseUrl: worker.baseUrl, apiKey: 'worker-key-1', timeoutMs: 30000 },
    Buffer.from(PNG_1PX, 'base64'),
    undefined,
  );
  assert.deepEqual(lines.map((line) => line.text), ['检验报告单', '空腹血糖 6.1 mmol/L']);
  assert.equal(lines[0].confidence, 1, '纯文本回退没有真实置信度');
  assert.deepEqual(worker.seen.map((s) => s.url), ['/v1/ocr/records', '/v1/ocr']);
});

test('服务不可达时本机识别自动落回系统组件', async (t) => {
  // 先开再关一个端口，保证连接被立即拒绝而不是等超时。
  const probe = http.createServer(() => {});
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const dead = `http://127.0.0.1:${probe.address().port}`;
  await new Promise((resolve) => probe.close(resolve));
  configureLocalOcrService(() => ({ baseUrl: dead, apiKey: '', timeoutMs: 5000 }));
  t.after(() => configureLocalOcrService(null));
  const result = await localOcrLines(Buffer.from(PNG_1PX, 'base64'), undefined);
  assert.notEqual(result.engine, 'paddle-service', '服务失败必须落回系统组件');
  assert.equal(typeof result.available, 'boolean');
  assert.deepEqual(result.lines, [], '1px 纯色图系统组件也读不出文字');
});

test('材料建档优先用 PaddleOCR 服务，模型零调用；「仅本机」下服务是唯一外发地', async (t) => {
  const up = await upstream(t);
  const worker = await paddleWorker(t);
  const f = await fixture(t);
  const put = await f.json('/api/ocr-settings', 'PUT', {
    strategy: 'local',
    service: { baseUrl: worker.baseUrl, apiKey: 'worker-key-1' },
    model: ocrModel(up),
  });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.service.baseUrl, worker.baseUrl, '服务与模型、策略一次保存互不覆盖');
  const { session, file } = await sessionWithImage(f);
  const prepared = await f.json(`/api/sessions/${session.id}/files/${file.id}/prepare`, 'POST', {});
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  assert.equal(prepared.data.file.extraction.ocr.method, 'local-ocr', '服务转录仍记为本机识别');
  assert.ok(prepared.data.file.text.includes('空腹血糖 6.1'));
  assert.equal(up.seen.length, 0, '大模型绝不被调用');
  assert.equal(worker.seen.length, 1, '图片只发到医生自己的 OCR 服务');
  assert.equal(worker.seen[0].url, '/v1/ocr/records');
});

test('测试端点支持未保存的服务表单值并返回引擎标识', async (t) => {
  const worker = await paddleWorker(t);
  const f = await fixture(t);
  const result = await f.json('/api/ocr-settings/test', 'POST', {
    scope: 'local',
    service: { baseUrl: worker.baseUrl, apiKey: 'worker-key-1' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.engine, 'paddle-service');
  assert.equal(result.data.ok, true);
  assert.ok(result.data.matched.includes('检验报告单'));
  assert.equal(worker.seen[0].auth, 'Bearer worker-key-1');
  assert.equal(worker.seen.length, 1, '测试恰好发出一次样张请求');
});
