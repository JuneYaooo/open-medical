import { check, string } from "../errors.mjs";

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


// Known adverse-reaction profiles for frequently used drug groups, keyed by
// canonical-name substrings. This is a screening aid built from common
// clinical knowledge — not a substitute for the label or pharmacovigilance
// databases; causality should be assessed with the Naranjo scale.
export const ADR_PROFILES = [
  { pattern: "普利", drugClass: "ACEI", reactions: ["干咳", "高钾血症", "血钾升高", "血钾偏高", "血肌酐升高", "血肌酐偏高", "肾功能恶化", "血管性水肿"], monitoring: ["血钾", "血肌酐"] },
  { pattern: "沙坦", drugClass: "ARB", reactions: ["高钾血症", "血钾升高", "血肌酐升高", "头晕"], monitoring: ["血钾", "血肌酐"] },
  { pattern: "地平", drugClass: "CCB", reactions: ["踝部水肿", "面部潮红", "头痛", "牙龈增生"], monitoring: ["血压"] },
  { pattern: "美托洛尔", drugClass: "β受体阻滞剂", reactions: ["心动过缓", "乏力", "支气管痉挛"], monitoring: ["心率"] },
  { pattern: "他汀", drugClass: "他汀类", reactions: ["肌痛", "肌无力", "横纹肌溶解", "转氨酶升高", "肝功能异常"], monitoring: ["肌酸激酶 CK", "肝功能"] },
  { pattern: "二甲双胍", drugClass: "双胍类", reactions: ["恶心", "腹泻", "乳酸酸中毒", "维生素b12缺乏"], monitoring: ["肾功能", "维生素 B12"] },
  { pattern: "列净", drugClass: "SGLT2抑制剂", reactions: ["泌尿系感染", "外阴阴道炎", "酮症酸中毒", "脱水"], monitoring: ["酮体", "血糖"] },
  { pattern: "列汀", drugClass: "DPP-4抑制剂", reactions: ["鼻咽炎", "胰腺炎"], monitoring: ["淀粉酶"] },
  { pattern: "呋塞米", drugClass: "袢利尿剂", reactions: ["低钾血症", "血钾降低", "低钠血症", "耳毒性", "高尿酸"], monitoring: ["电解质", "听力"] },
  { pattern: "螺内酯", drugClass: "醛固酮拮抗剂", reactions: ["高钾血症", "血钾升高", "男性乳房发育"], monitoring: ["血钾"] },
  { pattern: "地高辛", drugClass: "洋地黄类", reactions: ["恶心", "黄视", "绿视", "心律失常", "心动过缓"], monitoring: ["地高辛浓度", "血钾"] },
  { pattern: "华法林", drugClass: "维生素K拮抗剂", reactions: ["出血", "牙龈出血", "皮下瘀斑", "inr升高"], monitoring: ["INR"] },
  { pattern: "利伐沙班", drugClass: "Xa因子抑制剂", reactions: ["出血", "消化道出血"], monitoring: ["血红蛋白"] },
  { pattern: "胺碘酮", drugClass: "胺碘酮", reactions: ["甲状腺功能异常", "肺纤维化", "咳嗽", "qt延长", "心动过缓", "角膜色素沉着"], monitoring: ["甲状腺功能", "胸片/肺功能", "心电图 QT"] },
  { pattern: "奥美拉唑", drugClass: "质子泵抑制剂", reactions: ["头痛", "腹泻", "低镁血症", "维生素b12缺乏", "骨折风险增加"], monitoring: ["血镁"] },
  { pattern: "阿司匹林", drugClass: "抗血小板", reactions: ["上腹不适", "黑便", "消化道出血", "过敏", "哮喘发作"], monitoring: ["血红蛋白", "大便潜血"] },
  { pattern: "氯吡格雷", drugClass: "抗血小板", reactions: ["出血", "消化道出血", "皮疹"], monitoring: ["血红蛋白"] },
  { pattern: "泼尼松", drugClass: "糖皮质激素", reactions: ["血糖升高", "向心性肥胖", "骨质疏松", "感染风险增加", "消化道溃疡"], monitoring: ["血糖", "骨密度（长期）"] },
  { pattern: "氟西汀", drugClass: "SSRI", reactions: ["恶心", "失眠", "qt延长", "5-羟色胺综合征"], monitoring: ["心电图"] },
  { pattern: "克拉霉素", drugClass: "大环内酯类", reactions: ["恶心", "qt延长", "肝功能异常", "味觉异常"], monitoring: ["心电图", "肝功能"] },
  { pattern: "左氧氟沙星", drugClass: "喹诺酮类", reactions: ["肌腱炎", "跟腱疼痛", "跟腱断裂", "qt延长", "失眠", "血糖波动"], monitoring: ["心电图", "肌腱症状"] },
  { pattern: "头孢", drugClass: "头孢菌素类", reactions: ["过敏", "皮疹", "腹泻", "双硫仑样反应"], monitoring: ["过敏史询问"] },
  { pattern: "青霉素", drugClass: "青霉素类", reactions: ["过敏性休克", "皮疹", "过敏"], monitoring: ["皮试"] },
  { pattern: "异烟肼", drugClass: "抗结核", reactions: ["肝功能异常", "转氨酶升高", "周围神经病变"], monitoring: ["肝功能"] },
  { pattern: "利福平", drugClass: "抗结核", reactions: ["肝功能异常", "转氨酶升高", "体液橙染"], monitoring: ["肝功能"] },
  { pattern: "碳酸锂", drugClass: "心境稳定剂", reactions: ["震颤", "锂中毒", "口渴", "多尿", "甲状腺功能异常"], monitoring: ["血锂浓度", "甲状腺功能"] },
  { pattern: "甲氨蝶呤", drugClass: "抗代谢类", reactions: ["口腔溃疡", "骨髓抑制", "肝功能异常", "肺纤维化"], monitoring: ["血常规", "肝功能"] },
];

// Special-population cautions (indicative, label-verification required).
export const SPECIAL_POPULATION_RULES = [
  { pattern: "华法林", population: "pregnancy", caution: "妊娠期禁用（致畸与出血风险），需换用抗凝方案。", label: "妊娠" },
  { pattern: "普利", population: "pregnancy", caution: "妊娠期禁用（胎儿肾毒性/致畸）。", label: "妊娠" },
  { pattern: "沙坦", population: "pregnancy", caution: "妊娠期禁用（胎儿肾毒性/致畸）。", label: "妊娠" },
  { pattern: "他汀", population: "pregnancy", caution: "妊娠期原则上停用。", label: "妊娠" },
  { pattern: "左氧氟沙星", population: "pediatric", caution: "18 岁以下一般避免（软骨发育影响）。", label: "儿童" },
  { pattern: "阿司匹林", population: "pediatric", caution: "病毒感染发热的儿童慎用（Reye 综合征风险）。", label: "儿童" },
  { pattern: "二甲双胍", population: "renal", caution: "eGFR<30 禁用，30–45 减量并评估（乳酸酸中毒风险）。", label: "肾功能不全" },
  { pattern: "地高辛", population: "renal", caution: "肾功能下降时蓄积中毒，需减量并监测浓度。", label: "肾功能不全" },
  { pattern: "碳酸锂", population: "renal", caution: "经肾排泄，肾功能下降需减量并监测血锂。", label: "肾功能不全" },
  { pattern: "呋塞米", population: "elderly", caution: "老年患者注意脱水、电解质紊乱与体位性低血压。", label: "老年" },
  { pattern: "地西泮", population: "elderly", caution: "老年患者跌倒与认知影响风险，尽量短用。", label: "老年" },
  { pattern: "对乙酰氨基酚", population: "hepatic", caution: "肝功能不全者减量并限制总量（肝毒性）。", label: "肝功能不全" },
];

// Match presented findings against known reaction keywords for the patient's
// medications. Screening only — causality needs the Naranjo workup.
export function assessAdverseReaction({ medications = [], findings = "" } = {}) {
  const entries = medications
    .map((med) => (typeof med === "string" ? med : med?.name))
    .filter((name) => typeof name === "string" && name.trim())
    .map((raw) => ({ raw, canonical: canonicalDrugName(raw) }));
  check(entries.length >= 1, "INVALID_INPUT", "请提供至少 1 种当前用药");
  check(
    entries.length <= 60,
    "INVALID_INPUT",
    "用药清单最多 60 条",
  );
  const findingsText = string(findings, "临床表现", 3000);
  const lowerFindings = findingsText.toLowerCase();
  const suspected = [];
  const profiles = [];
  const seenProfiles = new Set();
  for (const entry of entries) {
    for (const profile of ADR_PROFILES) {
      if (!entry.canonical.includes(profile.pattern) && !normalizeName(entry.raw).includes(profile.pattern))
        continue;
      const key = profile.pattern;
      if (!seenProfiles.has(key)) {
        seenProfiles.add(key);
        profiles.push({
          drugClass: profile.drugClass,
          matchedMedications: entries
            .filter((e) => e.canonical.includes(profile.pattern))
            .map((e) => e.raw),
          knownReactions: profile.reactions,
          monitoring: profile.monitoring,
        });
      }
      for (const reaction of profile.reactions)
        if (lowerFindings.includes(reaction.toLowerCase()))
          suspected.push({
            medication: entry.raw,
            drugClass: profile.drugClass,
            reaction,
            message: `「${entry.raw}」（${profile.drugClass}）已知不良反应包含「${reaction}」，与临床表现相符，建议核查。`,
            monitoring: profile.monitoring,
          });
    }
  }
  const distinctSuspected = [];
  const seen = new Set();
  for (const item of suspected) {
    const key = `${item.medication}:${item.reaction}`;
    if (!seen.has(key)) {
      seen.add(key);
      distinctSuspected.push(item);
    }
  }
  return {
    findings: findingsText,
    suspected: distinctSuspected,
    drugProfiles: profiles,
    total: distinctSuspected.length,
    note: "不良反应筛查为提示性结果，不构成因果判定；请用 Naranjo 量表评估因果关系并按说明书/药物警戒数据库核实。",
  };
}

// Indicative special-population cautions for the current medication list.
export function specialPopulationCautions({ medications = [], populations = [] } = {}) {
  const validPopulations = ["pregnancy", "pediatric", "renal", "hepatic", "elderly"];
  check(
    Array.isArray(populations) &&
      populations.length >= 1 &&
      populations.length <= validPopulations.length &&
      populations.every((p) => validPopulations.includes(p)),
    "INVALID_INPUT",
    `populations 须为以下之一或组合：${validPopulations.join("/")}`,
  );
  const labels = {
    pregnancy: "妊娠",
    pediatric: "儿童",
    renal: "肾功能不全",
    hepatic: "肝功能不全",
    elderly: "老年",
  };
  const entries = medications
    .map((med) => (typeof med === "string" ? med : med?.name))
    .filter((name) => typeof name === "string" && name.trim())
    .map((raw) => ({ raw, canonical: canonicalDrugName(raw) }));
  const cautions = [];
  for (const entry of entries)
    for (const rule of SPECIAL_POPULATION_RULES) {
      if (!populations.includes(rule.population)) continue;
      const target = normalizeName(entry.canonical);
      if (target.includes(rule.pattern) || normalizeName(entry.raw).includes(rule.pattern))
        cautions.push({
          medication: entry.raw,
          population: rule.population,
          populationLabel: labels[rule.population],
          caution: rule.caution,
        });
    }
  return {
    populations: populations.map((p) => labels[p]),
    cautions,
    total: cautions.length,
    note: "特殊人群用药提示为示例规则，非穷尽；开药前请以说明书与最新指南为准。",
  };
}
