import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { PatientRegistry } from "../server/patients.mjs";
import { PendingActions } from "../server/medical/pending-actions.mjs";
import { WorkspaceStore } from "../server/core/workspace-store.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

test("patient-update proposal: propose -> confirm applies through the registry", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "提案患者" }))
    .data;

  const proposed = await f
    .json("/api/patients/" + patient.id + "/x", "POST")
    .catch(() => null);
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

  const listed = (await f.json(`/api/pending-actions?patientId=${patient.id}`))
    .data;
  assert.equal(listed.actions.length, 1);
  assert.equal(listed.counts.pending, 1);

  const confirmed = await f.json(
    `/api/pending-actions/${created.id}/confirm`,
    "POST",
  );
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.action.status, "applied");
  assert.equal(confirmed.data.applied.medications[0].name, "氨氯地平");
  assert.equal(confirmed.data.applied.diagnoses[0].code, "I10");

  const after = (await f.json(`/api/patients/${patient.id}`)).data;
  assert.equal(after.medications.length, 1);
  assert.equal(after.diagnoses[0].name, "原发性高血压");

  const double = await f.json(
    `/api/pending-actions/${created.id}/confirm`,
    "POST",
  );
  assert.equal(double.status, 409);

  const rejectedList = (await f.json(`/api/pending-actions?status=applied`))
    .data;
  assert.equal(rejectedList.actions.length, 1);
});

test("followup-create proposal confirms into a scheduled job; reject path", async (t) => {
  const f = await fixture(t);
  const patient = (
    await f.json("/api/patients", "POST", { name: "随访提案患者" })
  ).data;
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
  const confirmed = await f.json(
    `/api/pending-actions/${created.id}/confirm`,
    "POST",
  );
  assert.equal(confirmed.status, 200);
  const jobs = (await f.json(`/api/patients/${patient.id}/followups`)).data
    .jobs;
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
  const still = await f.json(
    `/api/pending-actions/${second.id}/confirm`,
    "POST",
  );
  assert.equal(still.status, 409);
  const jobsAfter = (await f.json(`/api/patients/${patient.id}/followups`)).data
    .jobs;
  assert.equal(jobsAfter.length, 1);
});

test("case-save proposal: with patient snapshot and standalone", async (t) => {
  const f = await fixture(t);
  const patient = (
    await f.json("/api/patients", "POST", {
      name: "病例入库提案",
      diagnoses: [{ code: "E11", name: "2 型糖尿病" }],
      labs: [
        { item: "糖化血红蛋白", value: 8.4, unit: "%", date: "2025-09-01" },
      ],
    })
  ).data;
  const service = f.server.runtime.toolPlugins.get("case_save_propose");
  const created = service.execute({
    patientId: patient.id,
    summary: "血糖控制不佳调整方案",
    outcome: "血糖逐步达标",
  });
  const confirmed = await f.json(
    `/api/pending-actions/${created.id}/confirm`,
    "POST",
  );
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.applied.diagnosis, "2 型糖尿病");
  const cases = (await f.json("/api/cases")).data;
  assert.equal(cases.count, 1);

  const standalone = service.execute({
    diagnosis: "社区获得性肺炎",
    summary: "抗感染有效",
  });
  assert.equal(standalone.patientId, null);
  const ok = await f.json(
    `/api/pending-actions/${standalone.id}/confirm`,
    "POST",
  );
  assert.equal(ok.status, 200);
  assert.equal((await f.json("/api/cases")).data.count, 2);
});

test("patient-create proposal: chat registration propose -> confirm creates patient", async (t) => {
  const f = await fixture(t);
  const boot = (await f.json("/api/bootstrap")).data;
  assert.ok(boot.tools.includes("patient_create_propose"));
  assert.ok(boot.tools.includes("doctor_memory_propose"));

  const service = f.server.runtime.toolPlugins.get("patient_create_propose");
  const created = service.execute({
    name: "王秀英",
    gender: "female",
    birthYear: 1952,
    groups: ["2型糖尿病"],
    tags: ["二甲双胍"],
    diagnoses: [{ code: "E11.9", name: "2型糖尿病", date: "2024-03-01" }],
    allergies: ["青霉素"],
    summary: "从上传的门诊病历识别出新患者，建议建档",
  });
  assert.equal(created.status, "pending");

  // Missing name is rejected at propose time.
  assert.throws(
    () => service.execute({ summary: "没有姓名" }),
    (err) => err.code === "INVALID_INPUT",
  );

  const listed = (await f.json("/api/pending-actions?status=pending")).data;
  assert.equal(
    listed.actions.filter((a) => a.type === "patient-create").length,
    1,
  );

  const confirmed = await f.json(
    `/api/pending-actions/${created.id}/confirm`,
    "POST",
  );
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.action.status, "applied");
  assert.equal(confirmed.data.applied.name, "王秀英");

  const after = (await f.json("/api/patients")).data;
  const made = after.patients.find((p) => p.name === "王秀英");
  assert.ok(made, "建档提案确认后患者应已创建");
  assert.equal(made.allergies[0], "青霉素");
  assert.equal(made.diagnoses[0].code, "E11.9");
  assert.ok(made.sessionId, "建档应同时创建病例工作区");
});

test("doctor_memory_propose: model-proposed memory starts pending and injects after confirm", async (t) => {
  const f = await fixture(t);
  const service = f.server.runtime.toolPlugins.get("doctor_memory_propose");
  const proposed = service.execute({
    content: "随访小结按科室模板第三节格式写",
    topic: "文书格式",
  });
  assert.equal(proposed.status, "pending");

  const profile = (await f.json("/api/doctor/profile")).data;
  assert.ok(!profile.digest.includes("随访小结按科室模板第三节格式"));

  const confirmed = await f.json(
    `/api/doctor/memories/${proposed.memoryId}/confirm`,
    "POST",
  );
  assert.equal(confirmed.status, 200);

  const after = (await f.json("/api/doctor/profile")).data;
  assert.ok(after.digest.includes("随访小结按科室模板第三节格式"));
});

test("old patient proposal cannot overwrite doctor changes or accept caller revision", async (t) => {
  const f = await fixture(t);
  const patient = f.server.patients.create({
    name: "合成版本保护",
    medications: [{ name: "初始用药" }],
  });
  const tool = f.server.runtime.toolPlugins.get("patient_record_propose");
  const proposal = tool.execute({
    patientId: patient.id,
    medications: [{ name: "旧提案用药" }],
    expectedRevision: 999,
    baseRevision: 999,
    summary: "合成提案",
  });
  assert.equal(proposal.baseRevision, patient.revision);
  const edited = f.server.patients.update(patient.id, {
    expectedRevision: patient.revision,
    medications: [{ name: "医生新用药" }],
    allergies: ["合成过敏信息"],
  });
  const response = await f.json(
    `/api/pending-actions/${proposal.id}/confirm`,
    "POST",
    { expectedRevision: edited.revision, baseRevision: edited.revision },
  );
  assert.equal(response.status, 409);
  assert.equal(response.data.code, "ACTION_CONFLICT");
  assert.match(response.data.error, /重新生成/);
  const { counts: _counts, ...editedRow } = edited;
  assert.deepEqual(f.server.patients.row(patient.id), editedRow);
  const pending = (await f.json(`/api/pending-actions?patientId=${patient.id}`))
    .data.actions;
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].baseRevision, patient.revision);
});

test("confirmation status failure rolls back patient edits and can be retried exactly once", async (t) => {
  const f = await fixture(t);
  const patient = f.server.patients.create({ name: "合成原子更新" });
  const before = f.server.patients.row(patient.id);
  const proposal = f.server.runtime.toolPlugins
    .get("patient_record_propose")
    .execute({
      patientId: patient.id,
      allergies: ["合成过敏"],
      summary: "原子更新",
    });
  f.server.store.db.exec(
    "CREATE TRIGGER reject_action_status BEFORE UPDATE ON pending_actions WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END",
  );
  assert.equal(
    (await f.json(`/api/pending-actions/${proposal.id}/confirm`, "POST"))
      .status,
    500,
  );
  assert.deepEqual(f.server.patients.row(patient.id), before);
  assert.equal(
    f.server.store.db
      .prepare("SELECT status FROM pending_actions WHERE id=?")
      .get(proposal.id).status,
    "pending",
  );
  f.server.store.db.exec("DROP TRIGGER reject_action_status");
  assert.equal(
    (await f.json(`/api/pending-actions/${proposal.id}/confirm`, "POST"))
      .status,
    200,
  );
  assert.equal(f.server.patients.row(patient.id).revision, before.revision + 1);
  assert.equal(
    (await f.json(`/api/pending-actions/${proposal.id}/confirm`, "POST"))
      .status,
    409,
  );
  assert.equal(f.server.patients.row(patient.id).revision, before.revision + 1);
});

test("patient creation and its workspace roll back together when marking applied fails", async (t) => {
  const f = await fixture(t);
  const beforePatients = f.server.patients.all().length;
  const beforeWorkspaces = f.server.workspaces.store.list().length;
  const proposal = f.server.runtime.toolPlugins
    .get("patient_create_propose")
    .execute({
      name: "合成原子建档",
      diagnoses: [{ name: "合成诊断" }],
      summary: "原子建档",
    });
  f.server.store.db.exec(
    "CREATE TRIGGER reject_create_status BEFORE UPDATE ON pending_actions WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END",
  );
  assert.equal(
    (await f.json(`/api/pending-actions/${proposal.id}/confirm`, "POST"))
      .status,
    500,
  );
  assert.equal(f.server.patients.all().length, beforePatients);
  assert.equal(f.server.workspaces.store.list().length, beforeWorkspaces);
  f.server.store.db.exec("DROP TRIGGER reject_create_status");
  const applied = await f.json(
    `/api/pending-actions/${proposal.id}/confirm`,
    "POST",
  );
  assert.equal(applied.status, 200);
  assert.equal(applied.data.applied.diagnoses[0].name, "合成诊断");
  assert.equal(f.server.patients.all().length, beforePatients + 1);
  assert.equal(f.server.workspaces.store.list().length, beforeWorkspaces + 1);
});

test("new patient clinical data is validated before proposal; old invalid payload cannot partly create", async (t) => {
  const f = await fixture(t),
    tool = f.server.runtime.toolPlugins.get("patient_create_propose");
  assert.throws(
    () =>
      tool.execute({
        name: "合成无效建档",
        labs: [{ item: "合成检验", value: "not-number", date: "2026-09-21" }],
        summary: "无效",
      }),
    { code: "INVALID_INPUT" },
  );
  const p = tool.execute({ name: "合成旧无效建档", summary: "旧无效" });
  f.server.store.db
    .prepare("UPDATE pending_actions SET payload=? WHERE id=?")
    .run(
      JSON.stringify({
        name: "合成旧无效建档",
        labs: [{ item: "合成检验", value: "not-number", date: "2026-09-21" }],
      }),
      p.id,
    );
  const before = f.server.patients.all().length,
    beforeWorkspaces = f.server.workspaces.store.list().length;
  assert.equal(
    (await f.json(`/api/pending-actions/${p.id}/confirm`, "POST")).status,
    400,
  );
  assert.equal(f.server.patients.all().length, before);
  assert.equal(f.server.workspaces.store.list().length, beforeWorkspaces);
});

test("legacy proposal migration keeps unknown baseline null and fresh baseline survives reload", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pending-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "synthetic.sqlite");
  let store = new Store(file);
  const patient = new PatientRegistry(store, {}).create({
    name: "合成迁移患者",
  });
  store.close();
  const old = new DatabaseSync(file);
  old.exec(
    "ALTER TABLE pending_actions DROP COLUMN base_revision; UPDATE meta SET value='6' WHERE key='schema_version'",
  );
  old
    .prepare("INSERT INTO pending_actions VALUES (?,?,?,?,?,?,?,?)")
    .run(
      "legacy-proposal",
      "patient-update",
      patient.id,
      "pending",
      JSON.stringify({ allergies: ["旧提案过敏"] }),
      "合成旧提案",
      "2026-01-01",
      "2026-01-01",
    );
  old.close();
  store = new Store(file);
  let patients = new PatientRegistry(store, {});
  let pending = new PendingActions(store, { patients: () => patients });
  assert.equal(pending.row("legacy-proposal").baseRevision, null);
  assert.throws(() => pending.confirm("legacy-proposal"), {
    code: "ACTION_CONFLICT",
    status: 409,
  });
  assert.deepEqual(patients.row(patient.id).allergies, []);
  const fresh = pending.propose({
    type: "patient-update",
    patientId: patient.id,
    payload: { allergies: ["新版过敏"] },
    summary: "合成新版提案",
  });
  assert.equal(fresh.baseRevision, patient.revision);
  store.close();
  store = new Store(file);
  t.after(() => store.close());
  patients = new PatientRegistry(store, {});
  pending = new PendingActions(store, { patients: () => patients });
  assert.equal(pending.row(fresh.id).baseRevision, patient.revision);
  pending.confirm(fresh.id);
  assert.deepEqual(patients.row(patient.id).allergies, ["新版过敏"]);
  assert.equal(pending.row("legacy-proposal").status, "pending");
});

test("nested patient creation confirmation joins caller transaction without committing it", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const workspaces = new WorkspaceStore(store.db);
  const patients = new PatientRegistry(
    store,
    {},
    {
      createSession: ({ title, patientId }) => {
        const w = workspaces.create({
          title,
          patientId,
          kind: "session",
          root: "/synthetic-owned-root",
          permissions: {},
        });
        workspaces.update(w.id, (value) => {
          value.title += " configured";
        });
        return w;
      },
    },
  );
  const pending = new PendingActions(store, { patients: () => patients });
  const proposal = pending.propose({
    type: "patient-create",
    payload: { name: "合成外层事务", allergies: ["合成"] },
    summary: "事务",
  });
  store.db.exec("BEGIN IMMEDIATE");
  pending.confirm(proposal.id);
  assert.equal(store.db.isTransaction, true);
  assert.equal(patients.all().length, 1);
  store.db.exec("ROLLBACK");
  assert.equal(patients.all().length, 0);
  assert.equal(workspaces.list().length, 0);
  assert.equal(pending.row(proposal.id).status, "pending");
  pending.confirm(proposal.id);
  assert.equal(patients.all().length, 1);
  const legacy = store.create({ title: "旧引擎合成会话" });
  store.db.exec("BEGIN IMMEDIATE");
  store.mutate(legacy.id, (value) => {
    value.title = "应回滚";
  });
  assert.equal(store.db.isTransaction, true);
  store.db.exec("ROLLBACK");
  assert.equal(store.get(legacy.id).title, "旧引擎合成会话");
});
