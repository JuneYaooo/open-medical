import { check } from "../errors.mjs";

export const AGENDA_KINDS = ["all", "review", "followup", "tracking", "messages", "risk", "attention"];
const time = (value) => typeof value === "number" ? value : Date.parse(value) || 0;

// Read model only: work remains owned by its original patient/session/domain.
// Counts are computed before pagination. A worklist row never doubles as a
// generic "complete" action: the doctor opens the appropriate review flow.
export class DoctorOverview {
  constructor(store, sessions) { this.store = store; this.sessions = sessions; }
  read({ kind = "all", query = "", offset = 0, limit = 12, now = Date.now() } = {}) {
    check(AGENDA_KINDS.includes(kind), "INVALID_INPUT", "待办分类无效");
    check(typeof query === "string" && query.length <= 100, "INVALID_INPUT", "搜索词过长");
    check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      "INVALID_INPUT", "分页参数无效");
    const db = this.store.db;
    const people = new Map(db.prepare("SELECT id,data FROM patients").all().map((row) => {
      const p = JSON.parse(row.data);
      return [row.id, { id: row.id, name: p.name, patientNumber: p.patientNumber || "", birthYear: p.birthYear, archived: p.archived }];
    }));
    const rows = [];
    const add = (item) => {
      const patient = item.patientId ? people.get(item.patientId) : null;
      if (item.patientId && (!patient || patient.archived)) return;
      rows.push({ ...item, at: time(item.at), patientName: patient?.name || "独立任务", patientNumber: patient?.patientNumber || "", birthYear: patient?.birthYear || null });
    };
    for (const row of db.prepare("SELECT id,patient_id,severity,updated_at,data FROM risk_alerts WHERE status='active'").all()) {
      const data = JSON.parse(row.data);
      add({ id: `risk:${row.id}`, kind: "risk", patientId: row.patient_id, title: data.title, detail: data.message,
        at: row.updated_at, weight: row.severity === "critical" ? 0 : 4, severity: row.severity,
        action: { type: "patient", tab: "overview", label: "核对风险" } });
    }
    for (const row of db.prepare("SELECT id,patient_id,status,due_at,data FROM care_tasks WHERE status IN ('awaiting_review','awaiting_communication') OR (status='waiting_result' AND due_at<=?)").all(now)) {
      const task = JSON.parse(row.data);
      const label = { waiting_result: "结果尚未收到，跟进时间已到", awaiting_review: "结果已收到，等待医生核对", awaiting_communication: "医生已核对，等待登记告知情况" }[row.status];
      add({ id: `tracking:${row.id}`, kind: "tracking", patientId: row.patient_id, title: task.title, detail: label,
        at: row.due_at, weight: row.status === "awaiting_review" ? 3 : 5,
        action: { type: "patient", tab: "tracking", label: "继续跟进" } });
    }
    for (const row of db.prepare("SELECT id,patient_id,due_at,data FROM reminders WHERE status='pending'").all()) {
      const data = JSON.parse(row.data);
      add({ id: `reminder:${row.id}`, kind: "followup", patientId: row.patient_id, title: data.title,
        detail: "提醒已生成，等待登记联系结果", at: row.due_at, weight: row.due_at < now - 86400000 ? 1 : 5,
        action: { type: "patient", tab: "followups", label: "登记随访" } });
    }
    for (const row of db.prepare("SELECT id,patient_id,status,next_due,data FROM follow_ups WHERE status='paused' OR (status='active' AND next_due<=?)").all(now)) {
      const data = JSON.parse(row.data);
      if (row.status === "paused" && !data.lastError) continue;
      add({ id: `schedule:${row.id}`, kind: row.status === "paused" ? "attention" : "followup", patientId: row.patient_id,
        title: data.name, detail: data.lastError || "计划已到期，等待本机运行时生成提醒", at: row.next_due, weight: row.status === "paused" ? 2 : 5,
        action: { type: "patient", tab: "followups", label: row.status === "paused" ? "检查失败计划" : "查看随访" } });
    }
    for (const row of db.prepare("SELECT patient_id,COUNT(*) n,MIN(time) oldest FROM patient_messages WHERE processed=0 AND patient_id IS NOT NULL GROUP BY patient_id").all()) {
      add({ id: `messages:${row.patient_id}`, kind: "messages", patientId: row.patient_id,
        title: `${row.n} 条消息待整理`, detail: "查看原文，再决定是否整理为草稿", at: time(row.oldest), weight: 6,
        count: row.n, action: { type: "patient", tab: "messages", label: "处理消息" } });
    }
    const inbox = db.prepare("SELECT COUNT(*) n FROM patient_messages WHERE patient_id IS NULL").get().n;
    if (inbox) add({ id: "inbox", kind: "messages", title: `${inbox} 条消息待认领`, detail: "患者归属不明确，先核对身份", at: 0, weight: 3,
      count: inbox, action: { type: "patients", label: "认领消息" } });
    for (const row of db.prepare("SELECT id,patient_id,summary,created_at FROM pending_actions WHERE status='pending'").all()) {
      add({ id: `proposal:${row.id}`, kind: "review", patientId: row.patient_id, title: row.summary,
        detail: "AI 提议尚未写入档案，等待医生确认", at: row.created_at, weight: 7,
        action: { type: row.patient_id ? "patient" : "patients", tab: "overview", label: "复核提案" } });
    }
    for (const session of this.sessions.list()) {
      if (session.reviewCount) add({ id: `review:${session.id}`, kind: "review", patientId: session.patientId,
        title: session.title, detail: `${session.reviewCount} 份成果待复核`, count: session.reviewCount,
        at: time(session.updatedAt), weight: 7, action: { type: "task", sessionId: session.id, tab: "results", label: "复核成果" } });
      if (["failed", "interrupted"].includes(session.lastRunStatus) && !session.running) add({
        id: `attention:${session.id}`, kind: "attention", patientId: session.patientId, title: session.title,
        detail: session.lastRunError || "执行未完成，查看记录后继续", at: time(session.updatedAt), weight: 2,
        action: { type: "task", sessionId: session.id, label: "继续任务" },
      });
    }
    const counts = Object.fromEntries(AGENDA_KINDS.map((key) => [key, key === "all" ? rows.length : rows.filter((item) => item.kind === key).length]));
    const needle = query.trim().toLowerCase();
    const filtered = rows.filter((item) => (kind === "all" || item.kind === kind) &&
      (!needle || `${item.patientName} ${item.patientNumber} ${item.title} ${item.detail}`.toLowerCase().includes(needle)))
      .sort((a, b) => a.weight - b.weight || a.at - b.at || a.id.localeCompare(b.id));
    return { counts, total: filtered.length, offset, limit, hasMore: offset + limit < filtered.length,
      items: filtered.slice(offset, offset + limit), generatedAt: now, patientCount: [...people.values()].filter((p) => !p.archived).length };
  }
}
