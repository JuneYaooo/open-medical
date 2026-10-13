export function initializeLearning(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS review_sessions (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, action_id TEXT, patient_id TEXT, model TEXT, context TEXT,
    ai_items INTEGER, modified INTEGER, added INTEGER, deleted INTEGER, review_ms INTEGER,
    ai_snapshot TEXT, final_snapshot TEXT, superseded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS review_action ON review_sessions(action_id) WHERE action_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS review_diffs (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
    section TEXT, op TEXT, field TEXT, before TEXT, after TEXT, reason TEXT, category TEXT, learnable INTEGER,
    superseded INTEGER DEFAULT 0, habit_id INTEGER, data TEXT, created_at TEXT);
    CREATE INDEX IF NOT EXISTS review_session_diffs ON review_diffs(session_id);
    CREATE TABLE IF NOT EXISTS habit_history (id INTEGER PRIMARY KEY, habit_id INTEGER, decision TEXT, snapshot TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS habit_patterns (key TEXT PRIMARY KEY, suppressed INTEGER DEFAULT 0, since_id INTEGER DEFAULT 0, memory_id INTEGER);
    CREATE TABLE IF NOT EXISTS habit_feedback (id INTEGER PRIMARY KEY, habit_id INTEGER, action_id TEXT, kind TEXT, created_at TEXT, UNIQUE(habit_id,action_id,kind));
    CREATE TABLE IF NOT EXISTS learning_events (id INTEGER PRIMARY KEY, type TEXT, subject TEXT, data TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS workbench_prefs (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  for (const [table, column, type] of [
    ["pending_actions", "review_draft", "TEXT"],
    ["pending_actions", "review_revision", "INTEGER NOT NULL DEFAULT 0"],
    ["doctor_memories", "origin", "TEXT NOT NULL DEFAULT 'stated'"],
    ["doctor_memories", "rule", "TEXT"],
    ["doctor_memories", "evidence", "TEXT"],
    ["doctor_memories", "dryrun", "TEXT"],
  ]) {
    if (
      !db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((c) => c.name === column)
    )
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
