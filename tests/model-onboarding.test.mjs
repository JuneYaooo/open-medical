import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fixture } from './helpers.mjs';
import { MODEL_PRESETS, presetFor } from '../shared/model-presets.mjs';

const KINDS = ['deepseek', 'openai', 'openai-compatible', 'openai-responses', 'anthropic', 'local'];

async function upstream(t, { tools = true, json = '{"ok": true}' } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); seen.push(body);
    const prompt = body.messages.at(-1).content;
    const chunk = (delta, finish = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (body.tools?.length && tools) res.end(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'report_ready', arguments: '{"status":"ready"}' } }] }, 'tool_calls') + 'data: [DONE]\n\n');
    else res.end(chunk({ content: /JSON/.test(prompt) ? json : 'OK' }, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, config: { provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'probe', apiKey: 'synthetic-key', timeoutMs: 5000, maxTokens: 256 } };
}

test('connection test probes text, tool calling and JSON output', async (t) => {
  const f = await fixture(t);
  const { seen, config } = await upstream(t);
  const result = await f.json('/api/model-settings/test', 'POST', config);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.ok, true);
  assert.deepEqual(result.data.checks.map((c) => [c.id, c.ok]), [['text', true], ['tools', true], ['json', true]]);
  assert.equal(seen.length, 3);
  assert.equal(seen[1].tools[0].function.name, 'report_ready');
  assert.match(result.data.message, /均正常/);
  assert.equal(JSON.stringify(result.data).includes(config.apiKey), false);
});

test('missing tool calling and invalid JSON are reported without failing the connection', async (t) => {
  const f = await fixture(t);
  const { config } = await upstream(t, { tools: false, json: '好的，这是结果' });
  const result = await f.json('/api/model-settings/test', 'POST', config);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const byId = Object.fromEntries(result.data.checks.map((c) => [c.id, c]));
  assert.equal(byId.text.ok, true);
  assert.equal(byId.tools.ok, false);
  assert.match(byId.tools.message, /不支持工具调用/);
  assert.equal(byId.json.ok, false);
  assert.match(result.data.message, /Agent 能力将受限/);
});

test('fenced JSON output is accepted', async (t) => {
  const f = await fixture(t);
  const { config } = await upstream(t, { json: '```json\n{"ok": true}\n```' });
  const result = await f.json('/api/model-settings/test', 'POST', config);
  assert.equal(result.data.checks.find((c) => c.id === 'json').ok, true);
});

test('model presets map onto supported protocols and recover from saved settings', () => {
  const ids = new Set();
  for (const preset of MODEL_PRESETS) {
    assert.ok(KINDS.includes(preset.provider), preset.id);
    assert.ok(!ids.has(preset.id)); ids.add(preset.id);
    assert.ok(preset.baseUrl === '' || /^https:\/\/|^http:\/\/127\.0\.0\.1/.test(preset.baseUrl), preset.id);
    for (const model of preset.models) assert.match(model, /^[\x21-\x7e]+$/, `${preset.id} model id must be plain ASCII`);
  }
  assert.equal(presetFor('openai-compatible', 'https://api.moonshot.cn/v1/').id, 'kimi');
  assert.equal(presetFor('deepseek', 'https://api.deepseek.com/v1').id, 'deepseek');
  assert.equal(presetFor('local', 'http://127.0.0.1:1234/v1').id, 'ollama');
  assert.equal(presetFor('anthropic', 'https://proxy.example').id, 'anthropic');
  assert.equal(presetFor('openai-compatible', 'https://unknown.example/v1').id, 'custom');
});
