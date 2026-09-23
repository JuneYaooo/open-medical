import { createHash } from "node:crypto";

const newest = (a, b) => String(b.date || b.at || "").localeCompare(String(a.date || a.at || ""));
const source = (value, fallback) => value || fallback;

// A deterministic, local read model. It does not infer diagnoses, normalize
// incompatible units, or turn missing history into a negative clinical fact.
export class PatientBrief {
  constructor(store, patients) { this.store = store; this.patients = patients; }
  read(patientId) {
    const p = this.patients.row(patientId);
    const db = this.store.db;
    const diagnoses = (p.diagnoses || []).map((d) => ({ ...d, source: source(d.source, "患者档案 · 诊断") })).sort(newest);
    const medications = (p.medications || []).map((m) => ({ ...m, status: m.status || "unknown", source: source(m.source, "患者档案 · 用药") }));
    const groups = new Map();
    for (const lab of p.labs || []) {
      // Exact stored analyte + unit only. Clinical equivalence needs explicit
      // mapping and review, so a visual trend never silently converts units.
      const key = JSON.stringify([lab.item.trim(), (lab.unit || "").trim()]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...lab, source: source(lab.source, "患者档案 · 检验") });
    }
    const labs = [...groups.values()].map((values) => {
      values.sort(newest);
      const latest = values[0];
      const sameDate = values.filter((v) => v.date === latest.date);
      const conflict = new Set(sameDate.map((v) => v.value)).size > 1;
      const previous = values.find((v) => v.date < latest.date);
      const previousConflict = previous && new Set(values.filter((v) => v.date === previous.date).map((v) => v.value)).size > 1;
      return { ...latest, conflict, observations: sameDate.slice(0, 5), sameDateCount: sameDate.length, count: values.length,
        previous: previous && !previousConflict ? previous : null,
        delta: !conflict && previous && !previousConflict && latest.unit ? Number((latest.value - previous.value).toPrecision(10)) : null };
    }).sort(newest);
    const outcomes = db.prepare("SELECT id,data FROM reminders WHERE patient_id=? AND json_extract(data,'$.outcome') IS NOT NULL ORDER BY json_extract(data,'$.outcome.recordedAt') DESC LIMIT 6").all(patientId)
      .map((r) => { const data = JSON.parse(r.data); return { id: r.id, title: data.title, ...data.outcome, addenda: (data.outcome.addenda || []).slice(-3), addendumCount: data.outcome.addenda?.length || 0, source: `随访记录 ${r.id}` }; });
    const messages = db.prepare("SELECT id,time,data FROM patient_messages WHERE patient_id=? AND processed=0 ORDER BY time DESC LIMIT 3").all(patientId)
      .map((r) => ({ id: r.id, at: r.time, text: JSON.parse(r.data).text, source: `患者消息 ${r.id}` }));
    const careTaskCount = db.prepare("SELECT COUNT(*) n FROM care_tasks WHERE patient_id=? AND status NOT IN ('completed','cancelled')").get(patientId).n;
    const careTasks = db.prepare("SELECT data FROM care_tasks WHERE patient_id=? AND status NOT IN ('completed','cancelled') ORDER BY due_at LIMIT 5").all(patientId)
      .map((row) => { const task = JSON.parse(row.data); return { id: task.id, title: task.title, status: task.status, dueAt: task.dueAt, note: task.note, resultSource: task.resultSource, reviewNote: task.reviewNote, source: `待跟进事项 ${task.id}` }; });
    const counts = this.patients.counts(patientId);
    const pendingReviews = db.prepare("SELECT COUNT(*) n FROM pending_actions WHERE patient_id=? AND status='pending'").get(patientId).n;
    const activeRisks = db.prepare("SELECT COUNT(*) n FROM risk_alerts WHERE patient_id=? AND status='active'").get(patientId).n;
    const allergyStatus = (p.allergies || []).length ? "recorded" : p.allergyStatus || "unknown";
    const gaps = [];
    if (allergyStatus === "unknown") gaps.push({ field: "allergies", label: "过敏史尚未核对", tab: "clinical" });
    if (!medications.length) gaps.push({ field: "medications", label: "尚无用药记录，请核对是否用药", tab: "clinical" });
    else if (medications.some((m) => m.status === "unknown")) gaps.push({ field: "medications", label: `${medications.filter((m) => m.status === "unknown").length} 条用药的当前状态待核对`, tab: "clinical" });
    if (!p.birthYear) gaps.push({ field: "birthYear", label: "出生年份未记录", tab: "info" });
    if (!diagnoses.length) gaps.push({ field: "diagnoses", label: "尚无已登记诊断", tab: "clinical" });
    const result = {
      patientId: p.id, sessionId: p.sessionId, revision: p.revision, updatedAt: p.updatedAt,
      ...(p.clinicalSummary ? { clinicalSummary: p.clinicalSummary } : {}),
      identity: { name: p.name, patientNumber: p.patientNumber || "", birthYear: p.birthYear || null, gender: p.gender || "unknown" },
      diagnoses: diagnoses.slice(0, 8), medications: medications.slice(0, 20),
      allergies: p.allergies || [], allergyStatus, labs: labs.slice(0, 8),
      visits: [...(p.visits || [])].sort(newest).slice(0, 5), outcomes, messages, gaps, careTasks,
      counts: { ...counts, careTasks: careTaskCount, pendingReviews, activeRisks, diagnoses: diagnoses.length, medications: medications.length, labGroups: labs.length, visits: (p.visits || []).length },
    };
    // Fingerprint includes source content, not the read time. New messages and
    // follow-up outcomes invalidate it even if the chart revision is unchanged.
    return { ...result, fingerprint: createHash("sha256").update(JSON.stringify(result)).digest("hex").slice(0, 16), generatedAt: new Date().toISOString() };
  }
}
