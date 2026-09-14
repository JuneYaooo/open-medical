import { randomUUID } from "node:crypto";
import { check, string } from "../errors.mjs";
import { providerConfigured } from "./provider-status.mjs";
import { hashText } from "./workspace-files.mjs";
import { CronExpressionParser } from "cron-parser";
import { executionLimits } from "./domain-adapter.mjs";
export function nextCron(expression, timezone = "UTC", after = Date.now()) {
  check(
    typeof expression === "string" &&
      expression.length <= 200 &&
      expression.trim().split(/\s+/).length === 5,
    "SCHEDULE_CRON",
    "Cron 需要五个字段：分 时 日 月 星期",
  );
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return CronExpressionParser.parse(expression, {
      currentDate: new Date(after),
      tz: timezone,
    })
      .next()
      .getTime();
  } catch {
    check(false, "SCHEDULE_CRON", "Cron 表达式或时区无效");
  }
}
export class WorkspaceScheduler {
  constructor(service, { now = () => Date.now() } = {}) {
    this.service = service;
    this.now = now;
    this.timer = null;
    this.pending = new Set();
  }
  identity(w) {
    const p = this.service.provider;
    return hashText(
      JSON.stringify([
        w.permissions,
        w.root,
        p.provider,
        p.baseUrl,
        p.model,
        this.service.contextIdentity(w.id),
      ]),
    );
  }
  create(id, body) {
    const w = this.service.store.get(id);
    check(
      !this.service.active.has(id),
      "RUN_ACTIVE",
      "执行期间不能创建计划",
      409,
    );
    check(
      providerConfigured(this.service.provider),
      "MODEL_NOT_CONFIGURED",
      "请先配置模型",
      503,
    );
    check(
      body.externalConsent === true,
      "CONSENT_REQUIRED",
      "计划任务需要单独授权按计划发送任务和读取的文件",
      412,
    );
    const runAt = body.cron
      ? nextCron(body.cron, body.timezone || "UTC", this.now())
      : body.runAt;
    check(
      Number.isFinite(runAt) && runAt > this.now(),
      "SCHEDULE_TIME",
      "计划时间必须晚于当前时间",
    );
    const interval = body.intervalMinutes || 0;
    check(
      !body.cron || interval === 0,
      "SCHEDULE_CRON",
      "Cron 与固定间隔不能同时使用",
    );
    check(
      Number.isInteger(interval) && interval >= 0 && interval <= 525600,
      "SCHEDULE_INTERVAL",
      "间隔须为 0–525600 分钟，0 表示单次",
    );
    const job = {
      id: randomUUID(),
      message: string(body.message, "任务内容", 20000),
      nextRunAt: runAt,
      ...(body.cron
        ? { cron: body.cron, timezone: body.timezone || "UTC" }
        : {}),
      limits: executionLimits(body.limits, this.service.domain.limits),
      intervalMinutes: interval,
      resumeOnRestart: body.resumeOnRestart === true,
      status: "active",
      authority: this.identity(w),
      history: [],
    };
    this.service.store.update(
      id,
      (current) => {
        current.schedules ||= [];
        check(
          current.schedules.length < 30,
          "SCHEDULE_LIMIT",
          "单工作区最多 30 个计划",
        );
        current.schedules.push(job);
      },
      this.service.revision(body),
    );
    return job;
  }
  change(id, jobId, body) {
    check(
      ["active", "paused"].includes(body.status),
      "INVALID_INPUT",
      "计划状态无效",
    );
    return this.service.store.update(
      id,
      (current) => {
        const job = (current.schedules || []).find((j) => j.id === jobId);
        check(job, "NOT_FOUND", "计划不存在", 404);
        check(
          !["running", "recovering"].includes(job.status),
          "RUN_ACTIVE",
          "计划正在执行，请先停止任务",
          409,
        );
        if (body.status === "active") {
          check(
            body.externalConsent === true,
            "CONSENT_REQUIRED",
            "恢复计划需要重新确认外发授权",
            412,
          );
          job.authority = this.identity(current);
          job.nextRunAt = job.cron
            ? nextCron(job.cron, job.timezone, this.now())
            : this.now() + 60000;
        }
        job.status = body.status;
      },
      this.service.revision(body),
    );
  }
  start() {
    if (!this.timer)
      this.timer = setInterval(() => {
        this.tick();
      }, 1000);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
  async drain() {
    await Promise.allSettled([...this.pending]);
  }
  tick() {
    for (const w of this.service.store.scheduled()) {
      if (
        this.service.active.has(w.id) ||
        this.service.active.size >= this.service.maxActive
      )
        continue;
      for (const job of (w.schedules || []).filter((j) => j.status === "recovering")) {
        const run = w.runs.find((r) => r.id === job.runId);
        if (!run || run.recoveryBlocked || ["failed", "cancelled"].includes(run.status)) {
          this.finish(w.id, job, { status: "failed", error: run?.recoveryBlocked || run?.error || "恢复检查点不存在" });
        } else if (run.status === "completed") this.finish(w.id, job, { status: "completed", runId: run.id });
      }
      const job = (w.schedules || []).find(
        (j) => j.status === "active" && j.nextRunAt <= this.now(),
      );
      if (!job) continue;
      if (job.authority !== this.identity(w)) {
        this.service.store.update(w.id, (current) =>
          Object.assign(
            current.schedules.find((j) => j.id === job.id),
            {
              status: "paused",
              error: "文件授权或模型配置已变化，请重新确认计划",
            },
          ),
        );
        continue;
      }
      this.service.store.update(w.id, (current) => {
        current.schedules.find((j) => j.id === job.id).status = "running";
      });
      const promise = this.execute(w.id, job);
      this.pending.add(promise);
      promise.then(
        () => this.pending.delete(promise),
        () => this.pending.delete(promise),
      );
    }
  }
  async execute(id, job) {
    let result;
    try {
      const handle = this.service.prepare(id, {
        revision: this.service.store.get(id).revision,
        message: job.message,
        requestId: `schedule_${job.id}_${job.nextRunAt}`,
        externalConsent: true,
        isolatedContext: true,
        limits: job.limits,
        resumeOnRestart: job.resumeOnRestart,
      });
      this.service.store.update(id, (w) => {
        w.schedules.find((j) => j.id === job.id).runId = handle.run.id;
      });
      result = await this.service.execute(handle);
    } catch (error) {
      result = {
        status: "failed",
        error: error.code ? error.message : "计划启动失败",
      };
    }
    this.finish(id, job, result);
  }
  finish(id, job, result) {
    this.service.store.update(id, (current) => {
      const saved = current.schedules.find((j) => j.id === job.id);
      saved.history.push({ ...result, at: this.now() });
      saved.history = saved.history.slice(-30);
      saved.error = result.error || null;
      if (result.status === "interrupted" && job.resumeOnRestart) {
        saved.status = "recovering";
        return;
      }
      if (result.status !== "completed") saved.status = "paused";
      else if (job.cron) {
        saved.nextRunAt = nextCron(job.cron, job.timezone, this.now());
        saved.status = "active";
      } else if (!job.intervalMinutes) saved.status = "completed";
      else {
        const interval = job.intervalMinutes * 60000;
        saved.nextRunAt =
          job.nextRunAt +
          (Math.floor(Math.max(0, this.now() - job.nextRunAt) / interval) + 1) *
            interval;
        saved.status = "active";
      }
    });
  }
}
