import { check } from "../errors.mjs";
import { isCalendarDate } from "../../shared/calendar-date.mjs";

// The shell owns "all", "visit" and the merge/sort/page/count pipeline. Every
// other kind comes from an enabled plugin agendaSource, so moving a scenario
// out only requires moving its source.
export const AGENDA_KINDS = ["all", "visit"];
const ALL_KIND = { kind: "all", label: "全部", order: 0 };
const VISIT_KIND = { kind: "visit", label: "复诊", order: 20 };
// Lab results awaiting review are part of the fixed patient chart. They keep
// the historical tracking kind so the agenda UI is unchanged after care
// tracking moved to a plugin.
const LABS_KIND = { kind: "tracking", label: "检查检验", order: 40 };
// Treatment-plan review dates belong to the fixed patient chart: an active
// plan whose review date has arrived stays on the agenda until the doctor
// records a new assessment or moves the date.
const PLAN_REVIEW_KIND = { kind: "plan-review", label: "方案复评", order: 25 };
const localDay = (ms) => { const d = new Date(ms); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const time = (value) => typeof value === "number" ? value : Date.parse(value) || 0;

// Read model only: work remains owned by its original patient/session/domain.
// The agenda lists what a patient needs today and high-risk findings; the
// doctor's own workflow (AI proposals, drafts to review, failed tasks) is a
// separate "work" lane so it never crowds out patient care. Counts are
// computed before pagination. A row never doubles as a "complete" action.
export class DoctorOverview {
  constructor(store, sessions, { schedule, contactMatches, trialWork, agendaSources, agendaItems } = {}) {
    this.store = store;
    this.sessions = sessions;
    this.schedule = schedule;
    this.contactMatches = contactMatches;
    this.trialWork = trialWork;
    this.agendaSources = agendaSources;
    this.agendaItems = agendaItems;
  }

  // Return visits: tomorrow tell the patient, today prepare, past ones need an outcome.
  _visitItems() {
    const items = [];
    for (const a of this.schedule?.dueAppointments() || []) {
      const at = [a.date, a.time].filter(Boolean).join(" "), what = [a.reason, a.place].filter(Boolean).join(" · ");
      const view = { tomorrow: ["明天复诊", "提醒患者按时来", 4], today: ["今天复诊", "提前查看档案和近期结果", 2], past: ["复诊未登记到诊情况", "确认患者是否来过，未来需重新预约", 3] }[a.when];
      // Untimed visits sort after the timed ones of the same day (end of day),
      // instead of pretending they are at 08:00. `time` lets the UI show HH:mm.
      items.push({ id: `visit:${a.id}`, kind: "visit", patientId: a.patientId, title: view[0], detail: [at, what, view[1]].filter(Boolean).join("，"),
        at: Date.parse(`${a.date}T${a.time || "23:59"}:00`), time: a.time || "", weight: view[2],
        // Inline 已到诊/未到诊 in the agenda needs the appointment id and revision.
        appointmentId: a.id, revision: a.revision || 0,
        action: { type: "patient", tab: "appointments", label: a.when === "past" ? "登记结果" : "查看预约" } });
    }
    return items;
  }

  // New lab values added to the chart since the doctor last marked them read.
  // The patient labs page owns the read state; this is only the agenda view.
  _labItems() {
    const items = [];
    for (const { patientId, labs } of this.schedule?.allNewLabs() || []) {
      const shown = labs
        .slice(0, 3)
        .map((lab) => `${lab.item} ${lab.value}${lab.unit || ""}`)
        .join("、");
      const date = isCalendarDate(labs[0].date) ? labs[0].date : "";
      const undated = labs.filter((lab) => !isCalendarDate(lab.date)).length;
      items.push({
        id: `labs:${patientId}`,
        kind: "tracking",
        patientId,
        title: `待阅检验结果 ${labs.length} 项`,
        detail: `${shown}${labs.length > 3 ? " 等" : ""}（${date ? `最近日期 ${date}` : "日期待核对"}${date && undated ? `；另有 ${undated} 条日期待核对` : ""}），查看后点「标记已阅」`,
        at: date,
        weight: 4,
        count: labs.length,
        action: { type: "patient", tab: "labs", label: "查看结果" },
      });
    }
    return items;
  }

  _planReviewItems(plans, current) {
    const today = this.schedule?.today?.() || localDay(current);
    const items = [];
    for (const { patientId, plan } of plans) {
      if (plan?.status !== "active" || !isCalendarDate(plan.reviewDate) || plan.reviewDate > today) continue;
      // Recording an assessment on or after the review date closes the item.
      if (isCalendarDate(plan.assessmentDate) && plan.assessmentDate >= plan.reviewDate) continue;
      const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${plan.reviewDate}T00:00:00Z`)) / 86400000);
      items.push({
        id: `plan-review:${patientId}:${plan.reviewDate}`,
        kind: "plan-review",
        patientId,
        title: days > 0 ? `治疗方案复评已逾期 ${days} 天` : "今天治疗方案复评",
        detail: `「${plan.title || "治疗方案"}」复评日期 ${plan.reviewDate}，核对疗效与耐受情况后记录评估，并安排下次复评日期`,
        at: Date.parse(`${plan.reviewDate}T08:00:00`),
        weight: days > 0 ? 3 : 4,
        action: { type: "patient", tab: "medications", label: "记录评估" },
      });
    }
    return items;
  }

  read({ kind = "all", query = "", group = "", patientId = "", excludeRiskAlerts = false, offset = 0, limit = 12, now = Date.now() } = {}) {
    const current = typeof now === "number" ? now : Date.parse(now) || Date.now();
    const sourceKinds = new Map([
      [VISIT_KIND.kind, VISIT_KIND],
      [PLAN_REVIEW_KIND.kind, PLAN_REVIEW_KIND],
      [LABS_KIND.kind, LABS_KIND],
    ]);
    for (const source of this.agendaSources?.() || [])
      if (!source.workOnly && !sourceKinds.has(source.kind))
        sourceKinds.set(source.kind, { kind: source.kind, label: source.label, order: source.order });
    const kindMeta = [ALL_KIND, ...sourceKinds.values()].sort((a, b) => a.order - b.order || a.kind.localeCompare(b.kind));
    check(kindMeta.some((item) => item.kind === kind), "INVALID_INPUT", "待办分类无效");
    check(typeof query === "string" && query.length <= 100, "INVALID_INPUT", "搜索词过长");
    check(typeof group === "string" && group.length <= 40, "INVALID_INPUT", "分组名过长");
    check(typeof patientId === "string" && patientId.length <= 200, "INVALID_INPUT", "患者编号无效");
    check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      "INVALID_INPUT", "分页参数无效");
    const db = this.store.db;
    const plans = [];
    const people = new Map(db.prepare("SELECT id,data FROM patients").all().map((row) => {
      const p = JSON.parse(row.data);
      if (p.treatmentPlan) plans.push({ patientId: row.id, plan: p.treatmentPlan });
      return [row.id, { id: row.id, name: p.name, patientNumber: p.patientNumber || "", birthYear: p.birthYear, archived: p.archived, groups: p.groups || [] }];
    }));
    check(!patientId || people.has(patientId), "NOT_FOUND", "患者不存在", 404);
    // 分组联动：分组待办只保留属于该分组在管患者的事项；与患者无关的
    // 通用事项（认领收件箱、工作台进化等）在筛选时隐藏。
    const groupMembers = group
      ? new Set([...people.values()].filter((p) => !p.archived && p.groups.includes(group)).map((p) => p.id))
      : null;
    const inGroup = (item) => (!patientId || item.patientId === patientId) && (!groupMembers || (item.patientId && groupMembers.has(item.patientId)));
    const rows = [], work = [];
    const place = (list) => (item) => {
      const patient = item.patientId ? people.get(item.patientId) : null;
      if (item.patientId && (!patient || patient.archived)) return;
      list.push({ ...item, at: time(item.at), patientName: patient?.name || item.fallbackName || "未关联患者", patientNumber: patient?.patientNumber || "", birthYear: patient?.birthYear || null });
    };
    const add = place(rows), addWork = place(work);
    const errors = [];

    // ---------- fixed region: return visits and new lab results ----------
    for (const item of this._visitItems()) add(item);
    for (const item of this._labItems()) add(item);
    const planReviews = new Set();
    for (const item of this._planReviewItems(plans, current)) { planReviews.add(item.id); add(item); }

    // ---------- plugin sources: everything else ----------
    const pluginItems = this.agendaItems?.({
      now: current,
      patientId,
      onError: (error) => errors.push({ kind: error.kind, message: error.message }),
    }) || [];
    for (const raw of pluginItems) {
      // pluginId/lane are host bookkeeping; keep the public row shape unchanged.
      // `covers` names a shell row describing the same work (a follow-up made
      // from a treatment-plan review date); show only the plan-review row.
      const { pluginId: _pluginId, lane, covers, ...item } = raw;
      if (covers && planReviews.has(covers)) continue;
      if (lane === "work") addWork(item); else add(item);
    }

    // ---------- the doctor's own workflow ----------
    for (const row of db.prepare("SELECT id,patient_id,summary,created_at FROM pending_actions WHERE status='pending'").all()) {
      addWork({ id: `proposal:${row.id}`, kind: "proposal", patientId: row.patient_id, title: row.summary,
        detail: "AI 提议，确认后才生效", at: row.created_at,
        action: { type: row.patient_id ? "patient" : "patients", tab: "overview", label: "确认提案" } });
    }
    for (const session of this.sessions.list()) {
      // Background sessions (per-patient trial screening) surface through their own summary item.
      if (session.background) continue;
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

    const dedupe = (items) => {
      const seen = new Set();
      return items.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
    };
    const visible = dedupe(rows.filter(item => inGroup(item) && !(patientId && excludeRiskAlerts && item.id.startsWith("risk:"))));
    const counts = Object.fromEntries(kindMeta.map((item) => [item.kind, item.kind === "all" ? visible.length : visible.filter((row) => row.kind === item.kind).length]));
    const kinds = kindMeta.map((item) => ({ kind: item.kind, label: item.label, count: counts[item.kind] }));
    const needle = query.trim().toLowerCase();
    const matchesQuery = (item) => !needle || `${item.patientName} ${item.patientNumber} ${item.title} ${item.detail}`.toLowerCase().includes(needle);
    const filtered = visible.filter((item) => (kind === "all" || item.kind === kind) && matchesQuery(item))
      .sort((a, b) => a.weight - b.weight || a.at - b.at || a.id.localeCompare(b.id));
    const workItems = dedupe(work.filter((item) => inGroup(item) && matchesQuery(item))).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    return { counts, kinds, criticalCount: filtered.filter(item => item.severity === "critical").length, total: filtered.length, offset, limit, hasMore: offset + limit < filtered.length,
      items: filtered.slice(offset, offset + limit), work: { total: workItems.length, items: workItems.slice(0, 30) },
      generatedAt: now, patientCount: [...people.values()].filter((p) => !p.archived && (!patientId || p.id === patientId)).length,
      ...(errors.length ? { errors } : {}) };
  }
}
