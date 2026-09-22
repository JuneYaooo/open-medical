import { createHash } from "node:crypto";
import { parsePatientImport } from "../../shared/patient-import.mjs";
import { check, identifier, AppError } from "../errors.mjs";
import { sqliteTransaction } from "../sqlite-transaction.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");

export class PatientImporter {
  constructor(store, patients) { Object.assign(this, { store, patients }); }
  preview(text) {
    let rows;
    try { rows = parsePatientImport(text); } catch (error) { throw new AppError("INVALID_IMPORT", error.message); }
    const people = this.patients.summaries(), numbers = new Set();
    for (const row of rows) {
      const { input, errors } = row;
      const existing = input.patientNumber && people.find((p) => p.patientNumber === input.patientNumber);
      const sameName = people.filter((p) => !p.archived && p.name === input.name);
      const sameBatchName = rows.filter((other) => other !== row && other.input.name === input.name).length;
      if (input.patientNumber && numbers.has(input.patientNumber)) errors.push("本表内患者编号重复");
      if (input.patientNumber) numbers.add(input.patientNumber);
      if (existing && existing.name !== input.name) errors.push("该编号已属于另一姓名，请核对");
      row.status = errors.length ? "invalid" : existing ? "existing" : sameName.length || sameBatchName ? "same_name" : "ready";
      row.existing = existing ? { id: existing.id, name: existing.name, archived: Boolean(existing.archived) } : null;
      row.matches = sameName.slice(0, 5).map(({ id, name, patientNumber, birthYear }) => ({ id, name, patientNumber, birthYear }));
      row.sameBatchName = sameBatchName;
    }
    return { rows, fingerprint: hash(text), counts: Object.fromEntries(["ready", "same_name", "existing", "invalid"].map((status) => [status, rows.filter((row) => row.status === status).length])) };
  }
  commit(input) {
    check(input && typeof input === "object", "INVALID_IMPORT", "导入请求无效");
    const requestId = identifier(input.requestId);
    check(typeof input.text === "string" && input.text.length <= 200000 && input.fingerprint === hash(input.text), "INVALID_IMPORT", "表格已变化，请重新预览");
    const selected = input.selectedRows, distinct = input.distinctRows || [];
    check(Array.isArray(selected) && selected.length > 0 && selected.length <= 200 && new Set(selected).size === selected.length && selected.every(Number.isSafeInteger), "INVALID_IMPORT", "请选择要新建的患者行");
    check(Array.isArray(distinct) && distinct.every((row) => selected.includes(row)), "INVALID_IMPORT", "同名核对选择无效");
    const fingerprint = hash(JSON.stringify({ text: input.text, selected: [...selected].sort(), distinct: [...distinct].sort() }));
    return sqliteTransaction(this.store.db, () => {
      const key = `patient-import:${requestId}`;
      const saved = this.store.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
      if (saved) { const result = JSON.parse(saved.value); check(result.fingerprint === fingerprint, "CONFLICT", "此批导入已经保存，修改内容后请重新预览", 409); return { ...result, replayed: true }; }
      const preview = this.preview(input.text), chosen = selected.map((number) => preview.rows.find((row) => row.row === number));
      check(chosen.every((row) => row && (row.status === "ready" || row.status === "same_name" && distinct.includes(row.row))), "IMPORT_CHANGED", "存在未核对同名、错误行或已存在的患者，请重新预览后选择", 409);
      const patients = chosen.map((row) => {
        const patient = this.patients.create({ ...row.input, confirmDistinctPatient: distinct.includes(row.row) });
        return { row: row.row, id: patient.id, name: patient.name, patientNumber: patient.patientNumber };
      });
      const result = { fingerprint, patients, count: patients.length, createdAt: Date.now() };
      this.store.db.prepare("INSERT INTO meta VALUES (?,?)").run(key, JSON.stringify(result));
      this.store.audit(null, "patient.imported", { requestId, count: patients.length, patientIds: patients.map((p) => p.id) });
      return result;
    });
  }
}
