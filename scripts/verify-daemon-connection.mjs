import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const exec = promisify(execFile),
  directory = mkdtempSync(join(tmpdir(), "agent-daemon-verify-")),
  script = resolve("scripts/agent-daemon.mjs");
const command = (action) =>
  exec(
    process.execPath,
    [script, action, "--directory", directory, "--port", "18788"],
    { env: { ...process.env, AGENT_SKIP_ENV_FILE: "1" }, timeout: 25000 },
  );
try {
  await command("start");
  const { connect } = createRequire(import.meta.url)(
    "../desktop/daemon-connection.cjs",
  );
  const first = await connect({ directory, root: process.cwd() }),
    again = await connect({ directory, root: process.cwd() });
  assert.equal(first.config.instanceId, again.config.instanceId);
  const response = await fetch(first.origin + "/api/workspaces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-medical-token": first.config.token,
    },
    body: JSON.stringify({
      root: directory,
      title: "DAEMON_SYNTHETIC",
      directoryConsent: true,
    }),
  });
  assert.equal(response.status, 201);
  const task = await response.json();
  await command("stop");
  await command("start");
  const restored = await connect({ directory, root: process.cwd() });
  const result = await fetch(restored.origin + "/api/workspaces/" + task.id, {
    headers: { "x-medical-token": restored.config.token },
  });
  assert.equal((await result.json()).title, "DAEMON_SYNTHETIC");
  console.log(
    "PASS: desktop reconnects to same daemon; task survives stop/start",
  );
} finally {
  await command("stop").catch(() => {});
  rmSync(directory, { recursive: true, force: true });
}
