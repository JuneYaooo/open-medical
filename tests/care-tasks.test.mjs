import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

async function setup(t) {
  const f = await fixture(t, { followupOptions: { autoStart: false } });
  const patient = (await f.json("/api/patients", "POST", { name: "合成跟进患者" })).data;
  const path = `/api/patients/${patient.id}/care-tasks`;
  const input = { title: "合成复查报告", kind: "test", dueAt: new Date(Date.now() - 60000).toISOString(), requestId: "synthetic-care-request" };
  return { ...f, patient, path, input };
}

test("results tracking closes only after receipt, review and communication; creates one next plan", async (t) => {
  const f = await setup(t);
  let task = (await f.json(f.path, "POST", f.input)).data;
  assert.equal(task.status, "waiting_result");
  assert.equal((await f.json(f.path, "POST", f.input)).data.id, task.id);
  assert.equal((await f.json(f.path, "POST", { ...f.input, title: "其他内容" })).status, 409);
  const path = `${f.path}/${task.id}`;
  assert.equal((await f.json("/api/doctor/overview?kind=tracking")).data.total, 1);
  assert.equal((await f.json(path, "PATCH", { expectedRevision: 0, action: "complete", note: "不能跳过核对", communication: "communicated" })).status, 409);
  assert.equal((await f.json(path, "PATCH", { expectedRevision: 0, action: "receive", note: "已收到" })).status, 400);
  task = (await f.json(path, "PATCH", { expectedRevision: 0, action: "receive", note: "已收到合成报告", source: "患者上传的合成报告" })).data;
  assert.equal(task.status, "awaiting_review");
  assert.equal((await f.json(path, "PATCH", { expectedRevision: 0, action: "receive", note: "重复", source: "合成" })).status, 409);
  task = (await f.json(path, "PATCH", { expectedRevision: task.revision, action: "review", note: "已核对原文，安排复诊" })).data;
  assert.equal(task.status, "awaiting_communication");
  const complete = { expectedRevision: task.revision, action: "complete", note: "已电话告知复诊安排", communication: "communicated", nextDueAt: new Date(Date.now() + 86400000).toISOString() };
  task = (await f.json(path, "PATCH", complete)).data;
  assert.equal(task.status, "completed");
  assert.equal(task.history.length, 4);
  assert.ok(task.nextFollowUpId);
  assert.equal((await f.json(path, "PATCH", complete)).status, 409);
  const plans = (await f.json(`/api/patients/${f.patient.id}/followups`)).data.jobs;
  assert.equal(plans.length, 1); assert.equal(plans[0].externalConsent, false);
  assert.equal((await f.json("/api/doctor/overview?kind=tracking")).data.total, 0);
  assert.equal((await f.json(f.path)).data.total, 0);
  assert.equal((await f.json(`${f.path}?status=closed`)).data.total, 1);
  task = (await f.json(path, "PATCH", { expectedRevision: 3, action: "reopen", note: "新一轮复查", dueAt: complete.nextDueAt })).data;
  assert.equal(task.status, "waiting_result");
  assert.equal(task.reviewNote, undefined);
  assert.equal(task.history[3].nextFollowUpId, plans[0].id);
});

test("care tracking rejects cross-patient writes, archived patients, and rolls back audit or scheduling failures", async (t) => {
  const f = await setup(t), db = f.server.store.db;
  const patient2 = (await f.json("/api/patients", "POST", { name: "另一位合成患者" })).data;
  const task = (await f.json(f.path, "POST", f.input)).data, path = `${f.path}/${task.id}`;
  assert.equal((await f.json(`/api/patients/${patient2.id}/care-tasks/${task.id}`, "PATCH", { expectedRevision: 0, action: "cancel", note: "误操作" })).status, 404);
  const audit = f.server.store.audit;
  f.server.store.audit = () => { throw new Error("synthetic disk failure"); };
  assert.equal((await f.json(path, "PATCH", { expectedRevision: 0, action: "cancel", note: "合成取消" })).status, 500);
  f.server.store.audit = audit;
  assert.equal((await f.json(f.path)).data.items[0].status, "waiting_result");
  await f.json(path, "PATCH", { expectedRevision: 0, action: "receive", note: "收到", source: "合成来源" });
  await f.json(path, "PATCH", { expectedRevision: 1, action: "review", note: "已核对" });
  assert.equal((await f.json(path, "PATCH", { expectedRevision: 2, action: "complete", note: "已告知", communication: "communicated", nextDueAt: "invalid" })).status, 400);
  assert.equal(db.prepare("SELECT count(*) n FROM follow_ups").get().n, 0);
  assert.equal((await f.json(f.path)).data.items[0].revision, 2);
  await f.json(`/api/patients/${f.patient.id}`, "PATCH", { expectedRevision: 0, archived: true });
  assert.equal((await f.json(path, "PATCH", { expectedRevision: 2, action: "cancel", note: "取消" })).status, 409);
  assert.equal((await f.json("/api/doctor/overview?kind=tracking")).data.total, 0);
});

test("tracking pagination counts all records and validates dates and whitespace", async (t) => {
  const f = await setup(t);
  assert.equal((await f.json(f.path, "POST", { ...f.input, title: "  " })).status, 400);
  assert.equal((await f.json(f.path, "POST", { ...f.input, dueAt: "invalid" })).status, 400);
  for (let i = 0; i < 23; i++) assert.equal((await f.json(f.path, "POST", { ...f.input, requestId: `synthetic-${i}` })).status, 201);
  const first = (await f.json(f.path)).data, second = (await f.json(`${f.path}?offset=20`)).data;
  assert.equal(first.total, 23); assert.equal(first.items.length, 20); assert.equal(second.items.length, 3);
  assert.equal(new Set([...first.items, ...second.items].map((row) => row.id)).size, 23);
  assert.equal((await f.json(`${f.path}?offset=-1`)).status, 400);
});
