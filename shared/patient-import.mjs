const headers = { 姓名: "name", 患者姓名: "name", name: "name", 患者编号: "patientNumber", 编号: "patientNumber", patientnumber: "patientNumber", 性别: "gender", gender: "gender", 出生年份: "birthYear", birthyear: "birthYear", 电话: "phone", 联系电话: "phone", phone: "phone", 分组: "groups", groups: "groups", 标签: "tags", tags: "tags" };
export const PATIENT_IMPORT_TEMPLATE = "姓名,患者编号,性别,出生年份,电话,分组,标签\n";

// Small RFC-style quoted cell parser for CSV and tab-separated Excel paste.
// Reject malformed quoting; never execute spreadsheet expressions.
export function parsePatientImport(text) {
  if (typeof text !== "string" || !text.trim() || text.length > 200000) throw new Error("请提供 200KB 以内的患者表格文本");
  text = text.replace(/^\uFEFF/, "");
  const first = text.split(/\r?\n/, 1)[0], delimiter = first.includes("\t") ? "\t" : ",";
  const rows = []; let row = [], cell = "", quoted = false, closed = false;
  const pushCell = () => { row.push(cell.trim()); cell = ""; closed = false; };
  const pushRow = () => { pushCell(); if (row.some(Boolean)) rows.push(row); row = []; if (rows.length > 201) throw new Error("一次最多导入 200 位患者，请分批处理"); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += char;
    } else if (char === delimiter) pushCell();
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[i + 1] === "\n") i++; pushRow(); }
    else if (char === '"' && !cell && !closed) quoted = true;
    else { if (closed && char.trim() || char === '"') throw new Error("表格引号格式不正确，请使用 CSV 模板或直接粘贴 Excel 单元格"); cell += char; }
  }
  if (quoted) throw new Error("表格中有未闭合的引号");
  if (cell || row.length) pushRow();
  const columns = rows.shift()?.map((name) => Object.hasOwn(headers, name.toLowerCase()) ? headers[name.toLowerCase()] : undefined);
  if (!columns?.includes("name")) throw new Error("首行必须包含「姓名」列，请下载模板核对表头");
  if (columns.some((key) => !key) || new Set(columns).size !== columns.length) throw new Error("表头包含未知列或重复列；仅支持姓名、患者编号、性别、出生年份、电话、分组、标签");
  if (!rows.length) throw new Error("表格中没有患者记录");
  return rows.map((cells, index) => {
    const input = Object.fromEntries(columns.map((key, i) => [key, cells[i] || ""]));
    const errors = [];
    if (cells.length !== columns.length) errors.push("列数与表头不一致");
    if (!input.name?.trim() || input.name.length > 80) errors.push("姓名须为 1–80 字");
    for (const [key, label, max] of [["patientNumber", "编号", 40], ["phone", "电话", 20]]) if ((input[key] || "").length > max) errors.push(`${label}过长`);
    if (input.gender) { const choices = { 男: "male", 女: "female", 未知: "unknown", male: "male", female: "female", unknown: "unknown" }; const value = Object.hasOwn(choices, input.gender.toLowerCase()) ? choices[input.gender.toLowerCase()] : undefined; if (!value) errors.push("性别请填写男、女或未知"); input.gender = value; } else delete input.gender;
    if (input.birthYear) { if (!/^\d{4}$/.test(input.birthYear) || +input.birthYear < 1900 || +input.birthYear > new Date().getFullYear()) errors.push("出生年份无效"); input.birthYear = Number(input.birthYear); } else delete input.birthYear;
    for (const [key, max] of [["groups", 10], ["tags", 20]]) {
      input[key] = [...new Set((input[key] || "").split(/[，,;；]/).map((s) => s.trim()).filter(Boolean))];
      if (input[key].length > max || input[key].some((value) => value.length > 40)) errors.push(`${key === "groups" ? "分组" : "标签"}数量或长度超限`);
    }
    if (!input.phone) delete input.phone;
    return { row: index + 2, input, errors };
  });
}
