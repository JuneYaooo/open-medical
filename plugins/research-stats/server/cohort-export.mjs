import { createHmac, randomBytes } from "node:crypto";
import { assignCohorts, describeOutcome } from "../../../server/medical/cohort-stats.mjs";
import { buildResearchDataset, researchDataDictionary } from "../../../server/medical/research-dataset.mjs";

// 导出脱敏队列：与 cohort_compare 同一分组和结局口径，只导出
// 假名编号、组别、年龄、性别和结局值。不含姓名、电话、病历号、证件号或
// 任何绝对日期；假名由本次导出的随机密钥生成且密钥不保存，不能还原，
// 不同导出之间也无法关联。行按组别和假名排序，不保留档案顺序。
const MISSING_LABEL = {
  no_record: "无记录",
  no_date: "缺日期",
  out_of_window: "时间范围外",
  unit: "单位不同",
  same_day_conflict: "同日结果冲突",
  single_record: "仅一次记录",
  unknown: "无法判断",
};
const SEX = { male: "男", female: "女" };
const field = (value) => {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text) && !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function exportCohortCsv(patients, input, { now = Date.now() } = {}) {
  const { comparison, groups, overlap } = assignCohorts(patients, input, { now });
  const key = randomBytes(32);
  const thisYear = new Date(now).getFullYear();
  const lab = comparison.outcome.type === "lab";
  const header = ["subject", "group", "age", "sex", "outcome", ...(lab && comparison.outcome.use === "change" ? ["outcome_span_days"] : []), "outcome_missing"];
  const rows = [];
  groups.forEach((group) => {
    const list = group.members.map((m) => {
      const birthYear = Number(m.patient.birthYear);
      const age = birthYear ? Math.min(90, thisYear - birthYear) : "";
      const value = m.missing ? "" : lab ? m.value : m.value === 1 ? "是" : "否";
      return [
        `S_${createHmac("sha256", key).update(String(m.patient.id)).digest("hex").slice(0, 12)}`,
        group.label,
        age,
        SEX[m.patient.gender] || "未记录",
        value,
        ...(header.includes("outcome_span_days") ? [m.spanDays ?? ""] : []),
        m.missing ? MISSING_LABEL[m.missing] : "",
      ];
    });
    list.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    rows.push(...list);
  });
  return {
    title: comparison.title,
    outcome: describeOutcome(comparison.outcome),
    rows: rows.length,
    excluded: { overlap: overlap.patients, unclear: groups.reduce((s, g) => s + g.unclear, 0) },
    csv: [header, ...rows].map((row) => row.map(field).join(",")).join("\n"),
    note: "假名由本次导出的随机密钥生成，密钥不保存，编码无法还原；年龄由出生年份推算（≥90 记为 90），不含姓名、电话、病历号与绝对日期。小样本数据仍可能被间接识别，请按单位规定使用。",
  };
}

// 统计页顶部的一句话：本地患者库有什么数据。只给计数，不给逐人数据。
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
