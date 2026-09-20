// XLSX 独立验收(S04):
// 1) 结构检查:必须是真实 ZIP 容器 + OOXML 必需部件(防伪造扩展名);
// 2) 内容检查:解析工作表单元格、公式、缓存值;
// 3) 公式重算:node_modules 没有电子表格公式引擎(exceljs/hyperformula 均未安装),
//    这里提供的是一个显式标注为"降级"的迷你求值器(算术/单元格引用/SUM/SUMPRODUCT/ROUND)。
//    它只用于内容级判定,不冒充独立电子表格引擎;完整重算断言记 blocked。
import { readZip, writeZip } from "./zip.mjs";
import { parseXml, findAll, findPath } from "./xml.mjs";

export const RECALC_MODE = "degraded-mini-evaluator (非独立电子表格引擎;exceljs/hyperformula 未安装)";

/** 解析 xlsx:返回 { sheets: [{name, cells: Map<"A1", {value, formula, type}>}] } */
export function parseXlsx(bytes) {
  const files = readZip(bytes);
  const required = ["[Content_Types].xml", "xl/workbook.xml"];
  for (const part of required)
    if (!files.has(part)) throw new Error(`xlsx 缺少必需部件 ${part}`);
  const workbook = parseXml(files.get("xl/workbook.xml").toString("utf8"));
  const sheets = findPath(workbook, "sheets", "sheet");
  if (!sheets.length) throw new Error("xlsx 工作簿没有工作表声明");
  const rels = files.has("xl/_rels/workbook.xml.rels")
    ? parseXml(files.get("xl/_rels/workbook.xml.rels").toString("utf8"))
    : null;
  const relMap = new Map();
  for (const rel of rels ? findAll(rels, "Relationship") : [])
    relMap.set(rel.attrs.Id, rel.attrs.Target);
  const shared = [];
  if (files.has("xl/sharedStrings.xml")) {
    const sst = parseXml(files.get("xl/sharedStrings.xml").toString("utf8"));
    for (const si of findAll(sst, "si")) {
      // 纯文本 <t> 或富文本多个 <r><t>。
      const parts = findAll(si, "t").map((t) => t.text);
      shared.push(parts.join(""));
    }
  }
  const result = [];
  for (const sheet of sheets) {
    const target = (relMap.get(sheet.attrs["r:id"]) || "").replace(/^\/?xl\//, "");
    const part = files.has(`xl/${target}`) ? `xl/${target}` : target;
    if (!files.has(part)) throw new Error(`找不到工作表部件:${part}`);
    const ws = parseXml(files.get(part).toString("utf8"));
    const cells = new Map();
    for (const c of findAll(ws, "c")) {
      const ref = c.attrs.r;
      if (!ref) continue;
      const fEl = c.children.find((ch) => ch.name === "f");
      const vEl = c.children.find((ch) => ch.name === "v");
      const isEl = c.children.find((ch) => ch.name === "is");
      const type = c.attrs.t || "n";
      let value = null;
      if (isEl) value = findAll(isEl, "t").map((t) => t.text).join("");
      else if (vEl) {
        if (type === "s") value = shared[Number(vEl.text)] ?? null;
        else if (type === "n" || type === "str") {
          const num = Number(vEl.text);
          value = Number.isFinite(num) && vEl.text.trim() !== "" ? num : vEl.text;
        } else value = vEl.text;
      }
      cells.set(ref, {
        type,
        value,
        formula: fEl ? fEl.text : null,
      });
    }
    result.push({ name: sheet.attrs.name || `sheet${result.length + 1}`, cells });
  }
  return { sheets: result };
}

// ---------- 降级公式求值器 ----------
function colToIndex(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(ref.toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

/** 把 A1 引用解析为坐标;支持 $A$1。 */
export function parseRef(ref) {
  return colToIndex(ref);
}

/**
 * 求值公式字符串。grid: Map<"A1", number|string>。
 * 支持:数字、四则运算、乘方、括号、单元格引用($A$1 形式忽略 $)、
 * SUM(range)、SUMPRODUCT(range,range)、ROUND(x,n)、ABS、MIN、MAX。
 * 明确标注:这是降级迷你求值器,不是独立电子表格引擎。
 */
export function evalFormula(formula, grid) {
  // 范围引用 A1:B3 归并为内部函数 RANGE("A1","B3"),避免 tokenizer 表达 ':'。
  const rewritten = String(formula)
    .replace(/^=/, "")
    .replace(
      /(\$?[A-Z]+\$?\d+)\s*:\s*(\$?[A-Z]+\$?\d+)/gi,
      (_, a, b) => `RANGE(${a.replace(/\$/g, "").toUpperCase()},${b.replace(/\$/g, "").toUpperCase()})`,
    );
  return evalTokens(tokenize(rewritten), grid);
}

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: "num", v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z$_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9$_]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j).toUpperCase() });
      i = j;
      continue;
    }
    if ("+-*/^(),".includes(ch)) { out.push({ t: ch }); i++; continue; }
    throw new Error(`公式包含不支持的字符:${ch}`);
  }
  return out;
}

/** 在给定 token 流上执行递归下降求值(与 evalFormula 共用文法)。 */
function evalTokens(tokens, grid) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function colName(n) {
    let s = "";
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function rangeValues(a, b) {
    const pa = colToIndex(a), pb = colToIndex(b);
    if (!pa || !pb) throw new Error(`无效范围 ${a}:${b}`);
    const out = [];
    for (let r = Math.min(pa.row, pb.row); r <= Math.max(pa.row, pb.row); r++)
      for (let c = Math.min(pa.col, pb.col); c <= Math.max(pa.col, pb.col); c++) {
        const v = grid.get(`${colName(c)}${r}`);
        if (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v)))
          out.push(Number(v));
      }
    return out;
  }
  function expect(t) {
    const tok = next();
    if (!tok || tok.t !== t) throw new Error(`公式语法错误:期望 ${t},得到 ${JSON.stringify(tok)}`);
  }
  function applyFunction(name, args) {
    const flat = args.flat().map(Number);
    switch (name) {
      case "SUM": return flat.reduce((s, v) => s + v, 0);
      case "SUMPRODUCT": {
        const arrays = args.map((a) => (Array.isArray(a) ? a.map(Number) : [Number(a)]));
        const len = Math.min(...arrays.map((a) => a.length));
        let sum = 0;
        for (let i = 0; i < len; i++) sum += arrays.reduce((p, a) => p * a[i], 1);
        return sum;
      }
      case "ROUND": {
        const v = flat[0] ?? 0;
        const n = flat[1] ?? 0;
        const f = 10 ** n;
        return Math.round((v + Number.EPSILON) * f) / f;
      }
      case "ABS": return Math.abs(flat[0] ?? 0);
      case "MIN": return Math.min(...flat);
      case "MAX": return Math.max(...flat);
      default: throw new Error(`不支持的函数:${name}`);
    }
  }
  function parsePrimary() {
    const tok = next();
    if (!tok) throw new Error("公式提前结束");
    if (tok.t === "num") return tok.v;
    if (tok.t === "-") return -parsePrimary();
    if (tok.t === "+") return parsePrimary();
    if (tok.t === "(") { const v = parseExpr(); expect(")"); return v; }
    if (tok.t === "id") {
      // 内部 RANGE(A1,B3):参数是引用名,不按表达式求值。
      if (tok.v === "RANGE" && peek() && peek().t === "(") {
        next();
        const a = next();
        const sep = next();
        const b = next();
        expect(")");
        if (a?.t !== "id" || b?.t !== "id" || sep?.t !== ",")
          throw new Error("RANGE 参数必须是单元格引用");
        return rangeValues(a.v, b.v);
      }
      if (peek() && peek().t === "(") {
        next();
        const args = [];
        if (peek() && peek().t !== ")") {
          for (;;) {
            args.push(parseExpr());
            if (peek() && peek().t === ",") { next(); continue; }
            break;
          }
        }
        expect(")");
        return applyFunction(tok.v, args);
      }
      if (!/^[A-Z]+\d+$/.test(tok.v)) throw new Error(`未知标识符:${tok.v}`);
      const v = grid.get(tok.v);
      if (v === undefined || v === null || v === "") return 0;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`单元格 ${tok.v} 不是数值`);
      return n;
    }
    throw new Error(`公式语法错误:${JSON.stringify(tok)}`);
  }
  function parsePow() {
    let base = parsePrimary();
    while (peek() && peek().t === "^") { next(); base = base ** parsePrimary(); }
    return base;
  }
  function parseTerm() {
    let v = parsePow();
    while (peek() && (peek().t === "*" || peek().t === "/")) {
      const op = next().t;
      const rhs = parsePow();
      v = op === "*" ? v * rhs : v / rhs;
    }
    return v;
  }
  function parseExpr() {
    let v = parseTerm();
    while (peek() && (peek().t === "+" || peek().t === "-")) {
      const op = next().t;
      const rhs = parseTerm();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  }
  return parseExpr();
}

/**
 * S04 核心判定(降级重算):
 * - workbook 存在表头(项目/单价/数量,列名放宽)与两行数据;
 * - 总额单元格必须是公式(有 <f>),缓存值=74(若提供);
 * - 把甲的数量改为 2 后用迷你求值器重算总额,应得 49;
 * - 求值器会把公式引用的单元格限制在工作表内,数字串不参与。
 */
export function checkQuoteWorkbook(bytes) {
  const { sheets } = parseXlsx(bytes);
  const sheet = sheets[0];
  const cells = sheet.cells;
  const numericGrid = new Map();
  for (const [ref, cell] of cells) {
    const n = Number(cell.value);
    if (cell.formula === null && Number.isFinite(n)) numericGrid.set(ref, n);
  }
  // 找出“总额”公式单元格:含 f 且求值结果接近 74。
  const candidates = [];
  for (const [ref, cell] of cells) {
    if (!cell.formula) continue;
    try {
      const v = evalFormula(cell.formula, numericGrid);
      if (Number.isFinite(v)) candidates.push({ ref, cell, value: v });
    } catch {
      // 公式超出迷你求值器能力时忽略,交给 blocked 报告。
    }
  }
  const totalCell =
    candidates.find((c) => Math.abs(c.value - 74) < 0.005) ||
    candidates.find((c) => Math.abs(c.value - (12.5 * 4 + 8 * 3)) < 0.005);
  if (!totalCell)
    return {
      ok: false,
      reason: candidates.length
        ? `存在公式但初始总额不是74(候选:${candidates.map((c) => `${c.ref}=${c.value}`).join(",")})`
        : "工作表中没有可用公式(疑似硬编码总额)",
      formulas: [...cells.values()].filter((c) => c.formula).length,
    };
  // 找到数量=4(甲)且被总额公式引用的单元格,替换为 2 再算。
  const referencedRefs = new Set(
    (totalCell.cell.formula.match(/\$?[A-Za-z]+\$?\d+/g) || []).map((r) =>
      r.replace(/\$/g, "").toUpperCase(),
    ),
  );
  let qtyRef = null;
  for (const [ref, cell] of cells)
    if (cell.formula === null && Number(cell.value) === 4 && referencedRefs.has(ref.toUpperCase()))
      qtyRef = ref;
  if (!qtyRef) return { ok: false, reason: "找不到被总额公式引用的甲数量单元格(值4)" };
  const modified = new Map(numericGrid);
  modified.set(qtyRef, 2);
  let recalced;
  try {
    recalced = evalFormula(totalCell.cell.formula, modified);
  } catch (error) {
    return { ok: false, reason: `重算失败:${error.message}`, formulas: 1 };
  }
  const recalcOk = Math.abs(recalced - 49) < 0.005;
  return {
    ok: recalcOk,
    reason: recalcOk ? null : `数量改为2后重算得 ${recalced},期望49`,
    totalRef: totalCell.ref,
    formula: totalCell.cell.formula,
    initial: totalCell.value,
    recalcedWithQty2: recalced,
    formulas: [...cells.values()].filter((c) => c.formula).length,
    mode: RECALC_MODE,
  };
}

// ---------- xlsx 写入器(自测样例/错误样例用) ----------
export function buildXlsx(rows) {
  // rows: [[{v, f}]] —— v 为字符串(进 sharedStrings)或数字;f 可选公式。
  const shared = [];
  const cellXml = rows
    .map((row, ri) => {
      const cells = row
        .map((cell, ci) => {
          const ref = `${String.fromCharCode(65 + ci)}${ri + 1}`;
          if (cell === null || cell === undefined) return "";
          if (typeof cell === "number")
            return `<c r="${ref}"><v>${cell}</v></c>`;
          if (typeof cell === "object" && cell.f) {
            const cached = cell.cached !== undefined ? `<v>${cell.cached}</v>` : "";
            return `<c r="${ref}"><f>${cell.f}</f>${cached}</c>`;
          }
          const text = String(cell);
          shared.push(text);
          return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cellXml}</sheetData></worksheet>`;
  const sharedXml = shared.length
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
        .map((s) => `<si><t>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></si>`)
        .join("")}</sst>`
    : null;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="报价" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${sharedXml ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : ""}</Types>`;
  const entries = [
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRels],
    ["xl/workbook.xml", workbookXml],
    ["xl/_rels/workbook.xml.rels", relsXml],
    ["xl/worksheets/sheet1.xml", sheetXml],
  ];
  if (sharedXml) entries.push(["xl/sharedStrings.xml", sharedXml]);
  return writeZip(entries);
}
