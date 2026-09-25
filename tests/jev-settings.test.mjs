import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JevSettings } from '../server/core/jev-settings.mjs';
import { createWorkspaceServer } from '../server/platform.mjs';

const valid = () => Response.json({ model: 'jev-1.13.0', answers: { task: { choice: 'document', confidence: 0.9 } } });
function setup(fetchImpl) {
  const values = new Map();
  const vault = { get: key => values.get(key) || {}, set: (key, value) => values.set(key, structuredClone(value)) };
  return new JevSettings(vault, fetchImpl);
}
const enabled = { enabled: true, consent: true, apiKey: 'test-only-secret' };

test('Jev defaults off, requires explicit consent, preserves and clears its independent key', async () => {
  let requests = 0;
  const j = setup(async () => { requests++; return valid(); });
  assert.equal(j.public().enabled, false);
  assert.equal(await j.observe('task'), null);
  assert.throws(() => j.save({ enabled: true, apiKey: 'test' }), /同意/);
  j.save(enabled);
  assert.equal(JSON.stringify(j.public()).includes(enabled.apiKey), false);
  j.save({ apiKey: '', enabled: false });
  assert.equal(j.public().hasKey, true);
  assert.equal(await j.observe('task'), null);
  assert.equal(requests, 0);
  j.save({ clearKey: true });
  assert.equal(j.public().hasKey, false);
  assert.throws(() => j.save({ enabled: 'false' }));
  assert.throws(() => j.save({ timeoutMs: 0 }));
});

test('connection test uses fixed text without saving or enabling, observations minimize retained data', async () => {
  const sent = [];
  const j = setup(async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.redirect, 'error');
    sent.push(JSON.parse(options.body));
    return valid();
  });
  await j.test({ apiKey: 'test' });
  assert.equal(j.public().enabled, false);
  assert.equal(j.public().hasKey, false);
  assert.match(sent[0].state, /gardening/);
  j.save(enabled);
  const observation = await j.observe('private task text');
  assert.equal(observation.mode, 'shadow');
  assert.equal(observation.usage.input_tokens, null);
  assert.equal(JSON.stringify(j.public()).includes('private task text'), false);
  assert.equal((await j.observe('a'.repeat(4001))).reason, 'input_limit');
  assert.equal(sent.length, 2);
});

test('Jev rejects malformed decisions and does not expose upstream errors or retry', async () => {
  for (const body of [null, {}, { model: 'jev-1.13.0', answers: { task: { choice: 'constructor', confidence: 0.9 } } },
    { model: 'jev-1.13.0', answers: { task: { choice: 'document', confidence: 2 } } }]) {
    const j = setup(async () => Response.json(body)); j.save(enabled);
    assert.equal((await j.observe('task')).reason, 'invalid_response');
  }
  let calls = 0;
  const j = setup(async () => { calls++; return new Response(enabled.apiKey, { status: 429 }); }); j.save(enabled);
  assert.equal((await j.observe('task')).reason, 'http');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(j.public()).includes(enabled.apiKey), false);
});

test('timeout falls back and user cancellation propagates', async () => {
  const j = setup((_url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(valid()), 1000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }));
  j.save({ ...enabled, timeoutMs: 100 });
  assert.equal((await j.observe('task')).reason, 'timeout');
  const controller = new AbortController();
  const pending = j.observe('task', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('authenticated settings persist encrypted; live workspace uses shadow without changing prompt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jev-settings-'));
  const database = join(root, 'state.sqlite');
  const prompts = [];
  let server;
  const start = async () => {
    server = createWorkspaceServer({ database, provider: {
      apiKey: 'synthetic', provider: 'synthetic', model: 'test',
      complete: async messages => { prompts.push(messages); return { message: { role: 'assistant', content: 'done' } }; },
    } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  };
  t.after(async () => { await server.shutdown(); rmSync(root, { recursive: true, force: true }); });
  await start();
  const call = (method, body, token = server.token) => fetch(`http://127.0.0.1:${server.address().port}/api/jev-settings`, {
    method, headers: { 'content-type': 'application/json', 'x-agent-token': token },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await call('GET', null, 'bad')).status, 401);
  assert.equal((await (await call('GET')).json()).enabled, false);
  assert.equal((await call('PUT', enabled)).status, 200);
  const encrypted = server.database.db.prepare("SELECT data FROM agent_credentials WHERE id='platform:jev-settings:v1'").get().data;
  assert.equal(encrypted.includes(enabled.apiKey), false);
  await server.shutdown(); await start();
  assert.equal((await (await call('GET')).json()).enabled, true);
  let requests = 0;
  server.service.jev.fetch = async () => { requests++; return valid(); };
  const w = server.service.create({ root, directoryConsent: true });
  const run = () => server.service.execute(server.service.prepare(w.id, {
    revision: server.service.get(w.id).revision, message: 'hello', externalConsent: true,
  }));
  assert.equal((await run()).status, 'completed');
  assert.equal(requests, 1);
  assert.equal(JSON.stringify(prompts).includes('input.preflight'), false);
  assert.equal(JSON.stringify(prompts).includes('jev-1.13.0'), false);
  await call('PUT', { enabled: false });
  assert.equal((await run()).status, 'completed');
  assert.equal(requests, 1);
});

test('medical server exposes the same optional settings behind existing auth', async t => {
  const { fixture } = await import('./helpers.mjs');
  const f = await fixture(t);
  assert.equal((await f.json('/api/jev-settings')).data.enabled, false);
  assert.equal((await f.json('/api/jev-settings', 'PUT', enabled)).status, 200);
  const saved = (await f.json('/api/jev-settings')).data;
  assert.equal(saved.hasKey, true);
  assert.equal(JSON.stringify(saved).includes(enabled.apiKey), false);
  await f.json('/api/jev-settings', 'PUT', { enabled: false, clearKey: true });
});
