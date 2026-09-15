import { check } from "../errors.mjs";

// Deterministic medication-safety screening shared by the patient risk
// engine and the standalone check tool/workflow. The built-in interaction
// pairs are intentionally small and clearly labelled non-exhaustive —
// results are advisory drafts for clinician/pharmacist review, never a
// substitute for a full drug knowledge base.
export const INTERACTION_PAIRS = [
  {
    key: "int_aspirin_warfarin",
    a: "阿司匹林",
    b: "华法林",
    severity: "warning",
    title: "抗栓药物联用",
    message: "阿司匹林与华法林联用会增加出血风险，请核对适应证与监测计划。",
  },
  {
    key: "int_digoxin_furosemide",
    a: "地高辛",
    b: "呋塞米",
    severity: "warning",
    title: "洋地黄与排钾利尿剂联用",
    message: "呋塞米可致低钾而增加洋地黄中毒风险，建议监测血钾与地高辛浓度。",
  },
  {
    key: "int_simvastatin_clarithromycin",
    a: "辛伐他汀",
    b: "克拉霉素",
    severity: "warning",
    title: "他汀与大环内酯类联用",
    message: "克拉霉素显著升高他汀血药浓度，横纹肌溶解风险增加。",
  },
  {
    key: "int_li_nsaids",
    a: "碳酸锂",
    b: "布洛芬",
    severity: "warning",
    title: "锂盐与 NSAIDs 联用",
    message: "NSAIDs 可升高锂盐血药浓度，增加锂中毒风险，建议监测锂浓度。",
  },
  {
    key: "int_maoi_ssc",
    a: "苯乙肼",
    b: "氟西汀",
    severity: "critical",
    title: "MAOI 与 SSRI 联用",
    message: "MAOI 与 SSRI 联用有 5-羟色胺综合征风险，原则上禁止联用。",
  },
];

const normalizeName = (value) => String(value || "").trim().toLowerCase();

export function evaluateMedicationSafety({ medications = [], allergies = [] } = {}) {
  check(
    Array.isArray(medications) && medications.length <= 60,
    "INVALID_INPUT",
    "用药清单最多 60 条",
  );
  check(
    Array.isArray(allergies) && allergies.length <= 20,
    "INVALID_INPUT",
    "过敏史最多 20 条",
  );
  const names = medications
    .map((med) => (typeof med === "string" ? med : med?.name))
    .filter((name) => typeof name === "string" && name.trim());
  const allergyMatches = [];
  for (const allergy of allergies) {
    const needle = normalizeName(allergy);
    if (!needle) continue;
    for (const hit of names.filter((name) =>
      normalizeName(name).includes(needle),
    ))
      allergyMatches.push({
        allergy,
        medication: hit,
        severity: "critical",
        message: `用药「${hit}」与过敏史「${allergy}」匹配，请立即核对。`,
      });
  }
  const interactions = [];
  for (const pair of INTERACTION_PAIRS) {
    const hasA = names.find((name) => normalizeName(name).includes(pair.a.toLowerCase()));
    const hasB = names.find((name) => normalizeName(name).includes(pair.b.toLowerCase()));
    if (hasA && hasB)
      interactions.push({
        ruleKey: pair.key,
        severity: pair.severity,
        title: pair.title,
        message: pair.message,
        medications: [hasA, hasB],
      });
  }
  const counts = new Map();
  for (const name of names) {
    const key = normalizeName(name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({
      medication: name,
      count,
      severity: "warning",
      message: `「${name}」出现 ${count} 次，请核对是否重复开具。`,
    }));
  return {
    checked: names.length,
    allergyMatches,
    interactions,
    duplicates,
    total: allergyMatches.length + interactions.length + duplicates.length,
    note: "内置规则集为常见示例，非穷尽；结果为提示性草稿，需药师或医生结合临床复核，不构成用药建议。",
  };
}
