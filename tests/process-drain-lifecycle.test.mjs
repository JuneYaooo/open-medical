import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { ProcessRunner } from "../server/core/process-runner.mjs";

function fixture(code, options = {}) {
  const runner = new ProcessRunner({ docker: process.execPath, detachedFactory: ({ docker, args, environment }) => spawn(docker, args, { env: environment, stdio: ["pipe", "pipe", "pipe"] }), ...options });
  // Real host children exercise lifecycle only, never tool sandbox execution.
  runner.args = () => ({ name: "lifecycle-fixture", args: ["-e", code] });
  return runner;
}

test("noninteractive child receives EOF immediately and retains full output", async () => {
  const runner = fixture("process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'.repeat(100000)))");
  const start = runner.start("owner", { interactive: false });
  const result = await runner.get("owner", start.id).done;
  assert.equal(result.status, "completed");
  assert.equal(result.output, "x".repeat(100000));
  assert.equal(result.outputComplete, true);
  for (const event of ["stdin.finish", "child.exit", "stdout.end", "child.close", "finalization.end"])
    assert.ok(result.lifecycle.some((item) => item.event === event), event);
  await runner.close();
});

test("exited child with inherited open stdout fails bounded drain instead of execution cancellation", async () => {
  const runner = fixture("require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},500)'],{stdio:['ignore',1,2]});process.stdout.write('complete-looking');process.exit(0)", { drainTimeoutMs: 60 });
  let receipt;
  const start = runner.start("owner", { timeoutMs: 1000 }, { onExit: (s) => { receipt = { code: s.exitCode, complete: s.outputComplete }; } });
  const result = await runner.get("owner", start.id).done;
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 0);
  assert.match(result.error, /PROCESS_DRAIN_TIMEOUT/);
  assert.deepEqual(receipt, { code: 0, complete: false });
  assert.ok(!result.lifecycle.some((item) => item.event === "cancel.requested"));
  await runner.close();
});

test("slow output after child exit drains through actual close", async () => {
  const runner = fixture("require('node:child_process').spawn(process.execPath,['-e',\"setTimeout(()=>process.stdout.write('tail'),1200)\"],{stdio:['ignore',1,2]});process.stdout.write('head');process.exit(0)");
  const start = runner.start("owner", { timeoutMs: 1000 });
  const result = await runner.get("owner", start.id).done;
  assert.equal(result.status, "completed");
  assert.equal(result.output, "headtail");
  assert.equal(result.outputComplete, true);
  await runner.close();
});

test("finalization timeout aborts work without evicting running finalizer early", async () => {
  const runner = fixture("process.exit(0)", { finalizationTimeoutMs: 40 });
  let finalizerSignal;
  const start = runner.start("owner", {}, { onExit: (s) => { finalizerSignal = s.finalizationController.signal; return new Promise(() => {}); } });
  const result = await runner.get("owner", start.id).done;
  assert.equal(result.status, "failed");
  assert.match(result.error, /PROCESS_FINALIZATION_TIMEOUT/);
  assert.equal(finalizerSignal.aborted, true);
  await runner.close();
});

test("cancellation escalates a child ignoring SIGTERM and settles without complete output", async () => {
  const runner = fixture("process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)", { cleanupTimeoutMs: 40 });
  const start = runner.start("owner", {});
  const session = runner.get("owner", start.id);
  await new Promise((resolve) => session.child.stdout.once("data", resolve));
  runner.stop("owner", start.id);
  const result = await session.done;
  assert.equal(result.status, "cancelled");
  assert.equal(result.outputComplete, false);
  assert.ok(result.lifecycle.some((item) => item.event === "kill.escalated"));
  await runner.close();
});


test("legacy custom sessions remain readable without inventing lifecycle evidence", () => {
  const runner = new ProcessRunner();
  runner.sessions.set("legacy", { owner: "owner", status: "completed", exitCode: 0,
    output: "retained output", offset: 0 });
  const receipt = runner.read("owner", "legacy");
  assert.equal(receipt.output, "retained output");
  assert.equal(receipt.status, "completed");
  assert.deepEqual(receipt.lifecycle, []);
  assert.equal(receipt.outputComplete, undefined);
});
