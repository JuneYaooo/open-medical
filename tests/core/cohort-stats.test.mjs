import test from "node:test";
import assert from "node:assert/strict";
import { compareCohorts, normalizeComparison } from "../../server/medical/cohort-stats.mjs";
import {
  chiSquare,
  fisherExact2x2,
  kruskalWallis,
  oneWayAnova,
  tQuantile,
  welchTTest,
  wilsonInterval,
} from "../../server/medical/stats-math.mjs";
import { SESSION_TOOL_GROUPS } from "../../server/medical/medical-workspace-domain.mjs";
import { createScriptedProvider, textTurn, toolCall } from "../helpers/scripted-provider.mjs";
import { startTestServer } from "../helpers/server.mjs";

const NOW = Date.parse("2026-10-31T00:00:00Z");
const close = (actual, expected, tolerance = 1e-4) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);

test("统计学基础：与 R 的已知结果一致", () => {
  // R: t.test(c(1,2,3,4,5), c(2,4,6,8,10)) → t = -1.8974, df = 5.8824, p = 0.1075
  const t = welchTTest([[1, 2, 3, 4, 5], [2, 4, 6, 8, 10]]);
  close(t.t, -1.897367);
  close(t.df, 5.882353);
  close(t.p, 0.107531);
  close(tQuantile(10), 2.228139); // qt(0.975, 10)
  close(tQuantile(5.882353), 2.458824, 1e-3);
  // chisq.test(matrix(c(10,20,20,10),2), correct=FALSE) → X² = 6.6667, p = 0.009823
  const chi = chiSquare([[10, 20], [20, 10]]);
  close(chi.chi2, 6.666667);
  close(chi.p, 0.009823);
  close(fisherExact2x2([[3, 1], [1, 3]]).p, 0.485714); // 品茶实验
  // aov / kruskal.test：1:3, 4:6, 7:9 → F = 27, p = 0.001；H = 7.2, p = 0.02732
  const anova = oneWayAnova([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  close(anova.f, 27);
  close(anova.p, 0.001);
  const kw = kruskalWallis([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  close(kw.h, 7.2);
  close(kw.p, 0.027324);
  const [lo, hi] = wilsonInterval(5, 10);
  close(lo, 0.236593);
  close(hi, 0.763407);
});

const T2DM = { label: "2型糖尿病", kind: "include", field: "diagnosis", terms: ["2型糖尿病", "T2DM"], codes: ["E11"] };
const METFORMIN = { label: "二甲双胍", field: "medication", terms: ["二甲双胍", "metformin"] };
const COMPARE = {
  title: "二甲双胍与 HbA1c",
  question: "比较用和不用二甲双胍的 2 型糖尿病患者最近一次 HbA1c",
  groups: [
    { label: "使用二甲双胍", spec: { title: "使用二甲双胍", conditions: [T2DM, { ...METFORMIN, kind: "include" }] } },
    { label: "未使用二甲双胍", spec: { title: "未使用二甲双胍", conditions: [T2DM, { ...METFORMIN, kind: "exclude" }] } },
  ],
  outcome: { type: "lab", label: "最近一次 HbA1c（%）", items: ["HbA1c"], unit: "%", use: "latest" },
};
let seq = 0;
const person = ({ med = "二甲双胍", labs = [], ...extra } = {}) => ({
  id: `p${++seq}`,
  name: `患者${seq}`,
  phone: "13900000000",
  gender: "male",
  birthYear: 1960,
  diagnoses: [{ name: "2型糖尿病", code: "E11.9", status: "confirmed" }],
  medications: med ? [{ name: med, status: "active" }] : [{ name: "阿托伐他汀", status: "active" }],
  labs,
  ...extra,
});
const hba1c = (value, date = "2026-09-01", unit = "%") => ({ item: "糖化血红蛋白", value, unit, date });

function roster() {
  seq = 0;
  return [
    ...[6, 7, 8, 9, 10].map((v) => person({ labs: [hba1c(9.9, "2026-01-01"), hba1c(v)] })),
    ...[7, 9, 11, 13, 15].map((v) => person({ med: null, labs: [hba1c(v)] })),
    person({ labs: [hba1c(64, "2026-09-01", "mmol/mol")] }), // 单位不同 → 结局缺失
    person({ med: null, labs: [] }), // 无检验 → 结局缺失
    person({ labs: [hba1c(7.1), hba1c(7.9)] }), // 同日冲突 → 结局缺失
    person({ medications: [] }), // 无用药记录 → 两组都待核对
    person({ diagnoses: [{ name: "高血压", code: "I10" }] }), // 不符合任何组
    person({ archived: true, labs: [hba1c(5)] }), // 已归档默认不计
  ];
}

test("数值结局两组：Welch t + Mann-Whitney，均差 95% CI，缺失按原因计数", () => {
  const result = compareCohorts(roster(), COMPARE, { now: NOW });
  assert.equal(result.population.total, 15);
  const [a, b] = result.groups;
  assert.equal(a.matched, 7);
  assert.equal(a.analyzed, 5);
  assert.deepEqual(a.outcomeMissing.map((m) => [m.reason, m.count]).sort(), [["same_day_conflict", 1], ["unit", 1]]);
  assert.equal(b.matched, 6);
  assert.equal(b.analyzed, 5);
  assert.deepEqual(b.outcomeMissing, [{ reason: "no_record", label: "没有该检验记录", count: 1 }]);
  assert.equal(a.excludedUnclear.count, 1, "无用药记录：待核对，不计入任何组");
  assert.equal(b.excludedUnclear.count, 1);
  assert.equal(a.summary.mean, 8, "取最近一次，不取更早的 9.9");
  assert.equal(a.summary.median, 8);
  assert.equal(b.summary.sd, 3.1623);
  const welch = result.tests.find((t) => t.method === "welch-t");
  assert.ok(welch.primary);
  close(welch.p, 0.107531);
  assert.ok(result.tests.some((t) => t.method === "mann-whitney"));
  assert.equal(result.effect.estimate, -3);
  close(result.effect.ci95[0], -6.8877, 1e-3);
  close(result.effect.ci95[1], 0.8877, 1e-3);
  assert.ok(result.warnings.some((w) => /混杂/.test(w)));
  assert.ok(result.warnings.some((w) => /最小组只有 5 例/.test(w)));
  const text = JSON.stringify(result);
  assert.ok(!/患者\d|13900000000/.test(text), "结果只有汇总，不含姓名电话");
});

test("同时符合多组的患者排除并报告；第 2 项分析提示多重比较", () => {
  const overlapping = {
    ...COMPARE,
    groups: [
      { label: "糖尿病", spec: { title: "糖尿病", conditions: [T2DM] } },
      { label: "二甲双胍", spec: { title: "二甲双胍", conditions: [{ ...METFORMIN, kind: "include" }] } },
    ],
  };
  const result = compareCohorts(roster(), overlapping, { now: NOW, analysisNumber: 2 });
  assert.equal(result.population.overlapExcluded, 7);
  assert.deepEqual(result.population.overlapPairs, { "糖尿病 + 二甲双胍": 7 });
  assert.ok(result.warnings.some((w) => /同时符合多组/.test(w)));
  assert.ok(result.warnings.some((w) => /第 2 项统计分析.*0\.025/.test(w)));
});

test("二分类结局：期望频数小用 Fisher，给率差与 OR；未记录按否计会提示", () => {
  const rows = roster().map((p, i) => (i < 4 ? { ...p, diagnoses: [...p.diagnoses, { name: "糖尿病肾病", code: "E11.2" }] } : p));
  const result = compareCohorts(rows, { ...COMPARE, outcome: { type: "condition", label: "合并糖尿病肾病", condition: { label: "糖尿病肾病", field: "diagnosis", terms: ["糖尿病肾病"] } } }, { now: NOW });
  const [a, b] = result.groups;
  assert.equal(a.summary.met, 4);
  assert.equal(a.summary.n, 7);
  assert.equal(b.summary.met, 0);
  assert.equal(result.tests[0].method, "fisher-exact");
  close(result.tests[0].p, fisherExact2x2([[4, 3], [0, 6]]).p);
  assert.equal(result.effect.estimate, Number((4 / 7).toFixed(4)));
  assert.match(result.effect.oddsRatio.ciMethod, /加 0\.5/);
  assert.ok(result.effect.ci95[0] < result.effect.estimate && result.effect.ci95[1] > result.effect.estimate);
  assert.ok(result.warnings.some((w) => /未记录不等于确无/.test(w)));
});

test("三组数值结局：方差分析 + Kruskal-Wallis；变化量需要两次记录", () => {
  seq = 0;
  const rows = [40, 50, 60].flatMap((age, gi) =>
    [0, 1, 2].map((k) => person({ birthYear: 2026 - age - 5 * gi, labs: [hba1c(9, "2026-01-01"), hba1c(9 - (gi * 3 + k + 1))] })),
  );
  rows.push(person({ birthYear: 1980, labs: [hba1c(8)] }));
  const age = (min, max) => ({ label: `${min}-${max}岁`, kind: "include", field: "age", min, max });
  const result = compareCohorts(rows, {
    title: "年龄段与 HbA1c 变化",
    groups: [
      { label: "青年", spec: { title: "青", conditions: [age(30, 46)] } },
      { label: "中年", spec: { title: "中", conditions: [age(48, 56)] } },
      { label: "老年", spec: { title: "老", conditions: [age(58, 80)] } },
    ],
    outcome: { type: "lab", label: "HbA1c 变化", items: ["HbA1c"], unit: "%", use: "change" },
  }, { now: NOW });
  assert.deepEqual(result.groups.map((g) => g.analyzed), [3, 3, 3]);
  assert.equal(result.groups[0].outcomeMissing[0].reason, "single_record");
  assert.deepEqual(result.tests.map((t) => t.method), ["anova", "kruskal-wallis"]);
  close(result.tests[0].p, 0.001, 1e-6);
  assert.ok(result.warnings.some((w) => /未做两两比较/.test(w)));
  assert.ok(result.warnings.some((w) => /未按时间标准化/.test(w)));
});

test("定义不合法时指出位置", () => {
  assert.throws(() => normalizeComparison({ ...COMPARE, groups: [COMPARE.groups[0]] }), { code: "COHORT_COMPARE" });
  assert.throws(() => normalizeComparison({ ...COMPARE, outcome: { ...COMPARE.outcome, unit: undefined } }), /单位/);
  assert.throws(() => normalizeComparison({ ...COMPARE, groups: [COMPARE.groups[0], { label: "x", spec: { title: "x", conditions: [{ label: "y", kind: "include", field: "lab" }] } }] }), /第 2 组「x」/);
});

test("队列比较工具在科研工具组中", () => {
  assert.ok(SESSION_TOOL_GROUPS.find((g) => g.id === "research-stats").names.includes("cohort_compare"));
});

test("从科研统计页提问：助手调用 cohort_compare，模型只看到汇总，结果存为成果", async (t) => {
  const provider = createScriptedProvider([toolCall("cohort_compare", COMPARE, "call_compare"), textTurn("已完成比较。")]);
  const app = await startTestServer({ provider, seedDemoPack: false });
  t.after(() => app.close());
  const today = new Date().toISOString().slice(0, 10);
  const year = new Date().getFullYear();
  const inputs = [
    ...[7.0, 7.4, 8.1].map((v, i) => ({ name: `赵${i}`, phone: "13800000000", gender: "male", birthYear: year - 60, diagnoses: [{ name: "2型糖尿病", date: "2024-01-01" }], medications: [{ name: "二甲双胍", status: "active" }], labs: [{ item: "HbA1c", value: v, unit: "%", date: today }] })),
    ...[8.0, 8.8, 9.5].map((v, i) => ({ name: `钱${i}`, gender: "female", birthYear: year - 55, diagnoses: [{ name: "2型糖尿病", date: "2024-01-01" }], medications: [{ name: "格列美脲", status: "active" }], labs: [{ item: "HbA1c", value: v, unit: "%", date: today }] })),
  ];
  for (const input of inputs) {
    const created = await app.request("/api/patients", { method: "POST", body: input });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
  const session = await app.request("/api/sessions", { method: "POST", body: { title: "科研统计" } });
  const response = await app.request("/api/agent/run", {
    method: "POST",
    body: {
      sessionId: session.body.id,
      message: COMPARE.question,
      mode: "model",
      externalConsent: true,
      context: { kind: "research-stats-question", label: "科研统计 · 本机患者库", scope: {} },
    },
  });
  assert.equal(response.body.status, "completed", JSON.stringify(response.body));
  assert.ok(provider.calls[0].tools.some((tool) => tool.function.name === "cohort_compare"), "科研统计页的问题应列出 cohort_compare");
  assert.ok(provider.calls[0].tools.some((tool) => tool.function.name === "cohort_query"));
  const reply = provider.calls.at(-1).messages.find((m) => m.role === "tool" && m.tool_call_id === "call_compare").content;
  const parsed = JSON.parse(reply);
  assert.equal(parsed.type, "cohort_comparison");
  assert.deepEqual(parsed.groups.map((g) => g.analyzed), [3, 3]);
  assert.equal(parsed.analysisNumber, 1);
  assert.ok(!/赵\d|钱\d|13800000000/.test(reply), "模型看到的结果不含姓名电话");
  const detail = await app.request(`/api/sessions/${session.body.id}`);
  assert.ok(JSON.stringify(detail.body).includes("cohort_comparison"), "比较结果保存为本次任务的成果");
});

test("Mann-Whitney 小样本用精确分布，结果与 R wilcox.test 一致", async () => {
  const { mannWhitney } = await import("../../server/medical/stats-math.mjs");
  const small = mannWhitney([[1, 2, 3], [4, 5, 6]]);
  assert.equal(small.exact, true);
  assert.ok(Math.abs(small.p - 0.1) < 1e-12);
  assert.ok(Math.abs(mannWhitney([[1.1, 2.2, 3.3, 4.4], [5.5, 6.6, 7.7, 8.8, 9.9]]).p - 1 / 63) < 1e-12);
  assert.equal(mannWhitney([[1, 2, 3, 4, 5], [1, 2, 3, 4, 5]]).p, 1, "并列秩也能精确计算");
  assert.equal(mannWhitney([Array.from({ length: 40 }, (_, i) => i), Array.from({ length: 40 }, (_, i) => i + 3)]).exact, false, "大样本仍用正态近似");
});
