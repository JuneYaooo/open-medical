import { DatabaseSync } from "node:sqlite";
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.mjs";

// Single-instance lock for a database file.
//
// The real lock is an exclusive SQLite lock on `<file>.instance`. SQLite uses
// OS file locks (fcntl / LockFileEx), which the OS releases when the process
// dies, including on SIGKILL or a Task Manager kill. So there is no stale lock
// to detect and no pid check that PID reuse can fool, and two processes
// starting at once cannot both win.
//
// `<file>.lock` (JSON pid + id) is still written so older runtimes, which only
// know that file, keep refusing to open a database this process owns.
export function acquireProcessLock(filename, { message = "该数据库已有运行时使用，请关闭旧进程" } = {}) {
  const guardPath = `${filename}.instance`;
  const infoPath = `${filename}.lock`;
  const id = randomUUID();
  const guard = new DatabaseSync(guardPath);
  try {
    guard.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch {
    guard.close();
    throw new AppError("DATABASE_LOCK", message, 503);
  }
  try {
    chmodSync(guardPath, 0o600);
  } catch {
    // permissions are best effort on platforms without POSIX modes
  }
  // We hold the OS lock, so any existing info file is stale by definition.
  writeFileSync(infoPath, JSON.stringify({ pid: process.pid, id }), { mode: 0o600 });
  let released = false;
  return {
    id,
    release() {
      if (released) return;
      released = true;
      try {
        if (JSON.parse(readFileSync(infoPath, "utf8")).id === id) unlinkSync(infoPath);
      } catch {
        // never remove another owner's file
      }
      try {
        guard.close();
      } catch {
        // already closed
      }
    },
  };
}
