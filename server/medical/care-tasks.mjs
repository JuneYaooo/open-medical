import { randomUUID, createHash } from "node:crypto";
import { check, identifier, string } from "../errors.mjs";
import { sqliteTransaction } from "../sqlite-transaction.mjs";

export const CARE_STATES = { waiting_result: "等待结果", awaiting_review: "待医生核对", awaiting_communication: "待告知患者", completed: "已闭环", cancelled: "已取消" };
const required = (value, label, length = 2000) => {
  const text = string(value, label, length).trim();
  check(text.length > 0, "INVALID_INPUT", `请填写${label}`);
  return text;
};

// A doctor's local tracking record, not a hospital order or an outbound message.
export class CareTasks {
  constructor(store, patients, followups) { Object.assign(this, { store, patients, followups }); }
  patient(id) {
    const p = this.patients.row(id);
    check(!p.archived, "PATIENT_ARCHIVED", "请先恢复患者档案再更新待跟进事项", 409);
    return p;
  }
  row(patientId, id) {
    identifier(id);
    const row = this.store.db.prepare("SELECT data FROM care_tasks WHERE id=? AND patient_id=?").get(id, patientId);
    check(row, "NOT_FOUND", "待跟进事项不存在", 404);
    return JSON.parse(row.data);
  }
  list(patientId, { status = "active", offset = 0, limit = 20 } = {}) {
    this.patients.row(patientId);
    check(["active", "closed", "all"].includes(status), "INVALID_INPUT", "跟进分类无效");
    check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, "INVALID_INPUT", "分页参数无效");
    const condition = status === "active" ? " AND status NOT IN ('completed','cancelled')" : status === "closed" ? " AND status IN ('completed','cancelled')" : "";
    const total = this.store.db.prepare(`SELECT COUNT(*) n FROM care_tasks WHERE patient_id=?${condition}`).get(patientId).n;
    const items = this.store.db.prepare(`SELECT data FROM care_tasks WHERE patient_id=?${condition} ORDER BY ${status === "closed" ? "updated_at DESC" : "due_at ASC"},id LIMIT ? OFFSET ?`).all(patientId, limit, offset).map((row) => JSON.parse(row.data));
    return { items, total, offset, limit, hasMore: offset + limit < total };
  }
  create(patientId, input) {
    return sqliteTransaction(this.store.db, () => {
      const p = this.patient(patientId);
      check(input && typeof input === "object", "INVALID_INPUT", "跟进事项无效");
      const title = required(input.title, "跟进内容", 100);
      check(["test", "referral", "other"].includes(input.kind), "INVALID_INPUT", "请选择跟进类型");
      const dueAt = Date.parse(input.dueAt);
      check(Number.isFinite(dueAt) && dueAt >= Date.parse("1900-01-01") && dueAt < Date.now() + 366 * 86400000, "INVALID_INPUT", "请设置一年内的跟进时间");
      const note = input.note ? required(input.note, "跟进说明") : "";
      const requestId = input.requestId ? identifier(input.requestId) : randomUUID();
      const id = `care_${requestId}`;
      check(id.length <= 100, "INVALID_INPUT", "请求标识过长");
      const fingerprint = createHash("sha256").update(JSON.stringify({ patientId, title, kind: input.kind, dueAt, note })).digest("hex");
      const existing = this.store.db.prepare("SELECT data FROM care_tasks WHERE id=?").get(id);
      if (existing) {
        const task = JSON.parse(existing.data);
        check(task.fingerprint === fingerprint, "CONFLICT", "该请求已用于其他跟进事项", 409);
        return task;
      }
      const now = Date.now();
      const task = { id, patientId, title, kind: input.kind, dueAt, note, status: "waiting_result", revision: 0,
        fingerprint, createdAt: now, updatedAt: now, history: [{ action: "created", at: now, note }] };
      this.store.db.prepare("INSERT INTO care_tasks VALUES (?,?,?,?,?,?)").run(id, patientId, task.status, dueAt, now, JSON.stringify(task));
      this.store.audit(p.sessionId, "care-task.created", { careTaskId: id });
      return task;
    });
  }
  update(patientId, id, input) {
    return sqliteTransaction(this.store.db, () => {
      const p = this.patient(patientId), task = this.row(patientId, id);
      check(input?.expectedRevision === task.revision, "REVISION_CONFLICT", "事项已变化，请刷新后重试", 409);
      const note = required(input.note, "处理记录");
      const before = task.status;
      const active = !["completed", "cancelled"].includes(before);
      const next = { receive: ["waiting_result", "awaiting_review"], review: ["awaiting_review", "awaiting_communication"], complete: ["awaiting_communication", "completed"] }[input.action];
      let nextJob = null;
      if (next) {
        check(before === next[0], "CONFLICT", "请按结果接收、医生核对、告知患者的顺序登记", 409);
        if (input.action === "receive") task.resultSource = required(input.source, "结果来源", 500);
        if (input.action === "review") task.reviewNote = note;
        if (input.action === "complete") {
          check(["communicated", "not_required"].includes(input.communication), "INVALID_INPUT", "请选择告知情况");
          task.communication = input.communication;
          if (input.nextDueAt) nextJob = this.followups.create(patientId, { name: input.nextName || task.title,
            once: true, firstDueAt: input.nextDueAt, checklist: [], externalConsent: false });
          task.nextFollowUpId = nextJob?.id || null;
          task.nextDueAt = nextJob?.nextDue || null;
        }
        task.status = next[1];
      } else if (input.action === "cancel") {
        check(active, "CONFLICT", "事项已结束", 409); task.status = "cancelled";
      } else if (input.action === "reopen") {
        check(!active, "CONFLICT", "事项尚未结束", 409); task.status = "waiting_result";
        // A new cycle retains its history but does not present old review as current.
        delete task.resultSource; delete task.reviewNote; delete task.communication;
        delete task.nextFollowUpId; delete task.nextDueAt;
      } else if (input.action === "reschedule") {
        check(active, "CONFLICT", "事项已结束", 409);
      } else check(false, "INVALID_INPUT", "跟进操作无效");
      if (["reschedule", "reopen"].includes(input.action)) {
        const dueAt = Date.parse(input.dueAt);
        check(Number.isFinite(dueAt) && dueAt > Date.now() && dueAt < Date.now() + 366 * 86400000, "INVALID_INPUT", "请设置未来一年内的跟进时间");
        task.dueAt = dueAt;
      }
      task.revision++; task.updatedAt = Date.now();
      task.history.push({ action: input.action, from: before, to: task.status, at: task.updatedAt, note,
        ...(input.action === "receive" ? { source: task.resultSource } : {}),
        ...(input.action === "complete" ? { communication: task.communication, nextFollowUpId: task.nextFollowUpId } : {}),
        ...(["reschedule", "reopen"].includes(input.action) ? { dueAt: task.dueAt } : {}) });
      this.store.db.prepare("UPDATE care_tasks SET status=?,due_at=?,updated_at=?,data=? WHERE id=?")
        .run(task.status, task.dueAt, task.updatedAt, JSON.stringify(task), id);
      this.store.audit(p.sessionId, `care-task.${input.action}`, { careTaskId: id, revision: task.revision, nextFollowUpId: nextJob?.id || null });
      return task;
    });
  }
}
