import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeCodeProvider } from "../scripts/claude-code-provider.mjs";

test("acceptance credentials are explicitly selected without mutating Claude Code configuration", (t) => {
  const home = mkdtempSync(join(tmpdir(), "provider-fixture-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".claude")); mkdirSync(join(home, ".cc-switch"));
  const settings = { env: { ANTHROPIC_AUTH_TOKEN: "fixture-only", ANTHROPIC_BASE_URL: "https://example.invalid/anthropic",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "test-model" } };
  const path = join(home, ".claude/settings.json");
  writeFileSync(path, JSON.stringify(settings));
  const db = new DatabaseSync(join(home, ".cc-switch/cc-switch.db"));
  db.exec("CREATE TABLE providers(id TEXT,app_type TEXT,settings_config TEXT)");
  db.prepare("INSERT INTO providers VALUES(?,?,?)").run("fixture", "claude", JSON.stringify(settings)); db.close();
  assert.equal(claudeCodeProvider("fixture", home).model, "test-model");
  assert.equal(claudeCodeProvider("active", home).apiKey, "fixture-only");
  assert.equal(readFileSync(path, "utf8"), JSON.stringify(settings));
  assert.throws(() => claudeCodeProvider("missing", home), /not found/);
  settings.env.ANTHROPIC_BASE_URL = "https://secret@example.invalid";
  writeFileSync(path, JSON.stringify(settings));
  assert.throws(() => claudeCodeProvider("active", home), /credential-free/);
});
