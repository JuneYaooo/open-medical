// 脱敏分享的纯展示层：report 结构 → 打印 HTML（桌面 printToPDF 与浏览器
// 打印回退共用同一模板），以及分享记录 → report 的组装。不引入 Node 专有
// 模块，渲染进程可以直接打包。打码标记统一渲染成高亮 <mark>。
export const SHARE_SECTIONS = [
  ["diagnoses", "诊断"],
  ["medications", "用药"],
  ["allergies", "过敏"],
  ["labs", "检验"],
  ["visits", "就诊"],
];
export const REDACT_MARK = "［已脱敏］";
export const FINDING_LABELS = [
  ["identity", "姓名等身份字样"],
  ["idNumber", "身份证号"],
  ["phone", "手机号"],
  ["landline", "座机号码"],
  ["longNumber", "住院号/病历号等长编号"],
];
const GENDER = { male: "男", female: "女", unknown: "性别未登记" };
const ALLERGY = { none_known: "无已知过敏", recorded: "已记录过敏原", unknown: "过敏状态未核对" };
const MED_STATUS = { active: "在用", stopped: "已停用", unknown: "使用情况不详" };
const DIAG_STATUS = { confirmed: "确诊", suspected: "疑似", finding: "影像/检验发现", needs_review: "待核对" };

const pair = (label, value) => (value === undefined || value === null || value === "" ? null : [label, String(value)]);
const joinPairs = (pairs) => pairs.filter(Boolean).map(([, value]) => value).join(" · ");

export function buildShareSections(record) {
  const allergies = record.allergies?.length
    ? record.allergies.map((a) => [a.name || "过敏原", joinPairs([pair("反应", a.reaction), pair("严重度", a.severity)]) || "已记录"])
    : [["过敏状态", ALLERGY[record.allergyStatus] || record.allergyStatus || "未核对"]];
  const sections = [
    { heading: "诊断", rows: (record.diagnoses || []).map((d) => [
      d.name || "诊断",
      joinPairs([pair("编码", d.code), pair("日期", d.date), pair("状态", DIAG_STATUS[d.status] || d.status), pair("说明", d.note)]),
    ]) },
    { heading: "用药", rows: (record.medications || []).map((m) => [
      m.name || "用药",
      joinPairs([pair("剂量", m.dose), pair("频次", m.frequency), pair("状态", MED_STATUS[m.status] || m.status)]),
    ]) },
    { heading: "过敏", rows: allergies },
    { heading: "检验", rows: (record.labs || []).map((l) => [
      l.item || "检验",
      joinPairs([pair("结果", `${l.value}${l.unit || ""}`), pair("日期", l.date)]),
    ]) },
    { heading: "就诊", rows: (record.visits || []).map((v) => [
      v.date || "就诊",
      v.reason || "",
    ]) },
  ].map(({ heading, rows }) => ({ heading, rows: rows.filter(([, value]) => value) }));
  const overview = {
    heading: "概况",
    rows: [
      pair("假名编号", record.pseudoId),
      pair("性别", GENDER[record.gender] || record.gender),
      pair("年龄段", record.ageBand ? `${record.ageBand} 岁` : ""),
    ].filter(Boolean),
  };
  return [overview, ...sections];
}

export function renderShareHtml({ title, subtitle, sections, note, footer }) {
  const escape = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );
  const mark = (value) => escape(value).replace(new RegExp(REDACT_MARK, "g"), (token) => `<mark>${token}</mark>`);
  const body = sections
    .filter((section) => section.rows.length)
    .map(
      (section) => `<section><h2>${escape(section.heading)}</h2><ul>${section.rows
        .map(([label, value]) => `<li><span>${escape(label)}</span><strong>${mark(value)}</strong></li>`)
        .join("")}</ul></section>`,
    )
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(title)}</title><style>
    @page { margin: 18mm 16mm; }
    body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: #1d2b25; margin: 0; }
    header { border-bottom: 2px solid #263831; padding-bottom: 10px; margin-bottom: 16px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    header p { margin: 0; color: #68786e; font-size: 12px; }
    section { break-inside: avoid; margin-bottom: 14px; }
    h2 { font-size: 14px; margin: 0 0 6px; color: #263831; border-left: 3px solid #263831; padding-left: 8px; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { display: flex; gap: 12px; padding: 4px 0; border-bottom: 1px dashed #e2e8e0; font-size: 12px; }
    li span { flex: 0 0 120px; color: #68786e; }
    li strong { font-weight: 400; overflow-wrap: anywhere; }
    mark { background: #fde68a; padding: 0 3px; border-radius: 3px; }
    footer { margin-top: 18px; padding-top: 10px; border-top: 1px solid #d8e1d7; color: #68786e; font-size: 11px; line-height: 1.7; white-space: pre-wrap; }
  </style></head><body>
  <header><h1>${escape(title)}</h1><p>${escape(subtitle || "")}</p></header>
  ${body}
  <footer>${mark(note || "")}${footer ? `\n${escape(footer)}` : ""}</footer>
  </body></html>`;
}
