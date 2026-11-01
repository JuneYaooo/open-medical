import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { Backups } from "../../server/medical/backups.mjs";

function setup(t) {
  const base = mkdtempSync(join(tmpdir(), "omw-backups-auto-"));
  const path = join(base, "medical.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version','8'); CREATE TABLE patients (id TEXT, data TEXT); CREATE TABLE sessions (id TEXT, data TEXT);");
  db.close();
  const backups = new Backups(path);
  t.after(() => { backups.stopAuto(); rmSync(base, { recursive: true, force: true }); });
  return backups;
}

test("startAuto creates a backup at startup when none is fresh", async (t) => {
  const backups = setup(t);
  assert.equal(backups.status().autoBackup, false);
  assert.equal(backups.startAuto(), true);
  assert.equal(backups.startAuto(), false, "second start is a no-op");
  await delay(50);
  const status = backups.status();
  assert.equal(status.count, 1);
  assert.equal(status.fresh, true);
  assert.equal(status.autoBackup, true);
  backups.stopAuto();
  assert.equal(backups.status().autoBackup, false);
});

test("startAuto skips when the latest backup is fresh and runs again when stale", async (t) => {
  const backups = setup(t);
  backups.run();
  backups.startAuto({ checkMs: 20 });
  await delay(60);
  assert.equal(backups.status().count, 1, "fresh backup is not duplicated");
  const [item] = backups.list();
  const old = (Date.now() - 2 * 86400000) / 1000;
  utimesSync(item.path, old, old);
  await delay(80);
  assert.equal(backups.status().count, 2);
});

test("startAuto never throws and reports errors", async (t) => {
  const backups = setup(t);
  const errors = [];
  backups.databasePath = join(backups.directory, "..", "missing.sqlite");
  assert.doesNotThrow(() => backups.startAuto({ onError: (e) => errors.push(e) }));
  await delay(50);
  assert.equal(errors.length, 1);
});

test("startAuto is unsupported for in-memory databases", () => {
  const backups = new Backups(":memory:");
  assert.equal(backups.startAuto(), false);
});
