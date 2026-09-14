import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { check } from "../errors.mjs";

// Standalone generic runtime database; the medical server instead supplies its already-owned connection.
export class WorkspaceDatabase {
  constructor(filename) {
    this.owner = randomUUID();
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      this.lock = filename + ".lock";
      const acquire = () => {
        const fd = openSync(this.lock, "wx", 0o600);
        try {
          writeFileSync(
            fd,
            JSON.stringify({ pid: process.pid, owner: this.owner }),
          );
        } finally {
          closeSync(fd);
        }
      };
      try {
        acquire();
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const previous = JSON.parse(readFileSync(this.lock, "utf8"));
        check(
          Number.isSafeInteger(previous.pid) && previous.pid > 0,
          "DATABASE_LOCK",
          "数据库锁状态无效",
          503,
        );
        let alive = true;
        try {
          process.kill(previous.pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") alive = false;
        }
        check(!alive, "DATABASE_LOCK", "已有进程正在使用该工作区数据库", 503);
        unlinkSync(this.lock);
        acquire();
      }
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
      if (this.lock) {
        try {
          if (JSON.parse(readFileSync(this.lock, "utf8")).owner === this.owner)
            unlinkSync(this.lock);
        } catch {
          /* Never remove another owner's lock. */
        }
      }
    }
  }
}
