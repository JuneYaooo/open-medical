// Deterministic patient-material classification for the report-folder view.
// Keyword rules over the file name (highest signal) then the extracted text
// head; the result is a suggestion the doctor confirms — never a final write.
export const MATERIAL_CATEGORIES = ["检验报告", "影像报告", "门诊病历", "住院记录", "用药记录", "其他"];

const RULES = [
  { category: "用药记录", keywords: ["处方", "用药医嘱", "用药清单", "医嘱单", "用药记录"] },
  { category: "检验报告", keywords: ["检验", "化验", "血常规", "生化", "肝功", "肾功", "甲功", "凝血功能", "肿瘤标志物", "血气", "尿常规", "免疫检验", "糖化血红蛋白"] },
  { category: "影像报告", keywords: ["CT", "MRI", "磁共振", "超声", "B超", "X线", "X光", "DR", "造影", "影像", "病理", "PET", "心电图报告"] },
  { category: "住院记录", keywords: ["出院记录", "出院小结", "住院记录", "入院记录", "手术记录", "病程记录", "住院病历"] },
  { category: "门诊病历", keywords: ["门诊病历", "急诊病历", "门诊记录", "就诊记录", "诊疗记录"] },
];

const normalize = (value) => String(value || "").toLowerCase();

// First matching rule wins; the file name outranks the text body because it
// usually states the document type explicitly (「生化检验报告单.pdf」).
export function classifyMaterial({ name, text } = {}) {
  const hayName = normalize(name);
  const hayText = normalize(text).slice(0, 6000);
  for (const source of [
    { haystack: hayName, field: "文件名" },
    { haystack: hayText, field: "正文" },
  ]) {
    if (!source.haystack) continue;
    for (const rule of RULES)
      for (const keyword of rule.keywords)
        if (source.haystack.includes(keyword.toLowerCase()))
          return { category: rule.category, reason: `${source.field}含「${keyword}」` };
  }
  return null;
}

const DATE_RE = /(\d{4})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})/;

// Best-effort document date from the file name, then the text head; the
// doctor always confirms the final value in the folder view.
export function suggestDocumentDate({ name, text } = {}) {
  for (const source of [normalize(name), normalize(text).slice(0, 3000)]) {
    const match = source.match(DATE_RE);
    if (!match) continue;
    const [, y, m, d] = match;
    const year = Number(y), month = Number(m), day = Number(d);
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) continue;
    const iso = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (Number.isFinite(Date.parse(iso))) return iso;
  }
  return null;
}
