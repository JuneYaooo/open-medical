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

// Common brand-name -> generic-name pairs (药品对码的医生版). Matching and
// duplicate detection run on the canonical generic so "拜阿司匹灵" and
// "阿司匹林肠溶片" are recognised as the same substance. Not a complete
// drug dictionary — extendable via this table.
export const DRUG_ALIASES = [
  ["拜阿司匹灵", "阿司匹林"], ["巴米尔", "阿司匹林"],
  ["芬必得", "布洛芬"], ["美林", "布洛芬"],
  ["扶他林", "双氯芬酸"], ["消炎痛", "吲哚美辛"],
  ["泰诺", "对乙酰氨基酚"], ["必理通", "对乙酰氨基酚"], ["散利痛", "对乙酰氨基酚"],
  ["西乐葆", "塞来昔布"],
  ["络活喜", "氨氯地平"], ["拜新同", "硝苯地平"], ["波依定", "非洛地平"],
  ["倍他乐克", "美托洛尔"],
  ["科素亚", "氯沙坦"], ["代文", "缬沙坦"], ["安博维", "厄贝沙坦"],
  ["开博通", "卡托普利"], ["洛汀新", "贝那普利"],
  ["立普妥", "阿托伐他汀"], ["舒降之", "辛伐他汀"], ["可定", "瑞舒伐他汀"],
  ["波立维", "氯吡格雷"], ["泰嘉", "氯吡格雷"],
  ["拜瑞妥", "利伐沙班"], ["泰毕全", "达比加群"],
  ["可达龙", "胺碘酮"],
  ["速尿", "呋塞米"], ["安体舒通", "螺内酯"],
  ["格华止", "二甲双胍"], ["拜唐苹", "阿卡波糖"], ["亚莫利", "格列美脲"],
  ["优甲乐", "左甲状腺素"],
  ["洛赛克", "奥美拉唑"], ["耐信", "埃索美拉唑"], ["达喜", "铝碳酸镁"],
  ["开瑞坦", "氯雷他定"], ["仙特明", "西替利嗪"],
  ["希刻劳", "头孢克洛"], ["罗氏芬", "头孢曲松"], ["凯福隆", "头孢噻肟"],
  ["可乐必妥", "左氧氟沙星"],
  ["强的松", "泼尼松"],
  ["鲁南欣康", "单硝酸异山梨酯"], ["消心痛", "硝酸异山梨酯"],
];

// Canonical substance name for a raw medication string: brand aliases map
// to their generic; names containing a known generic (e.g. "阿司匹林肠溶片")
// reduce to that generic so duplicates surface across dosage forms.
const GENERIC_VALUES = [...new Set(DRUG_ALIASES.map(([, generic]) => generic))].sort(
  (a, b) => b.length - a.length,
);
export function canonicalDrugName(name) {
  const lower = normalizeName(name);
  for (const [alias, generic] of DRUG_ALIASES)
    if (lower.includes(alias)) return generic;
  for (const generic of GENERIC_VALUES)
    if (lower.includes(generic.toLowerCase())) return generic;
  return String(name || "").trim();
}

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
  const entries = medications
    .map((med) => (typeof med === "string" ? med : med?.name))
    .filter((name) => typeof name === "string" && name.trim())
    .map((raw) => ({ raw, canonical: canonicalDrugName(raw) }));
  const canonicalList = entries.map((entry) => entry.canonical);
  const allergyMatches = [];
  for (const allergy of allergies) {
    const needle = normalizeName(allergy);
    if (!needle) continue;
    for (const entry of entries.filter((item) =>
      normalizeName(item.canonical).includes(needle),
    ))
      allergyMatches.push({
        allergy,
        medication: entry.raw,
        matchedGeneric: entry.canonical,
        severity: "critical",
        message: `用药「${entry.raw}」（${entry.canonical}）与过敏史「${allergy}」匹配，请立即核对。`,
      });
  }
  const interactions = [];
  for (const pair of INTERACTION_PAIRS) {
    const hasA = entries.find((entry) =>
      normalizeName(entry.canonical).includes(pair.a.toLowerCase()),
    );
    const hasB = entries.find((entry) =>
      normalizeName(entry.canonical).includes(pair.b.toLowerCase()),
    );
    if (hasA && hasB)
      interactions.push({
        ruleKey: pair.key,
        severity: pair.severity,
        title: pair.title,
        message: pair.message,
        medications: [hasA.raw, hasB.raw],
      });
  }
  const counts = new Map();
  for (const entry of entries) {
    const key = normalizeName(entry.canonical);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({
      medication: name,
      count,
      severity: "warning",
      message: `「${name}」的不同写法/规格共出现 ${count} 次，请核对是否重复开具。`,
    }));
  return {
    checked: entries.length,
    normalized: canonicalList,
    allergyMatches,
    interactions,
    duplicates,
    total: allergyMatches.length + interactions.length + duplicates.length,
    note: "内置规则集与药品别名为常见示例，非穷尽；结果为提示性草稿，需药师或医生结合临床复核，不构成用药建议。",
  };
}
