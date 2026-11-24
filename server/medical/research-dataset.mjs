import { createHash } from "node:crypto";
import { shareIdentities, scrubFreeText } from "./deidentify.mjs";

// 科研数据层：把患者库整理成 agent 可自由分析的脱敏长表。
//
// 脱敏在这一层强制完成，分析代码拿不到身份：
// - 患者编号换成稳定假名 pid（同一患者每次一致，便于复现）；
// - 去掉姓名、电话、病历号、来源文件名、自由备注；
// - 出生年份换成当前年龄（≥90 归为 90）；
// - 绝对日期换成「年份 + 距该患者首条临床记录的天数」，保留时间间隔；
// - 诊断名、就诊事由等短文本再做一遍身份与长编号打码。
// 数据快照带内容哈希，分析结果可据此判断数据是否变化、能否复现。

const DAY = 86400000;
const pidOf = (id) => `R${createHash("sha256").update(`research:${id}`).digest("hex").slice(0, 10)}`;
export const PID_PATTERN = /\bR[0-9a-f]{10}\b/g;

function dayCounter(patient) {
  const dates = [
    ...(patient.diagnoses || []).map((d) => d.date),
    ...(patient.labs || []).map((l) => l.date),
    ...(patient.visits || []).map((v) => v.date),
    patient.treatmentPlan?.startDate,
  ]
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite);
  const origin = dates.length ? Math.min(...dates) : null;
  return (value) => {
    const time = Date.parse(value || "");
    if (!Number.isFinite(time) || origin === null) return { year: null, day: null };
    return { year: new Date(time).getUTCFullYear(), day: Math.round((time - origin) / DAY) };
  };
}

export function buildResearchDataset(patients, { includeArchived = false, now = Date.now() } = {}) {
  const rows = patients.all().filter((p) => includeArchived || !p.archived);
  const tables = { patients: [], diagnoses: [], medications: [], labs: [], visits: [] };
  const thisYear = new Date(now).getFullYear();
  for (const patient of rows) {
    const pid = pidOf(patient.id);
    const at = dayCounter(patient);
    const identities = shareIdentities(patient);
    const counts = { identity: 0, idNumber: 0, phone: 0, landline: 0, longNumber: 0 };
    const clean = (text) => (text ? scrubFreeText(String(text), identities, counts) : "");
    const spans = [];
    const track = (stamp) => {
      if (stamp.day !== null) spans.push(stamp.day);
      return stamp;
    };
    for (const d of patient.diagnoses || [])
      tables.diagnoses.push({ pid, name: clean(d.name), code: d.code || "", status: d.status || "", ...track(at(d.date)) });
    for (const m of patient.medications || [])
      tables.medications.push({ pid, name: clean(m.name), status: m.status || "unknown", dose: m.dose || "", frequency: m.frequency || "" });
    for (const l of patient.labs || [])
      if (typeof l.value === "number") tables.labs.push({ pid, item: l.item, value: l.value, unit: l.unit || "", ...track(at(l.date)) });
    for (const v of patient.visits || []) tables.visits.push({ pid, reason: clean(v.reason), ...track(at(v.date)) });
    const age = patient.birthYear ? Math.min(90, thisYear - patient.birthYear) : null;
    const plan = patient.treatmentPlan;
    tables.patients.push({
      pid,
      gender: patient.gender || "unknown",
      age,
      groups: (patient.groups || []).join("|"),
      tags: (patient.tags || []).join("|"),
      archived: Boolean(patient.archived),
      followupDays: spans.length ? Math.max(...spans) : null,
      planTitle: plan ? clean(plan.title) : "",
      planStatus: plan?.status || "",
      planStartDay: plan?.startDate ? at(plan.startDate).day : null,
    });
  }
  for (const list of Object.values(tables)) list.sort((a, b) => (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0));
  const hash = createHash("sha256").update(JSON.stringify(tables)).digest("hex").slice(0, 16);
  return {
    snapshot: { hash, builtAt: new Date(now).toISOString(), patients: tables.patients.length, includeArchived },
    tables,
  };
}

const median = (sorted) =>
  sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
const round = (value) => Math.round(value * 1000) / 1000;

function topBy(rows, keyOf, limit, extra = () => ({})) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { rows: [], pids: new Set() });
    const entry = groups.get(key);
    entry.rows.push(row);
    entry.pids.add(row.pid);
  }
  const all = [...groups.entries()]
    .map(([key, entry]) => ({ key, patients: entry.pids.size, records: entry.rows.length, ...extra(entry.rows) }))
    .sort((a, b) => b.patients - a.patients || b.records - a.records);
  return { items: all.slice(0, limit), distinct: all.length, truncated: all.length > limit };
}

// 数据字典：告诉 agent「有什么可研究」。只给汇总，不给逐人数据。
export function researchDataDictionary(dataset, { limit = 80 } = {}) {
  const { tables, snapshot } = dataset;
  const n = tables.patients.length;
  const covered = (table) => new Set(tables[table].map((row) => row.pid)).size;
  const ages = tables.patients.map((p) => p.age).filter((a) => a !== null).sort((a, b) => a - b);
  const genders = {};
  for (const p of tables.patients) genders[p.gender] = (genders[p.gender] || 0) + 1;
  const split = (field) => topBy(tables.patients.flatMap((p) => (p[field] ? p[field].split("|").map((value) => ({ pid: p.pid, value })) : [])), (r) => r.value, 40);
  const labs = topBy(tables.labs, (r) => r.item, limit, (rows) => {
    const values = rows.map((r) => r.value).sort((a, b) => a - b);
    const years = rows.map((r) => r.year).filter(Boolean);
    return {
      units: [...new Set(rows.map((r) => r.unit).filter(Boolean))].slice(0, 5),
      min: round(values[0]),
      median: round(median(values)),
      max: round(values.at(-1)),
      ...(years.length ? { years: [Math.min(...years), Math.max(...years)] } : {}),
    };
  });
  return {
    snapshot,
    patients: {
      total: n,
      gender: genders,
      age: ages.length ? { known: ages.length, min: ages[0], median: median(ages), max: ages.at(-1) } : { known: 0 },
      groups: split("groups"),
      tags: split("tags"),
      withTreatmentPlan: tables.patients.filter((p) => p.planTitle).length,
      followupDays: (() => {
        const spans = tables.patients.map((p) => p.followupDays).filter((d) => d !== null).sort((a, b) => a - b);
        return spans.length ? { known: spans.length, median: median(spans), max: spans.at(-1) } : { known: 0 };
      })(),
    },
    coverage: Object.fromEntries(
      ["diagnoses", "medications", "labs", "visits"].map((table) => [
        table,
        { records: tables[table].length, patients: covered(table), share: n ? round(covered(table) / n) : 0 },
      ]),
    ),
    diagnoses: topBy(tables.diagnoses, (r) => r.name, limit, (rows) => ({
      codes: [...new Set(rows.map((r) => r.code).filter(Boolean))].slice(0, 3),
    })),
    medications: topBy(tables.medications, (r) => r.name, limit, (rows) => ({
      active: new Set(rows.filter((r) => r.status === "active").map((r) => r.pid)).size,
    })),
    labs,
    visitReasons: topBy(tables.visits, (r) => r.reason, 40),
    schema: {
      patients: "pid, gender(male/female/unknown), age(当前年龄,≥90记90), groups/tags(以|分隔), archived, followupDays(首末记录间隔天数), planTitle, planStatus, planStartDay",
      diagnoses: "pid, name, code(ICD-10,可能为空), status, year, day",
      medications: "pid, name, status(active/stopped/unknown), dose, frequency（无日期）",
      labs: "pid, item(原始项目名,同一指标可能有多种写法), value(数值), unit, year, day",
      visits: "pid, reason, year, day",
      note: "day = 距该患者首条带日期临床记录的天数（各患者各自从0起算），year 为日历年份；同一患者内 day 可用于先后顺序和间隔计算。",
    },
  };
}

// 本地患者库有什么数据（研究页、科研统计页顶部）。只给计数和常见项目名，不给逐人数据。
export function dictionarySummary(patients, { top = 6 } = {}) {
  const dictionary = researchDataDictionary(buildResearchDataset(patients));
  const pick = (block) => block.items.slice(0, top).map((item) => ({ name: item.key, patients: item.patients, ...(item.units ? { units: item.units } : {}) }));
  return {
    patients: dictionary.patients.total,
    ageKnown: dictionary.patients.age.known,
    coverage: Object.fromEntries(Object.entries(dictionary.coverage).map(([table, value]) => [table, { patients: value.patients, records: value.records }])),
    topDiagnoses: pick(dictionary.diagnoses),
    topLabs: pick(dictionary.labs),
    topMedications: pick(dictionary.medications),
    snapshot: dictionary.snapshot.hash,
  };
}
