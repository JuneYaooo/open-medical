import { check, AppError, identifier } from "../errors.mjs";
import { createHash } from "node:crypto";
import { sqliteTransaction } from "../sqlite-transaction.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");

// 检验结果表格导入（「能导出文件的医院」适配器）：医生从 LIS/Excel 导出
// CSV 或直接粘贴单元格，逐行匹配患者后生成 patient-update 档案提案——
// 写入仍走既有「AI 不直写」复核轨，本模块只做确定性解析与匹配。
const HEADERS = {
  姓名: "name", 患者姓名: "name", name: "name",
  患者编号: "patientNumber", 编号: "patientNumber", patientnumber: "patientNumber",
  项目: "item", 检验项目: "item", item: "item",
  数值: "value", 结果: "value", value: "value",
  单位: "unit", unit: "unit",
  日期: "date", 报告日期: "date", 检验日期: "date", date: "date",
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// LIS/Excel 常导出 2024/3/5 或 2024.3.5；统一补零为 YYYY-MM-DD，
// 不合法的日历日（如 2024/2/30）原样返回，交给 DATE_RE 拒绝。
export function normalizeLabDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/);
  if (!match) return text;
  const [, y, , m, d] = match;
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : text;
}

// 与患者名单导入同一风格的 RFC 引号单元解析；拒绝畸形引号，
// 不执行任何表格表达式。
function parseRows(text, limit) {
  if (typeof text !== "string" || !text.trim() || text.length > 200000)
    throw new AppError("LAB_IMPORT_LIMIT", "请提供 200KB 以内的检验表格文本", 413);
  text = text.replace(/^\uFEFF/, "");
  const first = text.split(/\r?\n/, 1)[0];
  const delimiter = first.includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [], cell = "", quoted = false, closed = false;
  const pushCell = () => { row.push(cell.trim()); cell = ""; closed = false; };
  const pushRow = () => { pushCell(); if (row.some(Boolean)) rows.push(row); row = []; if (rows.length > limit + 1) throw new AppError("LAB_IMPORT_LIMIT", `一次最多导入 ${limit} 行，请分批处理`, 413); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += char;
    } else if (char === delimiter) pushCell();
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[i + 1] === "\n") i++; pushRow(); }
    else if (char === '"' && !cell && !closed) quoted = true;
    else { if ((closed && char.trim()) || char === '"') throw new AppError("LAB_IMPORT_FILE", "表格引号格式不正确，请直接粘贴 Excel 单元格或使用 CSV", 422); cell += char; }
  }
  if (quoted) throw new AppError("LAB_IMPORT_FILE", "表格中有未闭合的引号", 422);
  if (cell || row.length) pushRow();
  return rows;
}

export class LabImporter {
  // patients：PatientRegistry；pending：PendingActions（提案复用既有复核轨）。
  constructor(patients, pending) { this.patients = patients; this.pending = pending; }

  preview(text) {
    const rows = parseRows(text, 500);
    const columns = rows.shift()?.map((name) => Object.hasOwn(HEADERS, name.toLowerCase()) ? HEADERS[name.toLowerCase()] : undefined);
    if (!columns?.includes("item") || !columns?.includes("value"))
      throw new AppError("LAB_IMPORT_FILE", "首行必须包含「项目」和「数值」列", 422);
    if (!columns.includes("name") && !columns.includes("patientNumber"))
      throw new AppError("LAB_IMPORT_FILE", "首行必须包含「姓名」或「患者编号」列用于匹配患者", 422);
    if (columns.some((key) => !key) || new Set(columns.filter(Boolean)).size !== columns.filter(Boolean).length)
      throw new AppError("LAB_IMPORT_FILE", "表头包含未知或重复列；支持姓名、患者编号、项目、数值、单位、日期", 422);
    if (!rows.length) throw new AppError("LAB_IMPORT_FILE", "表格中没有检验记录", 422);
    const byNumber = new Map(), byName = new Map(), sameName = new Set();
    for (const patient of this.patients.all()) {
      const number = String(patient.patientNumber || "").trim();
      if (number && !byNumber.has(number)) byNumber.set(number, patient);
      const name = String(patient.name || "").trim();
      if (!name) continue;
      if (byName.has(name)) sameName.add(name);
      else byName.set(name, patient);
    }
    const out = rows.map((cells, index) => {
      const input = Object.fromEntries(columns.map((key, i) => [key, cells[i] || ""]));
      if (input.date) input.date = normalizeLabDate(input.date);
      const row = { row: index + 2, item: input.item, unit: input.unit || "", ...input };
      const base = {
        item: input.item,
        ...(input.unit ? { unit: input.unit } : {}),
        ...(DATE_RE.test(input.date) ? { date: input.date } : {}),
      };
      if (!input.item || !input.value || !input.date) return { ...row, status: "invalid", reason: "项目、数值、日期均为必填" };
      if (!DATE_RE.test(input.date)) return { ...row, status: "invalid", reason: "日期须为有效日期，如 2024-03-05、2024/3/5 或 2024.3.5" };
      if (!Number.isFinite(Number(input.value))) return { ...row, status: "invalid", reason: "数值须为数字" };
      let patient = null;
      const number = String(input.patientNumber || "").trim();
      const name = String(input.name || "").trim();
      if (number) patient = byNumber.get(number) || null;
      if (patient && name && patient.name !== name) return { ...row, status: "invalid", reason: `姓名与编号不一致：编号属于 ${patient.name}，请核对原表`, candidates: [{ id: patient.id, name: patient.name, patientNumber: patient.patientNumber }] };
      if (!number && name) {
        if (sameName.has(name)) return { ...row, status: "same-name", reason: "存在同名患者，请补充患者编号", candidates: this.patients.list({ query: name, summary: true, includeArchived: true }).map((p) => ({ id: p.id, name: p.name, patientNumber: p.patientNumber || "" })) };
        patient = byName.get(name) || null;
      }
      if (!patient) return { ...row, status: "no-patient", reason: number ? "编号未匹配到患者" : "姓名未匹配到患者，请先建档或补充编号" };
      return { ...row, status: "ready", patientId: patient.id, patientName: patient.name, matchedPatientNumber: patient.patientNumber || "", patientBirthYear: patient.birthYear || null, patientRevision: patient.revision, labs: [{ ...base, value: Number(input.value) }] };
    });
    return {
      rows: out,
      fingerprint: hash(JSON.stringify({ text, rows: out })),
      stats: {
        total: out.length,
        ready: out.filter((r) => r.status === "ready").length,
        noPatient: out.filter((r) => r.status === "no-patient").length,
        sameName: out.filter((r) => r.status === "same-name").length,
        invalid: out.filter((r) => r.status === "invalid").length,
      },
    };
  }

  // 采纳预览中 status==="ready" 的行（医生可再剔除），按患者分组后逐人
  // 生成 patient-update 提案；确认仍在患者档案完成。
  commit({ text, selectedRows, fingerprint, requestId }) {
    check(
      Array.isArray(selectedRows) &&
        selectedRows.length >= 1 &&
        selectedRows.length <= 500 &&
        selectedRows.every(Number.isSafeInteger) &&
        new Set(selectedRows).size === selectedRows.length,
      "INVALID_INPUT",
      "请选择不重复的有效导入行",
    );
    identifier(requestId);
    check(
      typeof text === "string" &&
        text.length <= 200000 &&
        typeof fingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(fingerprint),
      "INVALID_INPUT",
      "请先预览并核对检验表格",
    );
    const requestFingerprint = hash(
      JSON.stringify({
        text,
        selectedRows: [...selectedRows].sort((a, b) => a - b),
        fingerprint,
      }),
    );
    const db = this.patients.store.db;
    return sqliteTransaction(db, () => {
      const key = `lab-import:${requestId}`;
      const receipt = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
      // An already committed submission remains the same submission even if
      // patient identities/revisions subsequently change. Never rematch a retry.
      if (receipt) {
        const saved = JSON.parse(receipt.value);
        check(
          saved.fingerprint === requestFingerprint,
          "REQUEST_CONFLICT",
          "本次检验提案已经生成，但重试内容已变化。请先核对已有提案，再返回重新预览",
          409,
        );
        return { ...saved.result, replayed: true };
      }
      const preview = this.preview(text);
      check(
        preview.fingerprint === fingerprint,
        "IMPORT_CHANGED",
        "患者身份、档案版本或原表内容已变化。尚未生成任何提案，请返回重新预览并核对患者",
        409,
      );
      const chosen = selectedRows.map((number) =>
        preview.rows.find((row) => row.row === number),
      );
      check(
        chosen.every((row) => row?.status === "ready"),
        "INVALID_INPUT",
        "所选行中存在不可导入记录，请重新预览后核对",
      );
      const grouped = new Map();
      for (const row of chosen) {
        if (!grouped.has(row.patientId))
          grouped.set(row.patientId, {
            patientName: row.patientName,
            labs: [],
          });
        grouped.get(row.patientId).labs.push(...row.labs);
      }
      const proposals = [];
      const overLimit = [];
      for (const [patientId, entry] of grouped) {
        // patient-update replaces the whole labs list, so the proposal carries
        // the existing results plus the new ones; exact repeats are skipped.
        const existing = this.patients.row(patientId).labs || [];
        const key = (lab) => JSON.stringify([lab.item, lab.date || "", lab.value, lab.unit || ""]);
        const seen = new Set(existing.map(key));
        const added = entry.labs.filter((lab) => !seen.has(key(lab)) && seen.add(key(lab)));
        if (!added.length) continue;
        // A patient record holds at most 500 lab results; one full record
        // must not roll back the proposals for everyone else in the file.
        if (existing.length + added.length > 500) {
          overLimit.push(entry.patientName || patientId);
          continue;
        }
        const action = this.pending.propose({
          type: "patient-update",
          patientId,
          payload: { labs: [...existing, ...added] },
          summary: `导入检验结果 ${added.length} 项（${[...new Set(added.map((l) => l.item))].slice(0, 3).join("、")}${added.length > 3 ? " 等" : ""}）`,
        });
        proposals.push({
          id: action.id,
          patientId,
          patientName: entry.patientName,
          labs: added.length,
        });
      }
      const result = {
        proposals,
        skipped: preview.stats.total - chosen.length,
        ...(overLimit.length ? { overLimit } : {}),
        note:
          "已生成待确认提案；请在患者档案顶部点「核对」确认写入，或在「待确认」中处理。" +
          (overLimit.length ? `以下患者的检验记录将超过 500 条上限，本次未导入：${overLimit.join("、")}。请先整理其历史检验后再导入。` : ""),
      };
      db.prepare("INSERT INTO meta VALUES (?,?)").run(
        key,
        JSON.stringify({ fingerprint: requestFingerprint, result }),
      );
      return result;
    });
  }
}
