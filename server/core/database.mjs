import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireProcessLock } from "../process-lock.mjs";

// Standalone generic runtime database; the medical server instead supplies its already-owned connection.
export class WorkspaceDatabase {
  constructor(filename) {
    this.owner = randomUUID();
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      this.lock = acquireProcessLock(filename, { message: "已有进程正在使用该工作区数据库" });
    }
    try {
      this.db = new DatabaseSync(filename);
      if (filename !== ":memory:") chmodSync(filename, 0o600);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    try {
      this.db?.close();
      this.db = null;
    } finally {
      this.lock?.release();
    }
  }
}
