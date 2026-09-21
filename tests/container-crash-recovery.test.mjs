import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ContainerJournal } from "../server/core/container-journal.mjs";
import { ProcessRunner } from "../server/core/process-runner.mjs";

test("real Docker execution survives owner SIGKILL and is reclaimed by its exact persisted identity", {
  skip: !process.env.TEST_DOCKER_IMAGE, timeout: 25000,
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "omw-crash-recovery-")), filename = join(directory, "executions.sqlite");
  const worker = `
    import { DatabaseSync } from 'node:sqlite';
    import { ContainerJournal } from './server/core/container-journal.mjs';
    import { ProcessRunner } from './server/core/process-runner.mjs';
    const db = new DatabaseSync(process.argv[1]);
    const journal = new ContainerJournal(db), runner = new ProcessRunner({journal});
    const s = runner.start('synthetic-owner', {runId:'synthetic-run', image:runner.image(process.argv[2]),
      command:['/bin/sh','-c','sleep 60'], interactive:false, timeoutMs:60000});
    const timer = setInterval(() => {
      const value = runner.get('synthetic-owner', s.id).child.execution;
      if(value?.phase === 'started') { clearInterval(timer); process.stdout.write(JSON.stringify({nonce:value.nonce,id:value.containerId})+'\\n'); }
    }, 20);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", worker, filename, process.env.TEST_DOCKER_IMAGE], { stdio: ["ignore", "pipe", "pipe"] });
  let db, runner;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    if (!runner && existsSync(filename)) {
      db = new DatabaseSync(filename); runner = new ProcessRunner({ journal: new ContainerJournal(db) });
    }
    if (runner) await runner.recoverContainers();
    db?.close(); rmSync(directory, { recursive: true, force: true });
  });
  let timer;
  const ready = await new Promise((resolve, reject) => {
    let text = "", error = "";
    timer = setTimeout(() => reject(new Error("Container did not start within fixture deadline")), 10000);
    child.stderr.on("data", (data) => { error += data; });
    child.stdout.on("data", (data) => { text += data; if (text.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(text.trim())); } });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(error || "Owner exited before creating container")); });
  });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  db = new DatabaseSync(filename);
  const journal = new ContainerJournal(db); runner = new ProcessRunner({ journal });
  assert.equal(journal.get(ready.nonce).phase, "started");
  const results = await runner.recoverContainers();
  assert.ok(results.some((r) => r.nonce === ready.nonce && r.phase === "removed"), JSON.stringify(results));
  const record = journal.get(ready.nonce);
  assert.equal(record.containerId, ready.id); assert.equal(record.interrupted, true);
  assert.equal(record.phase, "removed"); assert.notEqual(record.status, "completed");
  assert.deepEqual(await runner.recoverContainers(), []);
});
