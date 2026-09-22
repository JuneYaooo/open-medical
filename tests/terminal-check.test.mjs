import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceService } from "../server/core/workspace-service.mjs";
import { checkCommand } from "../server/core/check-command.mjs";

test("check argv quoting keeps shell syntax inert and rejects shell wrappers", () => {
  const value = "literal ' quote; echo BAD; $(echo BAD)";
  const command = checkCommand([process.execPath, "-e", "process.stdout.write(process.argv[1])", value]);
  assert.equal(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }), value);
  for (const argv of [["sh", "-c", "false; true"], ["/bin/bash", "-c", "true"], [], ["node", "x\0y"]]) assert.throws(() => checkCommand(argv), { code: "CHECK_COMMAND" });
});

let docker = false;
try { execFileSync("docker", ["image", "inspect", "open-medical-runtime:0.8-full"], { stdio: "ignore", timeout: 5000 }); docker = true; } catch { /* explicit environment skip */ }
test("real container checks preserve failure exit status, validate snapshot and discard generated files", { skip: !docker }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omw-check-")), db = new DatabaseSync(":memory:");
  const service = new WorkspaceService(db, {}), w = service.create({ root, directoryConsent: true });
  t.after(async () => { await service.extensions.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "source.txt"), "synthetic-source");
  await service.extensions.operation(w.id, { action: "configure", revision: service.get(w.id).revision, consent: true, terminal: true, image: "open-medical-runtime:0.8-full", browser: false, plugins: false, mcp: false, memoryRead: false, memoryWrite: false, origins: [], memory: { provider: "lsa" } });
  const run = async (argv) => {
    let value = await service.tool(w.id, { tool: "terminal_check", arguments: { argv } });
    while (["running", "finalizing"].includes(value.status)) value = await service.tool(w.id, { tool: "terminal_wait", arguments: { id: value.id, timeoutMs: 30000 } });
    return value;
  };
  const failed = await run(["node", "-e", "process.stdout.write('synthetic failure'); process.exit(7)"]);
  assert.equal(failed.exitCode, 7); assert.match(failed.output, /synthetic failure/);
  const passed = await run(["node", "-e", "const fs=require('fs'); if(fs.readFileSync('source.txt','utf8')!=='synthetic-source') process.exit(2); fs.writeFileSync('generated.txt','synthetic');"]);
  assert.equal(passed.exitCode, 0); assert.equal(existsSync(join(root, "generated.txt")), false);
  const receipts = service.store.get(w.id).verifications;
  assert.equal(receipts[0].exitCode, 7); assert.equal(receipts[1].outputComplete, true);
  assert.equal(receipts[1].inputs[0].path, "source.txt");
  assert.equal(service.store.get(w.id).approvals.length, 0);
});
