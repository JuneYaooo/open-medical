import { patientPhone } from "./patient-phone.mjs";
const headers = { 姓名: "name", 患者姓名: "name", name: "name", 患者编号: "patientNumber", 编号: "patientNumber", patientnumber: "patientNumber", 性别: "gender", gender: "gender", 出生年份: "birthYear", birthyear: "birthYear", 年龄: "age", age: "age", 电话: "phone", 联系电话: "phone", phone: "phone", 分组: "groups", groups: "groups", 标签: "tags", tags: "tags" };
export const PATIENT_IMPORT_TEMPLATE = "姓名,患者编号,性别,出生年份,电话,分组,标签\n";

// Small RFC-style quoted cell parser for CSV and tab-separated Excel paste.
// Reject malformed quoting; never execute spreadsheet expressions.
// Returns only the rows; use parsePatientImportTable to also learn which
// header columns were not recognised and therefore skipped.
export function parsePatientImport(text, options) {
  return parsePatientImportTable(text, options).rows;
}

// Unknown columns (e.g. 住址、备注 exported from another system) are skipped
// instead of rejecting the whole sheet; their header names are returned so the
// preview can say 「已忽略列：…」. 年龄 is converted to an estimated birth year.
export function parsePatientImportTable(text, { currentYear = new Date().getFullYear() } = {}) {
  if (typeof text !== "string" || !text.trim() || new TextEncoder().encode(text).length > 200000) throw new Error("请提供 200KB 以内的患者表格文本");
  text = text.replace(/^\uFEFF/, "");
  const first = text.split(/\r?\n/, 1)[0], delimiter = first.includes("\t") ? "\t" : ",";
  const rows = [], lineNumbers = []; let row = [], cell = "", quoted = false, closed = false, line = 1, rowStart = 1;
  const pushCell = () => { row.push(cell); cell = ""; closed = false; };
  const pushRow = () => { pushCell(); if (row.some(value => value.trim())) { rows.push(row); lineNumbers.push(rowStart); } row = []; if (rows.length > 201) throw new Error("一次最多导入 200 位患者，请分批处理"); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else { cell += char; if (char === "\n" || char === "\r" && text[i + 1] !== "\n") line++; }
    } else if (char === delimiter) pushCell();
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[i + 1] === "\n") i++; pushRow(); line++; rowStart = line; }
    else if (char === '"' && !cell && !closed) quoted = true;
    else { if (closed && char.trim() || char === '"') throw new Error("表格引号格式不正确，请使用 CSV 模板或直接粘贴 Excel 单元格"); cell += char; }
  }
  if (quoted) throw new Error("表格中有未闭合的引号");
  if (cell || row.length) pushRow();
  const headerCells = rows.shift() || [];
  const columns = headerCells.map((name) => Object.hasOwn(headers, name.trim().toLowerCase()) ? headers[name.trim().toLowerCase()] : undefined);
  if (!columns.includes("name")) throw new Error("首行必须包含「姓名」列，请下载模板核对表头");
  const known = columns.filter(Boolean);
  if (new Set(known).size !== known.length) throw new Error("表头有重复列（例如同时有「电话」和「联系电话」），请只保留一列");
  const ignoredColumns = headerCells.filter((name, i) => !columns[i] && name.trim()).map((name) => name.trim());
  lineNumbers.shift();
  if (!rows.length) throw new Error("表格中没有患者记录");
  const parsed = rows.map((cells, index) => {
    const input = Object.fromEntries(columns.flatMap((key, i) => key ? [[key, key === "phone" ? cells[i] || "" : (cells[i] || "").trim()]] : []));
    const errors = [];
    if (cells.length !== columns.length) errors.push("列数与表头不一致");
    if (!input.name?.trim() || input.name.length > 80) errors.push("姓名须为 1–80 字");
    if ((input.patientNumber || "").length > 40) errors.push("编号过长");
    if (input.gender) { const choices = { 男: "male", 女: "female", 未知: "unknown", male: "male", female: "female", unknown: "unknown" }; const value = Object.hasOwn(choices, input.gender.toLowerCase()) ? choices[input.gender.toLowerCase()] : undefined; if (!value) errors.push("性别请填写男、女或未知"); input.gender = value; } else delete input.gender;
    if (input.birthYear) { if (!/^\d{4}$/.test(input.birthYear) || +input.birthYear < 1900 || +input.birthYear > currentYear) errors.push("出生年份无效"); input.birthYear = Number(input.birthYear); }
    else if (input.age) { const age = input.age.replace(/岁$/, "").trim(); if (!/^\d{1,3}$/.test(age) || +age > 120) errors.push("年龄请填写 0–120 的整数"); else input.birthYear = currentYear - Number(age); }
    if (!input.birthYear) delete input.birthYear;
    delete input.age;
    for (const [key, max] of [["groups", 10], ["tags", 20]]) {
      input[key] = [...new Set((input[key] || "").split(/[，,;；]/).map((s) => s.trim()).filter(Boolean))];
      if (input[key].length > max || input[key].some((value) => value.length > 40)) errors.push(`${key === "groups" ? "分组" : "标签"}数量或长度超限`);
    }
    const phone = patientPhone(input.phone);
    if (phone.error) errors.push(phone.error);
    else if (phone.value) input.phone = phone.value;
    else delete input.phone;
    return { row: lineNumbers[index], input, errors };
  });
  return { rows: parsed, ignoredColumns };
}
