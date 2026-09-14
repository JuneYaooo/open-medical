import test from "node:test";
import assert from "node:assert/strict";
import { ProcessRunner } from "../server/core/process-runner.mjs";

test("scrollback eviction never evicts an in-progress artifact finalizer", async () => {
  const runner = new ProcessRunner({ docker: process.execPath });
  // Simulate process lifetime only; real Docker isolation is covered separately.
  runner.args = () => ({ name: "fixture", args: ["-e", "process.stdout.write('done')"] });
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  const first = runner.start("owner", {}, { onExit: async () => { entered(); await gate; return { saved: true }; } });
  await ready;
  try {
    for (let n = 0; n < 35; n++) {
      const next = runner.start("owner", {});
      await runner.get("owner", next.id).done;
    }
    assert.equal(runner.get("owner", first.id).status, "finalizing");
    assert.ok(runner.sessions.size <= 30);
    const done = runner.get("owner", first.id).done;
    release();
    assert.equal((await done).result.saved, true);
  } finally { release(); await runner.close(); }
});

test("repeated terminal input does not accumulate error listeners", async () => {
  const runner = new ProcessRunner({ docker: process.execPath });
  runner.args = () => ({ name: "fixture", args: ["-e", "process.stdin.resume()"] });
  const session = runner.start("owner", {});
  for (let n = 0; n < 40; n++) runner.write("owner", session.id, "input\n");
  assert.equal(runner.get("owner", session.id).child.stdin.listenerCount("error"), 1);
  runner.write("owner", session.id, "", true);
  await runner.get("owner", session.id).done;
  await runner.close();
});
