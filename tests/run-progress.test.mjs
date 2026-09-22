import test from "node:test";
import assert from "node:assert/strict";
import { RunProgress, OBSERVATIONS_MESSAGE } from "../server/core/run-progress.mjs";
import { AgentRuntime } from "../server/core/agent-runtime.mjs";
import { ToolRegistry } from "../server/core/tool-registry.mjs";
import { compactContext } from "../server/core/context-manager.mjs";
import { hashText } from "../server/core/workspace-files.mjs";
import { AnthropicProvider } from "../server/core/providers.mjs";

const call = (path, extra = {}) => ({ id: "reused", function: { name: "read_file", arguments: JSON.stringify({ path, ...extra }) } });
const tool = { permission: "filesystem.read", observation: { revision: "hash", content: "text" } };
const output = (text = "Observed data.\n" + "long background ".repeat(150)) => ({ text, hash: hashText(text) });
const permissions = { require() {}, can() { return true; } };
function archives() {
  const values = new Map();
  return { values, save: async (value) => { const id = `archive-${values.size}`; values.set(id, structuredClone(value)); return { id }; } };
}
test("versioned observations retain full archives, ranges and exact versions across resume", async () => {
  const data = archives();
  let progress = new RunProgress();
  const original = output();
  await progress.record(call("a.txt"), original, tool, data.save);
  progress = new RunProgress(progress.snapshot());
  const repeated = await progress.record(call("a.txt"), original, tool, data.save);
  assert.equal(repeated.unchanged, true);
  assert.equal(data.values.size, 1);
  assert.deepEqual(data.values.get(repeated.archiveId), original);
  assert.equal((await progress.record(call("a.txt", { startLine: 2 }), original, tool, data.save)).unchanged, false);
  assert.equal((await progress.record(call("a.txt"), output("Changed content"), tool, data.save)).unchanged, false);
  assert.equal(data.values.size, 3);
});
test("alternating unchanged reads and pending proposals cannot reset loop detection", async () => {
  const progress = new RunProgress(), data = archives();
  let status;
  for (let round = 0; round < 9; round++) {
    progress.beginRound();
    await progress.record(call("a.txt"), output(), tool, data.save);
    await progress.record(call("b.txt"), output("B"), tool, data.save);
    await progress.record({ id: "proposal", function: { name: "propose_file_write", arguments: '{}' } },
      { id: String(round), status: "pending" }, { permission: "filesystem.write" });
    status = progress.endRound();
    if (status.stopped) break;
  }
  assert.equal(status.stopped, true);
  assert.equal(progress.snapshot().observations.length, 2);
  progress.beginRound();
  progress.steer();
  await progress.record(call("a.txt"), output(), tool, data.save);
  assert.equal(progress.endRound().stopped, false);
});
test("ordinary terminal polling is not inferred to be a repeated read", async () => {
  const progress = new RunProgress();
  for (let round = 0; round < 30; round++) {
    progress.beginRound();
    await progress.record({ id: "poll", function: { name: "terminal_wait", arguments: '{"id":"session"}' } },
      { status: "running", output: "" }, { permission: "process.spawn" });
    assert.equal(progress.endRound().stopped, false);
  }
});
test("neutral list rounds cannot erase repeated-read progress history", async () => {
  const progress = new RunProgress(), data = archives();
  let stopped = false;
  for (let round = 0; round < 20; round++) {
    progress.beginRound();
    if (round % 2 === 0) await progress.record(call("a.txt"), output(), tool, data.save);
    else await progress.record({ id: "list", function: { name: "list_directory", arguments: '{}' } },
      ["a.txt"], { permission: "filesystem.read" });
    if (progress.endRound().stopped) { stopped = true; break; }
  }
  assert.equal(stopped, true);
});
test("pruning uses chronological calls, leaves pairs intact, and never discards unarchived content", async () => {
  const progress = new RunProgress(), data = archives(), messages = [];
  for (const path of ["a.txt", "b.txt"]) {
    const value = output(path + "\n" + "body ".repeat(400));
    await progress.record(call(path), value, tool, data.save);
    messages.push({ role: "assistant", tool_calls: [call(path)] }, { role: "tool", tool_call_id: "reused", content: JSON.stringify(value) });
  }
  const pruned = progress.prune(messages);
  assert.equal(pruned.count, 2);
  assert.equal(pruned.messages.length, messages.length);
  for (let i = 1; i < pruned.messages.length; i += 2) {
    const reduced = JSON.parse(pruned.messages[i].content);
    assert.deepEqual(data.values.get(reduced.archiveId), JSON.parse(messages[i].content));
    assert.equal(reduced.incomplete, true);
  }
  const withoutArchive = new RunProgress();
  await withoutArchive.record(call("a.txt"), output(), tool);
  assert.equal(withoutArchive.prune(messages).count, 0);
});
test("ledger rendering respects its exact bound and eviction leaves independently readable archives", async () => {
  const progress = new RunProgress(), data = archives();
  for (let n = 0; n < 90; n++) await progress.record(call(`file-${n}.txt`), output(String(n)), tool, data.save);
  assert.equal(progress.snapshot().observations.length, 64);
  assert.equal(data.values.size, 90);
  for (const limit of [0, 300, 500, 2000]) {
    const message = progress.message(limit);
    if (message) assert.ok(message.content.length <= limit);
  }
});
test("archive paging retains original sources and repeat tracking without flooding their display", async () => {
  const progress = new RunProgress(), saved = new Map();
  const save = async (value) => {
    const id = String(saved.size).padStart(36, "0"); saved.set(id, structuredClone(value)); return { id };
  };
  const sources = [];
  for (let n = 0; n < 16; n++) sources.push(await progress.record(call(`source-${n}.txt`), output(`Observed value ${n}.\n` + 'detail '.repeat(400)), tool, save));
  const pageTool = { permission: 'context.read', observation: { revision: 'hash', content: 'text', archiveReference: 'id', replan: false } };
  for (let n = 0; n < 90; n++) {
    const id = sources[n % sources.length].archiveId;
    await progress.record({ function: { name: 'read_context_archive', arguments: JSON.stringify({ archiveId: id, offset: n, limit: 100 }) } },
      { id, hash: saved.get(id).hash, text: saved.get(id).text.slice(n, n + 100) }, pageTool, save);
  }
  const restored = new RunProgress(progress.snapshot());
  assert.equal(restored.snapshot().observations.filter((entry) => entry.tool === 'read_file').length, 16);
  assert.equal(restored.snapshot().observations.filter((entry) => entry.tool === 'read_context_archive').length, 16);
  const message = restored.message(3400);
  assert.ok(message.content.length <= 3400);
  const ledger = JSON.parse(message.content.slice(message.content.indexOf('\n') + 1));
  assert.ok(ledger.columns.includes('hashPrefix'));
  assert.equal(ledger.observations.length, 16);
  assert.ok(ledger.observations.every((row) => row[0] === 'read_file' && row[2].length === 12));
  for (const entry of restored.snapshot().observations.filter((entry) => entry.tool === 'read_file'))
    assert.equal(entry.revision, saved.get(entry.archiveId).hash);
  assert.equal(saved.size, 16);
});
test("a full source ledger reserves repeat detection for archive reads instead of evicting each new page", async () => {
  const progress = new RunProgress(), data = archives();
  for (let n = 0; n < 64; n++) await progress.record(call(`source-${n}.txt`), output(String(n)), tool, data.save);
  const pageTool = { permission: 'context.read', observation: { revision: 'hash', content: 'text', archiveReference: 'id', replan: false } };
  const pageCall = { function: { name: 'read_context_archive', arguments: '{"archiveId":"archive-0","offset":0,"limit":10}' } };
  const page = { id: 'archive-0', hash: 'full-archive-hash', text: 'original' };
  let status;
  for (let n = 0; n < 7; n++) {
    progress.beginRound();
    const result = await progress.record(pageCall, page, pageTool, data.save);
    assert.equal(result.unchanged, n > 0);
    status = progress.endRound();
  }
  assert.equal(progress.snapshot().observations.length, 64);
  assert.equal(status.stopped, true);
});
function registryFor(execute) {
  return new ToolRegistry([{ ...tool, definition: { type: "function", function: { name: "read_file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }, execute }]);
}
test("runtime detects real repeated execution, durably checkpoints evidence before completion events, then stops without delivery", async () => {
  let executions = 0, checkpoint, requests = 0, delivered = false;
  const data = archives();
  const provider = { model: "synthetic", complete: async () => {
    requests++;
    return { message: { role: "assistant", content: null, tool_calls: [call("a.txt")] } };
  } };
  const runtime = new AgentRuntime({ provider, maxRounds: 30 });
  await assert.rejects(runtime.run({ messages: [{ role: "user", content: "Complete the task" }], permissions,
    registry: registryFor(() => { executions++; return output(); }), offload: data.save,
    onCheckpoint: (messages, state) => { checkpoint = { messages, state }; },
    emit: (event) => { if (event === "tool.complete") {
      assert.equal(checkpoint.state.pendingToolCall, undefined);
      assert.equal(checkpoint.state.runtimeState.observations.length, 1);
      assert.equal(checkpoint.messages.at(-1).role, "tool");
    } }, onDelivery: () => { delivered = true; },
  }), { code: "AGENT_NO_PROGRESS" });
  assert.equal(executions, requests - 1); // One explicit recovery pause, never cached success.
  assert.ok(executions <= 8);
  assert.equal(delivered, false);
  assert.equal(data.values.size, 1);
});
test("deterministic tool pruning avoids unnecessary model summarization under pressure", async () => {
  const data = archives(), progress = new RunProgress();
  const oldCalls = Array.from({ length: 4 }, (_, n) => ({ ...call(`old-${n}.txt`), id: `old-${n}` }));
  const oldResults = [];
  for (const item of oldCalls) {
    const value = output("old background ".repeat(200));
    await progress.record(item, value, tool, data.save);
    oldResults.push({ role: "tool", tool_call_id: item.id, content: JSON.stringify(value) });
  }
  const recent = call("recent.txt"), recentOutput = output("Small recent source.");
  await progress.record(recent, recentOutput, tool, data.save);
  let requests = 0, compacted = 0;
  const provider = { model: "synthetic", complete: async (messages) => {
    if (++requests === 1) return { message: { role: "assistant", content: null,
      tool_calls: [call("new.txt")] } };
    assert.equal(messages.filter((item) => item.name === OBSERVATIONS_MESSAGE).length, 1);
    assert.equal(messages.filter((item) => item.role === "tool").length, 6);
    return { message: { role: "assistant", content: "Sources retained." } };
  } };
  await new AgentRuntime({ provider, maxRounds: 3, maxContextChars: 12000 }).run({
    messages: [{ role: "user", content: "Read sources" },
      { role: "assistant", tool_calls: oldCalls }, ...oldResults,
      { role: "assistant", tool_calls: [recent] },
      { role: "tool", tool_call_id: recent.id, content: JSON.stringify(recentOutput) }], permissions,
    runtimeState: progress.snapshot(),
    registry: registryFor(({ path }) => output(path + "\nSmall new source.")), offload: data.save,
    compact: async () => { compacted++; throw new Error("unnecessary model summary"); },
  });
  assert.equal(compacted, 0);
  assert.equal(requests, 2);
});
test("a small actual model window bounds the ledger before compaction while preserving current user", async () => {
  const data = archives(), progress = new RunProgress();
  for (let n = 0; n < 64; n++) await progress.record(call(`file-${n}.txt`), output(), tool, data.save);
  let sent = 0;
  const provider = { model: "small", contextWindow: 8192, maxTokens: 512,
    complete: async (messages, _tools, options) => {
      assert.equal(options.budget.fits, true); sent++;
      return { message: { role: "assistant", content: "Historic sources preserved." } };
    } };
  const result = await new AgentRuntime({ provider, maxRounds: 2 }).run({ permissions,
    registry: registryFor(() => output()), runtimeState: progress.snapshot(), offload: data.save,
    messages: [{ role: "system", content: "Keep source boundaries." }, { role: "user", content: "Current exact request." },
      { role: "assistant", content: "old data ".repeat(800) }],
    compact: (messages, options) => compactContext({ ...options, messages, provider, archive: data.save }),
  });
  assert.ok(sent >= 1);
  assert.ok(result.messages.some((item) => item.content === "Current exact request."));
  assert.equal(result.messages.filter((item) => item.name === OBSERVATIONS_MESSAGE).length, 1);
});
test("steering arriving during compaction reaches the next model request before any tools", async () => {
  let queued = false, delivered = false;
  const provider = { model: "synthetic", complete: async (messages) => {
    assert.equal(messages.at(-1).content, "New instruction received during preparation.");
    delivered = true;
    return { message: { role: "assistant", content: "Acknowledged." } };
  } };
  await new AgentRuntime({ provider, maxRounds: 2, maxContextChars: 5000 }).run({ permissions,
    registry: registryFor(() => { throw new Error("unexpected tool execution"); }),
    messages: [{ role: "user", content: "Original task." }, { role: "assistant", content: "old ".repeat(1100) }],
    takeInput: () => { if (!queued) return []; queued = false; return [{ role: "user", content: "New instruction received during preparation." }]; },
    compact: async () => { queued = true; return { messages: [{ role: "user", content: "Original task." }] }; },
  });
  assert.equal(delivered, true);
});
test("one replan request cannot complete the task or permanently hide genuinely new reads", async () => {
  const data = archives(), paths = [];
  let requests = 0, state, deliveries = 0, pauses = 0;
  const provider = { model: "synthetic", complete: async (_messages, tools) => {
    requests++;
    if (requests <= 3) return { message: { role: "assistant", tool_calls: [call("a.txt")] } };
    if (requests === 4) {
      assert.equal(tools.some((item) => item.function.name === "read_file"), false);
      assert.equal(state.recoveryAttempted, true);
      assert.deepEqual(state.recoveryPending, []);
      return { message: { role: "assistant", content: "Plan: inspect the missing new source next." } };
    }
    if (requests === 5) {
      assert.equal(tools.some((item) => item.function.name === "read_file"), true);
      assert.equal(deliveries, 0);
      return { message: { role: "assistant", tool_calls: [call("new.txt")] } };
    }
    return { message: { role: "assistant", content: "Both sources checked." } };
  } };
  await new AgentRuntime({ provider, maxRounds: 8 }).run({ messages: [{ role: "user", content: "Read a and new." }],
    registry: registryFor(({ path }) => { paths.push(path); return output(path); }), permissions, offload: data.save,
    onCheckpoint: (_messages, checkpoint) => { state = checkpoint.runtimeState; },
    emit: (event) => { if (event === "run.replanning") pauses++; },
    onDelivery: () => { deliveries++; return null; },
  });
  assert.equal(pauses, 1);
  assert.equal(deliveries, 1);
  assert.deepEqual(paths, ["a.txt", "a.txt", "a.txt", "new.txt"]);
});
test("archive range observations detect repeats without recursively archiving or hiding archive access", async () => {
  const progress = new RunProgress();
  const spec = { permission: "tools.execute", observation: { revision: "hash", content: "text", archiveReference: "id", replan: false } };
  let stopped = false;
  for (let round = 0; round < 10; round++) {
    assert.deepEqual(progress.beginRound(), []);
    await progress.record({ id: "same", function: { name: "read_context_archive", arguments: '{"archiveId":"source","offset":0}' } },
      { id: "source", hash: "immutable", offset: 0, text: "actual data" }, spec,
      () => { throw new Error("must not recursively archive an archive read"); });
    if (progress.endRound().stopped) { stopped = true; break; }
  }
  assert.equal(stopped, true);
  assert.equal(progress.snapshot().observations[0].archiveId, "source");
});
test("replan control messages do not become Anthropic assistant prefill or replace the genuine user request", async () => {
  let requests = 0;
  const data = archives();
  const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
  const provider = new AnthropicProvider({ apiKey: "synthetic", model: "synthetic",
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests++;
      // Reproduces the real compatibility endpoint's rejecting assistant
      // prefill boundary without depending on a live model in this regression.
      assert.equal(payload.messages.at(-1).role, "user");
      const reading = requests <= 3 || requests === 5;
      const name = requests === 5 ? "new.txt" : "a.txt";
      const content = reading
        ? frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `r${requests}`, name: "read_file" } }) +
          frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: name }) } })
        : frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: requests === 4 ? "Plan next step." : "Finished." } });
      return new Response(content + frame({ type: "message_delta", delta: { stop_reason: reading ? "tool_use" : "end_turn" } }) +
        frame({ type: "message_stop" }), { headers: { "content-type": "text/event-stream" } });
    } });
  const result = await new AgentRuntime({ provider, maxRounds: 8 }).run({ permissions,
    messages: [{ role: "user", content: "Genuine task." }], registry: registryFor(({ path }) => output(path)), offload: data.save });
  assert.equal(requests, 6);
  assert.ok(result.messages.some((message) => message.name === "runtime_control"));
  assert.equal(result.messages.findLast((message) => message.role === "user" && message.name !== "runtime_control").content, "Genuine task.");
});

test("source ledger separates complete reads from shortened previews and deduplicates equivalent whole-file observations", async () => {
  const progress = new RunProgress(), data = archives();
  const content = "First line\nSecond line\n" + "Body ".repeat(200);
  const full = { path: "record.txt", text: content, hash: hashText(content) };
  await progress.record(call("record.txt", { endLine: 3 }), { ...full, startLine: 1, endLine: 3, totalLines: 3 }, tool, data.save);
  await progress.record(call("record.txt"), full, tool, data.save);
  await progress.record(call("record.txt", { startLine: 2, endLine: 2 }), { ...full, text: "Second line", startLine: 2, endLine: 2, totalLines: 3 }, tool, data.save);
  const message = progress.message(3400);
  const ledger = JSON.parse(message.content.slice(message.content.indexOf("\n") + 1));
  assert.equal(ledger.observations.length, 1, "whole-file evidence leaves room for other sources; original archives remain independent");
  assert.equal(ledger.observations[0][ledger.columns.indexOf("readComplete")], true);
  assert.equal(ledger.observations[0][ledger.columns.indexOf("incomplete")], true, "a shortened preview is still not the whole text");
  assert.equal(data.values.size, 3);
  const partial = new RunProgress();
  await partial.record(call("record.txt", { startLine: 2 }), { ...full, text: "Second line", startLine: 2, endLine: 2, totalLines: 3 }, tool, data.save);
  const partialMessage = partial.message(3400);
  const partialLedger = JSON.parse(partialMessage.content.slice(partialMessage.content.indexOf("\n") + 1));
  assert.equal(partialLedger.observations[0].at(-1), false, "a partial file read never certifies complete source access");
});
