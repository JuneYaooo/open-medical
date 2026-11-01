import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePatient, normalizeCohortSpec, runCohortQuery } from "../../server/medical/cohort-query.mjs";
import { SESSION_TOOL_GROUPS } from "../../server/medical/medical-workspace-domain.mjs";
import { createScriptedProvider, textTurn, toolCall } from "../helpers/scripted-provider.mjs";
import { startTestServer } from "../helpers/server.mjs";

const NOW = Date.parse("2026-10-31T00:00:00Z");
const SPEC = {
  title: "HbA1c 控制不佳的 2 型糖尿病",
  conditions: [
    { label: "2型糖尿病", kind: "include", field: "diagnosis", terms: ["2型糖尿病", "T2DM"], codes: ["E11"] },
    { label: "近半年 HbA1c ≥ 8%", kind: "include", field: "lab", items: ["HbA1c"], op: "gte", value: 8, unit: "%", withinDays: 180 },
    { label: "未使用胰岛素", kind: "exclude", field: "medication", terms: ["胰岛素", "insulin"] },
    { label: "40–75 岁", kind: "include", field: "age", min: 40, max: 75 },
  ],
};
const patient = (id, extra) => ({ id, name: `患者${id}`, phone: "13900000000", birthYear: 1960, gender: "male", diagnoses: [{ name: "2型糖尿病", code: "E11.9", status: "confirmed" }], medications: [{ name: "二甲双胍", status: "active" }], labs: [{ item: "糖化血红蛋白", value: 8.6, unit: "%", date: "2026-09-01" }], ...extra });

test("自然语言条件：全部符合、触发排除、缺资料待核对分别判断", () => {
  const spec = normalizeCohortSpec(SPEC);
  assert.equal(evaluatePatient(spec, patient("a"), NOW).status, "match", "检验项目别名（糖化血红蛋白 / HbA1c）应互认");
  const insulin = evaluatePatient(spec, patient("b", { medications: [{ name: "胰岛素 glargine", status: "active" }] }), NOW);
  assert.equal(insulin.status, "mismatch");
  assert.equal(insulin.results[2].verdict, "not_met");
  const noLab = evaluatePatient(spec, patient("c", { labs: [] }), NOW);
  assert.equal(noLab.status, "unclear", "没有检验是待核对，不是不符合");
  const oldLab = evaluatePatient(spec, patient("d", { labs: [{ item: "HbA1c", value: 9, unit: "%", date: "2025-01-01" }] }), NOW);
  assert.equal(oldLab.status, "unclear");
  assert.match(oldLab.results[1].evidence, /近 180 天/);
});

test("单位不同不换算、同日冲突不替医生选、只有出生年份时边界待核对", () => {
  const spec = normalizeCohortSpec(SPEC);
  const unit = evaluatePatient(spec, patient("a", { labs: [{ item: "HbA1c", value: 70, unit: "mmol/mol", date: "2026-10-01" }] }), NOW);
  assert.equal(unit.results[1].verdict, "unknown");
  assert.match(unit.results[1].evidence, /单位/);
  const conflict = evaluatePatient(spec, patient("b", { labs: [{ item: "HbA1c", value: 7.5, unit: "%", date: "2026-10-01" }, { item: "HbA1c", value: 8.5, unit: "%", date: "2026-10-01" }] }), NOW);
  assert.equal(conflict.results[1].verdict, "unknown");
  const boundary = evaluatePatient(spec, patient("c", { birthYear: 1950 }), NOW);
  assert.equal(boundary.results[3].verdict, "unknown", "2026 年时 1950 年生可能 75 或 76 岁");
  assert.equal(evaluatePatient(spec, patient("d", { birthYear: 1949 }), NOW).results[3].verdict, "not_met");
  const noDiagnosis = evaluatePatient(spec, patient("e", { diagnoses: [] }), NOW);
  assert.equal(noDiagnosis.results[0].verdict, "unknown", "没有任何诊断记录时待核对");
});

test("条件不合法时指出第几条", () => {
  assert.throws(() => normalizeCohortSpec({ title: "x", conditions: [{ label: "a", kind: "include", field: "lab", items: ["HbA1c"], op: "gte" }] }), /第 1 条条件需要比较数值/);
  assert.throws(() => normalizeCohortSpec({ title: "x", conditions: [] }), { code: "COHORT_SPEC" });
});

test("队列计数与名单：默认不列不符合，归档患者默认不计", () => {
  const rows = [patient("a"), patient("b", { labs: [] }), patient("c", { gender: "female", medications: [{ name: "insulin", status: "active" }] }), patient("d", { archived: true })];
  const result = runCohortQuery(rows, SPEC, { now: NOW });
  assert.deepEqual(result.counts, { total: 3, match: 1, unclear: 1, mismatch: 1 });
  assert.deepEqual(result.rows.map((r) => r.patientId), ["a", "b"]);
  assert.equal(result.perCondition[1].unknown, 1);
});

test("按条件找患者工具按需开启：提到筛选、试验、统计时列出", () => {
  const group = SESSION_TOOL_GROUPS.find((g) => g.id === "cohort");
  assert.deepEqual(group.names, ["cohort_query"]);
  for (const text of ["找出糖化血红蛋白高于8的患者", "哪些患者适合这个试验", "统计一下高血压患者"]) assert.ok(group.when.test(text), text);
  assert.ok(!group.when.test("血钾偏低要注意什么"));
});

test("助手用一句话筛患者：模型只拿到编号和依据，界面接口返回姓名", async (t) => {
  const provider = createScriptedProvider([toolCall("cohort_query", SPEC, "call_cohort"), textTurn("已按条件筛选。")]);
  const app = await startTestServer({ provider, seedDemoPack: false });
  t.after(() => app.close());
  const year = new Date().getFullYear();
  for (const input of [
    { name: "赵一", gender: "male", birthYear: year - 60, diagnoses: [{ name: "2型糖尿病", date: "2024-01-01" }], medications: [{ name: "二甲双胍", status: "active" }], labs: [{ item: "HbA1c", value: 8.8, unit: "%", date: new Date().toISOString().slice(0, 10) }] },
    { name: "钱二", gender: "female", birthYear: year - 55, diagnoses: [{ name: "高血压", date: "2024-01-01" }] },
  ]) {
    const created = await app.request("/api/patients", { method: "POST", body: input });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
  const session = await app.request("/api/assistant/session", { method: "POST", body: {} });
  const response = await app.request("/api/agent/run", {
    method: "POST",
    body: { sessionId: session.body.id, message: "找出糖化血红蛋白控制不佳的2型糖尿病患者", mode: "model", externalConsent: true },
  });
  assert.equal(response.body.status, "completed", JSON.stringify(response.body));
  assert.ok(provider.calls[0].tools.some((tool) => tool.function.name === "cohort_query"), "筛选类提问应列出 cohort_query");
  const reply = provider.calls.at(-1).messages.find((m) => m.role === "tool" && m.tool_call_id === "call_cohort").content;
  const parsed = JSON.parse(reply);
  assert.equal(parsed.type, "patient_cohort");
  assert.deepEqual(parsed.counts, { total: 2, match: 1, unclear: 0, mismatch: 1 });
  assert.ok(!reply.includes("赵一") && !reply.includes("钱二"), "模型看到的结果不含姓名");
  const detail = await app.request(`/api/sessions/${session.body.id}`);
  const artifact = JSON.stringify(detail.body).includes("patient_cohort");
  assert.ok(artifact, "结果保存为本次任务的成果");
  const ui = await app.request("/api/cohort/query", { method: "POST", body: { spec: SPEC } });
  assert.equal(ui.status, 200);
  assert.equal(ui.body.rows[0].name, "赵一");
});
