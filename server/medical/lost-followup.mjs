import { check } from "../errors.mjs";

// 失访患者：在诊（未归档）患者中，最近一次预约是「未到诊」且之后没有再约；
// 或最近一次就诊/预约已超过 N 天、没有将来的预约、也没有进行中的随访计划或待发提醒。
// 只读盘点，不联系患者。随访数据归随访插件所有，经 busyPatientIds 由插件服务提供；
// 插件未启用时按「没有随访」处理。
const DAY = 86400000;
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);
const isDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value);

export function lostPatients(schedule, { days = 90, busyPatientIds = () => [] } = {}) {
  days = Number(days);
  check(Number.isInteger(days) && days >= 1 && days <= 3650, "INVALID_INPUT", "天数须为 1–3650 的整数");
  const db = schedule.db, today = schedule.today();
  const busy = new Set(busyPatientIds() || []);
  const byPatient = new Map();
  for (const row of db.prepare("SELECT patient_id, data FROM appointments WHERE status<>'cancelled' ORDER BY date, rowid").all()) {
    if (!byPatient.has(row.patient_id)) byPatient.set(row.patient_id, []);
    byPatient.get(row.patient_id).push(JSON.parse(row.data));
  }
  const out = [];
  for (const patient of schedule.patients.all()) {
    if (patient.archived) continue;
    const list = byPatient.get(patient.id) || [];
    if (list.some((a) => a.status === "scheduled" && a.date >= today)) continue;
    const last = list.at(-1);
    const lastVisit = (patient.visits || []).map((v) => v?.date).filter(isDate).map((d) => d.slice(0, 10)).sort().at(-1) || "";
    const base = { patientId: patient.id, patientName: patient.name || "", patientNumber: patient.patientNumber || "" };
    if (last?.status === "missed" && !(lastVisit > last.date)) {
      out.push({ ...base, reason: "missed", lastDate: last.date, daysSince: daysBetween(last.date, today), appointmentId: last.id });
      continue;
    }
    const lastDate = [lastVisit, last?.date || ""].sort().at(-1);
    if (!lastDate || busy.has(patient.id)) continue;
    const since = daysBetween(lastDate, today);
    if (since > days) out.push({ ...base, reason: "overdue", lastDate, daysSince: since });
  }
  out.sort((a, b) => a.lastDate.localeCompare(b.lastDate) || a.patientId.localeCompare(b.patientId));
  return { days, today, patients: out };
}
