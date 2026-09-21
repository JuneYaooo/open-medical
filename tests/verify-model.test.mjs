import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { modelConfigCandidates, syntheticMode } from "../scripts/verify-model.mjs";

test("model config candidates cover desktop userData, legacy names, then repo .env", () => {
  const candidates = modelConfigCandidates({
    ...process.env,
    APPDATA: "C:\\Users\\someone\\AppData\\Roaming",
  });
  // N5 起 source 细化到具体目录名;sourceCategory 仍是 desktop/repo 两类。
  assert.deepEqual(
    candidates.map((c) => c.source),
    [
      `desktop:${process.platform}:Open Medical Workbench`,
      `desktop:${process.platform}:Open Agent`,
      `desktop:${process.platform}:Open Medical`,
      "repo",
    ],
  );
  assert.ok(
    candidates.every(
      (c) => c.sourceCategory === "desktop" || c.sourceCategory === "repo",
    ),
  );
  assert.ok(candidates[0].file.includes("Open Medical Workbench"));
  assert.ok(candidates[1].file.includes("Open Agent"));
  assert.ok(candidates[2].file.includes("Open Medical"));
  assert.equal(candidates[3].file, ".env");
});

test("real mode without credentials reports blocked with searched paths and exits 2", () => {
  // 独立进程运行，避免污染当前进程 env；本机当前无任何模型配置（W0 基线事实）
  let stdout = "";
  let code = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      ["scripts/verify-model.mjs"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
  } catch (error) {
    code = error.status ?? 1;
    stdout = error.stdout ?? "";
    stdout += error.stderr ?? ""; // blocked 报告走 stderr
  }
  const report = JSON.parse(stdout);
  assert.equal(report.result, "blocked");
  assert.equal(code, 2);
  assert.ok(report.configDiscovery.searched.length >= 4);
  assert.match(report.note, /model\.env/);
});

test("synthetic mode verifies provider protocol stack without credentials", async () => {
  const report = await syntheticMode();
  assert.equal(report.result, "passed");
  assert.equal(report.syntheticOnly, true);
  assert.equal(report.realModel, false);
  const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
  assert.equal(byName["retry-429-backoff"], "passed");
  assert.equal(byName["sse-tool-call"], "passed");
  assert.equal(byName["sse-stream-deltas"], "passed");
  assert.equal(byName["long-output"], "passed");
  assert.equal(byName["usage-accounting"], "passed");
});
