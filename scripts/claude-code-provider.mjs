import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

// Explicit, read-only credential reuse for local acceptance runs. Never changes
// Claude Code's active provider, persists secrets, or includes them in reports.
export function claudeCodeProvider(id, home = homedir()) {
  let settings;
  if (id === "active") settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  else {
    const db = new DatabaseSync(join(home, ".cc-switch/cc-switch.db"), { readOnly: true });
    try {
      const row = db.prepare("SELECT settings_config FROM providers WHERE app_type=? AND id=?").get("claude", id);
      if (!row) throw new Error("Claude Code provider configuration not found");
      settings = JSON.parse(row.settings_config);
    } finally { db.close(); }
  }
  const env = settings.env || {};
  const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  const model = env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  const baseUrl = env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Claude Code acceptance endpoint must use credential-free HTTPS URL");
  if (typeof apiKey !== "string" || !apiKey || typeof model !== "string" || !model)
    throw new Error("Claude Code configuration requires an explicit model and credential");
  return { provider: "anthropic", apiKey, model, baseUrl, timeoutMs: 180000 };
}
