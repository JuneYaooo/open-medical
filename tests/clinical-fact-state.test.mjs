import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

test("unknown allergy history is distinct from explicitly checked no-known-allergies", async (t) => {
  const f = await fixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "过敏状态患者" })).data;
  assert.equal(p.allergyStatus, "unknown");
  const checked = (await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: p.revision, allergyStatus: "none_known" })).data;
  assert.equal(checked.allergyStatus, "none_known");
  const withAllergy = (await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: checked.revision, allergies: ["青霉素"] })).data;
  assert.equal(withAllergy.allergyStatus, "recorded");
  assert.equal((await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: withAllergy.revision, allergyStatus: "none_known" })).status, 400);
  const removed = (await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: withAllergy.revision, allergies: [] })).data;
  assert.equal(removed.allergyStatus, "unknown", "removing last allergen is not a clinical assertion of no known allergy");
});

test("stopped medications remain in longitudinal record but do not trigger current medication rules", async (t) => {
  const f = await fixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "停药记录患者", allergies: ["阿司匹林"], medications: [{ name: "阿司匹林", status: "stopped", source: "合成停药记录" }] })).data;
  assert.equal(p.medications[0].status, "stopped");
  assert.equal((await f.json(`/api/risk-alerts?patientId=${p.id}&status=active`)).data.alerts.length, 0);
  await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: p.revision, medications: [{ ...p.medications[0], status: "active" }] });
  assert.ok((await f.json(`/api/risk-alerts?patientId=${p.id}&status=active`)).data.alerts.length > 0);
});

test("clinical proposals preserve medication state, evidence and explicit allergy checks through confirmation", async (t) => {
  const f = await fixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "提案状态患者" })).data;
  const action = f.server.runtime.toolPlugins.get("patient_record_propose").execute({ patientId: p.id, summary: "合成核对结果", allergyStatus: "none_known", medications: [{ name: "合成历史用药", status: "stopped", source: "合成来源第 3 页" }] });
  assert.equal(action.payload.allergyStatus, "none_known");
  const result = await f.json(`/api/pending-actions/${action.id}/confirm`, "POST", {});
  assert.equal(result.status, 200);
  const after = (await f.json(`/api/patients/${p.id}`)).data;
  assert.equal(after.allergyStatus, "none_known");
  assert.equal(after.medications[0].status, "stopped");
  assert.equal(after.medications[0].source, "合成来源第 3 页");
  const exported = (await f.json(`/api/patients/${p.id}/export`)).data;
  assert.equal(exported.medications[0].status, "stopped");
  assert.equal(exported.allergyStatus, "none_known");
});
