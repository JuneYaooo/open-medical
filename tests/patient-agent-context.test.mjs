import test from "node:test";
import assert from "node:assert/strict";
import { PermissionEngine } from "../server/core/permissions.mjs";
import { fixture } from "./helpers.mjs";

test("patient context tool is read-only, bound to its session and reads fresh status and follow-up", async (t) => {
  const f = await fixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "合成上下文", medications: [{ name: "合成停用药", status: "stopped" }] })).data;
  const other = (await f.json("/api/patients", "POST", { name: "另一合成患者" })).data;
  const registry = f.server.workspaces.registry(p.sessionId, "context-test");
  const permissions = new PermissionEngine({ profile: "standard", grants: {} });
  const call = (args = {}) => registry.execute("read_patient_brief", args, {}, permissions);
  const result = await call();
  assert.equal(result.patientId, p.id); assert.equal(result.readOnly, true);
  assert.equal(result.allergyStatus, "unknown"); assert.equal(result.medications[0].status, "stopped");
  await assert.rejects(call({ patientId: other.id }), /patientId|额外|参数|未知/);
  await f.json(`/api/patients/${p.id}/care-tasks`, "POST", { title: "合成复查待跟进", kind: "test", dueAt: new Date().toISOString() });
  const changed = await call();
  assert.equal(changed.counts.careTasks, 1); assert.notEqual(changed.fingerprint, result.fingerprint);
  assert.equal(f.server.workspaces.registry((await f.session()).id, "unbound").has("read_patient_brief"), false);
});

test("agent additions preserve old chart facts and require explicit replacement for changed medication state", async (t) => {
  const f = await fixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "合成追加", diagnoses: [{ name: "既往诊断" }], medications: [{ name: "合成药", status: "active" }], labs: [{ item: "合成检验", value: 5, unit: "U", date: "2026-09-01" }] })).data;
  const tool = f.server.runtime.toolPlugins.get("patient_record_propose");
  const proposal = tool.execute({ patientId: p.id, summary: "补充本次资料", diagnoses: [{ name: "本次诊断" }], labs: [{ item: "合成检验", value: 6, unit: "U", date: "2026-09-02" }] });
  assert.equal(proposal.payload.diagnoses.length, 2); assert.equal(proposal.payload.labs.length, 2);
  assert.equal(f.server.patients.row(p.id).labs.length, 1);
  assert.equal((await f.json(`/api/pending-actions/${proposal.id}/confirm`, "POST", {})).status, 200);
  assert.equal(f.server.patients.row(p.id).labs.length, 2);
  assert.throws(() => tool.execute({ patientId: p.id, summary: "更新用药状态", medications: [{ name: "合成药", status: "stopped" }] }), /同名用药/);
  const replacement = tool.execute({ patientId: p.id, summary: "医生核对后停用", updateMode: "replace", medications: [{ name: "合成药", status: "stopped" }] });
  assert.match(replacement.summary, /替换所选字段/);
  assert.equal((await f.json(`/api/pending-actions/${replacement.id}/confirm`, "POST", {})).status, 200);
  assert.equal(f.server.patients.row(p.id).medications[0].status, "stopped");
  assert.equal(f.server.patients.row(p.id).diagnoses.length, 2);
});

test("patient proposals stay bound to the open chart and archived charts cannot receive pending changes", async (t) => {
  const f = await fixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "合成当前患者" })).data;
  const other = (await f.json("/api/patients", "POST", { name: "合成其他患者" })).data;
  const registry = f.server.workspaces.registry(p.sessionId, "proposal-context-test");
  const permissions = new PermissionEngine({ profile: "standard", grants: {} });
  for (const [name, args] of [
    ["patient_record_propose", { diagnoses: [{ name: "合成资料" }] }],
    ["followup_create_propose", { name: "合成随访", firstDueAt: new Date(Date.now() + 86400000).toISOString() }],
    ["case_save_propose", {}],
  ]) await assert.rejects(registry.execute(name, { ...args, patientId: other.id, summary: "合成验收" }, {}, permissions), /提案患者与当前病例不一致/);
  assert.equal((await f.json(`/api/pending-actions?patientId=${other.id}`)).data.actions.length, 0);
  const proposal = await registry.execute("patient_record_propose", { patientId: p.id, diagnoses: [{ name: "合成资料" }], summary: "补充资料" }, {}, permissions);
  await f.json(`/api/patients/${p.id}`, "PATCH", { archived: true, expectedRevision: p.revision });
  const result = await f.json(`/api/pending-actions/${proposal.id}/confirm`, "POST", {});
  assert.equal(result.status, 409); assert.match(result.data.error, /已归档/);
  await assert.rejects(registry.execute("patient_record_propose", { patientId: p.id, diagnoses: [{ name: "合成新资料" }], summary: "已归档资料" }, {}, permissions), /已归档/);
  assert.equal(f.server.patients.row(p.id).diagnoses.length, 0);
});
