import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sealInterruptedContext } from "../server/core/run-recovery.mjs";
import { WorkspaceDatabase, WorkspaceService } from "../server/core/index.mjs";
import { createWorkspaceServer } from "../server/platform.mjs";
import { AgentTeam } from "../server/core/agent-team.mjs";

const exec = promisify(execFile);
const answer = (content) => ({ message: { role: "assistant", content } });
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "omw-recovery-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

for (const scenario of ["saved", "unknown"]) {
  test(`SIGKILL recovery preserves ${scenario} tool outcome without replaying effects`, async (t) => {
    const root = directory(t), worker = resolve("tests/fixtures/recovery-worker.mjs");
    // Windows cannot deliver POSIX signals: a self-SIGKILL surfaces as an
    // abnormal exit code with no signal. The recover phase below verifies the
    // actual no-replay semantics either way.
    const crashed = (error) =>
      process.platform === "win32"
        ? error.signal == null && typeof error.code === "number" && error.code !== 0
        : error.signal === "SIGKILL";
    await assert.rejects(
      exec(process.execPath, [worker, root, "crash", scenario], { timeout: 15000 }),
      crashed,
    );
    const result = await exec(process.execPath, [worker, root, "recover", scenario], { timeout: 15000 });
    assert.deepEqual(JSON.parse(result.stdout), { status: "completed", attempts: 1,
      rounds: scenario === "saved" ? 3 : 2, count: 1 });
  });
}

test("interrupted batches distinguish saved, uncertain, and unexecuted calls", () => {
  const messages = [{ role: "user", content: "task" }, { role: "assistant", tool_calls:
    ["a", "b", "c"].map((id) => ({ id, function: { name: "effect", arguments: "{}" } })) },
  { role: "tool", tool_call_id: "a", content: '{"ok":true}' }];
  const restored = sealInterruptedContext(messages, "b");
  assert.equal(restored.length, 5);
  assert.equal(restored[2].content, messages[2].content);
  assert.equal(JSON.parse(restored[3].content).code, "TOOL_OUTCOME_UNKNOWN");
  assert.equal(JSON.parse(restored[4].content).code, "TOOL_NOT_EXECUTED");
  assert.deepEqual(sealInterruptedContext(restored), restored);
  assert.equal(messages.length, 3);
});

test("HTTP shutdown drains background runs and next server resumes original run", async (t) => {
  const root = directory(t), file = join(root, "http.sqlite");
  let ready;
  const entered = new Promise((resolve) => { ready = resolve; });
  const provider = { apiKey: "synthetic", model: "restart-test", async complete(_m, _t, { signal }) {
    ready();
    await new Promise((_resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } };
  const server = createWorkspaceServer({ database: file, provider });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const w = server.service.create({ root, directoryConsent: true });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/workspaces/${w.id}/runs`, {
    method: "POST", headers: { "content-type": "application/json", "x-agent-token": server.token },
    body: JSON.stringify({ revision: w.revision, message: "keep my task", externalConsent: true, resumeOnRestart: true }),
  });
  const initial = await response.json();
  assert.equal(response.status, 202);
  await entered;
  await server.shutdown();
  const next = createWorkspaceServer({ database: file, provider: { ...provider,
    async complete(messages) {
      assert.equal(messages.filter((m) => m.content === "keep my task").length, 1);
      return answer("done after restart");
    } } });
  await new Promise((resolve) => next.listen(0, "127.0.0.1", resolve));
  await next.service.recovery.drain();
  const run = next.service.get(w.id).runs.at(-1);
  assert.equal(run.id, initial.runId);
  assert.equal(run.status, "completed");
  assert.equal(run.roundsUsed, 2);
  await next.shutdown();
});

test("automatic recovery obeys opt-in, cancellation, identity and cumulative budgets", async (t) => {
  const root = directory(t), db = new WorkspaceDatabase(":memory:");
  const service = new WorkspaceService(db.db, { apiKey: "synthetic", model: "test", complete: async () => answer("done") });
  t.after(async () => { await service.extensions.close(); db.close(); });
  for (const variant of ["opt-out", "cancelled", "identity", "rounds", "attempts", "time"]) {
    const w = service.create({ root, directoryConsent: true });
    const handle = service.prepare(w.id, { revision: w.revision, message: "test", externalConsent: true, resumeOnRestart: variant !== "opt-out" });
    service.active.delete(w.id);
    service.store.update(w.id, (w) => Object.assign(w.runs[0], {
      status: variant === "cancelled" ? "cancelled" : "interrupted",
      contextMessages: [{ role: "user", content: "test" }],
      ...(variant === "identity" ? { contextIdentity: "another-model" } : {}),
      ...(variant === "rounds" ? { roundsUsed: handle.run.limits.maxRounds } : {}),
      ...(variant === "attempts" ? { recoveryAttempts: 3 } : {}),
      ...(variant === "time" ? { activeMs: handle.run.limits.timeoutMs } : {}),
    }));
    service.recovery.tick();
    assert.equal(service.active.size, 0);
    assert.equal(Boolean(service.get(w.id).runs[0].recoveryBlocked), !["opt-out", "cancelled"].includes(variant));
  }
});

test("restored child checkpoints, queued messages and completed dependencies survive restart", async (t) => {
  const root = directory(t), db = new WorkspaceDatabase(":memory:");
  let requests = 0;
  const service = new WorkspaceService(db.db, { apiKey: "synthetic", model: "test", async complete(messages) {
    requests++;
    assert.ok(messages.some((m) => m.content === "continue child"));
    assert.ok(messages.some((m) => m.content === "new requirement"));
    return answer("child recovered");
  } });
  t.after(async () => { await service.extensions.close(); db.close(); });
  const w = service.create({ root, directoryConsent: true });
  const h = service.prepare(w.id, { revision: w.revision, message: "team", externalConsent: true });
  const team = new AgentTeam(service, w.id, h.run.id, h.controller.signal, () => {}, () => {});
  service.teams.set(w.id, team);
  team.restore([
    { id: "complete", task: "old", role: "reader", writePaths: [], dependsOn: [], status: "completed", text: "previous result" },
    { id: "child", task: "continue child", role: "reader", writePaths: [], dependsOn: ["complete"], status: "interrupted",
      messages: [{ role: "user", content: "continue child" }], inputs: ["new requirement"], roundsUsed: 1 },
  ]);
  const jobs = await team.wait(undefined, 2000);
  assert.equal(jobs[1].status, "completed");
  assert.equal(requests, 1);
  const saved = service.store.get(w.id).runs[0].children[1];
  assert.equal(saved.roundsUsed, 2);
  assert.deepEqual(saved.inputs, []);
  assert.equal(service.get(w.id).runs[0].children[1].messages, undefined);
  await team.close();
  service.active.delete(w.id);
});

test("scheduled recovery completes the original occurrence instead of dispatching a duplicate", async (t) => {
  const root = directory(t), file = join(root, "schedule.sqlite");
  let db = new WorkspaceDatabase(file), calls = 0;
  const provider = { apiKey: "synthetic", model: "test", complete: async () => { calls++; return answer("done"); } };
  let service = new WorkspaceService(db.db, provider);
  const w = service.create({ root, directoryConsent: true });
  const job = service.scheduler.create(w.id, { revision: w.revision, message: "scheduled task",
    runAt: Date.now() + 10000, externalConsent: true, resumeOnRestart: true });
  const handle = service.prepare(w.id, { revision: service.get(w.id).revision, message: job.message,
    externalConsent: true, resumeOnRestart: true, requestId: `schedule_${job.id}_${job.nextRunAt}` });
  service.store.update(w.id, (w) => {
    Object.assign(w.schedules[0], { status: "running", runId: handle.run.id });
    w.runs[0].contextMessages = [{ role: "user", content: job.message }];
  });
  service.active.clear();
  await service.extensions.close(); db.close();
  db = new WorkspaceDatabase(file); service = new WorkspaceService(db.db, provider);
  try {
    assert.equal(service.get(w.id).schedules[0].status, "recovering");
    service.recovery.tick(); await service.recovery.drain(); service.scheduler.tick();
    const result = service.get(w.id);
    assert.equal(result.schedules[0].status, "completed");
    assert.equal(result.schedules[0].history.at(-1).runId, handle.run.id);
    assert.equal(result.runs.length, 1);
    assert.equal(calls, 1);
  } finally { await service.extensions.close(); db.close(); }
});
