import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDetachedProcess } from "../server/core/detached-process.mjs";
import { ProcessRunner } from "../server/core/process-runner.mjs";

function fixture(t, mode = "success") {
  const directory = mkdtempSync(join(tmpdir(), "detached-lifecycle-"));
  const script = join(directory, "docker.cjs"), events = join(directory, "events");
  writeFileSync(events, "");
  writeFileSync(script, `
const fs=require('node:fs'),p=require('node:path');
const root=process.env.FIXTURE_ROOT,mode=process.env.FIXTURE_MODE,action=process.argv[2];
fs.appendFileSync(p.join(root,'events'),action+'\\n');
const id='a'.repeat(64),code=mode==='failed-exit'?7:0;
if(action==='create'){
 const label=process.argv.find(x=>x.startsWith('omw.execution='));
 if(mode==='create-conflict')process.exitCode=1;
 else if(mode==='create-interrupted'){fs.writeFileSync(p.join(root,'ownership'),label.split('=')[1]);setInterval(()=>{},1000);}
 else process.stdout.write(id);
}
else if(action==='start')process.stdout.write(id);
else if(action==='wait'){if(mode==='wait-hang')setInterval(()=>{},1000);else if(mode==='wait-disconnect')process.exitCode=1;else process.stdout.write(String(code));}
else if(action==='inspect'){
 if(process.argv.includes('{{.Id}} {{index .Config.Labels "omw.execution"}}'))process.stdout.write(id+' '+(mode==='create-conflict'?'different-owner':fs.readFileSync(p.join(root,'ownership'),'utf8')));
 else process.stdout.write(JSON.stringify({Running:false,Status:'exited',ExitCode:mode==='mismatch'?5:code}));
}
else if(action==='logs'){
 const count=fs.readFileSync(p.join(root,'events'),'utf8').split('\\n').filter(x=>x==='logs').length;
 if(mode==='logs-retry'&&count===1){process.stdout.write('partial untrusted response');process.exitCode=1;}
 else if(mode==='logs-hang'){process.stdout.write('partial');setInterval(()=>{},1000);}
 else process.stdout.write('complete archived output');
}
else if(action==='rm'){if(mode==='cleanup-hang')setInterval(()=>{},1000);else process.stdout.write(id);}
`);
  const commands = [], killed = [], realChildren = [];
  // Failure injection must not depend on a fresh Node executable reaching its
  // first statement within an 80ms cleanup budget under parallel test load.
  // Run the same synthetic CLI program against controlled child streams for
  // those cases. Success/retry/recovery still exercise actual OS children.
  const controlled = !["success", "logs-retry", "wait-disconnect"].includes(mode);
  const controlledChild = (args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let ended = false;
    const finish = (code) => {
      if (ended) return;
      ended = true;
      child.stdout.end(); child.stderr.end();
      Promise.all([child.stdout, child.stderr].map((stream) => stream.readableEnded
        ? Promise.resolve() : new Promise((resolve) => stream.once("end", resolve))))
        .then(() => { child.emit("exit", code); child.emit("close", code); });
    };
    child.kill = () => { killed.push(args[0]); finish(null); return true; };
    queueMicrotask(() => {
      let hang = false;
      const process = { argv: ["node", script, ...args],
        env: { FIXTURE_ROOT: directory, FIXTURE_MODE: mode }, stdout: child.stdout,
        exitCode: 0 };
      try {
        runInNewContext(readFileSync(script, "utf8"), { process,
          require: createRequire(import.meta.url), setInterval: () => { hang = true; } });
        if (!hang) finish(process.exitCode);
      } catch (error) { child.emit("error", error); finish(1); }
    });
    return child;
  };
  const runner = new ProcessRunner({ cleanupTimeoutMs: 80,
    detachedFactory: (options) => createDetachedProcess({ ...options,
      spawnProcess: (_, args, options) => {
        commands.push(args);
        if (controlled || args[0] === "rm") return controlledChild(args);
        realChildren.push(args[0]);
        return spawn(process.execPath, [script, ...args], { ...options,
          env: { FIXTURE_ROOT: directory, FIXTURE_MODE: mode } });
      } }) });
  t.after(async () => { await runner.close(); rmSync(directory, { recursive: true, force: true }); });
  const start = (options = {}) => runner.start("owner", { image: "sha256:" + "a".repeat(64),
    command: ["/bin/sh", "-c", "synthetic", "--rm"], interactive: false,
    timeoutMs: ["wait-hang", "logs-hang", "create-interrupted"].includes(mode) ? 300 : 3000 }, options);
  return { runner, start, commands, killed, realChildren, events: () => readFileSync(events, "utf8").trim().split("\n"),
    mark: (event) => appendFileSync(events, `${event}\n`) };
}

test("detached task starts once, verifies exit and reads complete logs before artifact finalization and cleanup", async (t) => {
  const f = fixture(t);
  const start = f.start({ onExit: () => { f.mark("artifact-finalized"); return { checked: true }; } });
  const result = await f.runner.get("owner", start.id).done;
  assert.equal(result.status, "completed");
  assert.equal(result.outputComplete, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "complete archived output");
  assert.deepEqual(f.realChildren, ["create", "start", "wait", "inspect", "logs"]);
  assert.deepEqual(f.events(), ["create", "start", "wait", "inspect", "logs", "artifact-finalized", "rm"]);
  assert.ok(f.commands[0].includes("--read-only"));
  assert.ok(f.commands[0].includes("--network=none"));
  assert.equal(f.commands[0].filter((arg) => arg === "--rm").length, 1);
  assert.equal(f.commands[0].at(-1), "--rm");
  assert.ok(!f.commands[0].includes("-i"));
  assert.ok(!f.commands.flat().includes("--follow"));
  assert.ok(result.lifecycle.some((event) => event.event === "container.exited" && event.code === 0));
});

test("failed log connection retries reading same container without replaying command or partial output", async (t) => {
  const f = fixture(t, "logs-retry"), started = f.start();
  const result = await f.runner.get("owner", started.id).done;
  assert.equal(result.status, "completed");
  assert.equal(result.output, "complete archived output");
  assert.deepEqual(f.events(), ["create", "start", "wait", "inspect", "logs", "logs", "rm"]);
  assert.deepEqual(f.commands.filter((args) => args[0] === "logs").map((args) => args[1]), ["a".repeat(64), "a".repeat(64)]);
});

for (const mode of ["failed-exit", "mismatch", "wait-hang", "logs-hang", "cleanup-hang"]) {
  test(`detached ${mode} cannot produce successful receipt or replay execution`, async (t) => {
    const f = fixture(t, mode), started = f.start();
    const session = f.runner.get("owner", started.id);
    if (mode === "cleanup-hang") {
      await new Promise((resolve) => session.child.on("lifecycle", (event) => {
        if (event === "detached.cleanup.start") resolve();
      }));
      assert.equal(f.runner.read("owner", started.id).status, "finalizing");
    }
    const result = await session.done;
    assert.notEqual(result.status, "completed");
    assert.equal(f.events().filter((event) => event === "start").length, 1);
    assert.equal(f.events().filter((event) => event === "rm").length, 1);
    if (mode.endsWith("-hang")) assert.ok(f.killed.includes(mode.slice(0, -5) === "cleanup" ? "rm" : mode.slice(0, -5)));
    if (mode === "failed-exit") assert.equal(result.exitCode, 7);
    if (["mismatch", "wait-hang", "logs-hang"].includes(mode)) {
      assert.equal(result.outputComplete, false);
      assert.ok(!result.output.includes("partial"));
    }
  });
}

for (const mode of ["create-conflict", "create-interrupted"]) {
  test(`detached ${mode} never deletes a foreign container or starts ambiguous execution`, async (t) => {
    const f = fixture(t, mode), started = f.start();
    const result = await f.runner.get("owner", started.id).done;
    assert.notEqual(result.status, "completed");
    assert.equal(f.events().filter((event) => event === "start").length, 0);
    assert.equal(f.events().filter((event) => event === "rm").length, mode === "create-conflict" ? 0 : 1);
    if (mode === "create-interrupted") assert.equal(f.commands.find((args) => args[0] === "rm").at(-1), "a".repeat(64));
  });
}


test("disconnected wait recovers authoritative exit from same container without replay", async (t) => {
  const f = fixture(t, "wait-disconnect"), started = f.start();
  const result = await f.runner.get("owner", started.id).done;
  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(f.events(), ["create", "start", "wait", "inspect", "logs", "rm"]);
  assert.ok(result.lifecycle.some((event) => event.event === "detached.wait.inspect-recovery"));
});
