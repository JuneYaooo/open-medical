// Followup-owned agenda sources. The collection code is lifted verbatim from
// the transitional legacy-agenda plugin; only the owning plugin changed.
import { messagingConnected } from "./connection.mjs";

const DAY = 86400000;
const time = (value) => typeof value === "number" ? value : Date.parse(value) || 0;
const moment = (now) => typeof now === "number" ? now : Date.parse(now) || Date.now();
const hasTable = (db, name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const overdue = (at, now) => { const days = Math.floor((now - time(at)) / DAY); return days >= 1 ? `已逾期 ${days} 天` : ""; };
// Snoozed reminders (due_at in the future) stay off the agenda until then.
// Anything more than a day past due ranks with urgent work; otherwise it waits behind today's visits.
const dueWeight = (at, now) => (time(at) < now - DAY ? 1 : 5);
// A follow-up generated from a treatment-plan review date is the same work as
// the shell's plan-review row; `covers` names that row so the host shows it once.
const reviewCover = (patientId, source) =>
  source?.kind === "treatment-review" && source.reviewDate ? `plan-review:${patientId}:${source.reviewDate}` : undefined;

// What the doctor does next for a reminder that carries a questionnaire.
const SURVEY_HINT = {
  pending_send: (title) => `问卷「${title}」待下发，或电话随访后代填`,
  sent: (title) => `问卷「${title}」已发出，等待患者回复，或电话随访后代填`,
  expired: (title) => `问卷「${title}」已过期未回复，请电话随访后代填`,
};
function surveyHint(db, reminderId, now = Date.now()) {
  if (!hasTable(db, "followup_surveys")) return "";
  const row = db.prepare("SELECT data FROM followup_surveys WHERE json_extract(data,'$.reminderId')=? ORDER BY rowid DESC LIMIT 1").get(reminderId);
  if (!row) return "";
  const survey = JSON.parse(row.data);
  // Expiry is computed, not stored; mirror the surveys module.
  if (survey.status === "sent" && survey.expiresAt && Date.parse(survey.expiresAt) < now) survey.status = "expired";
  return SURVEY_HINT[survey.status]?.(survey.questionnaire?.title || "随访问卷") || "";
}

const followup = {
  kind: "followup",
  label: "随访",
  order: 30,
  read(ctx, { now } = {}) {
    const db = ctx.db;
    const current = moment(now);
    const items = [];
    for (const row of db.prepare("SELECT r.id,r.patient_id,r.due_at,r.data,f.data plan FROM reminders r LEFT JOIN follow_ups f ON f.id=json_extract(r.data,'$.followUpId') WHERE r.status='pending' AND (json_extract(r.data,'$.snooze') IS NULL OR r.due_at<=?)").all(current)) {
      const data = JSON.parse(row.data);
      const covers = row.plan ? reviewCover(row.patient_id, JSON.parse(row.plan).source) : undefined;
      items.push({ id: `reminder:${row.id}`, kind: "followup", patientId: row.patient_id, title: data.title,
        detail: [overdue(row.due_at, current), surveyHint(db, row.id, current) || "联系患者后登记随访结果"].filter(Boolean).join("，"), at: row.due_at,
        weight: dueWeight(row.due_at, current), reminderId: row.id, ...(covers ? { covers } : {}),
        action: { type: "patient", tab: "followups", label: "登记随访" } });
    }
    for (const row of db.prepare("SELECT id,patient_id,status,next_due,data FROM follow_ups WHERE status='paused' OR (status='active' AND next_due<=?)").all(current)) {
      const data = JSON.parse(row.data);
      if (row.status === "paused") {
        if (data.lastError) items.push({ id: `schedule:${row.id}`, kind: "failure", lane: "work", patientId: row.patient_id,
          title: `随访计划「${data.name}」已暂停`, detail: data.lastError, at: row.next_due,
          action: { type: "patient", tab: "followups", label: "检查计划" } });
        continue;
      }
      const covers = reviewCover(row.patient_id, data.source);
      items.push({ id: `schedule:${row.id}`, kind: "followup", patientId: row.patient_id, title: data.name,
        detail: [overdue(row.next_due, current), "随访到期，联系患者"].filter(Boolean).join("，"), at: row.next_due,
        weight: dueWeight(row.next_due, current), ...(covers ? { covers } : {}),
        action: { type: "patient", tab: "followups", label: "查看随访" } });
    }
    return items;
  },
};

const messages = {
  kind: "messages",
  label: "患者消息",
  order: 50,
  // Patient messages only exist once a WeChat/WeCom channel is connected.
  available: (ctx) => messagingConnected(ctx),
  read(ctx) {
    const db = ctx.db;
    const items = [];
    // Urgent alerts are normally listed by risk-rules in the risk lane. When
    // that plugin is off, list them here so red flags never drop off the agenda.
    // Same item id either way, so they are never shown twice.
    const riskListsUrgent = ctx.services.followupHost?.isActive?.("risk-rules") === true;
    if (hasTable(db, "care_alerts")) for (const row of db.prepare("SELECT id,patient_id,level,reason,created_at FROM care_alerts WHERE status='open'").all()) {
      if (row.level === "urgent") {
        if (riskListsUrgent) continue;
        items.push({ id: `care-alert:${row.id}`, kind: "messages", patientId: row.patient_id,
          title: "患者消息提示紧急情况", detail: row.reason, at: row.created_at, weight: 0, severity: "critical",
          action: { type: "view", view: "care", tab: "alerts", label: "立即查看" } });
        continue;
      }
      items.push({ id: `care-alert:${row.id}`, kind: "messages", patientId: row.patient_id,
        title: "患者消息需要医生回复", detail: row.reason, at: row.created_at,
        weight: 3,
        action: { type: "view", view: "care", tab: "alerts", label: "查看消息" } });
    }
    for (const row of db.prepare("SELECT patient_id,COUNT(*) n,MIN(time) oldest FROM patient_messages WHERE processed=0 AND patient_id IS NOT NULL GROUP BY patient_id").all()) {
      items.push({ id: `messages:${row.patient_id}`, kind: "messages", patientId: row.patient_id,
        title: `${row.n} 条聊天记录待整理`, detail: "查看原文，决定是否回复或记入档案", at: time(row.oldest), weight: 6,
        count: row.n, action: { type: "patient", tab: "messages", label: "处理消息" } });
    }
    const inbox = db.prepare("SELECT COUNT(*) n FROM patient_messages WHERE patient_id IS NULL").get().n;
    if (inbox) items.push({ id: "inbox", kind: "messages", title: `${inbox} 条消息不确定是哪位患者`, detail: "核对身份后归到对应患者", at: 0, weight: 3,
      count: inbox, action: { type: "patients", label: "认领消息" } });
    if (hasTable(db, "care_replies")) for (const row of db.prepare("SELECT patient_id,COUNT(*) n,MIN(created_at) oldest,SUM(status IN ('failed','unknown')) bad FROM care_replies WHERE status IN ('draft','failed','unknown') AND patient_id IS NOT NULL GROUP BY patient_id").all()) {
      items.push({ id: `care-draft:${row.patient_id}`, kind: "messages", patientId: row.patient_id,
        title: row.bad ? (row.bad > 1 ? `${row.bad} 条回复发送失败或结果未知` : "回复发送失败或结果未知") : row.n > 1 ? `${row.n} 条回复待发送` : "回复待发送",
        detail: row.bad ? "核实是否已送达，再重发或关闭" : "已起草回复，核对后发给患者", at: row.oldest, weight: 4, count: row.n,
        action: { type: "view", view: "care", tab: "drafts", label: "核对发送" } });
    }
    return items;
  },
};

export const followupAgendaSources = Object.freeze([followup, messages]);
