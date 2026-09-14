import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";

test("database survives restart, prevents second active runtime and marks interrupted runs honestly", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "medical-store-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "test.sqlite");
  const first = new Store(path);
  const session = first.create();
  first.mutate(session.id, (s) =>
    s.runs.push({
      id: "r",
      status: "running",
      partial: "partial",
      providerMessages: [],
    }),
  );
  assert.throws(() => new Store(path), /已有运行时/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  first.close();
  const second = new Store(path);
  assert.equal(second.get(session.id).runs[0].status, "interrupted");
  assert.equal(second.get(session.id).runs[0].partial, "partial");
  second.close();
});
test("transaction rollback preserves prior data and later writes still succeed", () => {
  const store = new Store(":memory:");
  const s = store.create();
  assert.throws(() =>
    store.mutate(s.id, (data) => {
      data.title = "bad";
      throw new Error("failure");
    }),
  );
  assert.equal(store.get(s.id).title, "新的医疗工作");
  store.mutate(s.id, (data) => {
    data.title = "good";
  });
  assert.equal(store.get(s.id).revision, 1);
  store.close();
});

test("live WAL backup can be reopened and never overwrites existing data", async (t) => {
  const { backupDatabase } = await import("../scripts/backup.mjs");
  const folder = mkdtempSync(join(tmpdir(), "medical-backup-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const original = new Store(join(folder, "original.sqlite"));
  t.after(() => original.close());
  const s = original.create({ title: "合成备份测试" });
  original.mutate(s.id, (data) =>
    data.messages.push({ id: "m", role: "user", content: "已提交数据" }),
  );
  const path = backupDatabase(
    join(folder, "original.sqlite"),
    join(folder, "backup.sqlite"),
  );
  const restored = new Store(path);
  t.after(() => restored.close());
  assert.equal(restored.get(s.id).messages[0].content, "已提交数据");
  assert.throws(
    () => backupDatabase(join(folder, "original.sqlite"), path),
    /拒绝覆盖/,
  );
});
test("corrupt database startup releases its own lock without replacing source data", async (t) => {
  const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const folder = mkdtempSync(join(tmpdir(), "medical-corrupt-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "bad.sqlite");
  writeFileSync(file, "synthetic corrupted database");
  assert.throws(() => new Store(file));
  assert.equal(readFileSync(file, "utf8"), "synthetic corrupted database");
  assert.equal(existsSync(file + ".lock"), false);
});
