import test from 'node:test';
import assert from 'node:assert/strict';
import { contextBudget, assertContextBudget, calibrateInput, estimateTokens } from '../server/core/context-budget.mjs';
import { compactContext } from '../server/core/context-manager.mjs';
import { AgentRuntime } from '../server/core/agent-runtime.mjs';
import { OpenAIProvider, AnthropicProvider } from '../server/core/providers.mjs';
import { TASK_INPUT_MESSAGE } from '../server/core/run-progress.mjs';

const permissions = { require() {}, can() { return true; } };
const registry = { definitions: () => [] };
test('budget includes model window, output and schemas; estimates Chinese/code conservatively', () => {
  const provider = { model: 'small', contextWindow: 4096, maxTokens: 512, contextWindows: { large: 32000 } };
  const messages = [{ role: 'user', content: '中文 const x = 3;'.repeat(70) }];
  const small = contextBudget({ provider, messages });
  const large = contextBudget({ provider, model: 'large', messages });
  assert.ok(estimateTokens('中文') > estimateTokens('ab'));
  assert.equal(small.estimation, 'conservative_estimate');
  assert.ok(large.inputLimit > small.inputLimit);
  assert.equal(contextBudget({ provider, messages, tools: [{ description: 'x'.repeat(4000) }] }).fits, false);
  assert.equal(contextBudget({ provider, messages, maxChars: 10 }).fits, false);
  assert.equal(small.outputReserve, 512);
});
test('calibration accepts response input only and never reduces conservative estimate', () => {
  const budget = contextBudget({ messages: [{ role: 'user', content: 'text' }] });
  assert.equal(calibrateInput({ total_tokens: 900000, output_tokens: 800000 }, budget), 1);
  assert.equal(calibrateInput({ input_tokens: 900000, cumulative: true }, budget), 1);
  assert.equal(calibrateInput({ prompt_tokens: 1 }, budget), 1);
  assert.ok(calibrateInput({ input_tokens: 1000, cache_read_input_tokens: 1000 }, budget) > 1);
});
test('media estimates inspect content parts, expose uncertainty and retain vision support', () => {
  assert.equal(contextBudget({ messages: [{ role: 'user', content: '"image_url": example' }] }).unknownMultimodal, false);
  const budget = contextBudget({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] }] });
  assert.equal(budget.unknownMultimodal, true);
  assert.equal(budget.mediaTokens, 16384);
  assertContextBudget(budget);
});
test('compaction preserves authoritative facts/latest user/whole tool batch and archives original', async () => {
  const messages = [{ role: 'system', content: 'permission: read only' },
    { role: 'user', content: 'old request' }, { role: 'assistant', content: '旧'.repeat(12000) },
    { role: 'user', content: 'current request' },
    { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{}' } }, { id: 'b', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'a' }, { role: 'tool', tool_call_id: 'b', content: 'b' }];
  let archived, requests = 0;
  const provider = { model: 'small', contextWindow: 16000, maxTokens: 512,
    async complete(input, tools, options) {
      requests++;
      assertContextBudget(contextBudget({ provider, messages: input, tools, outputReserve: options.maxTokens, maxChars: options.budget.maxChars }));
      return { message: { role: 'assistant', content: 'Historical notes.' } };
    } };
  const durableMessages = [{ role: 'system', content: 'Stored plan: remaining step. Authorization: read only. No write applied.' }];
  const result = await compactContext({ messages, provider, model: provider.model, durableMessages,
    maxChars: 30000, archive: async (value) => { archived = structuredClone(value); return { id: 'archive-1' }; } });
  assert.deepEqual(archived, messages);
  assert.ok(requests > 1 && requests <= 128);
  assert.ok(result.messages.some((m) => m.content === durableMessages[0].content));
  assert.ok(result.messages.some((m) => m.content === 'current request'));
  assert.deepEqual(result.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), ['a', 'b']);
  assert.ok(result.messages.some((m) => m.content?.includes('archive-1')));
});

test('oversized lossy summaries are bounded without losing original constraints across repeated compaction', async () => {
  const users = [
    { role: 'user', name: TASK_INPUT_MESSAGE, content: 'Original task: preserve EVERY_SOURCE and do not apply the draft without approval.' },
    { role: 'user', name: TASK_INPUT_MESSAGE, content: 'Additional constraint: EXACT_MARKER and the original task both remain required.' },
  ];
  const durable = [{ role: 'system', content: 'Approval draft-1 is pending. No write was applied.' }];
  let messages = [users[0], { role: 'assistant', content: 'history '.repeat(1500) }, users[1]];
  const archives = [], traces = [];
  const provider = { model: 'fixture', complete: async () => ({ message: { role: 'assistant', content: '🧪'.repeat(1500) } }) };
  for (let i = 0; i < 2; i++) {
    const original = structuredClone(messages);
    const result = await compactContext({ messages, provider, maxChars: 10000, durableMessages: durable,
      archive: async (value) => { archives.push(structuredClone(value)); return { id: `archive-${archives.length}` }; },
      onTrace: (value) => traces.push(value) });
    assert.deepEqual(archives.at(-1), original);
    assert.deepEqual(result.messages.filter((m) => m.role === 'user' && m.name !== 'runtime_control'), users);
    assert.ok(result.messages.some((m) => m.content === durable[0].content));
    const summary = result.messages.find((m) => m.name === 'context_summary').content;
    assert.ok(summary.includes('摘要不完整'));
    assert.ok(summary.includes(`archive-${archives.length}`));
    assert.equal(summary.isWellFormed(), true);
    assert.ok(result.truncatedSummaries >= 1);
    assert.equal(result.budget.fits, true);
    messages = [...result.messages, { role: 'assistant', content: 'more history '.repeat(1000) },
      { role: 'user', name: 'runtime_control', content: 'Runtime continuation, not a user instruction.' }];
  }
  assert.ok(traces.some((t) => t.type === 'model.response' && t.message.content.length === 3000));
});

test('long original constraints are archived and summarized while short latest steering remains exact', async () => {
  let archived; const parts = [];
  const messages = [{ role: 'user', name: TASK_INPUT_MESSAGE, content: 'original '.repeat(500) },
    { role: 'assistant', content: 'history '.repeat(1000) }, { role: 'user', content: 'short latest input' }];
  const provider = { complete: async (input) => {
    const payload = JSON.parse(input.at(-1).content);
    if (payload.part) parts.push(payload.part.text);
    return { message: { role: 'assistant', content: 'Original task constraints remain pending; do not act without approval.' } };
  } };
  const result = await compactContext({ provider, maxChars: 4000, messages,
    archive: async value => { archived = structuredClone(value); return { id: 'archive' }; } });
  assert.deepEqual(archived, messages);
  assert.equal(parts.join(''), messages[0].content);
  assert.ok(result.messages.some(m => m.content === 'short latest input'));
  assert.ok(result.messages.some(m => m.content.includes('有损摘要') && m.content.includes('archive')));
  assert.equal(result.budget.fits, true);
});

test('compaction without a retained tail ends on the genuine user, never synthetic assistant prefill', async () => {
  const user = { role: 'user', content: 'Read all sources and submit the approval draft.' };
  const result = await compactContext({ maxChars: 6000,
    messages: [user, { role: 'assistant', tool_calls: [{ id: 'r', function: { name: 'read_file', arguments: '{"path":"source.txt"}' } }] },
      { role: 'tool', tool_call_id: 'r', content: 'source text '.repeat(2000) }],
    provider: { complete: async () => ({ message: { role: 'assistant', content: 'Historical summary.' } }) },
    archive: async () => ({ id: 'archive-protocol' }) });
  assert.deepEqual(result.messages.at(-1), user);
  assert.equal(result.messages.filter((m) => m.role === 'user').length, 1);
  let payload;
  const provider = new AnthropicProvider({ apiKey: 'synthetic', fetchImpl: async (_url, init) => {
    payload = JSON.parse(init.body); throw new Error('captured');
  } });
  await assert.rejects(provider.complete(result.messages, []), /captured/);
  assert.equal(payload.messages.at(-1).role, 'user');
});
test('runtime without a configured compactor rejects oversize input; provider failure propagates', async () => {
  let requests = 0;
  const provider = { model: 'small', contextWindow: 4096, maxTokens: 512, complete: async () => { requests++; throw new Error('offline'); } };
  const runtime = new AgentRuntime({ provider });
  await assert.rejects(runtime.run({ messages: [{ role: 'user', content: 'x'.repeat(5000) }], permissions, registry }), { code: 'CONTEXT_LIMIT' });
  assert.equal(requests, 0);
  await assert.rejects(compactContext({ messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'x'.repeat(7000) }, { role: 'user', content: 'new' }], provider, maxChars: 10000, archive: async () => ({ id: 'archive-2' }) }), /offline/);
  assert.equal(requests, 1);
});
test('provider preflight rejects schemas before network and honors compact output override', async () => {
  let calls = 0;
  const provider = new OpenAIProvider({ apiKey: 'synthetic', contextWindow: 4096, maxTokens: 512, fetchImpl: async () => { calls++; throw new Error('network reached'); } });
  await assert.rejects(provider.complete([{ role: 'user', content: 'hi' }], [{ description: 'x'.repeat(5000) }]), { code: 'CONTEXT_LIMIT' });
  assert.equal(calls, 0);
  const anthropic = new AnthropicProvider({ apiKey: 'synthetic', contextWindow: 4096, maxTokens: 512 });
  await assert.rejects(anthropic.complete([{ role: 'user', content: 'hi' }], [], { thinking: 'enabled' }), { code: 'CONTEXT_CONFIG' });
});
test('runtime archives huge tool results under token budget and preserves tool pairing', async () => {
  let requests = 0, archived;
  const provider = { model: 'small', contextWindow: 8192, maxTokens: 512,
    async complete(messages, tools, options) {
      assert.equal(options.budget.fits, true);
      if (++requests === 1) return { message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{}' } }] },
        usage: { total_tokens: 9999999, completion_tokens: 9999998, prompt_tokens: 1 } };
      assert.equal(messages.at(-1).tool_call_id, 'call-1');
      const result = JSON.parse(messages.at(-1).content);
      assert.equal(result.archived, true);
      assert.equal(result.archiveId, 'tool-archive');
      return { message: { role: 'assistant', content: 'done' } };
    } };
  const output = { text: '中'.repeat(15000) };
  const runtime = new AgentRuntime({ provider, maxRounds: 3, maxContextChars: 100000 });
  const result = await runtime.run({ messages: [{ role: 'user', content: 'read the source' }], permissions,
    registry: { definitions: () => [], authorize() {}, execute: async () => output },
    offload: async (value) => { archived = structuredClone(value); return { id: 'tool-archive' }; } });
  assert.deepEqual(archived, output);
  assert.equal(result.text, 'done');
  assert.equal(requests, 2);
});
test('Anthropic preserves all authoritative system and developer messages after compaction', async () => {
  let payload;
  const provider = new AnthropicProvider({ apiKey: 'synthetic', fetchImpl: async (_url, init) => {
    payload = JSON.parse(init.body); throw new Error('captured request');
  } });
  await assert.rejects(provider.complete([
    { role: 'system', name: 'runtime_durable_facts', content: 'Plan and approvals' },
    { role: 'system', content: 'Original permission policy' },
    { role: 'developer', content: 'Safety boundary' },
    { role: 'user', content: 'Current task' },
  ], []), /captured request/);
  assert.equal(payload.system, 'Plan and approvals\n\nOriginal permission policy\n\nSafety boundary');
  assert.deepEqual(payload.messages, [{ role: 'user', content: 'Current task' }]);
});
test('compaction packs complete source records, current steering and call provenance without reasoning fragments', async () => {
  const latestUser = { role: 'user', content: 'Additional real instruction: include EXACT_MARKER.' };
  const calls = Array.from({ length: 8 }, (_, i) => ({ id: `source-${i}`, function: { name: 'read_file', arguments: JSON.stringify({ path: `source-${i}.txt` }) } }));
  const messages = [{ role: 'system', content: 'Read only until authorized.' },
    { role: 'user', content: 'Read all sources and calculate their total.' }, latestUser,
    { role: 'assistant', content: null, reasoning_content: 'UNTRUSTED_INTERNAL_GUESS'.repeat(300), tool_calls: calls },
    ...calls.map((call, i) => ({ role: 'tool', tool_call_id: call.id,
      content: JSON.stringify({ path: `source-${i}.txt`, text: `amount=${i}\n` + 'background '.repeat(170), hash: `hash-${i}` }) }))];
  const requests = [], receipts = [];
  let archived;
  const provider = { model: 'fixture', maxTokens: 512, contextWindow: 131072,
    async complete(input, tools, options) {
      assertContextBudget(contextBudget({ provider, messages: input, tools, maxChars: 16000, outputReserve: options.maxTokens }));
      assert.equal(options.thinking, 'disabled');
      const payload = JSON.parse(input.at(-1).content);
      assert.deepEqual(payload.currentUser, latestUser);
      assert.equal(JSON.stringify(payload).includes('UNTRUSTED_INTERNAL_GUESS'), false);
      assert.ok(Array.isArray(payload.records));
      for (const record of payload.records.filter((r) => r.role === 'tool')) {
        assert.equal(record.archived, undefined);
        const output = JSON.parse(record.content);
        assert.equal(JSON.parse(record.call.function.arguments).path, output.path);
        assert.equal(record.call.id, record.tool_call_id);
        receipts.push(record);
      }
      requests.push(payload);
      return { message: { role: 'assistant', content: 'All supplied records were read. EXACT_MARKER is a real current user instruction.' } };
    } };
  const result = await compactContext({ messages, provider, model: provider.model, maxChars: 16000,
    archive: async (value) => { archived = structuredClone(value); return { id: 'whole-record-archive' }; } });
  assert.equal(receipts.length, 8);
  assert.ok(requests.length <= 2, `expected at most 2 complete-record requests, got ${requests.length}`);
  assert.deepEqual(archived, messages);
  assert.ok(result.messages.some((m) => m.content === latestUser.content));
});
test('oversized single summary record is explicitly archived rather than sliced into misleading JSON fragments', async () => {
  const messages = [{ role: 'user', content: 'prior task' },
    { role: 'assistant', content: 'long original '.repeat(20000) }, { role: 'user', content: 'current task' }];
  const records = [];
  const provider = { model: 'fixture', maxTokens: 512, contextWindow: 131072,
    async complete(input) { records.push(...JSON.parse(input.at(-1).content).records); return { message: { role: 'assistant', content: 'An older oversized message remains available in its archive.' } }; } };
  let archived;
  await compactContext({ messages, provider, model: provider.model, maxChars: 12000,
    archive: async (value) => { archived = value; return { id: 'huge-original' }; } });
  const excerpt = records.find((r) => r.archived);
  assert.equal(excerpt.previewIncomplete, true);
  assert.equal(excerpt.archiveId, 'huge-original');
  assert.deepEqual(archived[excerpt.messageIndex], messages[1]);
  assert.ok(excerpt.preview.length <= 1000);
});
test('compaction cancellation propagates after a provider returns its final summary', async () => {
  const controller = new AbortController();
  const provider = { model: 'fixture', complete: async () => {
    controller.abort(new Error('cancelled after summary'));
    return { message: { role: 'assistant', content: 'summary' } };
  } };
  await assert.rejects(compactContext({ provider, messages: [{ role: 'assistant', content: 'x'.repeat(10000) }, { role: 'user', content: 'current' }],
    maxChars: 4000, signal: controller.signal, archive: async () => ({ id: 'cancel-archive' }) }), /cancelled after summary/);
});
test('compaction associates reused call IDs with their own chronological assistant batch', async () => {
  const messages = [{ role: 'user', content: 'Compare the sources.' }];
  for (let i = 0; i < 8; i++) messages.push(
    { role: 'assistant', tool_calls: [{ id: 'reused', function: { name: 'read_file', arguments: JSON.stringify({ path: `file-${i}.txt` }) } }] },
    { role: 'tool', tool_call_id: 'reused', content: JSON.stringify({ path: `file-${i}.txt`, text: 'source text '.repeat(150) }) });
  messages.push({ role: 'user', content: 'Current task' });
  let inspected = 0;
  const provider = { model: 'fixture', maxTokens: 512,
    async complete(input) {
      for (const record of JSON.parse(input.at(-1).content).records.filter((r) => r.role === 'tool')) {
        assert.equal(JSON.parse(record.call.function.arguments).path, JSON.parse(record.content).path);
        inspected++;
      }
      return { message: { role: 'assistant', content: 'Sources read.' } };
    } };
  await compactContext({ messages, provider, maxChars: 8000, archive: async () => ({ id: 'reused-calls' }) });
  assert.ok(inspected >= 6);
});

test('large authoritative policy can compact history without the old worst-case character rejection', async () => {
  const system = { role: 'system', content: 'Policy: read only. '.repeat(450) };
  const durable = { role: 'system', content: 'Approval pending. Do not write.' };
  const user = { role: 'user', name: TASK_INPUT_MESSAGE, content: 'Summarize medications from the last two years.' };
  let archived;
  const messages = [system, user, { role: 'assistant', content: '历史资料'.repeat(14000) }];
  const provider = { model: 'fixture', contextWindow: 32000, maxTokens: 1024,
    complete: async () => ({ message: { role: 'assistant', content: 'Prior evidence is archived; medication review remains pending.' } }) };
  const result = await compactContext({ provider, messages, durableMessages: [durable], maxChars: 100000,
    archive: async value => { archived = structuredClone(value); return { id: 'policy-regression' }; } });
  assert.deepEqual(archived, messages);
  assert.ok(result.messages.some(m => m.content === system.content));
  assert.ok(result.messages.some(m => m.content === durable.content));
  assert.ok(result.messages.some(m => m.content === user.content));
  assert.ok(result.budget.fits);
  assert.ok(result.afterChars < result.beforeChars);
});

test('real fixed-context overflow reports budget numbers without summarizing permissions', async () => {
  let calls = 0;
  const provider = { model: 'small-window', contextWindow: 4096, maxTokens: 512,
    complete: async () => { calls++; } };
  await assert.rejects(compactContext({ provider, messages: [
    { role: 'system', content: '权限'.repeat(3000) }, { role: 'user', content: 'current task' }],
    archive: async () => ({ id: 'unused' }) }), error => {
    assert.equal(error.code, 'CONTEXT_LIMIT');
    assert.match(error.message, /small-window/);
    assert.match(error.message, /4096/);
    assert.match(error.message, /512/);
    return true;
  });
  assert.equal(calls, 0);
});

test('soft compaction threshold cannot reject an intact request that fits near a hard limit', async () => {
  const provider = { model: 'small', contextWindow: 4096, maxTokens: 512,
    complete: async () => { throw new Error('must not summarize protected content'); } };
  const messages = [{ role: 'system', content: 'x'.repeat(3150) }, { role: 'user', content: 'Summarize.' }];
  const before = contextBudget({ provider, messages });
  assert.ok(before.fits && before.shouldCompact);
  const result = await compactContext({ provider, messages,
    archive: async () => { throw new Error('no lossy transform to archive'); } });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.messages, messages);
  assert.ok(result.budget.fits);
});
