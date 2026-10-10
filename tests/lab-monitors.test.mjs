import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

const patientWithLabs = async (f, labs) => {
  const patient = (await f.json("/api/patients", "POST", { name: "监测患者" })).data;
  const updated = await f.json(`/api/patients/${patient.id}`, "PATCH", {
    expectedRevision: 0,
    labs,
  });
  assert.equal(updated.status, 200);
  return patient;
};

test("lab monitor fires on threshold breach, resolves when back in range", async (t) => {
  const f = await fixture(t);
  const patient = await patientWithLabs(f, [
    { item: "血钾", value: 5.6, unit: "mmol/L", date: "2026-10-01" },
  ]);
  const created = await f.json(`/api/patients/${patient.id}/lab-monitors`, "POST", {
    item: "血钾",
    op: "gt",
    threshold: 5.2,
    severity: "critical",
    note: "化疗相关高钾关注",
  });
  assert.equal(created.status, 201);
  const monitor = created.data;
  // CRUD 本身即触发评估：告警应已存在。
  let alerts = (await f.json("/api/risk-alerts?status=active")).data.alerts;
  let mine = alerts.filter((a) => a.ruleKey === `lab_monitor_${monitor.id}`);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].severity, "critical");
  assert.match(mine[0].message, /5\.6/);
  assert.match(mine[0].message, /高于监测阈值 5\.2/);
  // 数值回落 → auto-resolve。
  const current = (await f.json(`/api/patients/${patient.id}`)).data;
  await f.json(`/api/patients/${patient.id}`, "PATCH", {
    expectedRevision: current.revision,
    labs: [{ item: "血钾", value: 4.2, unit: "mmol/L", date: "2026-10-09" }],
  });
  const all = (await f.json(`/api/risk-alerts?patientId=${patient.id}`)).data.alerts;
  const resolved = all.find((a) => a.ruleKey === `lab_monitor_${monitor.id}`);
  assert.equal(resolved.status, "resolved");
  assert.ok(resolved.autoResolved);
});

test("lab monitor recheck interval raises a due alert and clears after new lab", async (t) => {
  const f = await fixture(t);
  const patient = await patientWithLabs(f, [
    { item: "糖化血红蛋白", value: 7.1, unit: "%", date: "2026-06-01" },
  ]);
  const monitor = (
    await f.json(`/api/patients/${patient.id}/lab-monitors`, "POST", {
      item: "血红蛋白",
      op: "gt",
      threshold: 999,
      recheckDays: 30,
    })
  ).data;
  await f.json("/api/risk-alerts/evaluate", "POST");
  let alerts = (await f.json(`/api/risk-alerts?patientId=${patient.id}`)).data.alerts;
  const due = alerts.find((a) => a.ruleKey === `lab_monitor_${monitor.id}`);
  assert.ok(due, "复查到期应触发告警");
  assert.match(due.title, /复查到期/);
  assert.match(due.message, /2026-06-01/);
  // 补一次新检验 → 到期告警解除。
  const current = (await f.json(`/api/patients/${patient.id}`)).data;
  await f.json(`/api/patients/${patient.id}`, "PATCH", {
    expectedRevision: current.revision,
    labs: [
      { item: "糖化血红蛋白", value: 7.1, unit: "%", date: "2026-06-01" },
      { item: "糖化血红蛋白", value: 6.8, unit: "%", date: "2026-10-09" },
    ],
  });
  alerts = (await f.json(`/api/risk-alerts?patientId=${patient.id}`)).data.alerts;
  assert.equal(
    alerts.find((a) => a.ruleKey === `lab_monitor_${monitor.id}`).status,
    "resolved",
  );
});

test("lab monitor respects pause, revision conflicts and deletion", async (t) => {
  const f = await fixture(t);
  const patient = await patientWithLabs(f, [
    { item: "血钾", value: 2.1, unit: "mmol/L", date: "2026-10-01" },
  ]);
  const monitor = (
    await f.json(`/api/patients/${patient.id}/lab-monitors`, "POST", {
      item: "血钾",
      op: "lt",
      threshold: 3,
    })
  ).data;
  // 暂停后不再触发。
  const paused = await f.json(
    `/api/patients/${patient.id}/lab-monitors/${monitor.id}`,
    "PATCH",
    { revision: monitor.revision, status: "paused" },
  );
  assert.equal(paused.status, 200);
  assert.equal(paused.data.status, "paused");
  await f.json("/api/risk-alerts/evaluate", "POST");
  let keys = (await f.json(`/api/risk-alerts?patientId=${patient.id}`)).data.alerts
    .filter((a) => a.status === "active")
    .map((a) => a.ruleKey);
  assert.ok(!keys.includes(`lab_monitor_${monitor.id}`));
  // revision 冲突拒绝。
  const conflict = await f.json(
    `/api/patients/${patient.id}/lab-monitors/${monitor.id}`,
    "PATCH",
    { revision: 0, status: "active" },
  );
  assert.equal(conflict.status, 409);
  // 恢复并删除。
  const resumed = await f.json(
    `/api/patients/${patient.id}/lab-monitors/${monitor.id}`,
    "PATCH",
    { revision: paused.data.revision, status: "active" },
  );
  assert.equal(resumed.status, 200);
  keys = (await f.json(`/api/risk-alerts?status=active`)).data.alerts.map(
    (a) => a.ruleKey,
  );
  assert.ok(keys.includes(`lab_monitor_${monitor.id}`));
  const del = await f.json(
    `/api/patients/${patient.id}/lab-monitors/${monitor.id}`,
    "DELETE",
    { revision: resumed.data.revision },
  );
  assert.equal(del.status, 200);
  const list = (await f.json(`/api/patients/${patient.id}/lab-monitors`)).data.monitors;
  assert.equal(list.length, 0);
});

test("lab monitor validation and matching boundaries", async (t) => {
  const f = await fixture(t);
  const patient = await patientWithLabs(f, [
    { item: "血钾", value: 4.0, unit: "mmol/L", date: "2026-10-01" },
  ]);
  const badOp = await f.json(`/api/patients/${patient.id}/lab-monitors`, "POST", {
    item: "血钾",
    op: "gte",
    threshold: 5,
  });
  assert.equal(badOp.status, 400);
  const badThreshold = await f.json(
    `/api/patients/${patient.id}/lab-monitors`,
    "POST",
    { item: "血钾", op: "gt", threshold: "很高" },
  );
  assert.equal(badThreshold.status, 400);
  const badRecheck = await f.json(
    `/api/patients/${patient.id}/lab-monitors`,
    "POST",
    { item: "血钾", op: "gt", threshold: 5, recheckDays: 0 },
  );
  assert.equal(badRecheck.status, 400);
  // 模糊匹配：监测「钾」可命中「血钾」；数值未越界时不触发。
  const monitor = (
    await f.json(`/api/patients/${patient.id}/lab-monitors`, "POST", {
      item: "钾",
      op: "gt",
      threshold: 5,
    })
  ).data;
  const alerts = (await f.json(`/api/risk-alerts?patientId=${patient.id}`)).data
    .alerts;
  assert.equal(
    alerts.filter((a) => a.ruleKey === `lab_monitor_${monitor.id}` && a.status === "active")
      .length,
    0,
  );
  // 404：他人患者的监测不可改。
  const stranger = (await f.json("/api/patients", "POST", { name: "别人" })).data;
  const cross = await f.json(
    `/api/patients/${stranger.id}/lab-monitors/${monitor.id}`,
    "PATCH",
    { revision: 0, status: "paused" },
  );
  assert.equal(cross.status, 404);
});
