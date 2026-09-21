import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  modelConfigCandidates,
  syntheticMode,
} from "../scripts/verify-model.mjs";

test("model config candidates cover desktop userData, legacy names, then repo .env", () => {
  const candidates = modelConfigCandidates({
    ...process.env,
    APPDATA: "C:\\Users\\someone\\AppData\\Roaming",
  });
  assert.deepEqual(
    candidates.map((c) => c.source),
    [
      "desktop:" + process.platform,
      "desktop:" + process.platform,
      "desktop:" + process.platform,
      "repo",
    ],
  );
  assert.ok(candidates[0].file.includes("Open Medical Workbench"));
  assert.ok(candidates[1].file.includes("Open Agent"));
  assert.ok(candidates[2].file.includes("Open Medical"));
  assert.equal(candidates[3].file, ".env");
});

test("real mode without credentials reports blocked with searched paths and exits 2", (t) => {
  // Isolate both discovery locations and environment; never inspect host credentials.
  const isolated = mkdtempSync(join(tmpdir(), "omw-model-discovery-"));
  t.after(() => rmSync(isolated, { recursive: true, force: true }));
  const script = fileURLToPath(
    new URL("../scripts/verify-model.mjs", import.meta.url),
  );
  const env = {
    HOME: isolated,
    USERPROFILE: isolated,
    APPDATA: join(isolated, "AppData"),
    ...(process.platform === "win32"
      ? { SYSTEMROOT: process.env.SYSTEMROOT }
      : {}),
  };
  let stdout = "";
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [script], {
      cwd: isolated,
      env,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    code = error.status ?? 1;
    stdout = error.stdout ?? "";
    stdout += error.stderr ?? ""; // blocked 报告走 stderr
  }
  const report = JSON.parse(stdout);
  assert.equal(report.result, "blocked");
  assert.equal(code, 2);
  assert.equal(report.configDiscovery.source, null);
  assert.equal(report.configDiscovery.searched.length, 4);
  for (const path of report.configDiscovery.searched)
    assert.ok(
      resolve(isolated, path).startsWith(isolated + "/") ||
        resolve(isolated, path).startsWith(isolated + "\\"),
    );
  assert.match(report.note, /model\.env/);
});

test("synthetic mode verifies provider protocol stack without credentials", async () => {
  const report = await syntheticMode();
  assert.equal(report.result, "passed");
  assert.equal(report.syntheticOnly, true);
  assert.equal(report.realModel, false);
  const byName = Object.fromEntries(
    report.checks.map((c) => [c.name, c.status]),
  );
  assert.equal(byName["retry-429-backoff"], "passed");
  assert.equal(byName["sse-tool-call"], "passed");
  assert.equal(byName["sse-stream-deltas"], "passed");
  assert.equal(byName["long-output"], "passed");
  assert.equal(byName["usage-accounting"], "passed");
});
