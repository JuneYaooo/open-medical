import { initializeReviewColumns } from "./medical/review-schema.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { AppError, check } from "./errors.mjs";
import { acquireProcessLock } from "./process-lock.mjs";

const STORE_SCHEMA_VERSION = "8";

// Single local user; parameterized queries + SQLite transactions prevent lost updates.
export class Store {
  constructor(filename) {
    if (filename !== ":memory:")
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    // OS-level lock: released by the OS on any process exit, including a
    // hard kill, so a crashed runtime never blocks the next start.
    if (filename !== ":memory:") this.lock = acquireProcessLock(filename);
    try {
      this.db = new DatabaseSync(filename);
      if (filename !== ":memory:") chmodSync(filename, 0o600);
      // Refuse a database written by a newer runtime before touching it: the
      // ALTER/DROP steps below must never run against a newer schema.
      const hasMeta = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
      const storedSchema = hasMeta && this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
      if (storedSchema && Number(storedSchema) > Number(STORE_SCHEMA_VERSION))
        throw new AppError("DATABASE_SCHEMA", "数据库版本不兼容；未修改既有会话，请使用匹配的运行时", 503);
      this.db
        .exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, action TEXT NOT NULL, time TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, time TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_log_session ON event_log(session_id,id);
      CREATE TABLE IF NOT EXISTS patients (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS patient_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, channel TEXT NOT NULL, direction TEXT NOT NULL, time TEXT NOT NULL, external_id TEXT UNIQUE, processed INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS patient_messages_patient ON patient_messages(patient_id,id);
      CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, kind TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status,due_at);
      CREATE TABLE IF NOT EXISTS doctor_profile (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS doctor_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, status TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 1, topic TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS doctor_memories_kind ON doctor_memories(kind,status);
      CREATE TABLE IF NOT EXISTS literature_cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS guideline_docs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS guideline_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, ord INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS guideline_chunk_vectors (doc_id TEXT NOT NULL, ord INTEGER NOT NULL, model TEXT NOT NULL DEFAULT '', dim INTEGER NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(doc_id, ord, model));
      CREATE INDEX IF NOT EXISTS guideline_chunks_doc ON guideline_chunks(doc_id,ord);
      CREATE TABLE IF NOT EXISTS case_library (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_archives (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, hash TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS context_archives_session ON context_archives(session_id);
      CREATE TABLE IF NOT EXISTS pending_actions (id TEXT PRIMARY KEY, type TEXT NOT NULL, patient_id TEXT, status TEXT NOT NULL, payload TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS pending_actions_patient ON pending_actions(patient_id,status);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      initializeReviewColumns(this.db);
      // Existing proposals have no trustworthy base version. Keep NULL rather
      // than backfilling today's revision: confirmation must fail closed.
      const pendingColumns = this.db.prepare("PRAGMA table_info(pending_actions)").all();
      if (!pendingColumns.some((column) => column.name === "base_revision"))
        this.db.exec("ALTER TABLE pending_actions ADD COLUMN base_revision INTEGER");
      // Vectors carry their embedding model; pre-model tables are derived
      // data and are simply rebuilt by reindex.
      const vectorCols = this.db.prepare("PRAGMA table_info(guideline_chunk_vectors)").all();
      if (vectorCols.length && !vectorCols.some((c) => c.name === "model")) {
        this.db.exec("DROP TABLE guideline_chunk_vectors");
        this.db.exec(
          "CREATE TABLE guideline_chunk_vectors (doc_id TEXT NOT NULL, ord INTEGER NOT NULL, model TEXT NOT NULL DEFAULT '', dim INTEGER NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(doc_id, ord, model))",
        );
      }
      // schema 2 → 3 adds patient-domain tables; 3 → 4 adds the doctor
      // profile/memory tables; later versions add knowledge-domain tables.
      // All migrations are additive; session rows are unchanged.
      const SCHEMA_VERSION = STORE_SCHEMA_VERSION;
      const schemaRow = this.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get("schema_version");
      const setSchema = (value) =>
        this.db
          .prepare("UPDATE meta SET value=? WHERE key=?")
          .run(value, "schema_version");
      if (!schemaRow)
        this.db
          .prepare("INSERT INTO meta VALUES (?,?)")
          .run("schema_version", SCHEMA_VERSION);
      else if (Number(schemaRow.value) < Number(SCHEMA_VERSION))
        setSchema(SCHEMA_VERSION);
      else if (schemaRow.value !== SCHEMA_VERSION)
        throw new AppError(
          "DATABASE_SCHEMA",
          "数据库版本不兼容；未修改既有会话，请使用匹配的运行时",
          503,
        );
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
    this.lock?.release();
  }
  close() {
    try {
      this.db.close();
    } finally {
      this.releaseLock();
    }
  }
  // The sessions table only holds sessions from older versions until
  // SessionBridge.migrateLegacySessions() moves them into session workspaces.
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
