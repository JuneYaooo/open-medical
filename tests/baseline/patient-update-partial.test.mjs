import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createScriptedProvider } from "../helpers/scripted-provider.mjs";
import { startTestServer } from "../helpers/server.mjs";

test("档案更新提案可只确认勾选的分区，且不能借 payload 改写内容", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]) });
  t.after(() => app.close());
  const [patient] = await app.patients();
  const before = (await app.request(`/api/patients/${patient.id}`)).body;

  const payload = {
    clinicalSummary: { text: "部分确认测试摘要", source: "医生补充" },
    allergyStatus: "none_known",
    medications: [{ name: "部分确认测试药", dose: "1 片", frequency: "每日一次", status: "active" }],
  };
  const id = `act_${randomUUID()}`;
  const now = new Date().toISOString();
  const db = new DatabaseSync(app.databasePath);
  db.prepare("INSERT INTO pending_actions(id,type,patient_id,base_revision,status,payload,summary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "patient-update", patient.id, before.revision, "pending", JSON.stringify(payload), "部分确认测试", now, now);
  db.close();

  const tampered = await app.request(`/api/pending-actions/${id}/confirm`, {
    method: "POST",
    body: { payload: { clinicalSummary: { text: "被改写的摘要", source: "医生补充" } } },
  });
  assert.equal(tampered.status, 400);
  const added = await app.request(`/api/pending-actions/${id}/confirm`, {
    method: "POST",
    body: { payload: { name: "新名字" } },
  });
  assert.equal(added.status, 400);

  const confirm = await app.request(`/api/pending-actions/${id}/confirm`, {
    method: "POST",
    body: { payload: { clinicalSummary: payload.clinicalSummary } },
  });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  assert.equal(confirm.body.action.status, "applied");

  const after = (await app.request(`/api/patients/${patient.id}`)).body;
  assert.equal(after.clinicalSummary.text, "部分确认测试摘要");
  assert.ok(!(after.medications || []).some((m) => m.name === "部分确认测试药"), "未勾选的用药不应写入");
  assert.equal(after.allergyStatus, before.allergyStatus);
});
