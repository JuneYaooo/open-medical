import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const { resolveBackup, restoreBackup } = createRequire(import.meta.url)("../../desktop/backup-restore.cjs");
const NAME = "medical-2026-10-30T08-15-00-0123456789ab.sqlite";

function setup(t) {
  const base = mkdtempSync(join(tmpdir(), "omw-restore-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const databasePath = join(base, "medical.sqlite");
  mkdirSync(join(base, "backups"));
  const backup = new DatabaseSync(join(base, "backups", NAME));
  backup.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('backup');");
  backup.close();
  writeFileSync(databasePath, "current");
  writeFileSync(`${databasePath}-wal`, "wal");
  writeFileSync(`${databasePath}-shm`, "shm");
  return { base, databasePath };
}

test("resolveBackup accepts only managed names inside the backups directory", (t) => {
  const { base, databasePath } = setup(t);
  assert.equal(resolveBackup(databasePath, NAME), join(base, "backups", NAME));
  for (const bad of ["../medical.sqlite", join(base, "backups", NAME), "other.sqlite", "medical-2026-10-30T08-15-00.sqlite", null])
    assert.throws(() => resolveBackup(databasePath, bad));
  const outside = join(base, "outside.sqlite");
  writeFileSync(outside, "x");
  symlinkSync(outside, join(base, "backups", "medical-2026-10-31T08-15-00.sqlite"));
  assert.throws(() => resolveBackup(databasePath, "medical-2026-10-31T08-15-00.sqlite"), /普通文件/);
});

test("restoreBackup saves current files, swaps in the backup, drops stale sidecars", (t) => {
  const { base, databasePath } = setup(t);
  const { savedTo } = restoreBackup({ databasePath, name: NAME, now: new Date(2026, 9, 31, 9, 5, 7) });
  assert.equal(savedTo, join(base, "restore-before-20261031-090507"));
  assert.deepEqual(readdirSync(savedTo).sort(), ["medical.sqlite", "medical.sqlite-shm", "medical.sqlite-wal"]);
  assert.equal(readFileSync(join(savedTo, "medical.sqlite-wal"), "utf8"), "wal");
  assert.equal(existsSync(`${databasePath}-wal`), false);
  assert.equal(existsSync(`${databasePath}-shm`), false);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(db.prepare("SELECT v FROM t").get().v, "backup");
  db.close();
  assert.ok(existsSync(join(base, "backups", NAME)));
});

test("restoreBackup rolls back when the integrity check fails", (t) => {
  const { databasePath } = setup(t);
  assert.throws(() => restoreBackup({ databasePath, name: NAME, check: () => false }), /完整性检查未通过/);
  assert.equal(readFileSync(databasePath, "utf8"), "current");
  assert.equal(readFileSync(`${databasePath}-wal`, "utf8"), "wal");
});
