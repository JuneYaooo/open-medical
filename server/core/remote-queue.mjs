import { randomUUID } from "node:crypto";
import { check } from "../errors.mjs";
export class RemoteQueue {
  constructor(db, { now = Date.now, leaseMs = 90000 } = {}) {
    this.db = db;
    this.now = now;
    this.leaseMs = leaseMs;
    db.exec(
      "CREATE TABLE IF NOT EXISTS remote_jobs (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL)",
    );
  }
  save(job) {
    this.db
      .prepare(
        "INSERT INTO remote_jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(job.id, job.requestId, JSON.stringify(job));
    return job;
  }
  get(id) {
    const row = this.db
      .prepare("SELECT data FROM remote_jobs WHERE id=?")
      .get(id);
    check(row, "REMOTE_JOB", "任务不存在", 404);
    return JSON.parse(row.data);
  }
  expire() {
    for (const job of this.list())
      if (job.status === "running" && job.leaseUntil < this.now())
        this.save({
          ...job,
          status: "interrupted",
          error: "Worker 租约已过期；需要显式重试以免重复外部操作",
        });
  }
  list() {
    return this.db
      .prepare("SELECT data FROM remote_jobs ORDER BY rowid DESC LIMIT 1000")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  create(input) {
    check(
      typeof input.requestId === "string" &&
        /^[\w-]{1,100}$/.test(input.requestId),
      "REMOTE_ID",
      "无效请求 ID",
    );
    const existing = this.db
      .prepare("SELECT data FROM remote_jobs WHERE request_id=?")
      .get(input.requestId);
    if (existing) return JSON.parse(existing.data);
    check(
      typeof input.prompt === "string" &&
        input.prompt.trim() &&
        input.prompt.length <= 20000,
      "REMOTE_PROMPT",
      "任务说明无效",
    );
    check(
      Array.isArray(input.files) && input.files.length <= 500,
      "REMOTE_FILES",
      "最多 500 个文件",
    );
    const names = new Set();
    let total = 0;
    for (const file of input.files) {
      check(
        typeof file.path === "string" &&
          file.path.length < 1000 &&
          !file.path.startsWith("/") &&
          !file.path.includes("\\") &&
          !file.path
            .split("/")
            .some(
              (p) =>
                !p ||
                p === ".." ||
                p === "." ||
                /^\.env(?:\.|$)/i.test(p) ||
                [".git", "node_modules"].includes(p),
            ) &&
          !/[:\0]/.test(file.path) &&
          !names.has(file.path),
        "REMOTE_PATH",
        "文件路径无效",
      );
      check(typeof file.text === "string", "REMOTE_FILES", "仅支持文本快照");
      names.add(file.path);
      total += Buffer.byteLength(file.text);
    }
    check(total <= 10_000_000, "REMOTE_LIMIT", "文件快照超过 10MB");
    check(
      this.list().length < 1000,
      "REMOTE_LIMIT",
      "任务队列达到 1000 项，请先清理已完成任务",
    );
    return this.save({
      id: randomUUID(),
      requestId: input.requestId,
      prompt: input.prompt,
      files: input.files,
      status: "queued",
      createdAt: this.now(),
      attempt: 0,
    });
  }
  claim(worker) {
    check(
      typeof worker === "string" && /^[\w-]{1,100}$/.test(worker),
      "REMOTE_WORKER",
      "Worker ID 无效",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.expire();
      const job = this.list()
        .reverse()
        .find((j) => j.status === "queued");
      if (!job) {
        this.db.exec("COMMIT");
        return null;
      }
      Object.assign(job, {
        status: "running",
        worker,
        lease: randomUUID(),
        leaseUntil: this.now() + this.leaseMs,
        attempt: job.attempt + 1,
      });
      this.save(job);
      this.db.exec("COMMIT");
      return job;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  heartbeat(id, lease) {
    const job = this.get(id);
    check(
      job.status === "running" &&
        job.lease === lease &&
        job.leaseUntil >= this.now(),
      "REMOTE_LEASE",
      "租约失效或任务已取消",
      409,
    );
    job.leaseUntil = this.now() + this.leaseMs;
    this.save(job);
    return { status: job.status };
  }
  complete(id, lease, result) {
    this.heartbeat(id, lease);
    check(
      JSON.stringify(result).length <= 12_000_000,
      "REMOTE_LIMIT",
      "结果超过 12MB",
    );
    const job = this.get(id);
    job.status = result.status === "completed" ? "completed" : "failed";
    job.result = result;
    job.finishedAt = this.now();
    return this.save(job);
  }
  cancel(id) {
    const job = this.get(id);
    if (["queued", "running", "interrupted"].includes(job.status)) {
      job.status = "cancelled";
      job.finishedAt = this.now();
      this.save(job);
    }
    return job;
  }
  retry(id) {
    const job = this.get(id);
    check(
      ["failed", "interrupted", "cancelled"].includes(job.status),
      "REMOTE_STATE",
      "只有终止的任务可重试",
    );
    job.status = "queued";
    delete job.result;
    delete job.error;
    return this.save(job);
  }
  remove(id) {
    const job = this.get(id);
    check(
      !["queued", "running"].includes(job.status),
      "REMOTE_STATE",
      "请先取消正在执行的任务",
    );
    this.db.prepare("DELETE FROM remote_jobs WHERE id=?").run(id);
    return { removed: true };
  }
}
