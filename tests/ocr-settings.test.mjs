import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { imageTextWithFallback } from '../server/core/image-text.mjs';
import { extractDocument } from '../server/medical/knowledge-media.mjs';

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

test('检测本机模型服务：Ollama /api/tags 转成可填入的 OpenAI 兼容配置', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'qwen2.5vl:7b' }, { name: 'llama3:8b' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const f = await fixture(t, { ocrLocalEndpoints: [base] });
  const detected = (await f.json('/api/ocr-settings/detect-local', 'POST', {})).data;
  assert.equal(detected.ok, true);
  assert.equal(detected.sources[0].source, 'ollama');
  assert.equal(detected.sources[0].baseUrl, `${base}/v1`);
  assert.ok(detected.sources[0].models.includes('qwen2.5vl:7b'));
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
