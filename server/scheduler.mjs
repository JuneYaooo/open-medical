import { providerConfigured } from "./core/provider-status.mjs";
import { randomUUID } from "node:crypto";
import { AppError, check, identifier, string } from "./errors.mjs";
import { MEDICAL_AGENTS } from "./subagents.mjs";

// Durable local queue, independent of a browser connection. No outgoing messages.
// Missed intervals coalesce; interrupted occurrences never silently replay.
export class MedicalScheduler {
  constructor(
    store,
    runtime,
    {
      now = () => Date.now(),
      pollMs = 1000,
      autoStart = true,
      resolveSession,
    } = {},
  ) {
    Object.assign(this, { store, runtime, now, pollMs, autoStart });
    // 会话统一内核后，计划可能挂在 kind:"session" 的工作区上；
    // resolveSession 返回 {revision, files}，缺省读旧 sessions 表。
    this.resolveSession =
      resolveSession || ((sessionId) => this.store.get(sessionId));
    this.inFlight = new Set();
    this.stopped = false;
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS scheduled_jobs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, next_run_at INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS scheduled_jobs_due ON scheduled_jobs(status,next_run_at);",
    );
    for (const row of store.db
      .prepare("SELECT data FROM scheduled_jobs WHERE status='running'")
      .all()) {
      const job = JSON.parse(row.data);
      job.status = "paused";
      job.lastError = "服务重启，计划执行已中断；请核对结果后手动恢复";
      job.history.push({
        status: "interrupted",
        time: new Date(now()).toISOString(),
        runId: job.activeRunId || null,
      });
      job.activeRunId = null;
      this.save(job);
    }
  }
  identity() {
    const p = this.runtime.provider;
    return JSON.stringify([p.provider, p.baseUrl, p.model]);
  }
  get(id) {
    identifier(id);
    const row = this.store.db
      .prepare("SELECT data FROM scheduled_jobs WHERE id=?")
      .get(id);
    check(row, "NOT_FOUND", "计划任务不存在", 404);
    return JSON.parse(row.data);
  }
  list(sessionId) {
    this.resolveSession(sessionId);
    return this.store.db
      .prepare(
        "SELECT data FROM scheduled_jobs WHERE session_id=? ORDER BY next_run_at",
      )
      .all(sessionId)
      .map((r) => JSON.parse(r.data));
  }
  save(job) {
    job.revision++;
    job.history = job.history.slice(-50);
    this.store.db
      .prepare(
        "UPDATE scheduled_jobs SET status=?,next_run_at=?,data=? WHERE id=?",
      )
      .run(job.status, job.nextRunAt, JSON.stringify(job), job.id);
    return job;
  }
  create(sessionId, input) {
    const session = this.resolveSession(sessionId);
    check(
      input && typeof input === "object" && !Array.isArray(input),
      "INVALID_INPUT",
      "计划参数无效",
    );
    if (input.sessionRevision !== undefined)
      check(
        input.sessionRevision === session.revision,
        "REVISION_CONFLICT",
        "会话资料已变化，请刷新核对计划范围",
        409,
      );
    check(
      this.list(sessionId).length < 30,
      "SCHEDULE_LIMIT",
      "每个会话最多保留 30 个计划",
      422,
    );
    const mode = input.mode || "local";
    check(
      ["local", "model"].includes(mode),
      "INVALID_INPUT",
      "计划运行方式无效",
    );
    if (mode === "model") {
      check(
        providerConfigured(this.runtime.provider),
        "MODEL_NOT_CONFIGURED",
        "尚未配置模型",
        503,
      );
      check(
        input.externalConsent === true,
        "CONSENT_REQUIRED",
        "模型计划需明确授权按固定材料重复外发",
        412,
      );
    }
    const nextRunAt = Date.parse(input.runAt);
    check(
      Number.isFinite(nextRunAt) &&
        nextRunAt > this.now() &&
        nextRunAt <= this.now() + 366 * 86400000,
      "INVALID_INPUT",
      "首次执行时间须在未来一年以内",
    );
    const intervalMinutes = input.intervalMinutes ?? 0;
    check(
      Number.isInteger(intervalMinutes) &&
        (intervalMinutes === 0 ||
          (intervalMinutes >= 1 && intervalMinutes <= 525600)),
      "INVALID_INPUT",
      "间隔应为 0（单次）或 1–525600 分钟",
    );
    check(
      Array.isArray(input.fileIds) &&
        input.fileIds.length <= 10 &&
        new Set(input.fileIds).size === input.fileIds.length,
      "INVALID_INPUT",
      "计划资料选择无效",
    );
    const sourceHashes = input.fileIds.map((id) => {
      const file = session.files.find((f) => f.id === id);
      check(file, "SOURCE_NOT_FOUND", "计划只能读取当前会话材料", 404);
      return { id, hash: file.hash };
    });
    const delegations = input.delegations || [];
    check(
      Array.isArray(delegations) &&
        delegations.length <= 3 &&
        new Set(delegations).size === delegations.length &&
        delegations.every((p) => Object.hasOwn(MEDICAL_AGENTS, p)),
      "AGENT_PROFILE",
      "子代理配置无效",
    );
    const job = {
      id: randomUUID(),
      sessionId,
      name: string(input.name, "计划名称", 100),
      message: string(input.message, "计划任务", 20000),
      mode,
      fileIds: [...input.fileIds],
      sourceHashes,
      delegations,
      nextRunAt,
      intervalMinutes,
      status: "active",
      revision: 0,
      createdAt: new Date(this.now()).toISOString(),
      providerIdentity: mode === "model" ? this.identity() : null,
      externalConsent: mode === "model",
      history: [],
      lastError: null,
      activeRunId: null,
    };
    this.store.db
      .prepare("INSERT INTO scheduled_jobs VALUES (?,?,?,?,?)")
      .run(job.id, sessionId, job.status, nextRunAt, JSON.stringify(job));
    this.store.audit(sessionId, "schedule.created", {
      jobId: job.id,
      mode,
      sourceHashes,
      externalConsent: job.externalConsent,
    });
    return job;
  }
  update(id, { revision, status }) {
    const job = this.get(id);
    check(
      job.revision === revision,
      "REVISION_CONFLICT",
      "计划已变化，请刷新",
      409,
    );
    check(
      ["active", "paused"].includes(status),
      "INVALID_INPUT",
      "仅支持恢复或暂停计划",
    );
    check(job.status !== "running", "RUN_ACTIVE", "请先停止当前计划执行", 409);
    check(
      job.status !== "completed",
      "SCHEDULE_COMPLETED",
      "单次计划已完成，请新建计划",
      409,
    );
    if (status === "active") {
      this.validateSnapshot(job);
      // Explicit resume after a failed/interrupted occurrence creates a NEW
      // future occurrence; do not replay the uncertain original request ID.
      if (job.lastError && job.nextRunAt <= this.now())
        job.nextRunAt =
          this.now() + Math.max(1000, job.intervalMinutes * 60000);
      job.lastError = null;
    }
    job.status = status;
    this.save(job);
    this.store.audit(job.sessionId, `schedule.${status}`, { jobId: id });
    return job;
  }
  delete(id, revision) {
    const job = this.get(id);
    check(
      job.revision === revision,
      "REVISION_CONFLICT",
      "计划已变化，请刷新",
      409,
    );
    check(job.status !== "running", "RUN_ACTIVE", "请先停止计划执行", 409);
    this.store.db.prepare("DELETE FROM scheduled_jobs WHERE id=?").run(id);
    this.store.audit(job.sessionId, "schedule.deleted", { jobId: id });
  }
  validateSnapshot(job) {
    const session = this.resolveSession(job.sessionId);
    check(
      job.sourceHashes.every((snapshot) =>
        session.files.some(
          (f) => f.id === snapshot.id && f.hash === snapshot.hash,
        ),
      ),
      "SCHEDULE_SCOPE_CHANGED",
      "计划授权的材料已变化或删除，请重新创建计划",
      409,
    );
    check(
      job.mode !== "model" || job.providerIdentity === this.identity(),
      "SCHEDULE_PROVIDER_CHANGED",
      "模型服务或模型已变化，请重新确认外发并创建计划",
      412,
    );
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
        "SELECT id FROM scheduled_jobs WHERE status='active' AND next_run_at<=? ORDER BY next_run_at LIMIT 10",
      )
      .all(this.now());
    const started = [];
    for (const { id } of due) {
      if (this.stopped || this.runtime.active.size >= this.runtime.maxActive)
        break;
      const job = this.get(id);
      if (job.status !== "active" || this.runtime.active.has(job.sessionId))
        continue;
      // Synchronous claim + prepare on the single database owner: no await gap.
      job.status = "running";
      this.save(job);
      const promise = this.execute(job);
      this.inFlight.add(promise);
      promise.finally(() => this.inFlight.delete(promise)).catch(() => {});
      started.push(promise);
    }
    await Promise.allSettled(started);
  }
  async execute(job) {
    let result;
    try {
      this.validateSnapshot(job);
      const requestId = `schedule_${job.id}_${job.nextRunAt}`;
      const existing = this.store
        .get(job.sessionId)
        .runs.find((r) => r.requestId === requestId);
      if (existing)
        throw new AppError(
          "DUPLICATE_REQUEST",
          "该计划时点已有执行记录，请核对后重新创建计划",
          409,
        );
      const handle = this.runtime.prepare(job.sessionId, {
        message: job.message,
        mode: job.mode,
        fileIds: job.fileIds,
        externalConsent: job.externalConsent,
        delegations: job.delegations,
        requestId,
        isolatedContext: true,
      });
      job.activeRunId = handle.run.id;
      this.save(job);
      result = await this.runtime.execute(handle);
    } catch (error) {
      result = {
        status: "failed",
        error: error instanceof AppError ? error.message : "计划执行失败",
        runId: job.activeRunId,
      };
    }
    job.history.push({
      status: result.status,
      error: result.error,
      runId: result.runId,
      scheduledAt: job.nextRunAt,
      time: new Date(this.now()).toISOString(),
    });
    job.activeRunId = null;
    job.lastError = result.error || null;
    if (result.status !== "completed") job.status = "paused";
    else if (!job.intervalMinutes) job.status = "completed";
    else {
      const interval = job.intervalMinutes * 60000;
      job.nextRunAt +=
        (Math.floor(Math.max(0, this.now() - job.nextRunAt) / interval) + 1) *
        interval;
      job.status = "active";
    }
    this.save(job);
    this.store.audit(job.sessionId, "schedule.executed", {
      jobId: job.id,
      runId: result.runId,
      status: result.status,
    });
  }
}
