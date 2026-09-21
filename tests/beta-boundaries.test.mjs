import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RunProgress } from "../server/core/run-progress.mjs";
import { ContainerJournal } from "../server/core/container-journal.mjs";
import { AgentRuntime } from "../server/core/agent-runtime.mjs";
import { ToolRegistry } from "../server/core/tool-registry.mjs";
import { quantityContentValid } from "../scripts/document-content-audit.mjs";

const archiveTool = { observation: { revision: "hash", content: "text", archiveReference: "archiveId" } };
const archiveCall = (offset, limit = 10) => ({ id: "read", function: { name: "read_context_archive", arguments: JSON.stringify({ archiveId: "source", offset, limit }) } });
test("17-page cycles stop across checkpoint reloads; signatures and coverage outlive the 16 excerpts", async () => {
  let progress = new RunProgress(), stopped = false, rounds = 0;
  for (; rounds < 68; rounds++) {
    progress.beginRound();
    const offset = rounds % 17 * 10;
    await progress.record(archiveCall(offset), { archiveId: "source", hash: "a".repeat(64), offset, text: "x".repeat(10) }, archiveTool);
    if (progress.endRound().stopped) { stopped = true; break; }
    progress = new RunProgress(progress.snapshot());
  }
  assert.equal(stopped, true); assert.ok(rounds < 30);
  assert.equal(progress.snapshot().observations.length, 16);
  assert.equal(progress.snapshot().visits.length, 17);
  assert.deepEqual(progress.snapshot().coverage[0].ranges, [[0, 170]]);
});
test("overlapping ranges do not fake progress; uncovered suffix and new versions do", async () => {
  const p = new RunProgress();
  await p.record(archiveCall(0, 100), { archiveId: "source", hash: "a", offset: 0, text: "x".repeat(100) }, archiveTool);
  p.beginRound();
  assert.equal((await p.record(archiveCall(30), { archiveId: "source", hash: "a", offset: 30, text: "x".repeat(10) }, archiveTool)).unchanged, true);
  assert.equal((await p.record(archiveCall(90, 20), { archiveId: "source", hash: "a", offset: 90, text: "x".repeat(20) }, archiveTool)).unchanged, false);
  assert.equal((await p.record(archiveCall(0), { archiveId: "source", hash: "b", offset: 0, text: "y".repeat(10) }, archiveTool)).unchanged, false);
});
test("exact visit storage is bounded and does not evict into false novelty", async () => {
  const p = new RunProgress();
  for (let n = 0; n < 2100; n++) await p.record(archiveCall(n), { archiveId: "source", hash: "a", offset: n, text: "x" }, archiveTool);
  assert.equal(p.snapshot().visits.length, 2048); assert.ok(p.snapshot().coverage.length <= 128);
  assert.equal((await p.record(archiveCall(0), { archiveId: "source", hash: "a", offset: 0, text: "x" }, archiveTool)).unchanged, true);
});
function journalFixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const old = new ContainerJournal(db, { machine: "machine", pid: 111, processId: "old" });
  const r = old.create({ owner: "workspace", runId: "run", sessionId: "session", name: "random-name", endpoint: "daemon", deadline: 99 });
  const recovery = new ContainerJournal(db, { machine: "machine", pid: 222, processId: "new", isAbsent: (pid) => pid === 111 });
  const id = "a".repeat(64), calls = [];
  let removed = false;
  const cli = async (args) => {
    calls.push(args);
    if (args[0] === "rm") { removed = true; return { code: 0 }; }
    if (removed) return { code: 1, missing: true };
    return { code: 0, stdout: JSON.stringify({ Id: id, Config: { Labels: {
      "omw.installation": r.installation, "omw.execution": r.nonce, "omw.protocol": "1",
    } }, State: { Running: true } }) };
  };
  return { db, old, r, recovery, cli, calls, id };
}
for (const phase of ["creating", "created", "started", "exited", "logs_complete", "cleanup_pending"]) test(`restart from ${phase} reclaims exact ID without starting or delivering`, async (t) => {
  const f = journalFixture(t);
  f.old.update(f.r.nonce, { phase, ...(phase !== "creating" ? { containerId: f.id } : {}) });
  await f.recovery.recover({ endpoint: "daemon", cli: f.cli });
  assert.equal(f.recovery.get(f.r.nonce).phase, "removed");
  assert.deepEqual(f.calls.filter((c) => c[0] === "rm"), [["rm", "-f", f.id]]);
  assert.ok(f.calls.every((c) => ["inspect", "rm"].includes(c[0])));
  await f.recovery.recover({ endpoint: "daemon", cli: f.cli });
  assert.equal(f.calls.filter((c) => c[0] === "rm").length, 1);
});
for (const condition of ["live", "pid-reused", "machine", "endpoint", "nonce", "installation", "legacy-labels", "lease"]) test(`recovery refuses ${condition} ownership ambiguity`, async (t) => {
  const f = journalFixture(t);
  if (["live", "pid-reused"].includes(condition)) f.recovery.isAbsent = () => false;
  if (condition === "machine") f.recovery.machine = "other";
  if (condition === "lease") f.db.prepare("UPDATE container_executions SET lease_until=?").run(Date.now() + 60000);
  const cli = async (args) => {
    const result = await f.cli(args);
    if (args[0] === "inspect" && ["nonce", "installation", "legacy-labels"].includes(condition)) {
      const info = JSON.parse(result.stdout);
      if (condition === "legacy-labels") info.Config.Labels = { "omw.managed": "true" };
      else info.Config.Labels[condition === "nonce" ? "omw.execution" : "omw.installation"] = "other";
      result.stdout = JSON.stringify(info);
    }
    return result;
  };
  await f.recovery.recover({ endpoint: condition === "endpoint" ? "other" : "daemon", cli });
  assert.equal(f.calls.some((c) => c[0] === "rm"), false);
  assert.notEqual(f.recovery.get(f.r.nonce).phase, "removed");
});
test("rm timeout and daemon absence retain durable identity and bounded retries", async (t) => {
  const f = journalFixture(t);
  await f.recovery.recover({ endpoint: "daemon", cli: async (args) => args[0] === "rm" ? { code: 1 } : f.cli(args) });
  const r = f.recovery.get(f.r.nonce);
  assert.equal(r.phase, "cleanup_pending"); assert.equal(r.containerId, f.id);
  assert.equal(r.attempts, 1); assert.ok(r.nextRetryAt > Date.now());
  assert.doesNotMatch(JSON.stringify(r), /command|password|Env/);
});
test("approval boundary checkpoints verification then waiting, without another model request", async () => {
  let requested = 0;
  const runtime = new AgentRuntime({ provider: { model: "fixture", complete: async () => {
    requested++; return { message: { role: "assistant", tool_calls: [{ id: "one", function: { name: "submit", arguments: "{}" } }] } };
  } }, maxRounds: 5 });
  const registry = new ToolRegistry([{ permission: "filesystem.write", definition: { type: "function", function: {
    name: "submit", parameters: { type: "object", properties: {} } } }, execute: () => ({}) }]);
  const phases = [];
  const result = await runtime.run({ messages: [{ role: "user", content: "prepare" }], registry,
    permissions: { require() {}, can() { return true; } },
    onApprovalReady: () => ({ phase: "verification_complete", proposals: [{ path: "report.md" }] }),
    onCheckpoint: (_, state) => phases.push(state.runtimeState.phase) });
  assert.equal(requested, 1); assert.equal(result.status, "waiting_approval"); assert.equal(result.delivery, undefined);
  assert.deepEqual(phases.slice(-2), ["verification_complete", "waiting_approval"]);
});
for (const separator of [" ", " = ", ": "]) test(`PDF semantic audit accepts ${JSON.stringify(separator)} with exact values`, () => {
  assert.equal(quantityContentValid({ truncated: false, pages: [{ text: `Source: sales.csv\nAlpha${separator}4\nBeta${separator}6\nTotal${separator}10` }] }), true);
});
for (const bad of ["40", "4.1", "-4", "4,000", "4e1"]) test(`PDF audit rejects wrong value ${bad}`, () => {
  assert.equal(quantityContentValid({ truncated: false, pages: [{ text: `Source: sales.csv\nAlpha: ${bad}\nBeta: 6\nTotal: 10` }] }), false);
});

test("coalescing repeated archived batches retains complete tool pairs and latest original result", async () => {
  const p = new RunProgress(), messages = [];
  const call = archiveCall(0), value = { archiveId: "source", hash: "a", offset: 0, totalChars: 1500, nextOffset: null, text: "x".repeat(1500) };
  await p.record(call, value, archiveTool);
  for (let i = 0; i < 8; i++) messages.push({ role: "assistant", tool_calls: [{ ...call, id: String(i) }] },
    { role: "tool", tool_call_id: String(i), content: JSON.stringify(value) });
  const reduced = p.prune(messages, { protectLatestBatch: true });
  assert.ok(reduced.messages.length < messages.length);
  assert.equal(reduced.messages.at(-1).content, JSON.stringify(value));
  for (let i = 0; i < reduced.messages.length; i += 2)
    assert.equal(reduced.messages[i].tool_calls[0].id, reduced.messages[i + 1].tool_call_id);
});
test("bounded visit saturation never reuses an archive for a different output", async () => {
  const p = new RunProgress({ version: 1, observations: [], visits: Array.from({ length: 2048 }, (_, i) => ({ key: String(i), repeats: 0 })), failures: [], stalledRounds: 0 });
  const tool = { observation: { revision: "hash", content: "text" } };
  const call = { id: "one", function: { name: "read_file", arguments: '{"path":"a"}' } };
  const references = [];
  const offload = async (value) => { references.push(value); return { id: String(references.length) }; };
  await p.record(call, { hash: "old", text: "old" }, tool, offload);
  const changed = await p.record(call, { hash: "new", text: "new" }, tool, offload);
  assert.equal(changed.archiveId, "2"); assert.equal(references[1].text, "new");
});

test("recovery leaves failed inspect ambiguous and does not treat missing random name as removed", async (t) => {
  const f = journalFixture(t);
  await f.recovery.recover({ endpoint: "daemon", cli: async () => ({ code: 1, missing: true }) });
  assert.equal(f.recovery.get(f.r.nonce).phase, "cleanup_pending");
});
test("two recovery instances contend for a per-execution lease without duplicate removal", async (t) => {
  const f = journalFixture(t);
  const third = new ContainerJournal(f.db, { machine: "machine", processId: "third", isAbsent: () => true });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let first = true;
  const work = f.recovery.recover({ endpoint: "daemon", cli: async (args) => {
    if (first) { first = false; await gate; }
    return f.cli(args);
  } });
  await third.recover({ endpoint: "daemon", cli: f.cli });
  release(); await work;
  assert.equal(f.calls.filter((c) => c[0] === "rm").length, 1);
});
test("resume at a verified approval checkpoint does not call the model", async () => {
  const runtime = new AgentRuntime({ provider: { model: "fixture", complete() { throw new Error("must not run"); } } });
  const result = await runtime.run({ messages: [{ role: "user", content: "prepare" }],
    registry: new ToolRegistry(), permissions: { require() {}, can() { return true; } },
    runtimeState: { version: 1, phase: "verification_complete", observations: [], failures: [], stalledRounds: 0 },
    onApprovalReady: () => ({ phase: "verification_complete", proposals: [{ path: "report.md" }] }) });
  assert.equal(result.status, "waiting_approval"); assert.equal(result.rounds, 0);
});
test("unchanged historical summary is retained without another summarizer call", async () => {
  const { compactContext } = await import("../server/core/context-manager.mjs");
  const summary = "Completed step: source checked. ".repeat(20);
  const result = await compactContext({ maxChars: 3000, messages: [
    { role: "system", content: "Follow the task." },
    { role: "assistant", name: "context_summary", content: "Archived history\n" + summary },
    { role: "user", name: "runtime_task_input", content: "Preserve my original task requirements." },
    { role: "assistant", content: "Recent completed work. ".repeat(45) },
  ], archive: async () => ({ id: "complete-history" }), provider: { model: "fixture", complete() { throw new Error("redundant compression"); } } });
  assert.ok(result.messages.find((m) => m.name === "context_summary").content.endsWith(summary));
  assert.ok(result.budget.fits);
});
