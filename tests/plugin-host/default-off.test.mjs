import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginHost } from "../../server/plugin-host/host.mjs";

const PLUGIN_ROOT = join(fileURLToPath(new URL("../../", import.meta.url)), "plugins");
const OPTIONAL = ["drg", "trials", "research-stats"];

const enabledMap = (db) => {
  const host = new PluginHost({ db, pluginDirs: [PLUGIN_ROOT] });
  host.load();
  return Object.fromEntries(host.records.map((record) => [record.id, record.enabled]));
};

test("非核心插件：全新安装默认关闭，第二次启动仍关闭", () => {
  const db = new DatabaseSync(":memory:");
  const first = enabledMap(db);
  for (const id of OPTIONAL) assert.equal(first[id], false, id);
  assert.equal(first.followup, true, "核心随访插件默认开启");
  // 首次启动后已有迁移记录，第二次启动不能被误判为升级用户。
  db.prepare("INSERT OR IGNORE INTO plugin_migrations VALUES ('followup','001_init.sql',?)").run(new Date().toISOString());
  const second = enabledMap(db);
  for (const id of OPTIONAL) assert.equal(second[id], false, id);
});

test("非核心插件：升级用户保持开启，手动设置优先", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE plugin_migrations (plugin_id TEXT NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(plugin_id, name))");
  db.prepare("INSERT INTO plugin_migrations VALUES ('followup','001_init.sql',?)").run(new Date().toISOString());
  db.exec("CREATE TABLE plugin_state (plugin_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL)");
  db.prepare("INSERT INTO plugin_state VALUES ('drg',0,?)").run(new Date().toISOString());
  const state = enabledMap(db);
  assert.equal(state.trials, true);
  assert.equal(state["research-stats"], true);
  assert.equal(state.drg, false, "医生之前手动关闭的保持关闭");
});

test("非核心插件：插件系统之前的老数据库（有患者、无迁移记录）也按升级处理", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE patients (id TEXT PRIMARY KEY, data TEXT)");
  db.prepare("INSERT INTO patients VALUES ('p1','{}')").run();
  const state = enabledMap(db);
  for (const id of OPTIONAL) assert.equal(state[id], true, id);
});
