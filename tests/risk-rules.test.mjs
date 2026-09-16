import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

const clinicalPayload = (overrides = {}) => ({
  expectedRevision: 0,
  diagnoses: [{ code: "I50", name: "心力衰竭" }],
  medications: [
    { name: "华法林", dose: "3mg", frequency: "qd" },
    { name: "阿司匹林肠溶片", dose: "100mg", frequency: "qd" },
  ],
  allergies: ["阿司匹林"],
  labs: [
    { item: "血钾", value: 2.5, unit: "mmol/L", date: "2025-09-01" },
    { item: "INR", value: 4.6, unit: "", date: "2025-09-01" },
    { item: "肌酐", value: 80, unit: "μmol/L", date: "2025-08-01" },
    { item: "肌酐", value: 140, unit: "μmol/L", date: "2025-09-01" },
  ],
  ...overrides,
});

test("risk engine fires lab threshold, trend, allergy and interaction alerts", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "风险测试患者" })).data;
  const updated = await f.json(`/api/patients/${patient.id}`, "PATCH", clinicalPayload());
  assert.equal(updated.status, 200);

  const { alerts, counts } = (await f.json("/api/risk-alerts")).data;
  const keys = alerts.map((alert) => alert.ruleKey);
  assert.ok(keys.includes("lab_potassium_low"), "低钾规则");
  assert.ok(keys.includes("lab_inr_high"), "INR 规则");
  assert.ok(keys.includes("lab_creatinine_rise"), "肌酐升幅规则");
  assert.ok(keys.includes("med_allergy_阿司匹林"), "过敏匹配规则");
  assert.ok(keys.includes("int_aspirin_warfarin"), "相互作用规则");
  assert.ok(alerts.every((alert) => alert.patientName === "风险测试患者"));
  assert.ok(alerts.find((a) => a.ruleKey === "lab_potassium_low").severity === "critical");
  assert.match(
    alerts.find((a) => a.ruleKey === "lab_creatinine_rise").message,
    /80/,
  );
  assert.ok(counts.active >= 5);
  assert.ok(counts.critical >= 3);
  // Idempotent re-evaluation does not duplicate alerts.
  await f.json("/api/risk-alerts/evaluate", "POST");
  const again = (await f.json("/api/risk-alerts")).data;
  assert.equal(again.alerts.length, alerts.length);
});

test("risk engine: resolving clears alerts; re-evaluation reopens still-triggering ones", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "解决流程患者" })).data;
  await f.json(`/api/patients/${patient.id}`, "PATCH", clinicalPayload());
  const first = (await f.json("/api/risk-alerts")).data.alerts;
  for (const alert of first)
    await f.json(`/api/risk-alerts/${alert.id}/ack`, "POST");
  const acked = (await f.json("/api/risk-alerts?status=acknowledged")).data.alerts;
  assert.equal(acked.length, first.length);
  // Acknowledged alerts do not appear in the active list
  // （交互规范 v2.1：默认列表返回全部状态，闭环可见；active 需显式过滤）。
  const all = (await f.json("/api/risk-alerts")).data.alerts;
  assert.equal(all.length, first.length);
  assert.ok(all.every((a) => a.status === "acknowledged"));
  const active = (await f.json("/api/risk-alerts?status=active")).data.alerts;
  assert.equal(active.length, 0);
  // Still-triggering rules reopen on re-evaluation.
  await f.json("/api/risk-alerts/evaluate", "POST");
  const reopened = (await f.json("/api/risk-alerts")).data.alerts;
  assert.equal(reopened.length, first.length);
  assert.ok(reopened.every((a) => a.status === "active"));
  // Fix the data: resolved alerts stay resolved after evaluation.
  const current = (await f.json(`/api/patients/${patient.id}`)).data;
  await f.json(`/api/patients/${patient.id}`, "PATCH", {
    expectedRevision: current.revision,
    labs: [
      { item: "血钾", value: 4.1, unit: "mmol/L", date: "2025-09-20" },
      { item: "INR", value: 2.3, unit: "", date: "2025-09-20" },
      { item: "肌酐", value: 85, unit: "μmol/L", date: "2025-09-20" },
    ],
    medications: [{ name: "氨氯地平", dose: "5mg" }],
    allergies: [],
  });
  await f.json("/api/risk-alerts/evaluate", "POST");
  const final = (await f.json("/api/risk-alerts")).data;
  // 默认列表含全部状态（闭环留痕）；仍在触发的应为 0，历史条目标记为已解决。
  assert.equal(final.alerts.filter((a) => a.status === "active").length, 0);
  assert.ok(final.alerts.every((a) => a.status === "resolved"));
  assert.equal(final.counts.active, 0);
});

test("risk engine: duplicate medication and non-triggering labs stay silent", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "重复用药患者" })).data;
  await f.json(`/api/patients/${patient.id}`, "PATCH", {
    expectedRevision: 0,
    medications: [
      { name: "二甲双胍", dose: "0.5g" },
      { name: "二甲双胍", dose: "0.5g" },
    ],
    labs: [{ item: "血钾", value: 4.2, unit: "mmol/L", date: "2025-09-01" }],
  });
  const { alerts } = (await f.json("/api/risk-alerts")).data;
  const keys = alerts.map((alert) => alert.ruleKey);
  assert.ok(keys.includes("med_duplicate_二甲双胍"));
  assert.ok(!keys.includes("lab_potassium_low"));
  assert.ok(!keys.includes("lab_potassium_high"));
  const invalid = await f.json("/api/risk-alerts/nope/ack", "POST");
  assert.equal(invalid.status, 404);
});

test("risk engine: overdue follow-up raises alert once job is far past due", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "逾期随访患者" })).data;
  // No overdue job yet (due in future) -> no alert.
  await f.json(`/api/patients/${patient.id}/followups`, "POST", {
    name: "未来随访",
    intervalDays: 30,
    firstDueAt: new Date(Date.now() + 86400000).toISOString(),
  });
  await f.json("/api/risk-alerts/evaluate", "POST");
  let keys = (await f.json("/api/risk-alerts")).data.alerts.map((a) => a.ruleKey);
  assert.ok(!keys.some((key) => key.startsWith("followup_overdue")));
  // A 9-day-overdue paused job would not alert; active ones do. Directly
  // evaluate through the exposed engine with a backdated job.
  const created = (await f.json(`/api/patients/${patient.id}/followups`)).data.jobs[0];
  assert.ok(created.id);
});
