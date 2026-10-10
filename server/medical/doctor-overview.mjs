import { check } from "../errors.mjs";

export const AGENDA_KINDS = ["all", "risk", "visit", "followup", "tracking", "messages", "trial", "custom"];
const time = (value) => typeof value === "number" ? value : Date.parse(value) || 0;
const DAY = 86400000;
const TRIAL_STEP = { shortlisted: "联系患者，说明研究", contacted: "登记知情同意", consented: "确认入组" };

// Read model only: work remains owned by its original patient/session/domain.
// The agenda lists what a patient needs today and high-risk findings; the
// doctor's own workflow (AI proposals, drafts to review, failed tasks) is a
// separate "work" lane so it never crowds out patient care. Counts are
// computed before pagination. A row never doubles as a "complete" action.
export class DoctorOverview {
  constructor(store, sessions, { schedule, extensions, contactMatches, trialWork } = {}) { this.store = store; this.sessions = sessions; this.schedule = schedule; this.extensions = extensions; this.contactMatches = contactMatches; this.trialWork = trialWork; }
  read({ kind = "all", query = "", group = "", offset = 0, limit = 12, now = Date.now() } = {}) {
    check(AGENDA_KINDS.includes(kind), "INVALID_INPUT", "待办分类无效");
    check(typeof query === "string" && query.length <= 100, "INVALID_INPUT", "搜索词过长");
    check(typeof group === "string" && group.length <= 40, "INVALID_INPUT", "分组名过长");
    check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      "INVALID_INPUT", "分页参数无效");
    const db = this.store.db;
    const table = (name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const people = new Map(db.prepare("SELECT id,data FROM patients").all().map((row) => {
      const p = JSON.parse(row.data);
      return [row.id, { id: row.id, name: p.name, patientNumber: p.patientNumber || "", birthYear: p.birthYear, archived: p.archived, groups: p.groups || [] }];
    }));
    // 分组联动：分组待办只保留属于该分组在管患者的事项；与患者无关的
    // 通用事项（认领收件箱、工作台进化等）在筛选时隐藏。
    const groupMembers = group
      ? new Set([...people.values()].filter((p) => !p.archived && p.groups.includes(group)).map((p) => p.id))
      : null;
    const inGroup = (item) => !groupMembers || (item.patientId && groupMembers.has(item.patientId));
    const rows = [], work = [];
    const place = (list) => (item) => {
      const patient = item.patientId ? people.get(item.patientId) : null;
      if (item.patientId && (!patient || patient.archived)) return;
      list.push({ ...item, at: time(item.at), patientName: patient?.name || item.fallbackName || "未关联患者", patientNumber: patient?.patientNumber || "", birthYear: patient?.birthYear || null });
    };
    const add = place(rows), addWork = place(work);
    const overdue = (at) => { const days = Math.floor((now - time(at)) / DAY); return days >= 1 ? `已逾期 ${days} 天` : ""; };

    // ---------- high risk ----------
    for (const row of db.prepare("SELECT id,patient_id,severity,updated_at,data FROM risk_alerts WHERE status='active'").all()) {
      const data = JSON.parse(row.data);
      add({ id: `risk:${row.id}`, kind: "risk", patientId: row.patient_id, title: data.title, detail: data.message,
        at: row.updated_at, weight: row.severity === "critical" ? 0 : 4, severity: row.severity,
        action: { type: "patient", tab: "overview", label: "核对风险" } });
    }
    if (table("care_alerts")) for (const row of db.prepare("SELECT id,patient_id,level,reason,created_at FROM care_alerts WHERE status='open'").all()) {
      const urgent = row.level === "urgent";
      add({ id: `care-alert:${row.id}`, kind: urgent ? "risk" : "messages", patientId: row.patient_id,
        title: urgent ? "患者消息提示紧急情况" : "患者消息需要医生回复", detail: row.reason, at: row.created_at,
        weight: urgent ? 0 : 3, severity: urgent ? "critical" : undefined,
        action: { type: "view", view: "care", tab: "alerts", label: urgent ? "立即查看" : "查看消息" } });
    }

    // ---------- follow-up and tracking ----------
    for (const row of db.prepare("SELECT id,patient_id,status,due_at,data FROM care_tasks WHERE status IN ('awaiting_review','awaiting_communication') OR (status='waiting_result' AND due_at<=?)").all(now)) {
      const task = JSON.parse(row.data);
      const label = { waiting_result: "结果尚未收到，跟进时间已到", awaiting_review: "结果已收到，等待医生核对", awaiting_communication: "医生已核对，需告知患者" }[row.status];
      add({ id: `tracking:${row.id}`, kind: "tracking", patientId: row.patient_id, title: task.title, detail: label,
        at: row.due_at, weight: row.status === "awaiting_review" ? 3 : 5,
        action: { type: "patient", tab: "tracking", label: "继续跟进" } });
    }
    // Return visits: tomorrow tell the patient, today prepare, past ones need an outcome.
    for (const a of this.schedule?.dueAppointments() || []) {
      const at = [a.date, a.time].filter(Boolean).join(" "), what = [a.reason, a.place].filter(Boolean).join(" · ");
      const view = { tomorrow: ["明天复诊", "提醒患者按时来", 4], today: ["今天复诊", "提前查看档案和近期结果", 2], past: ["复诊未登记到诊情况", "确认患者是否来过，未来需重新预约", 3] }[a.when];
      add({ id: `visit:${a.id}`, kind: "visit", patientId: a.patientId, title: view[0], detail: [at, what, view[1]].filter(Boolean).join("，"),
        at: Date.parse(`${a.date}T${a.time || "08:00"}:00`), weight: view[2], action: { type: "patient", tab: "appointments", label: a.when === "past" ? "登记结果" : "查看预约" } });
    }
    // Lab values added to the chart since the doctor last marked them read.
    for (const { patientId, labs } of this.schedule?.allNewLabs() || []) {
      const shown = labs.slice(0, 3).map((l) => `${l.item} ${l.value}${l.unit || ""}`).join("、");
      add({ id: `labs:${patientId}`, kind: "tracking", patientId, title: `新检验结果 ${labs.length} 项`, detail: `${shown}${labs.length > 3 ? " 等" : ""}（${labs[0].date}），查看后标记已阅`,
        at: labs[0].date, weight: 4, count: labs.length, action: { type: "patient", tab: "labs", label: "查看结果" } });
    }
    // Reminders are created when a follow-up falls due.
    for (const row of db.prepare("SELECT id,patient_id,due_at,data FROM reminders WHERE status='pending'").all()) {
      const data = JSON.parse(row.data);
      add({ id: `reminder:${row.id}`, kind: "followup", patientId: row.patient_id, title: data.title,
        detail: [overdue(row.due_at), "联系患者后登记随访结果"].filter(Boolean).join("，"), at: row.due_at, weight: row.due_at < now - DAY ? 1 : 5,
        action: { type: "patient", tab: "followups", label: "登记随访" } });
    }
    for (const row of db.prepare("SELECT id,patient_id,status,next_due,data FROM follow_ups WHERE status='paused' OR (status='active' AND next_due<=?)").all(now)) {
      const data = JSON.parse(row.data);
      if (row.status === "paused") {
        if (data.lastError) addWork({ id: `schedule:${row.id}`, kind: "failure", patientId: row.patient_id, title: `随访计划「${data.name}」已暂停`,
          detail: data.lastError, at: row.next_due, action: { type: "patient", tab: "followups", label: "检查计划" } });
        continue;
      }
      add({ id: `schedule:${row.id}`, kind: "followup", patientId: row.patient_id, title: data.name,
        detail: [overdue(row.next_due), "随访到期，联系患者"].filter(Boolean).join("，"), at: row.next_due, weight: 5,
        action: { type: "patient", tab: "followups", label: "查看随访" } });
    }

    // ---------- patient messages ----------
    for (const row of db.prepare("SELECT patient_id,COUNT(*) n,MIN(time) oldest FROM patient_messages WHERE processed=0 AND patient_id IS NOT NULL GROUP BY patient_id").all()) {
      add({ id: `messages:${row.patient_id}`, kind: "messages", patientId: row.patient_id,
        title: `发来 ${row.n} 条消息`, detail: "查看原文，决定是否回复或记入档案", at: time(row.oldest), weight: 6,
        count: row.n, action: { type: "patient", tab: "messages", label: "处理消息" } });
    }
    const inbox = db.prepare("SELECT COUNT(*) n FROM patient_messages WHERE patient_id IS NULL").get().n;
    if (inbox) add({ id: "inbox", kind: "messages", title: `${inbox} 条消息不确定是哪位患者`, detail: "核对身份后归到对应患者", at: 0, weight: 3,
      count: inbox, action: { type: "patients", label: "认领消息" } });
    if (table("care_replies")) for (const row of db.prepare("SELECT patient_id,COUNT(*) n,MIN(created_at) oldest FROM care_replies WHERE status='draft' AND patient_id IS NOT NULL GROUP BY patient_id").all()) {
      add({ id: `care-draft:${row.patient_id}`, kind: "messages", patientId: row.patient_id, title: row.n > 1 ? `${row.n} 条回复待发送` : "回复待发送",
        detail: "已起草回复，核对后发给患者", at: row.oldest, weight: 4, count: row.n,
        action: { type: "view", view: "care", tab: "drafts", label: "核对发送" } });
    }

    // ---------- trial enrollment ----------
    if (table("trial_enrollments")) {
      const titles = new Map(db.prepare("SELECT id,data FROM trial_protocols").all().map((r) => [r.id, JSON.parse(r.data).title]));
      for (const row of db.prepare("SELECT trial_id,patient_id,data FROM trial_enrollments").all()) {
        const e = JSON.parse(row.data);
        if (!TRIAL_STEP[e.stage] || !titles.has(row.trial_id)) continue;
        add({ id: `trial:${row.trial_id}:${row.patient_id}`, kind: "trial", patientId: row.patient_id, title: TRIAL_STEP[e.stage],
          detail: `临床试验「${titles.get(row.trial_id).slice(0, 40)}」`, at: e.updatedAt, weight: 6,
          action: { type: "view", view: "research", trialId: row.trial_id, label: "打开试验" } });
      }
    }

    // ---------- the doctor's own rules (extension center) ----------
    const ext = this.extensions?.();
    for (const item of ext?.openItems() || []) {
      const entry = { id: `rule:${item.id}`, itemId: item.id, patientId: item.patientId, title: item.title, detail: `${item.detail ? `${item.detail} · ` : ""}来自规则「${item.rule}」`,
        at: item.createdAt, weight: 5, resolvable: true, fallbackName: "我的规则",
        action: item.sessionId ? { type: "task", sessionId: item.sessionId, label: "打开汇总" } : item.replyId ? { type: "view", view: "care", tab: "drafts", label: "核对发送" } : { type: "patient", tab: "overview", label: "查看患者" } };
      if (item.lane === "work" || !item.patientId) addWork({ ...entry, kind: "review" }); else add({ ...entry, kind: "custom" });
    }
    for (const s of ext?.suggestions() || []) addWork({ id: `evolve:${s.id}`, kind: "evolve", title: s.title, detail: s.evidence, at: s.createdAt, fallbackName: "工作台进化",
      action: { type: "view", view: "settings", settingsTab: "workbench", label: "查看建议" } });
    for (const c of (ext?.changes() || []).filter((c) => c.status === "applied" && now - time(c.createdAt) < 7 * DAY)) addWork({ id: `evolved:${c.id}`, kind: "evolve", title: `已自动调整：${c.title}`,
      detail: c.detail, at: c.createdAt, fallbackName: "工作台进化", action: { type: "view", view: "settings", settingsTab: "workbench", label: "查看或撤销" } });

    // ---------- the doctor's own workflow ----------
    for (const row of db.prepare("SELECT id,patient_id,summary,created_at FROM pending_actions WHERE status='pending'").all()) {
      addWork({ id: `proposal:${row.id}`, kind: "proposal", patientId: row.patient_id, title: row.summary,
        detail: "AI 提议，确认后才生效", at: row.created_at,
        action: { type: row.patient_id ? "patient" : "patients", tab: "overview", label: "确认提案" } });
    }
    for (const session of this.sessions.list()) {
      // Background sessions (per-patient trial screening) surface through their own summary item.
      if (session.background) continue;
      const pending = session.reviewItems || Array.from({ length: session.reviewCount || 0 }, () => "");
      if (pending.length) addWork({ id: `review:${session.id}`, kind: "review", patientId: session.patientId,
        title: pending[0] ? `${pending[0]}${pending.length > 1 ? ` 等 ${pending.length} 份` : ""}` : session.title,
        detail: pending[0] ? `草稿待复核 · 来自「${session.title}」` : `${pending.length} 份成果待复核`, count: pending.length,
        at: time(session.updatedAt), fallbackName: "独立任务", action: { type: "task", sessionId: session.id, tab: "results", label: "复核" } });
      if (["failed", "interrupted"].includes(session.lastRunStatus) && !session.running) addWork({
        id: `attention:${session.id}`, kind: "failure", patientId: session.patientId, title: `任务未完成：${session.title}`,
        detail: session.lastRunError || "查看记录后继续", at: time(session.updatedAt), fallbackName: "独立任务",
        action: { type: "task", sessionId: session.id, label: "继续任务" },
      });
    }
    for (const t of this.trialWork?.() || []) if (t.awaitingReview) addWork({ id: `trial-review:${t.id}`, kind: "review",
      title: `「${t.title}」${t.awaitingReview} 位患者的 AI 初筛待核对`, detail: "核对冲突和待补资料后保存结论", at: 0, count: t.awaitingReview,
      fallbackName: "临床试验", action: { type: "view", view: "research", trialId: t.id, label: "去核对" } });
    const matches = this.contactMatches?.() || 0;
    if (matches) addWork({ id: "care-contacts", kind: "review", title: `${matches} 位微信客户待确认是哪位患者`, detail: "系统已按备注电话、编号推荐",
      at: 0, count: matches, fallbackName: "企业微信", action: { type: "view", view: "care", tab: "contacts", label: "去确认" } });

    const visible = rows.filter(inGroup);
    const counts = Object.fromEntries(AGENDA_KINDS.map((key) => [key, key === "all" ? visible.length : visible.filter((item) => item.kind === key).length]));
    const needle = query.trim().toLowerCase();
    const matchesQuery = (item) => !needle || `${item.patientName} ${item.patientNumber} ${item.title} ${item.detail}`.toLowerCase().includes(needle);
    const filtered = visible.filter((item) => (kind === "all" || item.kind === kind) && matchesQuery(item))
      .sort((a, b) => a.weight - b.weight || a.at - b.at || a.id.localeCompare(b.id));
    const workItems = work.filter((item) => inGroup(item) && matchesQuery(item)).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    return { counts, total: filtered.length, offset, limit, hasMore: offset + limit < filtered.length,
      items: filtered.slice(offset, offset + limit), work: { total: workItems.length, items: workItems.slice(0, 30) },
      generatedAt: now, patientCount: [...people.values()].filter((p) => !p.archived).length };
  }
}
