import { check, string } from "../errors.mjs";
import { LAB_ENTRIES } from "../../shared/lab-reference.mjs";
import { normalizeName, normalizeUnit } from "../../shared/lab-flags.mjs";
import { cohortSpecSchema, describeCondition, evaluatePatient, normalizeCohortSpec } from "./cohort-query.mjs";
import { mean, quantile, variance } from "./cohort-profile.mjs";
import {
  chiSquare,
  fisherExact2x2,
  kruskalWallis,
  mannWhitney,
  oneWayAnova,
  tQuantile,
  welchTTest,
  wilsonInterval,
} from "./stats-math.mjs";

// 队列比较：模型把研究问题翻译成「几组人群条件 + 一个结局」，这里用确定性
// 代码完成分组、取结局值和统计检验，不需要 Python。
//
// 分组口径（显式、可复核）：
// - 某组只计 cohort 判断为「符合」的患者；「待核对」不计入，单列为缺资料排除。
// - 同时符合两组及以上的患者从所有组排除并报告人数（组定义应互斥）。
// - 结局缺失（无检验、时间窗内无记录、单位不同、同日结果冲突、变化量只有一次记录、
//   条件判断待核对）不计入统计，按原因计数；缺失不当作阴性或正常。
// 检验选择：数值结局 2 组 → Welch t + Mann-Whitney U（均报告），均差及 95% CI；
// 3–4 组 → 单因素方差分析 + Kruskal-Wallis（不做事后两两比较）；
// 二分类结局 2 组 → 期望频数均 ≥ 5 用 Pearson 卡方，否则 Fisher 精确检验，
// 并给出率差（Newcombe/Wilson）与 OR（Woolf）及 95% CI；3–4 组 → k×2 卡方。
// 输出只含汇总，不含姓名或逐人数据。所有结果是探索性、相关性草稿。

const DAY = 86400000;
const MAX_GROUPS = 4;
const Z975 = 1.959963984540054;

const conditionSchema = {
  ...cohortSpecSchema.properties.conditions.items,
  required: ["label", "field"],
};

export const cohortCompareSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "比较的简短名称，如“二甲双胍使用与 HbA1c”" },
    question: { type: "string", description: "医生的研究问题原文" },
    groups: {
      type: "array",
      minItems: 2,
      maxItems: MAX_GROUPS,
      description: "2–4 组互斥的人群定义；每组用与 cohort_query 相同的条件格式。对照组要写明排除暴露（如 exclude 二甲双胍）。",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "组名，如“使用二甲双胍”" },
          spec: cohortSpecSchema,
        },
        required: ["label", "spec"],
        additionalProperties: false,
      },
    },
    outcome: {
      type: "object",
      description: "结局：type=lab 为数值检验结局；type=condition 为二分类结局（某条件是否成立）。",
      properties: {
        type: { type: "string", enum: ["lab", "condition"] },
        label: { type: "string", description: "结局的医生可读说明，如“最近一次 HbA1c（%）”" },
        items: { type: "array", maxItems: 12, items: { type: "string" }, description: "lab：检验项目名及常见写法" },
        unit: { type: "string", description: "lab：只用该单位的记录（不换算）；其他单位计为缺失。无单位的项目填空字符串" },
        use: { type: "string", enum: ["latest", "first", "change"], description: "lab：latest 最近一次（默认）/ first 最早一次 / change 末次减首次" },
        withinDays: { type: "integer", minimum: 1, maximum: 3650, description: "lab：只看最近多少天内的记录" },
        condition: conditionSchema,
      },
      required: ["type", "label"],
      additionalProperties: false,
    },
    includeArchived: { type: "boolean", description: "是否包含已归档患者，默认否" },
  },
  required: ["title", "groups", "outcome"],
  additionalProperties: false,
};

const fold = (text) => normalizeName(text).replace(/[,，、/;；]/g, "");
// 与 cohort-query 相同口径：医生给的写法 + 内置别名表里同一项目的其他写法。
function labNames(items) {
  const names = new Set(items.map(fold));
  for (const entry of LAB_ENTRIES) {
    const keys = [entry.name, ...entry.name.split(/\s+/), ...entry.aliases].map(fold).filter(Boolean);
    if (keys.some((key) => names.has(key))) keys.forEach((key) => names.add(key));
  }
  return names;
}
const dateOf = (value) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : null;
};

export function normalizeComparison(input) {
  check(input && typeof input === "object" && !Array.isArray(input), "COHORT_COMPARE", "需要比较定义对象");
  const title = string(input.title, "比较名称", 120).trim();
  check(title, "COHORT_COMPARE", "请填写比较名称");
  const question = input.question ? string(input.question, "研究问题", 500).trim() : "";
  const includeArchived = input.includeArchived === true;
  check(Array.isArray(input.groups) && input.groups.length >= 2 && input.groups.length <= MAX_GROUPS, "COHORT_COMPARE", `需要 2–${MAX_GROUPS} 组`);
  const groups = input.groups.map((group, index) => {
    check(group && typeof group === "object", "COHORT_COMPARE", `第 ${index + 1} 组格式无效`);
    const label = string(group.label, `第 ${index + 1} 组名称`, 60).trim();
    check(label, "COHORT_COMPARE", `第 ${index + 1} 组缺少名称`);
    let spec;
    try {
      spec = normalizeCohortSpec({ ...group.spec, includeArchived });
    } catch (error) {
      error.message = `第 ${index + 1} 组「${label}」：${error.message}`;
      throw error;
    }
    return { label, spec };
  });
  check(new Set(groups.map((g) => g.label)).size === groups.length, "COHORT_COMPARE", "各组名称不能重复");
  const raw = input.outcome;
  check(raw && typeof raw === "object", "COHORT_COMPARE", "需要结局定义 outcome");
  const label = string(raw.label, "结局说明", 120).trim();
  check(label, "COHORT_COMPARE", "请填写结局说明 label");
  let outcome;
  if (raw.type === "lab") {
    check(Array.isArray(raw.items) && raw.items.length >= 1 && raw.items.length <= 12, "COHORT_COMPARE", "检验结局需要 1–12 个项目写法 items");
    const items = [...new Set(raw.items.map((item) => string(item, "检验项目", 80).trim()).filter(Boolean))];
    check(items.length, "COHORT_COMPARE", "检验结局需要项目写法 items");
    check(typeof raw.unit === "string", "COHORT_COMPARE", "检验结局需要写明单位 unit（不同单位不换算）；无单位填空字符串");
    const use = raw.use === undefined ? "latest" : raw.use;
    check(["latest", "first", "change"].includes(use), "COHORT_COMPARE", "use 须为 latest / first / change");
    outcome = { type: "lab", label, items, unit: raw.unit === "" ? "" : string(raw.unit, "单位", 30).trim(), use };
    if (raw.withinDays !== undefined) {
      check(Number.isInteger(raw.withinDays) && raw.withinDays >= 1 && raw.withinDays <= 3650, "COHORT_COMPARE", "withinDays 须为 1–3650 的整数");
      outcome.withinDays = raw.withinDays;
    }
  } else if (raw.type === "condition") {
    check(raw.condition && typeof raw.condition === "object", "COHORT_COMPARE", "二分类结局需要 condition");
    let spec;
    try {
      spec = normalizeCohortSpec({ title: label, conditions: [{ ...raw.condition, kind: "include" }] });
    } catch (error) {
      error.message = `结局条件：${error.message.replace("第 1 条条件", "")}`;
      throw error;
    }
    outcome = { type: "condition", label, condition: spec.conditions[0] };
  } else check(false, "COHORT_COMPARE", "outcome.type 须为 lab 或 condition");
  return { title, question, groups, outcome, includeArchived };
}

export function describeOutcome(outcome) {
  if (outcome.type === "condition") return `${describeCondition(outcome.condition)}（是 / 否）`;
  const use = { latest: "最近一次", first: "最早一次", change: "末次减首次的变化" }[outcome.use];
  return `${outcome.items[0]}${outcome.unit ? `（${outcome.unit}）` : ""}${use}${outcome.withinDays ? `，近 ${outcome.withinDays} 天` : ""}`;
}

const MISSING = {
  no_record: "没有该检验记录",
  no_date: "检验记录缺日期",
  out_of_window: "时间范围内没有记录",
  unit: "单位不同（未换算）",
  same_day_conflict: "同日多条结果不一致",
  single_record: "只有一次记录，无法计算变化",
  unknown: "条件无法判断（缺资料）",
};

// 单个患者的结局值：{ value } 或 { missing: 原因 }。
function labOutcome(outcome, patient, now, names) {
  const all = (patient.labs || []).filter((l) => typeof l.value === "number" && Number.isFinite(l.value) && names.has(fold(l.item)));
  if (!all.length) return { missing: "no_record" };
  const dated = all.filter((l) => dateOf(l.date) !== null);
  if (!dated.length) return { missing: "no_date" };
  const since = outcome.withinDays ? now - outcome.withinDays * DAY : null;
  const inWindow = since === null ? dated : dated.filter((l) => dateOf(l.date) >= since);
  if (!inWindow.length) return { missing: "out_of_window" };
  const unit = normalizeUnit(outcome.unit);
  const usable = inWindow.filter((l) => normalizeUnit(l.unit) === unit);
  if (!usable.length) return { missing: "unit" };
  // 按日期聚合；同日多条数值不同则该日不可用，不替医生挑一个。
  const days = new Map();
  for (const l of usable) {
    const key = String(l.date).slice(0, 10);
    if (!days.has(key)) days.set(key, { time: dateOf(l.date), values: new Set() });
    days.get(key).values.add(l.value);
  }
  const ordered = [...days.values()].sort((a, b) => a.time - b.time);
  const pick = (day) => (day.values.size === 1 ? { value: [...day.values][0], time: day.time } : null);
  if (outcome.use === "change") {
    if (ordered.length < 2) return { missing: "single_record" };
    const first = pick(ordered[0]),
      last = pick(ordered.at(-1));
    if (!first || !last) return { missing: "same_day_conflict" };
    return { value: last.value - first.value, spanDays: Math.round((last.time - first.time) / DAY) };
  }
  const chosen = pick(outcome.use === "first" ? ordered[0] : ordered.at(-1));
  return chosen ? { value: chosen.value } : { missing: "same_day_conflict" };
}

// 分组 + 取结局：逐人结果只在本模块内使用，对外只给汇总（导出接口另行脱敏）。
export function assignCohorts(patients, input, { now = Date.now() } = {}) {
  const comparison = normalizeComparison(input);
  const pool = patients.filter((p) => comparison.includeArchived || !p.archived);
  const names = comparison.outcome.type === "lab" ? labNames(comparison.outcome.items) : null;
  const outcomeSpec = comparison.outcome.type === "condition" ? { conditions: [comparison.outcome.condition] } : null;
  const groups = comparison.groups.map((g) => ({
    ...g,
    unclear: 0,
    unclearConditions: g.spec.conditions.map(() => 0),
    alsoUnclearElsewhere: 0,
    members: [],
  }));
  const overlap = { patients: 0, pairs: {} };
  for (const patient of pool) {
    const verdicts = groups.map((g) => evaluatePatient(g.spec, patient, now));
    const matched = verdicts.map((v, i) => (v.status === "match" ? i : -1)).filter((i) => i >= 0);
    if (matched.length > 1) {
      overlap.patients++;
      const key = matched.map((i) => groups[i].label).join(" + ");
      overlap.pairs[key] = (overlap.pairs[key] || 0) + 1;
      continue;
    }
    if (matched.length === 0) {
      verdicts.forEach((v, i) => {
        if (v.status !== "unclear") return;
        groups[i].unclear++;
        v.results.forEach((r) => r.verdict === "unknown" && groups[i].unclearConditions[r.index]++);
      });
      continue;
    }
    const gi = matched[0];
    if (verdicts.some((v, i) => i !== gi && v.status === "unclear")) groups[gi].alsoUnclearElsewhere++;
    let result;
    if (names) result = labOutcome(comparison.outcome, patient, now, names);
    else {
      const status = evaluatePatient(outcomeSpec, patient, now).status;
      result = status === "unclear" ? { missing: "unknown" } : { value: status === "match" ? 1 : 0 };
    }
    groups[gi].members.push({ patient, ...result });
  }
  return { comparison, pool: pool.length, groups, overlap };
}

const round = (value, digits = 4) => (typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

function numericSummary(values) {
  if (!values.length) return { n: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    n: values.length,
    mean: round(mean(values)),
    sd: values.length > 1 ? round(Math.sqrt(variance(values))) : null,
    median: round(quantile(sorted, 0.5)),
    q1: round(quantile(sorted, 0.25)),
    q3: round(quantile(sorted, 0.75)),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
  };
}

function numericTests(arrays, labels, warnings) {
  const tests = [];
  let effect = null;
  const ready = arrays.filter((a) => a.length >= 2).length === arrays.length;
  if (!ready) {
    warnings.push("至少一组有效数值少于 2 个，未做统计检验，只给描述统计。");
    return { tests, effect };
  }
  if (arrays.length === 2) {
    const [a, b] = arrays;
    const v1 = variance(a),
      v2 = variance(b);
    if (v1 + v2 > 0) {
      const t = welchTTest(arrays);
      const se = Math.sqrt(v1 / a.length + v2 / b.length);
      const diff = mean(a) - mean(b);
      const crit = tQuantile(t.df);
      const pooled = Math.sqrt(((a.length - 1) * v1 + (b.length - 1) * v2) / (a.length + b.length - 2));
      const hedges = pooled > 0 ? (diff / pooled) * (1 - 3 / (4 * (a.length + b.length) - 9)) : null;
      tests.push({ name: "Welch t 检验", method: "welch-t", statistic: { t: round(t.t), df: round(t.df, 2) }, p: t.p, primary: true });
      effect = {
        name: `均值差（${labels[0]} − ${labels[1]}）`,
        estimate: round(diff),
        ci95: [round(diff - crit * se), round(diff + crit * se)],
        ciMethod: "Welch",
        standardized: hedges === null ? null : { name: "Hedges g", estimate: round(hedges) },
      };
    } else warnings.push("两组数值完全没有变异，无法做 t 检验。");
    const mw = mannWhitney(arrays);
    if (Number.isFinite(mw.p)) {
      tests.push({ name: mw.exact ? "Mann-Whitney U 检验（精确）" : "Mann-Whitney U 检验（正态近似）", method: "mann-whitney", statistic: { U: round(mw.u, 2), z: round(mw.z) }, p: mw.p, primary: !tests.length });
      if (mw.note) warnings.push(`Mann-Whitney：${mw.note}`);
    }
  } else {
    const anova = oneWayAnova(arrays);
    if (anova.p !== null)
      tests.push({ name: "单因素方差分析", method: "anova", statistic: { F: round(anova.f), df1: anova.df1, df2: anova.df2 }, p: anova.p, primary: true });
    const kw = kruskalWallis(arrays);
    if (kw.p !== null)
      tests.push({ name: "Kruskal-Wallis 检验", method: "kruskal-wallis", statistic: { H: round(kw.h), df: kw.df }, p: kw.p, primary: !tests.length });
    if (anova.etaSquared !== null) effect = { name: "η²（组间变异占比）", estimate: round(anova.etaSquared), ci95: null };
    warnings.push("多组比较只检验“各组是否全部相同”，未做两两比较；如需两两比较须预先说明并校正多重比较。");
  }
  return { tests, effect };
}

function binaryTests(counts, labels, warnings) {
  const tests = [];
  let effect = null;
  const table = counts.map((c) => [c.met, c.notMet]);
  const total = table.flat().reduce((s, v) => s + v, 0);
  const metTotal = counts.reduce((s, c) => s + c.met, 0);
  if (counts.some((c) => c.met + c.notMet === 0)) {
    warnings.push("至少一组没有可判断结局的患者，未做统计检验。");
    return { tests, effect };
  }
  if (metTotal === 0 || metTotal === total) {
    warnings.push("所有可判断的患者结局相同，无法检验组间差异。");
    return { tests, effect };
  }
  const rows = table.map((r) => r[0] + r[1]);
  const cols = [metTotal, total - metTotal];
  const minExpected = Math.min(...rows.flatMap((r) => cols.map((c) => (r * c) / total)));
  if (counts.length === 2) {
    if (minExpected < 5) {
      const f = fisherExact2x2(table);
      tests.push({ name: "Fisher 精确检验（双侧）", method: "fisher-exact", statistic: {}, p: f.p, primary: true, reason: `最小期望频数 ${round(minExpected, 2)} < 5` });
    } else {
      const c = chiSquare(table);
      tests.push({ name: "Pearson 卡方检验（未校正）", method: "chi-square", statistic: { "χ²": round(c.chi2), df: c.df }, p: c.p, primary: true });
    }
    const [[a, b], [c, d]] = table;
    const p1 = a / (a + b),
      p2 = c / (c + d);
    // Newcombe 混合评分区间（基于 Wilson）。
    const [l1, u1] = wilsonInterval(a, a + b),
      [l2, u2] = wilsonInterval(c, c + d);
    const rd = p1 - p2;
    const zero = [a, b, c, d].some((v) => v === 0);
    const [aa, bb, cc, dd] = zero ? [a + 0.5, b + 0.5, c + 0.5, d + 0.5] : [a, b, c, d];
    const logOr = Math.log((aa * dd) / (bb * cc));
    const seLog = Math.sqrt(1 / aa + 1 / bb + 1 / cc + 1 / dd);
    effect = {
      name: `率差（${labels[0]} − ${labels[1]}）`,
      estimate: round(rd),
      ci95: [round(rd - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2)), round(rd + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2))],
      ciMethod: "Newcombe（Wilson）",
      oddsRatio: {
        estimate: round(Math.exp(logOr)),
        ci95: [round(Math.exp(logOr - Z975 * seLog)), round(Math.exp(logOr + Z975 * seLog))],
        ciMethod: zero ? "Woolf（含 0 格，各格加 0.5）" : "Woolf",
      },
    };
  } else {
    const c = chiSquare(table);
    tests.push({ name: `Pearson 卡方检验（${counts.length}×2）`, method: "chi-square", statistic: { "χ²": round(c.chi2), df: c.df }, p: c.p, primary: true });
    if (minExpected < 5) warnings.push(`最小期望频数 ${round(minExpected, 2)} < 5，卡方近似可能不可靠，请谨慎解读或合并组别。`);
    warnings.push("多组比较只检验“各组比例是否全部相同”，未做两两比较。");
  }
  return { tests, effect };
}

// 主入口：返回只含汇总的比较结果。
export function compareCohorts(patients, input, { now = Date.now(), analysisNumber = 1 } = {}) {
  const { comparison, pool, groups, overlap } = assignCohorts(patients, input, { now });
  const { outcome } = comparison;
  const warnings = [];
  const labels = groups.map((g) => g.label);
  const groupOut = groups.map((g) => {
    const analyzed = g.members.filter((m) => m.missing === undefined);
    const reasons = {};
    for (const m of g.members) if (m.missing) reasons[m.missing] = (reasons[m.missing] || 0) + 1;
    const summary =
      outcome.type === "lab"
        ? numericSummary(analyzed.map((m) => m.value))
        : (() => {
            const met = analyzed.filter((m) => m.value === 1).length;
            const n = analyzed.length;
            const [lo, hi] = wilsonInterval(met, n);
            return { n, met, notMet: n - met, proportion: n ? round(met / n) : null, ci95: n ? [round(lo), round(hi)] : null };
          })();
    if (outcome.use === "change" && analyzed.length) {
      const spans = analyzed.map((m) => m.spanDays).sort((a, b) => a - b);
      summary.spanDays = { median: round(quantile(spans, 0.5), 1), min: spans[0], max: spans.at(-1) };
    }
    return {
      label: g.label,
      spec: { ...g.spec, conditions: g.spec.conditions.map((c) => ({ ...c, description: describeCondition(c) })) },
      matched: g.members.length,
      analyzed: analyzed.length,
      outcomeMissing: Object.entries(reasons).map(([reason, count]) => ({ reason, label: MISSING[reason], count })),
      excludedUnclear: {
        count: g.unclear,
        byCondition: g.unclearConditions
          .map((count, index) => ({ index, label: g.spec.conditions[index].label, count }))
          .filter((item) => item.count > 0),
      },
      alsoUnclearElsewhere: g.alsoUnclearElsewhere,
      summary,
    };
  });
  const arrays = groups.map((g) => g.members.filter((m) => m.missing === undefined).map((m) => m.value));
  const { tests, effect } =
    outcome.type === "lab"
      ? numericTests(arrays, labels, warnings)
      : binaryTests(groupOut.map((g) => g.summary), labels, warnings);

  // 方法学提示：放在检验特有提示之前。
  const head = [
    "探索性、相关性比较：分组不是随机分配，年龄、病程、合并用药等混杂因素未校正，不能据此推断因果或疗效。",
  ];
  const minN = Math.min(...groupOut.map((g) => g.analyzed));
  if (minN < 10) head.push(`最小组只有 ${minN} 例可分析，统计效能很低，p 值和区间都不稳定。`);
  else if (outcome.type === "lab" && minN < 30) head.push("样本量较小（某组 < 30 例），t 检验依赖近似正态，请同时参考 Mann-Whitney / Kruskal-Wallis 结果。");
  if (overlap.patients) head.push(`${overlap.patients} 位患者同时符合多组条件，已从所有组排除；组定义应互斥（对照组写明排除暴露）。`);
  const unclearTotal = groupOut.reduce((s, g) => s + g.excludedUnclear.count, 0);
  if (unclearTotal) head.push(`共 ${unclearTotal} 人次因分组条件缺资料（待核对）未纳入，可能造成选择偏倚。`);
  const ambiguous = groupOut.reduce((s, g) => s + g.alsoUnclearElsewhere, 0);
  if (ambiguous) head.push(`${ambiguous} 位已入组患者对其他组的判断为待核对，分组可能有误，建议抽查。`);
  for (const g of groupOut) {
    const share = g.matched ? 1 - g.analyzed / g.matched : 0;
    if (g.matched && share > 0.2) head.push(`「${g.label}」有 ${Math.round(share * 100)}% 的患者结局缺失，若缺失与结局相关，结果会有偏倚。`);
  }
  if (outcome.type === "lab" && outcome.use === "change") head.push("变化量的首末次间隔因人而异，未按时间标准化。");
  if (outcome.type === "condition" && ["diagnosis", "medication", "group", "tag"].includes(outcome.condition.field))
    head.push("二分类结局按档案记录判断：有其他记录但未记录该项按“否”计，可能低估发生率（未记录不等于确无）。");
  if (analysisNumber > 1)
    head.push(`这是本次任务第 ${analysisNumber} 项统计分析，p 值未做多重比较校正（Bonferroni 阈值约 ${round(0.05 / analysisNumber, 4)}）。`);
  warnings.unshift(...head);

  const primary = tests.find((t) => t.primary) || null;
  return {
    title: comparison.title,
    question: comparison.question,
    outcome: { ...outcome, description: describeOutcome(outcome), ...(outcome.condition ? { condition: { ...outcome.condition, description: describeCondition(outcome.condition) } } : {}) },
    population: { total: pool, includeArchived: comparison.includeArchived, overlapExcluded: overlap.patients, overlapPairs: overlap.pairs },
    groups: groupOut,
    tests: tests.map((t) => ({ ...t, p: round(t.p, 6) })),
    primaryTest: primary ? primary.method : null,
    effect,
    warnings,
    analysisNumber,
    evaluatedAt: new Date(now).toISOString(),
  };
}
