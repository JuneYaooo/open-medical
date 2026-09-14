import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { WorkspaceDatabase } from "../server/core/database.mjs";

test("standalone CLI persists generic workspaces without importing medical database tables", (t) => {
  const root = mkdtempSync(join(tmpdir(), "standalone-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = join(root, "agent.sqlite");
  const run = (args) =>
    spawnSync(
      process.execPath,
      [resolve("scripts/workspace-cli.mjs"), ...args, "--database=" + database],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          AI_PROVIDER: "local",
          LOCAL_MODEL_NAME: "synthetic",
        },
      },
    );
  const created = run(["create", "--root=" + root, "--title=Synthetic"]);
  assert.equal(created.status, 0, created.stderr);
  const workspace = JSON.parse(created.stdout);
  const list = run(["list"]);
  assert.equal(list.status, 0);
  assert.equal(JSON.parse(list.stdout)[0].id, workspace.id);
  const db = new WorkspaceDatabase(database);
  t.after(() => db.close());
  const tables = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((t) => t.name);
  assert.ok(tables.includes("agent_workspaces"));
  assert.equal(tables.includes("patients"), false);
  assert.equal(tables.includes("sessions"), false);
  assert.throws(() => new WorkspaceDatabase(database), /已有进程/);
});

test("CLI configures extensions and persists offline memory across separate processes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cli-extensions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = join(root, "agent.sqlite");
  const run = (args) => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/workspace-cli.mjs"), ...args, "--database=" + database],
      {
        encoding: "utf8",
        timeout: 15000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const workspace = run(["create", "--root=" + root]);
  const config = join(root, "extensions.json");
  writeFileSync(
    config,
    JSON.stringify({
      action: "configure",
      consent: true,
      terminal: false,
      browser: false,
      plugins: false,
      mcp: false,
      memoryRead: true,
      memoryWrite: true,
      origins: [],
      memory: { provider: "lsa" },
    }),
  );
  run(["extensions", "--workspace=" + workspace.id, "--config-file=" + config]);
  run([
    "tool",
    "--workspace=" + workspace.id,
    "--tool=memory_add",
    '--arguments={"text":"离线临床资料索引"}',
  ]);
  const found = run([
    "tool",
    "--workspace=" + workspace.id,
    "--tool=memory_search",
    '--arguments={"query":"临床资料"}',
  ]);
  assert.equal(found.results[0].text, "离线临床资料索引");
});
