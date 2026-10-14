// Canonical short summary uses the existing sourced text contract, so proposal
// review, exports and older clients continue to carry every word.
export const SUMMARY_FIELDS = [
  ['current', '当前状态'], ['problems', '主要问题'], ['course', '病程演变'],
];
export const SUMMARY_LIMIT = 120;
export function parseClinicalSummary(text = '') {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length !== 3) return null;
  const result = {};
  for (let i = 0; i < SUMMARY_FIELDS.length; i++) {
    const [key, label] = SUMMARY_FIELDS[i];
    if (!lines[i].startsWith(`${label}：`)) return null;
    const value = lines[i].slice(label.length + 1).trim();
    if (!value || value.length > SUMMARY_LIMIT) return null;
    result[key] = value;
  }
  return result;
}
export function formatClinicalSummary(fields) {
  return SUMMARY_FIELDS.map(([key, label]) => `${label}：${fields[key].trim().replace(/\s*\n\s*/g, ' ')}`).join('\n');
}

export const CLINICAL_SUMMARY_INSTRUCTION = 'clinicalSummary 的 text 固定为三行：当前状态：…\n主要问题：…\n病程演变：…。每行正文最多 120 字，通常 1–2 句，依次回答截至最近哪次记录患者状态如何、当前主要症状或功能问题是什么、起病到关键治疗及近期变化如何。只保留影响理解的临床事实和关键日期，疑似不改为确诊；未记录的信息如实标明，不能当作正常。不要罗列全部检查、复制长病历或混入身份核对、导入异常、OCR 错误、资料冲突清单；这些资料问题单独写 note。source 单独记录可回查的文件名与页码或行号。';
