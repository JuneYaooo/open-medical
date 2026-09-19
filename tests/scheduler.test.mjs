import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { Store } from "../server/store.mjs";
import { MedicalRuntime } from "../server/runtime.mjs";
import { MedicalScheduler } from "../server/scheduler.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const legacySession = async (f, tag) =>
  (
    await f.json("/api/sessions", "POST", {
      id: `legacy-${tag}-${Math.random().toString(36).slice(2, 8)}`,
    })
  ).data;

test("explicit resume after failure schedules a fresh occurrence without replaying old request", async (t) => {
  let now = Date.now(),
    fail = true;
  const provider = {
    apiKey: "synthetic",
    model: "test",
    async complete(_m, _t, { onDelta = () => {} }) {
      if (fail) throw new Error("synthetic failure");
      onDelta("合成恢复完成。");
      return { message: { role: "assistant", content: "合成恢复完成。" } };
    },
  };
  const f = await fixture(t, {
    provider,
    schedulerOptions: { now: () => now, autoStart: false },
  });
  const s = await legacySession(f, "c"),
    scheduler = f.server.scheduler;
  const job = scheduler.create(s.id, {
    name: "合成恢复",
    message: "整理",
    mode: "model",
    externalConsent: true,
    fileIds: [],
    runAt: new Date(now + 1000).toISOString(),
  });
  now += 1001;
  await scheduler.tick();
  const failed = scheduler.get(job.id);
  assert.equal(failed.status, "paused");
  fail = false;
  scheduler.update(job.id, { revision: failed.revision, status: "active" });
  now += 1001;
  await scheduler.tick();
  assert.equal(scheduler.get(job.id).status, "completed");
  const runs = f.server.store.get(s.id).runs;
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0].requestId, runs[1].requestId);
});

test("scheduler starts on server listen and executes without browser connection", async (t) => {
  const f = await fixture(t, { schedulerOptions: { pollMs: 10 } });
  const s = await legacySession(f, "s");
  const job = f.server.scheduler.create(s.id, {
    name: "自动执行验证",
    message: "合成时间线",
    fileIds: [],
    runAt: new Date(Date.now() + 60).toISOString(),
  });
  const deadline = Date.now() + 2000;
  while (
    f.server.scheduler.get(job.id).status !== "completed" &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.server.scheduler.get(job.id).status, "completed");
  assert.equal(f.server.store.get(s.id).runs.length, 1);
});

test("persistent scheduler runs once, coalesces missed intervals and rejects duplicate ticks", async (t) => {
  let now = Date.now();
  const f = await fixture(t, {
    schedulerOptions: { now: () => now, autoStart: false },
  });
  const s = await legacySession(f, "s");
  const scheduler = f.server.scheduler;
  const job = scheduler.create(s.id, {
    name: "合成计划",
    message: "整理时间线",
    fileIds: [],
    runAt: new Date(now + 1000).toISOString(),
    intervalMinutes: 1,
    delegations: ["timeline"],
  });
  now += 301000;
  await Promise.all([scheduler.tick(), scheduler.tick()]);
  const current = scheduler.get(job.id);
  assert.equal(current.history.length, 1);
  assert.equal(current.history[0].status, "completed");
  assert.ok(current.nextRunAt > now);
  assert.equal(f.server.store.get(s.id).runs.length, 1);
  assert.throws(
    () => scheduler.update(job.id, { revision: 0, status: "paused" }),
    { code: "REVISION_CONFLICT" },
  );
  scheduler.update(job.id, { revision: current.revision, status: "paused" });
  now += 120000;
  await scheduler.tick();
  assert.equal(scheduler.get(job.id).history.length, 1);
});
test("scheduled model tasks require consent and pause when provider or materials change", async (t) => {
  let now = Date.now(),
    calls = 0;
  const provider = {
    apiKey: "synthetic",
    model: "test",
    baseUrl: "https://synthetic.invalid",
    complete() {
      calls++;
      throw new Error("must not run");
    },
  };
  const f = await fixture(t, {
    provider,
    schedulerOptions: { now: () => now, autoStart: false },
  });
  const s = await legacySession(f, "s");
  const scheduler = f.server.scheduler;
  const input = {
    name: "合成计划",
    message: "整理时间线",
    fileIds: [],
    mode: "model",
    runAt: new Date(now + 1000).toISOString(),
  };
  assert.throws(() => scheduler.create(s.id, input), {
    code: "CONSENT_REQUIRED",
  });
  const job = scheduler.create(s.id, { ...input, externalConsent: true });
  provider.baseUrl = "https://different.invalid";
  now += 1001;
  await scheduler.tick();
  assert.equal(scheduler.get(job.id).status, "paused");
  assert.equal(calls, 0);
  f.server.runtime.addFile(s.id, { name: "test.txt", text: "合成病历" });
  const fileId = f.server.store.get(s.id).files[0].id;
  const local = scheduler.create(s.id, {
    ...input,
    mode: "local",
    runAt: new Date(now + 1000).toISOString(),
    fileIds: [fileId],
  });
  f.server.store.mutate(s.id, (state) => {
    state.files = [];
  });
  now += 1001;
  await scheduler.tick();
  assert.equal(scheduler.get(local.id).status, "paused");
});
test("scheduler REST scope, revision and one-shot completion are enforced", async (t) => {
  let now = Date.now();
  const f = await fixture(t, {
    schedulerOptions: { now: () => now, autoStart: false },
  });
  const s = await legacySession(f, "d"),
    other = await legacySession(f, "e");
  const created = await f.json(`/api/sessions/${s.id}/schedules`, "POST", {
    name: "合成计划",
    message: "整理资料",
    fileIds: [],
    runAt: new Date(now + 1000).toISOString(),
  });
  assert.equal(created.status, 201);
  assert.equal(
    (
      await f.json(
        `/api/sessions/${other.id}/schedules/${created.data.id}`,
        "PATCH",
        { revision: 0, status: "paused" },
      )
    ).status,
    404,
  );
  now += 1001;
  await f.server.scheduler.tick();
  const job = f.server.scheduler.get(created.data.id);
  assert.equal(job.status, "completed");
  assert.equal(
    (await f.json(`/api/sessions/${s.id}/schedules`, "GET")).data.jobs.length,
    1,
  );
  assert.equal((await f.json(`/api/sessions/${s.id}`, "DELETE")).status, 200);
  assert.throws(() => f.server.scheduler.get(job.id), { code: "NOT_FOUND" });
});
test("restart preserves jobs and pauses uncertain interrupted occurrence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "medical-schedule-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "test.sqlite");
  let store = new Store(file);
  let runtime = new MedicalRuntime(store, {});
  let scheduler = new MedicalScheduler(store, runtime, { autoStart: false });
  const session = store.create();
  const job = scheduler.create(session.id, {
    name: "restart",
    message: "合成任务",
    fileIds: [],
    runAt: new Date(Date.now() + 10000).toISOString(),
  });
  job.status = "running";
  scheduler.save(job);
  store.close();
  store = new Store(file);
  runtime = new MedicalRuntime(store, {});
  scheduler = new MedicalScheduler(store, runtime, { autoStart: false });
  try {
    assert.equal(scheduler.get(job.id).status, "paused");
    assert.equal(scheduler.get(job.id).history.at(-1).status, "interrupted");
  } finally {
    store.close();
  }
});
