import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceDatabase, WorkspaceService } from "../server/core/index.mjs";

for (const mode of ["timeout", "cancel", "reject"]) {
  test(`terminal durable receipt follows runner ${mode} during staging cleanup`, async () => {
    const base = mkdtempSync(join(tmpdir(), "terminal-settlement-"));
    const root = join(base, "project");
    mkdirSync(root);
    const db = new WorkspaceDatabase(join(base, "state.sqlite"));
    const service = new WorkspaceService(db.db, { model: "synthetic-unused" });
    const workspace = service.create({ root, directoryConsent: true });
    service.update(workspace.id, { revision: workspace.revision, profile: "standard", allowWrite: true });
    service.store.update(workspace.id, (w) => {
      w.extensions = { ...w.extensions, image: "sha256:" + "a".repeat(64) };
    });
    const runner = service.extensions.runner;
    runner.docker = process.execPath;
    runner.detachedFactory = ({ docker, args, environment }) => spawn(docker, args, { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    runner.finalizationTimeoutMs = 80;
    // Actual child lifecycle, with no Docker or host tool execution fallback.
    runner.args = () => ({ name: "synthetic-settlement", args: ["-e", "process.stdout.write('verified command output')"] });
    const originalRm = fs.rm;
    let releaseCleanup, enteredCleanup;
    const entered = new Promise((resolve) => { enteredCleanup = resolve; });
    const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
    fs.rm = (path, options) => {
      if (!String(path).includes("omw-terminal-")) return originalRm(path, options);
      enteredCleanup();
      return mode === "reject" ? Promise.reject(new Error("synthetic cleanup failure")) : cleanup;
    };
    syncBuiltinESMExports();
    try {
      const started = await service.extensions.terminal.start(workspace.id,
        { command: "synthetic", timeoutMs: 1000 }, { discardOutputs: true, interactive: false });
      const session = runner.get(workspace.id, started.id);
      await entered;
      assert.notEqual(service.store.get(workspace.id).verifications.at(-1).status, "completed");
      if (mode === "cancel") runner.stop(workspace.id, started.id);
      const result = await session.done;
      assert.equal(result.status, mode === "cancel" ? "cancelled" : "failed");
      assert.equal(result.outputComplete, true);
      assert.equal(result.exitCode, 0);
      const receipt = service.store.get(workspace.id).verifications.at(-1);
      assert.equal(receipt.status, result.status);
      assert.equal(receipt.outputComplete, true);
      if (mode === "timeout") assert.match(result.error, /PROCESS_FINALIZATION_TIMEOUT/);
      if (mode === "reject") assert.match(result.error, /synthetic cleanup failure/);
      // A late cleanup completion must not promote the failed/cancelled receipt.
      releaseCleanup();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(service.store.get(workspace.id).verifications.at(-1).status, result.status);
    } finally {
      releaseCleanup();
      fs.rm = originalRm;
      syncBuiltinESMExports();
      await service.extensions.close();
      db.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
}
