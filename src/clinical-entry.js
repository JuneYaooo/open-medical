// Pure helpers for the clinical entry forms (vitals quick entry, structured
// visit notes). Kept free of React so they can be unit-tested in node.

// 生命体征按固定项目名与单位存为检验记录，复用现有趋势图；
// 名称与单位不可改，否则同一指标会被拆成两条趋势。
export const VITAL_FIELDS = [
  { key: "sbp", item: "收缩压", unit: "mmHg", label: "收缩压", min: 40, max: 300 },
  { key: "dbp", item: "舒张压", unit: "mmHg", label: "舒张压", min: 20, max: 200 },
  { key: "hr", item: "心率", unit: "次/分", label: "心率", min: 20, max: 250 },
  { key: "weight", item: "体重", unit: "kg", label: "体重", min: 1, max: 400 },
  { key: "fpg", item: "空腹血糖", unit: "mmol/L", label: "空腹血糖", min: 0.5, max: 60 },
];
export const VITAL_ITEMS = VITAL_FIELDS.map((field) => field.item);
export const emptyVitals = () => Object.fromEntries(VITAL_FIELDS.map((field) => [field.key, ""]));

// "148/86"、"148／86"、"148 / 86 mmHg" → { sbp: "148", dbp: "86" }
export function parseBloodPressure(text) {
  const match = String(text || "").trim().match(/^(\d{2,3}(?:\.\d+)?)\s*[/／]\s*(\d{2,3}(?:\.\d+)?)\s*(?:mmhg)?$/i);
  return match ? { sbp: match[1], dbp: match[2] } : null;
}

// Returns { labs } or { error }. Empty fields are skipped.
export function vitalLabs(vitals = {}, date, source = "") {
  const labs = [];
  for (const field of VITAL_FIELDS) {
    const raw = String(vitals[field.key] ?? "").trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) return { error: `${field.label}请输入数字` };
    if (value < field.min || value > field.max) return { error: `${field.label} ${raw} ${field.unit} 超出可录入范围（${field.min}–${field.max}），请核对` };
    labs.push({ item: field.item, value, unit: field.unit, date, ...(source ? { source } : {}) });
  }
  const sbp = labs.find((lab) => lab.item === "收缩压"), dbp = labs.find((lab) => lab.item === "舒张压");
  if (sbp && dbp && sbp.value <= dbp.value) return { error: "收缩压应高于舒张压，请核对" };
  return { labs };
}

// 多项检验录入：按最近日期取患者已有的不同项目（名称+单位）预填空行。
export const emptyLabRow = () => ({ item: "", value: "", unit: "", referenceRange: "" });
export function labPanelRows(labs = [], limit = 8) {
  const seen = new Set(), rows = [];
  const sorted = labs.map((lab, i) => [lab, i]).sort(([a, i], [b, j]) => String(b.date || "").localeCompare(String(a.date || "")) || j - i);
  for (const [lab] of sorted) {
    const item = String(lab.item || "").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    rows.push({ ...emptyLabRow(), item, unit: lab.unit || "" });
    if (rows.length >= limit) break;
  }
  return rows.length ? rows : [emptyLabRow()];
}

// Returns { labs } or { error }. 未填数值的行忽略；「血压 148/86」拆成两条。
export function batchLabs(rows = [], date, source = "") {
  if (!date) return { error: "请填写检验日期" };
  const labs = [];
  for (const row of rows) {
    const raw = String(row.value ?? "").trim();
    if (!raw) continue;
    const item = String(row.item || "").trim();
    if (!item) return { error: `数值 ${raw} 缺少项目名称` };
    const bp = /^血压$/.test(item) ? parseBloodPressure(raw) : null;
    if (bp) {
      const result = vitalLabs(bp, date, source);
      if (result.error) return result;
      labs.push(...result.labs);
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) return { error: `${item}：请输入数字；阴性、<0.01 等结果请上传原报告到资料库` };
    const unit = String(row.unit || "").trim(), referenceRange = String(row.referenceRange || "").trim();
    labs.push({ item, value, ...(unit ? { unit } : {}), date, ...(source ? { source } : {}), ...(referenceRange ? { referenceRange } : {}) });
  }
  if (!labs.length) return { error: "请至少填写一项数值" };
  return { labs };
}

export const VISIT_SECTIONS = [
  { key: "complaint", label: "主诉", rows: 1 },
  { key: "history", label: "现病史", rows: 2 },
  { key: "exam", label: "查体", rows: 2 },
  { key: "assessment", label: "评估", rows: 2 },
  { key: "plan", label: "计划", rows: 2 },
];
export const emptyVisitSections = () => Object.fromEntries(VISIT_SECTIONS.map((section) => [section.key, ""]));

// 分项内容按「主诉：…」逐行拼成就诊备注，空项不写。
export function serializeVisitSections(sections = {}) {
  return VISIT_SECTIONS
    .map(({ key, label }) => [label, String(sections[key] || "").trim()])
    .filter(([, text]) => text)
    .map(([label, text]) => `${label}：${text}`)
    .join("\n");
}

// Pull a labelled section back out of a saved note (e.g. "计划").
export function visitNoteSection(note, label) {
  const labels = VISIT_SECTIONS.map((section) => section.label).join("|");
  const match = String(note || "").match(new RegExp(`(?:^|\\n)${label}：([\\s\\S]*?)(?=\\n(?:${labels})：|$)`));
  return match ? match[1].trim() : "";
}
