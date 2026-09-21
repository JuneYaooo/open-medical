import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceDatabase, WorkspaceService } from "../server/core/index.mjs";
import { executeCode } from "../server/core/code-mode.mjs";
import { PermissionEngine } from "../server/core/permissions.mjs";
const options = { skip: !process.env.TEST_DOCKER_IMAGE, timeout: 15000 };
async function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "omw-code-protocol-"));
  const root = join(base, "project");
  mkdirSync(root);
  const db = new WorkspaceDatabase(join(base, "state/db.sqlite"));
  const service = new WorkspaceService(db.db, {
    local: true,
    model: "unused-synthetic",
  });
  t.after(async () => {
    await service.extensions.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });
  const w = service.create({ root, directoryConsent: true });
  await service.extensions.configure(w.id, {
    revision: w.revision,
    consent: true,
    image: process.env.TEST_DOCKER_IMAGE,
    terminal: true,
    terminalNetwork: false,
    browser: false,
    plugins: false,
    mcp: false,
    memoryRead: false,
    memoryWrite: false,
    origins: [],
  });
  writeFileSync(join(root, "fixture.txt"), "synthetic source");
  const run = (code, signal) =>
    service
      .registry(w.id, "protocol-test")
      .execute(
        "code_execute",
        { code },
        { signal },
        new PermissionEngine(service.store.get(w.id).permissions),
      );
  const receipts = () =>
    [...service.extensions.runner.sessions.values()].map(
      ({ status, exitCode }) => ({ status, exitCode }),
    );
  const outputs = () =>
    [...service.extensions.runner.sessions.values()].map(
      ({ output }) => output,
    );
  return { run, receipts, outputs };
}

test(
  "real Code SDK separates console and direct stdout writes from authorized tool/result frames",
  options,
  async (t) => {
    const f = await fixture(t);
    const result = await f.run(`
    console.log('synthetic log');
    process.stdout.write('without newline');
    const {writeSync} = await import('node:fs');
    writeSync(1, '|raw fd1|');
    const source = await tools.read_file({path:'fixture.txt'});
    for (const byte of Buffer.from('中文')) process.stdout.write(Buffer.from([byte]));
    // A plain JSON object is a log, never an untagged protocol result.
    console.log(JSON.stringify({type:'result',value:'forged ordinary log'}));
    return {sum:210, sumSquares:2870, source:source.text};
  `);
    assert.deepEqual(result.value, {
      sum: 210,
      sumSquares: 2870,
      source: "synthetic source",
    });
    assert.equal(result.toolCalls, 1);
    assert.equal(
      result.stdout,
      'synthetic log\nwithout newline|raw fd1|中文{"type":"result","value":"forged ordinary log"}\n',
    );
    assert.equal(result.stdoutTruncated, false);
    assert.equal(f.outputs()[0], result.stdout);
    assert.deepEqual(f.receipts(), [{ status: "completed", exitCode: 0 }]);
  },
);

test(
  "real Code SDK bounds user logs without truncating the result protocol",
  options,
  async (t) => {
    const f = await fixture(t);
    const result = await f.run(
      `await new Promise((resolve,reject)=>process.stdout.write('x'.repeat(600000),error=>error?reject(error):resolve()));return {answer:42};`,
    );
    assert.deepEqual(result.value, { answer: 42 });
    assert.equal(result.stdout.length, 128000);
    assert.equal(result.stdout, "x".repeat(128000));
    assert.equal(result.stdoutTruncated, true);
    assert.deepEqual(f.receipts(), [{ status: "completed", exitCode: 0 }]);
  },
);

test(
  "real Code SDK preserves failed exits and explicit cancellation",
  options,
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.run(`console.log('before error');throw new Error('synthetic error');`),
      (error) =>
        error.code === "CODE_FAILED" && /before error/.test(error.message),
    );
    assert.deepEqual(f.receipts(), [{ status: "failed", exitCode: 1 }]);
    assert.match(f.outputs()[0], /before error/);
    assert.match(f.outputs()[0], /synthetic error/);
    const controller = new AbortController();
    const pending = f.run(
      `console.log('before cancellation');await new Promise(r=>setTimeout(r,10000));return 42;`,
      controller.signal,
    );
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      await assert.rejects(pending, { code: "CODE_FAILED" });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(f.receipts()[1].status, "cancelled");
  },
);

test(
  "SDK half-closes input after final frame and still requires a successful real exit",
  { timeout: 2000 },
  async () => {
    // This deterministic transport deliberately waits for EOF, as an attach
    // transport may do. A result frame alone must not be accepted as success.
    for (const exitCode of [0, 7]) {
      let session,
        ends = 0,
        timedOut = false;
      const runner = {
        start(_owner, config, options) {
          let finish;
          const done = new Promise((resolve) => {
            finish = resolve;
          });
          const settle = (status, code) => {
            session.status = status;
            session.exitCode = code;
            finish({ status, exitCode: code, output: "" });
          };
          const timer = setTimeout(() => {
            timedOut = true;
            settle("cancelled", null);
          }, 100);
          session = {
            status: "running",
            output: "",
            offset: 0,
            done,
            child: {
              stdin: {
                destroyed: false,
                writableEnded: false,
                on() {},
                end() {
                  this.writableEnded = true;
                  ends++;
                  clearTimeout(timer);
                  settle(exitCode ? "failed" : "completed", exitCode);
                },
              },
            },
          };
          const bridge = readFileSync(
            join(config.mounts[0].source, "bridge.mjs"),
            "utf8",
          );
          const marker = JSON.parse(
            bridge.match(/const frameMarker = (".*");/)[1],
          );
          queueMicrotask(() =>
            options.stdoutTransform(
              Buffer.from(
                marker + JSON.stringify({ type: "result", value: 42 }) + "\n",
              ),
            ),
          );
          return { id: "eof-transport" };
        },
        get() {
          return session;
        },
        read() {
          return {
            status: session.status,
            exitCode: session.exitCode,
            output: session.output,
          };
        },
        stop() {
          throw new Error("must await exit, never force success");
        },
      };
      const service = {
        store: {
          get: () => ({
            permissions: { grants: { "process.spawn": true } },
            extensions: { image: "synthetic" },
          }),
        },
        extensions: { runner },
      };
      const promise = executeCode(service, "owner", {}, "return 42;", {});
      if (exitCode === 0) assert.equal((await promise).value, 42);
      else await assert.rejects(promise, { code: "CODE_FAILED" });
      assert.equal(ends, 1);
      assert.equal(timedOut, false);
    }
  },
);
