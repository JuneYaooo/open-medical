import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceDatabase, WorkspaceService } from "../server/core/index.mjs";
import { TASK_INPUT_MESSAGE } from "../server/core/run-progress.mjs";

const answer = () => ({ message: { role: "assistant", content: "Finished synthetic task." } });
const active = (messages) => messages.filter((m) => m.role === "user" && m.name === TASK_INPUT_MESSAGE).map((m) => m.content);
function fixture(t, complete) {
  const directory = mkdtempSync(join(tmpdir(), "omw-active-inputs-"));
  const root = join(directory, "project");
  mkdirSync(root);
  const db = new WorkspaceDatabase(join(directory, "synthetic.sqlite"));
  const service = new WorkspaceService(db.db, { apiKey: "synthetic", model: "active-input-test", complete });
  const { id } = service.create({ root, directoryConsent: true });
  t.after(async () => { await service.extensions.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const prepare = (message, extra = {}) => service.prepare(id, {
    message, revision: service.get(id).revision, externalConsent: true, ...extra,
  });
  const steer = (handle, message, requestId) => service.steer(id, {
    runId: handle.run.id, message, requestId, externalConsent: true,
  });
  return { service, id, prepare, steer };
}

test("new ordinary workspace task demotes previous active instructions without deleting history", async (t) => {
  const requests = [];
  const f = fixture(t, async (messages) => { requests.push(structuredClone(messages)); return answer(); });
  assert.equal((await f.service.execute(f.prepare("Old task requirement"))).status, "completed");
  assert.deepEqual(active(requests[0]), ["Old task requirement"]);
  assert.equal((await f.service.execute(f.prepare("New independent task"))).status, "completed");
  assert.deepEqual(active(requests[1]), ["New independent task"]);
  assert.ok(requests[1].some((m) => m.role === "user" && m.content === "Old task requirement" && m.name !== TASK_INPUT_MESSAGE));
});

test("two manual resumes rebuild legacy task anchors, consumed steering and repeated text in order", async (t) => {
  const requests = [];
  const f = fixture(t, async (messages) => {
    requests.push(structuredClone(messages));
    if (requests.length < 3) throw new Error("Synthetic interruption");
    return answer();
  });
  const first = f.prepare("Original goal");
  f.steer(first, "Repeated constraint", "repeat-1");
  f.steer(first, "Repeated constraint", "repeat-2");
  assert.equal((await f.service.execute(first)).status, "failed");
  assert.deepEqual(active(requests[0]), ["Original goal", "Repeated constraint", "Repeated constraint"]);
  const legacyCheckpoint = (runId) => f.service.store.update(f.id, (w) => {
    // Emulate a checkpoint from before active anchors were introduced: earlier
    // user text is absent from the lossy provider context but remains durable.
    w.runs.find((r) => r.id === runId).contextMessages = [{ role: "assistant", name: "context_summary", content: "Lossy old history." }];
  });
  legacyCheckpoint(first.run.id);
  const second = f.prepare("First continuation", { resumeRunId: first.run.id });
  assert.equal((await f.service.execute(second)).status, "failed");
  assert.deepEqual(active(requests[1]), ["Original goal", "Repeated constraint", "Repeated constraint", "First continuation"]);
  legacyCheckpoint(second.run.id);
  const third = f.prepare("Second continuation", { resumeRunId: second.run.id });
  assert.equal((await f.service.execute(third)).status, "completed");
  assert.deepEqual(active(requests[2]), ["Original goal", "Repeated constraint", "Repeated constraint", "First continuation", "Second continuation"]);
});

test("automatic recovery rebuilds consumed instructions and delivers queued input exactly once", async (t) => {
  const requests = [];
  const f = fixture(t, async (messages) => { requests.push(structuredClone(messages)); return answer(); });
  const handle = f.prepare("Recover original goal", { resumeOnRestart: true });
  const consumed = f.steer(handle, "Already consumed requirement", "consumed-1");
  const queued = f.steer(handle, "Queued requirement", "queued-1");
  f.service.store.update(f.id, (w) => {
    const run = w.runs.find((r) => r.id === handle.run.id);
    run.status = "interrupted";
    run.inputs.find((i) => i.id === consumed.id).status = "consumed";
    run.contextMessages = [{ role: "assistant", name: "context_summary", content: "Legacy compacted context." }];
  });
  f.service.active.delete(f.id);
  f.service.recovery.tick();
  await f.service.recovery.drain();
  const run = f.service.store.get(f.id).runs.at(-1);
  assert.equal(run.id, handle.run.id);
  assert.equal(run.status, "completed");
  assert.equal(requests.length, 1);
  assert.deepEqual(active(requests[0]), ["Recover original goal", "Already consumed requirement", "Queued requirement"]);
  assert.equal(requests[0].filter((m) => m.role === "user" && m.content === "Queued requirement").length, 1);
  assert.equal(run.inputs.find((i) => i.id === queued.id).status, "consumed");
});

test("steering delivered during a model request remains active without duplicate queue delivery", async (t) => {
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const requests = [];
  const f = fixture(t, async (messages) => {
    requests.push(structuredClone(messages));
    if (requests.length === 1) { entered(); await gate; }
    return answer();
  });
  const handle = f.prepare("Initial task");
  const running = f.service.execute(handle);
  await ready;
  const update = f.steer(handle, "Late constraint", "late-1");
  assert.equal(f.steer(handle, "Late constraint", "late-1").id, update.id);
  release();
  assert.equal((await running).status, "completed");
  assert.equal(requests.length, 2);
  assert.deepEqual(active(requests[1]), ["Initial task", "Late constraint"]);
  assert.equal(f.service.store.get(f.id).runs.at(-1).inputs.length, 1);
});
