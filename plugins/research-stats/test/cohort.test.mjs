import test from "node:test";
import assert from "node:assert/strict";
import { createScriptedProvider } from "../../../tests/helpers/scripted-provider.mjs";
import { startTestServer } from "../../../tests/helpers/server.mjs";

const T2DM = { label: "2型糖尿病", kind: "include", field: "diagnosis", terms: ["2型糖尿病"] };
const MET = { label: "二甲双胍", field: "medication", terms: ["二甲双胍"] };
const COMPARISON = {
  title: "二甲双胍与 HbA1c",
  groups: [
    { label: "使用", spec: { title: "使用", conditions: [T2DM, { ...MET, kind: "include" }] } },
    { label: "未使用", spec: { title: "未使用", conditions: [T2DM, { ...MET, kind: "exclude" }] } },
  ],
  outcome: { type: "lab", label: "HbA1c", items: ["HbA1c"], unit: "%", use: "latest" },
};

async function seed(app) {
  const year = new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);
  const inputs = [
    { name: "孙一", phone: "13700000001", patientNumber: "MRN-001", gender: "male", birthYear: year - 61, diagnoses: [{ name: "2型糖尿病", date: "2024-01-01" }], medications: [{ name: "二甲双胍", status: "active" }], labs: [{ item: "HbA1c", value: 7.2, unit: "%", date: today }] },
    { name: "周二", phone: "13700000002", patientNumber: "MRN-002", gender: "female", birthYear: year - 95, diagnoses: [{ name: "2型糖尿病", date: "2024-01-01" }], medications: [{ name: "格列美脲", status: "active" }], labs: [{ item: "HbA1c", value: 64, unit: "mmol/mol", date: today }] },
    { name: "吴三", gender: "male", birthYear: year - 50, diagnoses: [{ name: "高血压", date: "2024-01-01" }] },
  ];
  for (const input of inputs) {
    const created = await app.request("/api/patients", { method: "POST", body: input });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
}

test("research-stats：本机患者库概况只有计数，没有逐人数据", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]), seedDemoPack: false });
  t.after(() => app.close());
  await seed(app);
  const summary = await app.request("/api/research/dictionary-summary");
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.patients, 3);
  assert.equal(summary.body.coverage.labs.patients, 2);
  assert.deepEqual(summary.body.topDiagnoses[0], { name: "2型糖尿病", patients: 2 });
  assert.ok(summary.body.topLabs.some((lab) => lab.name === "HbA1c" && lab.units.includes("%")));
  const text = JSON.stringify(summary.body);
  assert.ok(!/孙一|周二|吴三|1370000|MRN-/.test(text));
});

test("research-stats：导出脱敏队列 CSV 只含假名、组别、年龄、性别与结局", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]), seedDemoPack: false });
  t.after(() => app.close());
  await seed(app);
  const exported = await app.request("/api/research/cohort-export", { method: "POST", body: { comparison: COMPARISON } });
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  const lines = exported.body.csv.split("\n");
  assert.equal(lines[0], "subject,group,age,sex,outcome,outcome_missing");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^S_[0-9a-f]{12},使用,61,男,7\.2,$/);
  assert.match(lines[2], /^S_[0-9a-f]{12},未使用,90,女,,单位不同$/, "≥90 岁记为 90；单位不同为缺失而非 0");
  assert.ok(!/孙一|周二|吴三|1370000|MRN-|\d{4}-\d{2}-\d{2}/.test(exported.body.csv), "不含姓名、电话、病历号或日期");
  const again = await app.request("/api/research/cohort-export", { method: "POST", body: { comparison: COMPARISON } });
  assert.notEqual(again.body.csv.split("\n")[1].slice(0, 14), lines[1].slice(0, 14), "每次导出的假名不同，不能跨文件关联");
  const bad = await app.request("/api/research/cohort-export", { method: "POST", body: { comparison: { ...COMPARISON, groups: [] } } });
  assert.equal(bad.status, 400);
});

test("research-stats：停用插件后概况与导出接口 404", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]), seedDemoPack: false });
  t.after(() => app.close());
  const disabled = await app.request("/api/plugins/research-stats", { method: "PUT", body: { enabled: false } });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal((await app.request("/api/research/dictionary-summary")).status, 404);
  assert.equal((await app.request("/api/research/cohort-export", { method: "POST", body: { comparison: COMPARISON } })).status, 404);
});
