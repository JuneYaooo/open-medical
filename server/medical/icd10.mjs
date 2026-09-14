import { check } from "../errors.mjs";

// Small built-in ICD-10 helper covering frequently used codes so the doctor
// can attach standardized diagnoses quickly. Not exhaustive — free-text
// diagnosis remains allowed and the assistant never "corrects" coding.
export const ICD10_COMMON = [
  ["I10", "原发性高血压"],
  ["I20", "稳定型心绞痛"],
  ["I21", "急性心肌梗死"],
  ["I25.2", "陈旧性心肌梗死"],
  ["I48", "心房颤动"],
  ["I50", "心力衰竭"],
  ["I63", "脑梗死"],
  ["I61", "脑出血"],
  ["E10", "1 型糖尿病"],
  ["E11", "2 型糖尿病"],
  ["E78.5", "高脂血症"],
  ["E03", "甲状腺功能减退"],
  ["E05", "甲状腺功能亢进"],
  ["J18", "肺炎"],
  ["J44", "慢性阻塞性肺疾病"],
  ["J45", "支气管哮喘"],
  ["K29", "胃炎"],
  ["K35", "急性阑尾炎"],
  ["K74", "肝硬化"],
  ["K80", "胆石症"],
  ["B18", "慢性乙型病毒性肝炎"],
  ["N18", "慢性肾脏病"],
  ["N39.0", "尿路感染"],
  ["C16", "胃癌"],
  ["C34", "肺癌"],
  ["C50", "乳腺癌"],
  ["C61", "前列腺癌"],
  ["G40", "癫痫"],
  ["G43", "偏头痛"],
  ["M17", "膝骨关节炎"],
  ["M54", "腰痛"],
  ["D64", "贫血"],
  ["F32", "抑郁发作"],
  ["F41", "焦虑障碍"],
  ["R07.4", "胸痛"],
];

export function searchIcd10(query, { limit = 10 } = {}) {
  check(
    Number.isInteger(limit) && limit >= 1 && limit <= 30,
    "INVALID_INPUT",
    "返回数量须为 1–30",
  );
  const text = String(query || "").trim().toLowerCase();
  if (!text) return [];
  const scored = [];
  for (const [code, name] of ICD10_COMMON) {
    const codeLower = code.toLowerCase();
    const nameLower = name.toLowerCase();
    if (codeLower === text) scored.push([3, code, name]);
    else if (codeLower.startsWith(text)) scored.push([2, code, name]);
    else if (nameLower.includes(text) || codeLower.includes(text))
      scored.push([1, code, name]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, code, name]) => ({ code, name }));
}
