import { providerConfigured } from "./core/provider-status.mjs";
import { randomUUID } from "node:crypto";
import { AppError, check, identifier, string } from "./errors.mjs";
import { composeDigest } from "./patients.mjs";

// Durable per-patient follow-up queue. Same semantics as MedicalScheduler:
// synchronous claim on the single database owner, missed intervals advance,
// failed occurrences pause instead of replaying an uncertain request.
export class FollowUpManager {
  constructor(
    store,
    runtime,
    { now = () => Date.now(), pollMs = 1000, autoStart = true } = {},
  ) {
    Object.assign(this, { store, runtime, now, pollMs, autoStart });
    this.inFlight = new Set();
    this.stopped = false;
    for (const row of store.db
      .prepare("SELECT id, data FROM follow_ups WHERE status='running'")
      .all()) {
      const job = JSON.parse(row.data);
      job.status = "paused";
      job.lastError = "服务重启，随访执行已中断；请核对结果后手动恢复";
      job.history.push({
        status: "interrupted",
        time: new Date(now()).toISOString(),
        runId: job.activeRunId || null,
      });
      job.activeRunId = null;
      this.save(job);
    }
  }
  save(job) {
    job.revision++;
    job.history = job.history.slice(-50);
    this.store.db
      .prepare("UPDATE follow_ups SET status=?,next_due=?,data=? WHERE id=?")
      .run(job.status, job.nextDue, JSON.stringify(job), job.id);
  }
  row(id) {
    identifier(id);
    const row = this.store.db
      .prepare("SELECT data FROM follow_ups WHERE id=?")
      .get(id);
    check(row, "NOT_FOUND", "随访计划不存在", 404);
    return JSON.parse(row.data);
  }
  patientRow(patientId) {
    const row = this.store.db
      .prepare("SELECT data FROM patients WHERE id=?")
      .get(patientId);
    check(row, "NOT_FOUND", "患者不存在", 404);
    return JSON.parse(row.data);
  }
  list(patientId) {
    this.patientRow(patientId);
    return this.store.db
      .prepare(
        "SELECT data FROM follow_ups WHERE patient_id=? ORDER BY next_due",
      )
      .all(patientId)
      .map((r) => JSON.parse(r.data));
  }
  create(patientId, input) {
    const patient = this.patientRow(patientId);
    check(
      !patient.archived,
      "PATIENT_ARCHIVED",
      "已归档患者不能新建随访计划",
      409,
    );
    check(
      input && typeof input === "object" && !Array.isArray(input),
      "INVALID_INPUT",
      "随访计划参数无效",
    );
    check(
      this.list(patientId).length < 20,
      "SCHEDULE_LIMIT",
      "每位患者最多保留 20 个随访计划",
      422,
    );
    const firstDueAt = Date.parse(input.firstDueAt);
    check(
      Number.isFinite(firstDueAt) &&
        firstDueAt > this.now() &&
        firstDueAt <= this.now() + 366 * 86400000,
      "INVALID_INPUT",
      "首次随访时间须在未来一年以内",
    );
    const intervalDays = input.intervalDays;
    check(
      Number.isInteger(intervalDays) &&
        intervalDays >= 1 &&
        intervalDays <= 3650,
      "INVALID_INPUT",
      "随访间隔须为 1–3650 天",
    );
    const checklist = (input.checklist || []).map((item) =>
      string(item, "随访条目", 500),
    );
    check(
      checklist.length <= 20 && new Set(checklist).size === checklist.length,
      "INVALID_INPUT",
      "随访条目须为最多 20 条且不重复",
    );
    const job = {
      id: randomUUID(),
      patientId,
      sessionId: patient.sessionId,
      name: string(input.name, "随访名称", 100),
      intervalDays,
      checklist,
      externalConsent: input.externalConsent === true,
      nextDue: firstDueAt,
      status: "active",
      revision: 0,
      createdAt: new Date(this.now()).toISOString(),
      history: [],
      lastError: null,
      activeRunId: null,
    };
    this.store.db
      .prepare("INSERT INTO follow_ups VALUES (?,?,?,?,?)")
      .run(job.id, patientId, job.status, job.nextDue, JSON.stringify(job));
    this.store.audit(patient.sessionId, "followup.created", {
      followUpId: job.id,
      externalConsent: job.externalConsent,
    });
    return job;
  }
  update(id, { revision, status }) {
    const job = this.row(id);
    check(
      job.revision === revision,
      "REVISION_CONFLICT",
      "随访计划已变化，请刷新",
      409,
    );
    check(
      ["active", "paused"].includes(status),
      "INVALID_INPUT",
      "仅支持恢复或暂停随访计划",
    );
    check(job.status !== "running", "RUN_ACTIVE", "请先停止当前随访执行", 409);
    if (status === "active") {
      const patient = this.patientRow(job.patientId);
      check(
        !patient.archived,
        "PATIENT_ARCHIVED",
        "已归档患者不能恢复随访计划",
        409,
      );
      if (job.lastError && job.nextDue <= this.now())
        job.nextDue = this.now() + Math.max(60000, job.intervalDays * 86400000);
      job.lastError = null;
    }
    job.status = status;
    this.save(job);
    this.store.audit(job.sessionId, `followup.${status}`, { followUpId: id });
    return job;
  }
  remove(id, revision) {
    const job = this.row(id);
    check(
      job.revision === revision,
      "REVISION_CONFLICT",
      "随访计划已变化，请刷新",
      409,
    );
    check(job.status !== "running", "RUN_ACTIVE", "请先停止随访执行", 409);
    this.store.db.prepare("DELETE FROM follow_ups WHERE id=?").run(id);
    this.store.audit(job.sessionId, "followup.deleted", { followUpId: id });
  }
  start() {
    if (!this.autoStart || this.timer || this.stopped) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.pollMs);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
  async drain() {
    await Promise.allSettled([...this.inFlight]);
  }
  async tick() {
    if (this.stopped) return;
    const due = this.store.db
      .prepare(
        "SELECT id FROM follow_ups WHERE status='active' AND next_due<=? ORDER BY next_due LIMIT 10",
      )
      .all(this.now());
    const started = [];
    for (const { id } of due) {
      if (this.stopped) break;
      const job = this.getForClaim(id);
      if (!job) continue;
      job.status = "running";
      this.save(job);
      const promise = this.execute(job);
      this.inFlight.add(promise);
      promise.finally(() => this.inFlight.delete(promise)).catch(() => {});
      started.push(promise);
    }
    await Promise.allSettled(started);
  }
  getForClaim(id) {
    const row = this.store.db
      .prepare("SELECT data FROM follow_ups WHERE id=?")
      .get(id);
    if (!row) return null;
    const job = JSON.parse(row.data);
    if (job.status !== "active") return null;
    const patient = this.patientRow(job.patientId);
    if (patient.archived) return null;
    // One execution at a time per workspace, mirroring session run locking.
    if (this.runtime.active.has(job.sessionId)) return null;
    return job;
  }
  pendingMessages(patient, limit = 50) {
    return this.store.db
      .prepare(
        "SELECT direction, channel, time, data FROM patient_messages WHERE patient_id=? AND processed=0 ORDER BY time ASC, id ASC LIMIT ?",
      )
      .all(patient.id, limit)
      .map((row) => ({
        direction: row.direction,
        channel: row.channel,
        time: row.time,
        text: JSON.parse(row.data).text,
      }));
  }
  createReminder(patient, followUp, detail) {
    const reminder = {
      id: randomUUID(),
      patientId: patient.id,
      followUpId: followUp.id,
      title: `随访：${followUp.name}`,
      detail,
      checklist: followUp.checklist,
      sessionId: patient.sessionId,
    };
    this.store.db
      .prepare("INSERT INTO reminders VALUES (?,?,?,?,?,?)")
      .run(
        reminder.id,
        patient.id,
        "followup",
        this.now(),
        "pending",
        JSON.stringify(reminder),
      );
    return reminder;
  }
  async execute(job) {
    let result;
    try {
      const patient = this.patientRow(job.patientId);
      // Keep the composed message inside the runtime's 20000-char budget;
      // anything left over stays unprocessed for the next occurrence.
      const messages = [];
      let budget = 12000;
      for (const message of this.pendingMessages(patient)) {
        if (message.text.length > budget) break;
        budget -= message.text.length;
        messages.push(message);
      }
      const reminder = this.createReminder(
        patient,
        job,
        messages.length
          ? `有 ${messages.length} 条未处理消息`
          : "按计划到期的常规随访",
      );
      result = { status: "completed", digest: false, reminderId: reminder.id };
      if (messages.length) {
        if (
          !job.externalConsent ||
          !providerConfigured(this.runtime.provider)
        ) {
          result.digestSkipped = !job.externalConsent
            ? "未授权自动外发"
            : "未配置模型";
        } else {
          const requestId = `followup_${job.id}_${job.nextDue}`;
          const handle = this.runtime.prepare(job.sessionId, {
            message: composeDigest(messages, patient.name),
            mode: "model",
            externalConsent: true,
            fileIds: [],
            requestId,
            isolatedContext: true,
          });
          job.activeRunId = handle.run.id;
          this.save(job);
          const run = await this.runtime.execute(handle);
          result.runId = run.runId;
          if (run.status === "completed") {
            this.store.db
              .prepare(
                "UPDATE patient_messages SET processed=1, data=json_set(data,'$.digestRunId',json_quote(?)) WHERE patient_id=? AND processed=0",
              )
              .run(run.runId, patient.id);
            result.digest = true;
          } else {
            result = {
              status: "failed",
              error: run.error || "消息摘要执行失败",
              runId: run.runId,
            };
          }
        }
      }
    } catch (error) {
      result = {
        status: "failed",
        error: error instanceof AppError ? error.message : "随访执行失败",
        runId: job.activeRunId,
      };
    }
    job.history.push({
      status: result.status,
      digest: Boolean(result.digest),
      digestSkipped: result.digestSkipped,
      error: result.error,
      runId: result.runId,
      scheduledAt: job.nextDue,
      time: new Date(this.now()).toISOString(),
    });
    job.activeRunId = null;
    job.lastError = result.error || null;
    if (result.status !== "completed") job.status = "paused";
    else {
      const interval = job.intervalDays * 86400000;
      job.nextDue +=
        (Math.floor(Math.max(0, this.now() - job.nextDue) / interval) + 1) *
        interval;
      job.status = "active";
    }
    this.save(job);
    this.store.audit(job.sessionId, "followup.executed", {
      followUpId: job.id,
      status: result.status,
      digest: Boolean(result.digest),
    });
    return result;
  }
  reminders({ patientId, status = "pending", limit = 100 } = {}) {
    check(
      ["pending", "done"].includes(status),
      "INVALID_INPUT",
      "提醒状态无效",
    );
    check(
      Number.isInteger(limit) && limit > 0 && limit <= 500,
      "INVALID_INPUT",
      "提醒分页参数无效",
    );
    const where = patientId
      ? "WHERE status=? AND patient_id=?"
      : "WHERE status=?";
    const args = patientId ? [status, patientId, limit] : [status, limit];
    return this.store.db
      .prepare(
        `SELECT r.id, r.patient_id, r.kind, r.due_at, r.status, r.data, p.data AS patient
         FROM reminders r LEFT JOIN patients p ON p.id=r.patient_id
         ${where} ORDER BY r.due_at ASC LIMIT ?`,
      )
      .all(...args)
      .map((row) => {
        const patient = row.patient ? JSON.parse(row.patient) : null;
        return {
          id: row.id,
          patientId: row.patient_id,
          patientName: patient?.name || "已删除",
          kind: row.kind,
          dueAt: row.due_at,
          status: row.status,
          ...JSON.parse(row.data),
        };
      });
  }
  ackReminder(id) {
    identifier(id);
    const row = this.store.db
      .prepare("SELECT id, data FROM reminders WHERE id=?")
      .get(id);
    check(row, "NOT_FOUND", "提醒不存在", 404);
    this.store.db
      .prepare("UPDATE reminders SET status='done' WHERE id=?")
      .run(id);
    return { ok: true };
  }
}
