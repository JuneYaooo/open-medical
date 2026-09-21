import test from "node:test";
import assert from "node:assert/strict";
import { RunProgress } from "../server/core/run-progress.mjs";
import { AgentRuntime } from "../server/core/agent-runtime.mjs";
import { ToolRegistry } from "../server/core/tool-registry.mjs";
import { compactContext } from "../server/core/context-manager.mjs";
import { hashText } from "../server/core/workspace-files.mjs";

const permissions = { can: () => true, require() {} };
const fileObservation = { revision: "hash", content: "text" };
const archiveObservation = { ...fileObservation, archiveReference: "id", replan: false };
const call = (name, args, id = "reused") => ({ id, function: { name, arguments: JSON.stringify(args) } });
const batch = (item, result) => [{ role: "assistant", tool_calls: [item] },
  { role: "tool", tool_call_id: item.id, content: JSON.stringify(result) }];

for (const range of [
  { offset: 0, totalChars: 1993, nextOffset: null, length: 1993 },
  { offset: 1000, totalChars: 1993, nextOffset: null, length: 993 },
  { offset: 0, totalChars: 3000, nextOffset: 1000, length: 1000 },
]) test(`archive excerpt preserves actual range ${range.offset}..${range.nextOffset ?? "EOF"}`, async () => {
  const progress = new RunProgress();
  const item = call("read_context_archive", { archiveId: "original", offset: range.offset, limit: range.length });
  const value = { id: "original", hash: "archive-hash", text: "x".repeat(range.length),
    offset: range.offset, totalChars: range.totalChars, nextOffset: range.nextOffset };
  let recursiveArchives = 0;
  await progress.record(item, value, { observation: archiveObservation }, async () => { recursiveArchives++; return { id: "wrong" }; });
  const reduced = JSON.parse(progress.prune(batch(item, value)).messages[1].content);
  assert.equal(reduced.archiveId, "original");
  assert.equal(reduced.hash, "archive-hash");
  assert.equal(reduced.hashScope, "archive-json");
  assert.equal(reduced.contentKind, "archive-json-page");
  for (const key of ["offset", "totalChars", "nextOffset"]) assert.equal(reduced[key], value[key]);
  assert.equal(reduced.returnedChars, range.length);
  assert.equal(reduced.reachedArchiveEnd, range.nextOffset === null);
  assert.equal(reduced.previewIncomplete, true);
  assert.equal(reduced.originalChars, undefined, "archive JSON length must not masquerade as source-file length");
  assert.equal(recursiveArchives, 0);
});

test("microcompaction protects latest whole tool batch and keeps older duplicate IDs correctly associated", async () => {
  const progress = new RunProgress(), messages = [];
  for (const path of ["old.txt", "new.txt"]) {
    const item = call("read_file", { path });
    const value = { path, text: path + " body".repeat(300), hash: hashText(path) };
    await progress.record(item, value, { observation: fileObservation }, async () => ({ id: path + "-archive" }));
    messages.push(...batch(item, value));
  }
  messages.push({ role: "assistant", name: "runtime_progress", content: "Runtime guidance." });
  const result = progress.prune(messages, { protectLatestBatch: true });
  assert.equal(result.count, 1);
  assert.equal(result.messages.length, messages.length);
  assert.equal(JSON.parse(result.messages[1].content).archiveId, "old.txt-archive");
  assert.equal(JSON.parse(result.messages[1].content).hashScope, "source-file");
  assert.deepEqual(result.messages[3], messages[3]);
  assert.equal(progress.prune(messages).count, 2, "default conversion retains its existing contract");
});

test("large latest batch reaches summarizer as complete results under actual request budgets", async () => {
  const seen = new Map();
  let mainRequests = 0, compactions = 0;
  const provider = { model: "synthetic", maxTokens: 512, complete: async (messages, tools, options) => {
    assert.equal(options.budget.fits, true);
    if (messages[0].content.includes("会话历史压缩器")) {
      const payload = JSON.parse(messages.at(-1).content);
      for (const record of payload.records.filter((r) => r.role === "tool")) {
        const value = JSON.parse(record.content);
        assert.equal(value.archived, undefined);
        assert.equal(value.text, value.path + "\n" + "background ".repeat(190));
        assert.equal(JSON.parse(record.call.function.arguments).path, value.path);
        seen.set(value.path, value.hash);
      }
      return { message: { role: "assistant", content: "All six supplied source records were summarized." } };
    }
    if (++mainRequests === 1) return { message: { role: "assistant", tool_calls:
      Array.from({ length: 6 }, (_, i) => call("read_file", { path: `file-${i}.txt` }, `c${i}`)) } };
    return { message: { role: "assistant", content: "Done." } };
  } };
  const registry = new ToolRegistry([{ permission: "filesystem.read", observation: fileObservation,
    definition: { type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    execute: ({ path }) => ({ path, text: path + "\n" + "background ".repeat(190), hash: hashText(path) }) }]);
  await new AgentRuntime({ provider, maxContextChars: 12000, maxRounds: 3 }).run({
    messages: [{ role: "user", content: "Read all six sources." }], registry, permissions,
    offload: async (value) => ({ id: value.path }),
    compact: (messages, options) => { compactions++; return compactContext({ ...options, messages, provider,
      maxChars: 12000, archive: async () => ({ id: "history" }) }); },
  });
  assert.equal(compactions, 1);
  assert.equal(mainRequests, 2);
  assert.equal(seen.size, 6);
});

test("hard output offload uses the same archive range semantics without recursive archives", async () => {
  const page = { id: "original", hash: "archive-hash", offset: 1000, totalChars: 3500,
    nextOffset: null, text: "x".repeat(2500) };
  let requests = 0, offloads = 0;
  const provider = { model: "small", contextWindow: 8192, maxTokens: 512,
    complete: async (messages, _tools, options) => {
      assert.equal(options.budget.fits, true);
      if (++requests === 1) return { message: { role: "assistant", tool_calls:
        [call("read_context_archive", { archiveId: "original", offset: 1000, limit: 2500 })] } };
      const reduced = JSON.parse(messages.findLast((m) => m.role === "tool").content);
      assert.equal(reduced.archived, true);
      assert.equal(reduced.contentKind, "archive-json-page");
      assert.equal(reduced.offset, 1000);
      assert.equal(reduced.totalChars, 3500);
      assert.equal(reduced.nextOffset, null);
      assert.equal(reduced.returnedChars, 2500);
      assert.equal(reduced.previewIncomplete, true);
      return { message: { role: "assistant", content: "Range retained." } };
    } };
  const registry = new ToolRegistry([{ permission: "tools.execute", observation: archiveObservation,
    definition: { type: "function", function: { name: "read_context_archive", parameters: { type: "object",
      properties: { archiveId: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } } } } },
    execute: () => page }]);
  await new AgentRuntime({ provider, maxRounds: 3, maxContextChars: 6000 }).run({
    messages: [{ role: "user", content: "Read archive." }], registry, permissions,
    offload: async () => { offloads++; return { id: "incorrect-recursive-archive" }; },
  });
  assert.equal(requests, 2);
  assert.equal(offloads, 0);
});

test("a repeated read reaches the next model request with full fresh text rather than an eager excerpt", async () => {
  const text = "full repeated source ".repeat(80);
  let requests = 0, executions = 0;
  const provider = { model: "synthetic", complete: async (messages) => {
    requests++;
    if (requests > 1) assert.equal(JSON.parse(messages.findLast((m) => m.role === "tool").content).text, text);
    if (requests < 3) return { message: { role: "assistant", tool_calls: [call("read_file", { path: "source" })] } };
    return { message: { role: "assistant", content: "Read twice." } };
  } };
  const registry = new ToolRegistry([{ permission: "filesystem.read", observation: fileObservation,
    definition: { type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    execute: () => { executions++; return { text, hash: hashText(text) }; } }]);
  await new AgentRuntime({ provider, maxRounds: 3, maxContextChars: 12000 }).run({
    messages: [{ role: "user", content: "Read twice." }], registry, permissions,
    offload: async () => ({ id: "source-archive" }),
  });
  assert.equal(executions, 2);
  assert.equal(requests, 3);
});

test("1993-character archive pages enter compaction complete with exact EOF metadata", async () => {
  const progress = new RunProgress(), calls = [], results = [];
  for (let i = 0; i < 6; i++) {
    const item = call("read_context_archive", { archiveId: `original-${i}`, offset: 0, limit: 2000 }, `c${i}`);
    const page = { id: `original-${i}`, hash: `archive-hash-${i}`, offset: 0, totalChars: 1993,
      nextOffset: null, text: "x".repeat(1993) };
    await progress.record(item, page, { observation: archiveObservation });
    calls.push(item);
    results.push({ role: "tool", tool_call_id: item.id, content: JSON.stringify(page) });
  }
  const messages = [{ role: "user", content: "Read entire archives." }, { role: "assistant", tool_calls: calls }, ...results];
  const protectedBatch = progress.prune(messages, { protectLatestBatch: true });
  assert.equal(protectedBatch.count, 0);
  let pagesSeen = 0;
  const provider = { model: "synthetic", maxTokens: 512, complete: async (input, _tools, options) => {
    assert.equal(options.budget.fits, true);
    for (const record of JSON.parse(input.at(-1).content).records.filter((r) => r.role === "tool")) {
      assert.equal(record.archived, undefined, "a normal 1993-character page must not become an oversized-record excerpt");
      const page = JSON.parse(record.content);
      assert.equal(page.offset, 0);
      assert.equal(page.totalChars, 1993);
      assert.equal(page.nextOffset, null);
      assert.equal(page.text.length, 1993);
      assert.equal(JSON.parse(record.call.function.arguments).archiveId, page.id);
      pagesSeen++;
    }
    return { message: { role: "assistant", content: "Complete archive pages retrieved; display summaries remain lossy." } };
  } };
  const result = await compactContext({ messages: protectedBatch.messages, provider, maxChars: 12000,
    archive: async () => ({ id: "history" }) });
  assert.equal(pagesSeen, 6);
  assert.equal(result.budget.fits, true);
});

test("multiple call IDs reused in later batches retain their own source associations", async () => {
  const progress = new RunProgress(), messages = [];
  for (const prefix of ["old", "new"]) {
    const calls = [], results = [];
    for (const id of ["a", "b"]) {
      const path = `${prefix}-${id}`;
      const item = call("read_file", { path }, id);
      const value = { path, text: path + " text".repeat(200), hash: hashText(path) };
      await progress.record(item, value, { observation: fileObservation }, async () => ({ id: path }));
      calls.push(item);
      results.push({ role: "tool", tool_call_id: id, content: JSON.stringify(value) });
    }
    messages.push({ role: "assistant", tool_calls: calls }, ...results);
  }
  const reduced = progress.prune(messages, { protectLatestBatch: true });
  assert.equal(reduced.count, 2);
  assert.equal(JSON.parse(reduced.messages[1].content).archiveId, "old-a");
  assert.equal(JSON.parse(reduced.messages[2].content).archiveId, "old-b");
  assert.deepEqual(reduced.messages.slice(3), messages.slice(3));
});
