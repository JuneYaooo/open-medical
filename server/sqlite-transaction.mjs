import { randomUUID } from "node:crypto";

// Synchronous SQLite work can join an existing unit of work without committing
// or rolling back its caller's transaction. Keep IMMEDIATE for outer writers.
export function sqliteTransaction(db, operation) {
  const outer = db.isTransaction === false;
  const name = `operation_${randomUUID().replaceAll("-", "")}`;
  db.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
  try {
    const result = operation();
    db.exec(outer ? "COMMIT" : `RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    // SQLite may already have rolled back on its own (SQLITE_FULL, IOERR, a
    // busy COMMIT). Never let the rollback hide the original error.
    try {
      if (outer) {
        if (db.isTransaction) db.exec("ROLLBACK");
      } else if (db.isTransaction) {
        db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
      }
    } catch {
      // keep the original error
    }
    throw error;
  }
}
