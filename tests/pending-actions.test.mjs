import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

test("patient-update proposal: propose -> confirm applies through the registry", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "提案患者" })).data;

  const proposed = await f.json("/api/patients/" + patient.id + "/x", "POST").catch(() => null);
  void proposed;
  // Propose through the agent tool path (tool runs same code as REST would).
  const boot = (await f.json("/api/bootstrap")).data;
  assert.ok(boot.tools.includes("patient_record_propose"));

  // Create the proposal directly through the exposed service (agent tool uses
  // the same entry point) to keep this test focused on confirm semantics.
  const pending = f.server.constructor && null;
  void pending;
  const service = f.server.runtime.toolPlugins.get("patient_record_propose");
  const created = service.execute({
    patientId: patient.id,
    medications: [{ name: "氨氯地平", dose: "5mg", frequency: "qd" }],
    diagnoses: [{ code: "I10", name: "原发性高血压", date: "2025-08-01" }],
    summary: "把门诊整理的用药与诊断写入档案",
  });
  assert.equal(created.status, "pending");
  assert.ok(created.note.includes("确认"));

  // Invalid clinical payload is rejected at propose time, not at confirm.
  assert.throws(
    () =>
      service.execute({
        patientId: patient.id,
        labs: [{ item: "血钾", value: "偏高", date: "2025-09-01" }],
        summary: "坏数据",
      }),
    (err) => err.code === "INVALID_INPUT",
  );

  const listed = (await f.json(`/api/pending-actions?patientId=${patient.id}`)).data;
  assert.equal(listed.actions.length, 1);
  assert.equal(listed.counts.pending, 1);

  const confirmed = await f.json(`/api/pending-actions/${created.id}/confirm`, "POST");
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.action.status, "applied");
  assert.equal(confirmed.data.applied.medications[0].name, "氨氯地平");
  assert.equal(confirmed.data.applied.diagnoses[0].code, "I10");

  const after = (await f.json(`/api/patients/${patient.id}`)).data;
  assert.equal(after.medications.length, 1);
  assert.equal(after.diagnoses[0].name, "原发性高血压");

  const double = await f.json(`/api/pending-actions/${created.id}/confirm`, "POST");
  assert.equal(double.status, 409);

  const rejectedList = (await f.json(`/api/pending-actions?status=applied`)).data;
  assert.equal(rejectedList.actions.length, 1);
});

test("followup-create proposal confirms into a scheduled job; reject path", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "随访提案患者" })).data;
  const service = f.server.runtime.toolPlugins.get("followup_create_propose");
  const created = service.execute({
    patientId: patient.id,
    name: "出院后 2 周复诊",
    once: true,
    firstDueAt: new Date(Date.now() + 14 * 86400000).toISOString(),
    checklist: ["伤口", "复查血常规"],
    summary: "出院随访一次",
  });
  assert.equal(created.status, "pending");
  const confirmed = await f.json(`/api/pending-actions/${created.id}/confirm`, "POST");
  assert.equal(confirmed.status, 200);
  const jobs = (await f.json(`/api/patients/${patient.id}/followups`)).data.jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, "出院后 2 周复诊");

  const second = service.execute({
    patientId: patient.id,
    name: "会被拒绝的随访",
    once: true,
    firstDueAt: new Date(Date.now() + 86400000).toISOString(),
    summary: "拒绝演示",
  });
  await f.json(`/api/pending-actions/${second.id}/reject`, "POST");
  const rejected = (await f.json(`/api/pending-actions/${second.id}`)).data;
  void rejected;
  const still = await f.json(`/api/pending-actions/${second.id}/confirm`, "POST");
  assert.equal(still.status, 409);
  const jobsAfter = (await f.json(`/api/patients/${patient.id}/followups`)).data.jobs;
  assert.equal(jobsAfter.length, 1);
});

test("case-save proposal: with patient snapshot and standalone", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", {
    name: "病例入库提案",
    diagnoses: [{ code: "E11", name: "2 型糖尿病" }],
    labs: [{ item: "糖化血红蛋白", value: 8.4, unit: "%", date: "2025-09-01" }],
  })).data;
  const service = f.server.runtime.toolPlugins.get("case_save_propose");
  const created = service.execute({
    patientId: patient.id,
    summary: "血糖控制不佳调整方案",
    outcome: "血糖逐步达标",
  });
  const confirmed = await f.json(`/api/pending-actions/${created.id}/confirm`, "POST");
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.applied.diagnosis, "2 型糖尿病");
  const cases = (await f.json("/api/cases")).data;
  assert.equal(cases.count, 1);

  const standalone = service.execute({
    diagnosis: "社区获得性肺炎",
    summary: "抗感染有效",
  });
  assert.equal(standalone.patientId, null);
  const ok = await f.json(`/api/pending-actions/${standalone.id}/confirm`, "POST");
  assert.equal(ok.status, 200);
  assert.equal((await f.json("/api/cases")).data.count, 2);
});
