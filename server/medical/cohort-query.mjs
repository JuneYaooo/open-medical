import { check, string } from "../errors.mjs";
import { LAB_ENTRIES } from "../../shared/lab-reference.mjs";
import { normalizeName, normalizeUnit } from "../../shared/lab-flags.mjs";

// 按条件找患者：模型把医生的一句话（或试验入排标准）翻译成结构化条件，
// 这里用确定性代码逐人判断。每条条件给出「符合 / 不符合 / 待核对」和依据。
//
// 判断原则：
// - 缺资料是「待核对」，不是「不符合」：没有检验、缺出生年份、单位不同都待核对。
// - 档案里没记录某诊断或用药，只说明「未记录」；纳入条件按不符合处理，
//   排除条件按未触发处理，并在依据里写明「未记录不等于确无」。
// - 单位不同不换算，标待核对；同一检验只比较同单位记录。
// - 结果只含患者 id 和判断依据，不含姓名、电话等身份信息。

const DAY = 86400000;
export const COHORT_FIELDS = Object.freeze({
  age: "年龄",
  sex: "性别",
  diagnosis: "诊断",
  medication: "用药",
  lab: "检验",
  group: "分组",
  tag: "标签",
});
const OPS = Object.freeze({ gt: ">", gte: "≥", lt: "<", lte: "≤", between: "介于" });
const RESULT_LABEL = { met: "符合", not_met: "不符合", unknown: "待核对" };
export const COHORT_STATUS = Object.freeze({ match: "符合", unclear: "待核对", mismatch: "不符合" });

// JSON Schema：模型生成条件时使用，同时作为输入校验的说明。
export const cohortSpecSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "这组条件的简短名称，如“HbA1c 控制不佳的 2 型糖尿病”" },
    conditions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "医生能看懂的条件原文，如“HbA1c ≥ 8%（近 180 天）”" },
          kind: { type: "string", enum: ["include", "exclude"], description: "include=必须满足；exclude=满足则排除" },
          field: { type: "string", enum: Object.keys(COHORT_FIELDS) },
          min: { type: "number", description: "age：最小年龄（含）" },
          max: { type: "number", description: "age：最大年龄（含）" },
          sex: { type: "string", enum: ["male", "female"] },
          terms: {
            type: "array",
            maxItems: 12,
            items: { type: "string" },
            description: "diagnosis/medication/group/tag：名称及常见写法（中文名、英文名、缩写、通用名/商品名），任一匹配即可",
          },
          codes: { type: "array", maxItems: 12, items: { type: "string" }, description: "diagnosis：ICD-10 编码前缀，如 E11" },
          confirmedOnly: { type: "boolean", description: "diagnosis：只算已确诊，不含疑似" },
          activeOnly: { type: "boolean", description: "medication：只算正在使用（默认 true）" },
          items: {
            type: "array",
            maxItems: 12,
            items: { type: "string" },
            description: "lab：检验项目名及常见写法，如 [\"糖化血红蛋白\",\"HbA1c\",\"GHb\"]",
          },
          op: { type: "string", enum: Object.keys(OPS) },
          value: { type: "number" },
          value2: { type: "number", description: "op=between 时的上限（含）" },
          unit: { type: "string", description: "lab：比较时要求的单位；不同单位的记录标为待核对" },
          use: { type: "string", enum: ["latest", "any"], description: "lab：latest=只看最近一次（默认）；any=时间范围内任一次" },
          withinDays: { type: "integer", minimum: 1, maximum: 3650, description: "lab：只看最近多少天内的记录" },
        },
        required: ["label", "kind", "field"],
        additionalProperties: false,
      },
    },
    includeArchived: { type: "boolean", description: "是否包含已归档患者，默认否" },
  },
  required: ["title", "conditions"],
  additionalProperties: false,
};

const textList = (value, label, max = 12) => {
  if (value === undefined) return [];
  check(Array.isArray(value) && value.length <= max, "COHORT_SPEC", `${label}须为最多 ${max} 项的列表`);
  return [...new Set(value.map((item) => string(item, label, 80).trim()).filter(Boolean))];
};
const number = (value, label) => {
  if (value === undefined || value === null) return null;
  check(typeof value === "number" && Number.isFinite(value), "COHORT_SPEC", `${label}须为数字`);
  return value;
};

// 校验并规整条件；不合法时报出具体是哪一条，便于模型修正。
export function normalizeCohortSpec(input) {
  check(input && typeof input === "object" && !Array.isArray(input), "COHORT_SPEC", "需要条件对象");
  const title = string(input.title, "条件名称", 120).trim();
  check(title, "COHORT_SPEC", "请填写条件名称");
  check(Array.isArray(input.conditions) && input.conditions.length >= 1 && input.conditions.length <= 20, "COHORT_SPEC", "条件须为 1–20 条");
  const conditions = input.conditions.map((raw, index) => {
    const where = `第 ${index + 1} 条条件`;
    check(raw && typeof raw === "object", "COHORT_SPEC", `${where}格式无效`);
    check(COHORT_FIELDS[raw.field], "COHORT_SPEC", `${where}的 field 无效`);
    check(raw.kind === "include" || raw.kind === "exclude", "COHORT_SPEC", `${where}的 kind 须为 include/exclude`);
    const c = { label: string(raw.label, `${where}说明`, 300).trim(), kind: raw.kind, field: raw.field };
    check(c.label, "COHORT_SPEC", `${where}缺少说明`);
    if (c.field === "age") {
      c.min = number(raw.min, `${where}最小年龄`);
      c.max = number(raw.max, `${where}最大年龄`);
      check(c.min !== null || c.max !== null, "COHORT_SPEC", `${where}需要 min 或 max`);
    } else if (c.field === "sex") {
      check(raw.sex === "male" || raw.sex === "female", "COHORT_SPEC", `${where}的 sex 须为 male/female`);
      c.sex = raw.sex;
    } else if (c.field === "lab") {
      c.items = textList(raw.items, `${where}检验项目`);
      check(c.items.length, "COHORT_SPEC", `${where}需要检验项目 items`);
      check(OPS[raw.op], "COHORT_SPEC", `${where}的 op 无效`);
      c.op = raw.op;
      c.value = number(raw.value, `${where}数值`);
      check(c.value !== null, "COHORT_SPEC", `${where}需要比较数值 value`);
      if (c.op === "between") {
        c.value2 = number(raw.value2, `${where}上限`);
        check(c.value2 !== null && c.value2 >= c.value, "COHORT_SPEC", `${where}的 between 需要 value2 ≥ value`);
      }
      if (raw.unit) c.unit = string(raw.unit, `${where}单位`, 30).trim();
      c.use = raw.use === "any" ? "any" : "latest";
      if (raw.withinDays !== undefined) {
        check(Number.isInteger(raw.withinDays) && raw.withinDays >= 1 && raw.withinDays <= 3650, "COHORT_SPEC", `${where}的 withinDays 须为 1–3650 的整数`);
        c.withinDays = raw.withinDays;
      }
    } else {
      c.terms = textList(raw.terms, `${where}名称`);
      if (c.field === "diagnosis") {
        c.codes = textList(raw.codes, `${where}编码`).map((code) => code.toUpperCase());
        if (raw.confirmedOnly === true) c.confirmedOnly = true;
        check(c.terms.length || c.codes.length, "COHORT_SPEC", `${where}需要诊断名称 terms 或编码 codes`);
      } else check(c.terms.length, "COHORT_SPEC", `${where}需要名称 terms`);
      if (c.field === "medication") c.activeOnly = raw.activeOnly !== false;
    }
    return c;
  });
  return { title, conditions, includeArchived: input.includeArchived === true };
}

// 一句话描述条件，用于界面和提示。
export function describeCondition(c) {
  const head = c.kind === "exclude" ? "排除：" : "";
  if (c.field === "age") return `${head}年龄 ${c.min !== null ? `≥ ${c.min}` : ""}${c.min !== null && c.max !== null ? " 且 " : ""}${c.max !== null ? `≤ ${c.max}` : ""} 岁`;
  if (c.field === "sex") return `${head}${c.sex === "female" ? "女性" : "男性"}`;
  if (c.field === "lab") {
    const range = c.op === "between" ? `${c.value}–${c.value2}` : `${OPS[c.op]} ${c.value}`;
    return `${head}${c.items[0]} ${range}${c.unit ? ` ${c.unit}` : ""}（${c.use === "any" ? "任一次" : "最近一次"}${c.withinDays ? `，近 ${c.withinDays} 天` : ""}）`;
  }
  const names = [...(c.terms || []), ...(c.codes || [])].slice(0, 3).join(" / ");
  const extra = c.field === "medication" ? (c.activeOnly ? "（在用）" : "（含停用）") : c.confirmedOnly ? "（已确诊）" : "";
  return `${head}${COHORT_FIELDS[c.field]}：${names}${extra}`;
}

const fold = (text) => normalizeName(text).replace(/[,，、/;；]/g, "");
// 名称互相包含即算命中（"2型糖尿病" 命中 "2型糖尿病伴周围神经病变"），
// 但 2 个字以下的词只做完全匹配，避免 "糖" 之类误中。
function termHit(value, terms) {
  const v = fold(value);
  if (!v) return null;
  return terms.find((term) => {
    const t = fold(term);
    if (!t) return false;
    if (t.length <= 2 || v.length <= 2) return t === v;
    return v.includes(t) || t.includes(v);
  }) || null;
}

// 检验项目：医生给的写法 + 内置别名表里同一项目的其他写法。
function labNames(items) {
  const names = new Set(items.map(fold));
  for (const entry of LAB_ENTRIES) {
    const keys = [entry.name, ...entry.name.split(/\s+/), ...entry.aliases].map(fold).filter(Boolean);
    if (keys.some((key) => names.has(key))) keys.forEach((key) => names.add(key));
  }
  return names;
}

function compare(value, c) {
  if (c.op === "gt") return value > c.value;
  if (c.op === "gte") return value >= c.value;
  if (c.op === "lt") return value < c.value;
  if (c.op === "lte") return value <= c.value;
  return value >= c.value && value <= c.value2;
}

const dateOf = (value) => {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : null;
};

// 单条条件对单个患者：返回「条件是否成立」（met/not_met/unknown）及依据。
// 排除条件的 met 表示「触发排除」。
function evaluateCondition(c, patient, now) {
  if (c.field === "age") {
    if (!patient.birthYear) return { result: "unknown", evidence: "档案缺出生年份" };
    const age = new Date(now).getFullYear() - Number(patient.birthYear);
    // 只有出生年份时，实际年龄可能小 1 岁。
    const low = age - 1, high = age;
    const okLow = c.min === null || low >= c.min, okHigh = c.max === null || high <= c.max;
    const failLow = c.min !== null && high < c.min, failHigh = c.max !== null && low > c.max;
    if (failLow || failHigh) return { result: "not_met", evidence: `约 ${age} 岁` };
    if (okLow && okHigh) return { result: "met", evidence: `约 ${age} 岁` };
    return { result: "unknown", evidence: `约 ${age} 岁，只有出生年份，在边界上需核对生日` };
  }
  if (c.field === "sex") {
    if (!["male", "female"].includes(patient.gender)) return { result: "unknown", evidence: "档案未记录性别" };
    return { result: patient.gender === c.sex ? "met" : "not_met", evidence: patient.gender === "female" ? "女" : "男" };
  }
  if (c.field === "diagnosis") {
    const list = (patient.diagnoses || []).filter((d) => d?.name || d?.code);
    if (!list.length) return { result: "unknown", evidence: "档案没有诊断记录" };
    for (const d of list) {
      const byCode = d.code && c.codes.some((code) => String(d.code).toUpperCase().startsWith(code));
      const byName = c.terms.length && termHit(d.name, c.terms);
      if (!byCode && !byName) continue;
      const suspected = d.status && d.status !== "confirmed";
      if (c.confirmedOnly && suspected) return { result: "unknown", evidence: `「${d.name}」尚未确诊` };
      return { result: "met", evidence: `诊断「${d.name}」${d.code ? `（${d.code}）` : ""}${suspected ? "，疑似/待核对" : ""}` };
    }
    return { result: "not_met", evidence: "档案诊断中未记录（未记录不等于确无）" };
  }
  if (c.field === "medication") {
    const list = (patient.medications || []).filter((m) => m?.name);
    if (!list.length) return { result: "unknown", evidence: "档案没有用药记录" };
    let unclear = null;
    for (const m of list) {
      if (!termHit(m.name, c.terms)) continue;
      if (!c.activeOnly || m.status === "active") return { result: "met", evidence: `用药「${m.name}」${m.status === "stopped" ? "（已停用）" : m.status === "active" ? "（在用）" : ""}` };
      if (m.status !== "stopped") unclear = `用药「${m.name}」使用状态未核对`;
    }
    if (unclear) return { result: "unknown", evidence: unclear };
    return { result: "not_met", evidence: c.activeOnly ? "未记录正在使用（未记录不等于确无）" : "档案用药中未记录（未记录不等于确无）" };
  }
  if (c.field === "lab") {
    const names = labNames(c.items);
    const since = c.withinDays ? now - c.withinDays * DAY : null;
    const all = (patient.labs || []).filter((l) => typeof l.value === "number" && names.has(fold(l.item)));
    if (!all.length) return { result: "unknown", evidence: `没有「${c.items[0]}」检验记录` };
    const dated = all.filter((l) => dateOf(l.date) !== null).sort((a, b) => dateOf(b.date) - dateOf(a.date));
    const inWindow = since === null ? dated : dated.filter((l) => dateOf(l.date) >= since);
    if (!inWindow.length) return { result: "unknown", evidence: since === null ? `「${c.items[0]}」记录缺日期` : `近 ${c.withinDays} 天没有「${c.items[0]}」检验` };
    const sameUnit = c.unit ? inWindow.filter((l) => normalizeUnit(l.unit) === normalizeUnit(c.unit)) : inWindow;
    const show = (l) => `${l.item} ${l.value}${l.unit ? ` ${l.unit}` : ""}（${String(l.date).slice(0, 10)}）`;
    if (c.use === "latest") {
      const latest = inWindow[0];
      if (c.unit && normalizeUnit(latest.unit) !== normalizeUnit(c.unit)) return { result: "unknown", evidence: `${show(latest)}，单位与条件（${c.unit}）不同，未换算` };
      // 同一天多条结果冲突时不替医生选一个。
      const sameDay = inWindow.filter((l) => String(l.date).slice(0, 10) === String(latest.date).slice(0, 10) && (!c.unit || normalizeUnit(l.unit) === normalizeUnit(c.unit)));
      const outcomes = new Set(sameDay.map((l) => compare(l.value, c)));
      if (outcomes.size > 1) return { result: "unknown", evidence: `同日有多条结果且结论不一：${sameDay.map(show).join("；")}` };
      return { result: compare(latest.value, c) ? "met" : "not_met", evidence: show(latest) };
    }
    if (!sameUnit.length) return { result: "unknown", evidence: `${show(inWindow[0])}，单位与条件（${c.unit}）不同，未换算` };
    const hit = sameUnit.find((l) => compare(l.value, c));
    return hit ? { result: "met", evidence: show(hit) } : { result: "not_met", evidence: `${sameUnit.length} 次记录均不满足，最近 ${show(sameUnit[0])}` };
  }
  // group / tag
  const values = (c.field === "group" ? patient.groups : patient.tags) || [];
  const hit = values.find((value) => termHit(value, c.terms));
  return hit ? { result: "met", evidence: `${COHORT_FIELDS[c.field]}「${hit}」` } : { result: "not_met", evidence: `不在该${COHORT_FIELDS[c.field]}` };
}

// 单个患者：纳入条件全部符合、且没有触发排除条件，才算符合。
export function evaluatePatient(spec, patient, now = Date.now()) {
  const results = spec.conditions.map((c, index) => {
    const r = evaluateCondition(c, patient, now);
    // 排除条件：条件成立 = 不符合；未记录 = 未触发。
    const verdict = c.kind === "include" ? r.result : r.result === "met" ? "not_met" : r.result === "unknown" ? "unknown" : "met";
    return { index, verdict, verdictLabel: RESULT_LABEL[verdict], evidence: r.evidence };
  });
  const status = results.some((r) => r.verdict === "not_met") ? "mismatch" : results.some((r) => r.verdict === "unknown") ? "unclear" : "match";
  return { patientId: patient.id, status, results };
}

// 对患者库执行；rows 默认只返回「符合 / 待核对」，按符合优先。
export function runCohortQuery(patients, input, { now = Date.now(), limit = 200, includeMismatch = false } = {}) {
  const spec = normalizeCohortSpec(input);
  const pool = patients.filter((p) => spec.includeArchived || !p.archived);
  const evaluated = pool.map((p) => evaluatePatient(spec, p, now));
  const counts = { total: pool.length, match: 0, unclear: 0, mismatch: 0 };
  for (const row of evaluated) counts[row.status]++;
  // 每条条件各有多少人「待核对」，帮助医生判断该补什么资料或调整口径。
  const perCondition = spec.conditions.map((c, index) => {
    const tally = { met: 0, not_met: 0, unknown: 0 };
    for (const row of evaluated) tally[row.results[index].verdict]++;
    return { index, label: c.label, description: describeCondition(c), ...tally };
  });
  const order = { match: 0, unclear: 1, mismatch: 2 };
  const rows = evaluated
    .filter((row) => includeMismatch || row.status !== "mismatch")
    .sort((a, b) => order[a.status] - order[b.status] || a.results.filter((r) => r.verdict === "unknown").length - b.results.filter((r) => r.verdict === "unknown").length);
  return {
    spec: { ...spec, conditions: spec.conditions.map((c) => ({ ...c, description: describeCondition(c) })) },
    counts,
    perCondition,
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    evaluatedAt: new Date(now).toISOString(),
  };
}
