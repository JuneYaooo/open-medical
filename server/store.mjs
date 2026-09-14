import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError, check } from "./errors.mjs";

// Single local user; parameterized queries + SQLite transactions prevent lost updates.
export class Store {
  constructor(filename) {
    if (filename !== ":memory:")
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    if (filename !== ":memory:") {
      this.lockPath = filename + ".lock";
      this.lockId = randomUUID();
      const acquire = () => {
        const fd = openSync(this.lockPath, "wx", 0o600);
        try {
          writeFileSync(
            fd,
            JSON.stringify({ pid: process.pid, id: this.lockId }),
          );
        } finally {
          closeSync(fd);
        }
      };
      try {
        acquire();
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let owner;
        try {
          owner = JSON.parse(readFileSync(this.lockPath, "utf8"));
        } catch {
          throw new AppError(
            "DATABASE_LOCK",
            "数据库锁状态不明，请检查现有服务",
            503,
          );
        }
        if (
          !Number.isInteger(owner.pid) ||
          owner.pid <= 0 ||
          typeof owner.id !== "string"
        )
          throw new AppError(
            "DATABASE_LOCK",
            "数据库锁记录无效，请检查现有服务",
            503,
          );
        let alive = true;
        try {
          process.kill(owner.pid, 0);
        } catch (e) {
          if (e.code === "ESRCH") alive = false;
        }
        if (alive)
          throw new AppError(
            "DATABASE_LOCK",
            "该数据库已有运行时使用，请关闭旧进程",
            503,
          );
        unlinkSync(this.lockPath);
        acquire();
      }
    }
    try {
      this.db = new DatabaseSync(filename);
      if (filename !== ":memory:") chmodSync(filename, 0o600);
      this.db
        .exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, action TEXT NOT NULL, time TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, time TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_log_session ON event_log(session_id,id);
      CREATE TABLE IF NOT EXISTS patients (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS patient_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, channel TEXT NOT NULL, direction TEXT NOT NULL, time TEXT NOT NULL, external_id TEXT UNIQUE, processed INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS patient_messages_patient ON patient_messages(patient_id,id);
      CREATE TABLE IF NOT EXISTS follow_ups (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, status TEXT NOT NULL, next_due INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS follow_ups_due ON follow_ups(status,next_due);
      CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, kind TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status,due_at);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      // schema 2 → 3 only adds patient-domain tables; session rows are unchanged.
      const schemaRow = this.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get("schema_version");
      if (!schemaRow)
        this.db
          .prepare("INSERT INTO meta VALUES (?,?)")
          .run("schema_version", "3");
      else if (schemaRow.value === "2")
        this.db
          .prepare("UPDATE meta SET value=? WHERE key=?")
          .run("3", "schema_version");
      else if (schemaRow.value !== "3")
        throw new AppError(
          "DATABASE_SCHEMA",
          "数据库版本不兼容；未修改既有会话，请使用匹配的运行时",
          503,
        );
      // Interrupted turns remain visible after restart, never falsely complete.
      for (const session of this.list()) {
        if (session.runs.some((r) => r.status === "running"))
          this.mutate(session.id, (s) => {
            for (const r of s.runs.filter((r) => r.status === "running")) {
              r.status = "interrupted";
              r.error = "服务重新启动，执行已中断。";
              r.endedAt = new Date().toISOString();
              for (const child of r.children || []) {
                if (["running", "queued"].includes(child.status)) {
                  child.status = "interrupted";
                  child.error = "服务重启，子代理执行已中断";
                  child.endedAt = r.endedAt;
                }
              }
            }
          });
      }
    } catch (error) {
      try {
        this.db?.close();
      } finally {
        this.releaseLock();
      }
      throw error;
    }
  }
  releaseLock() {
    if (this.lockPath) {
      try {
        if (JSON.parse(readFileSync(this.lockPath, "utf8")).id === this.lockId)
          unlinkSync(this.lockPath);
      } catch {}
    }
  }
  close() {
    try {
      this.db.close();
    } finally {
      this.releaseLock();
    }
  }
  list() {
    return this.db
      .prepare("SELECT data FROM sessions")
      .all()
      .map((row) => JSON.parse(row.data))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id) {
    const row = this.db.prepare("SELECT data FROM sessions WHERE id=?").get(id);
    if (!row) throw new AppError("NOT_FOUND", "会话不存在", 404);
    return JSON.parse(row.data);
  }
  create({
    id = randomUUID(),
    title = "新的医疗工作",
    files = [],
    copiedFrom,
    patientId = null,
  } = {}) {
    const session = {
      id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 0,
      messages: [],
      files,
      ...(copiedFrom ? { copiedFrom } : {}),
      ...(patientId ? { patientId } : {}),
      artifacts: [],
      runs: [],
    };
    try {
      this.db
        .prepare("INSERT INTO sessions VALUES (?,?)")
        .run(id, JSON.stringify(session));
    } catch (e) {
      if (this.db.prepare("SELECT id FROM sessions WHERE id=?").get(id))
        throw new AppError("CONFLICT", "会话已存在", 409);
      throw e;
    }
    this.audit(id, "session.created");
    return session;
  }
  mutate(id, update) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const data = this.get(id);
      update(data);
      data.revision++;
      data.updatedAt = Date.now();
      this.db
        .prepare("UPDATE sessions SET data=? WHERE id=?")
        .run(JSON.stringify(data), id);
      this.db.exec("COMMIT");
      return data;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  delete(id) {
    this.get(id);
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    this.db.prepare("DELETE FROM audit WHERE session_id=?").run(id);
    this.db.prepare("DELETE FROM event_log WHERE session_id=?").run(id);
    if (
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE name='scheduled_jobs'")
        .get()
    )
      this.db.prepare("DELETE FROM scheduled_jobs WHERE session_id=?").run(id);
  }
  audit(sessionId, action, detail = {}) {
    this.db
      .prepare(
        "INSERT INTO audit(session_id,action,time,detail) VALUES (?,?,?,?)",
      )
      .run(sessionId, action, new Date().toISOString(), JSON.stringify(detail));
  }
  appendEvent(event) {
    this.db
      .prepare(
        "INSERT INTO event_log(session_id,run_id,seq,type,time,payload) VALUES (?,?,?,?,?,?)",
      )
      .run(
        event.session_id,
        event.run_id,
        event.seq,
        event.type,
        event.time,
        JSON.stringify(event.payload || {}),
      );
  }
  eventLog(id, { after = 0, limit = 1000 } = {}) {
    check(
      Number.isInteger(after) &&
        after >= 0 &&
        Number.isInteger(limit) &&
        limit > 0 &&
        limit <= 5000,
      "INVALID_INPUT",
      "事件分页参数无效",
    );
    return this.db
      .prepare(
        "SELECT id,run_id,seq,type,time,payload FROM event_log WHERE session_id=? AND id>? ORDER BY id ASC LIMIT ?",
      )
      .all(id, after, limit)
      .map((row) => ({
        id: row.id,
        run_id: row.run_id,
        seq: row.seq,
        type: row.type,
        time: row.time,
        payload: JSON.parse(row.payload),
      }));
  }
  auditLog(id) {
    return this.db
      .prepare(
        "SELECT id,action,time,detail FROM audit WHERE session_id=? ORDER BY id DESC LIMIT 200",
      )
      .all(id)
      .map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
  }
}
