import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

test("same-name patients require explicit distinction; shared contacts never pick first patient", async (t) => {
  const f = await fixture(t);
  const first = (await f.json("/api/patients", "POST", { name: "李同名", birthYear: 1960, phone: "13800000000", patientNumber: "TEST-A" })).data;
  assert.equal((await f.json("/api/patients", "POST", { name: "李同名", birthYear: 1980 })).status, 409);
  const second = (await f.json("/api/patients", "POST", { name: "李同名", birthYear: 1980, phone: "13800000000", patientNumber: "TEST-B", confirmDistinctPatient: true })).data;
  assert.ok(second.id);
  assert.notEqual(first.id, second.id);
  assert.equal(f.server.patients.matchPatient("李同名"), null);
  assert.equal(f.server.patients.matchPatient("13800000000"), null);
  assert.equal(f.server.patients.matchPatient("TEST-A").id, first.id);
  assert.equal(f.server.patients.matchPatient(second.id).id, second.id);
  const result = f.server.patients.ingest([{ direction: "in", text: "合成复查反馈", patientHint: "13800000000" }]);
  assert.equal(result.unassigned, 1);
  assert.equal(f.server.patients.messages(first.id).length, 0);
  assert.equal(f.server.patients.messages(second.id).length, 0);
});

test("patient numbers remain unique on create/update and are searchable", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "编号患者", patientNumber: "TEST-001" })).data;
  assert.equal((await f.json("/api/patients", "POST", { name: "其他患者", patientNumber: "TEST-001" })).status, 409);
  const other = (await f.json("/api/patients", "POST", { name: "其他患者" })).data;
  assert.equal((await f.json(`/api/patients/${other.id}`, "PATCH", { expectedRevision: 0, patientNumber: "TEST-001" })).status, 409);
  assert.equal((await f.json("/api/patients?q=TEST-001")).data.patients[0].id, patient.id);
});

test("patient registration retry reuses its saved record even with explicit same-name distinction", async (t) => {
  const f = await fixture(t), input = { name: "合成重试患者", requestId: "patient-create-retry", confirmDistinctPatient: true };
  const first = await f.json("/api/patients", "POST", input);
  const retry = await f.json("/api/patients", "POST", input);
  assert.equal(first.data.id, retry.data.id);
  assert.equal((await f.json("/api/patients")).data.patients.length, 1);
  assert.equal((await f.json("/api/patients", "POST", { ...input, name: "不同输入" })).status, 409);
});

test("renaming a patient updates only its automatic session title and audit failures roll back", async (t) => {
  const f = await fixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "原姓名" })).data;
  const renamed = await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: 0, name: "新姓名" });
  assert.equal(renamed.status, 200);
  assert.equal((await f.json(`/api/sessions/${p.sessionId}`)).data.title, "新姓名 · 病例");
  const audit = f.server.store.audit;
  f.server.store.audit = () => { throw new Error("synthetic audit failure"); };
  const failed = await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: 1, name: "失败姓名" });
  f.server.store.audit = audit;
  assert.equal(failed.status, 500);
  assert.equal((await f.json(`/api/patients/${p.id}`)).data.name, "新姓名");
  assert.equal((await f.json(`/api/sessions/${p.sessionId}`)).data.title, "新姓名 · 病例");
  const session = (await f.json(`/api/sessions/${p.sessionId}`)).data;
  assert.equal((await f.json(`/api/sessions/${p.sessionId}`, "PATCH", { revision: session.revision, title: "医生自定义标题" })).status, 200);
  await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: 1, name: "再次更名" });
  assert.equal((await f.json(`/api/sessions/${p.sessionId}`)).data.title, "医生自定义标题");
});
