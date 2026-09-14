import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MedicalSandbox } from "../server/sandbox.mjs";

const sandbox = new MedicalSandbox();
test("sandbox fails closed on missing runtime", async () => {
  const missing = new MedicalSandbox({ python: "/missing/python" });
  assert.equal(missing.status().available, false);
  await assert.rejects(missing.run({ code: "result=1" }), {
    code: "SANDBOX_UNAVAILABLE",
  });
});
test(
  "real OS sandbox computes on scoped input and hides environment",
  { skip: !sandbox.status().available },
  async () => {
    process.env.MEDICAL_SANDBOX_TEST_SECRET = "do-not-pass";
    try {
      const value = await sandbox.run({
        code: 'import os\nresult={"sum":sum([1,2,3]),"text":sources[0]["text"],"secret":os.environ.get("MEDICAL_SANDBOX_TEST_SECRET")}',
        sources: [{ text: "合成测试 Hb 98 g/L" }],
      });
      assert.deepEqual(value.result, {
        sum: 6,
        text: "合成测试 Hb 98 g/L",
        secret: null,
      });
    } finally {
      delete process.env.MEDICAL_SANDBOX_TEST_SECRET;
    }
  },
);
test(
  "real OS boundary blocks host reads, writes, network and process creation",
  { skip: !sandbox.status().available },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "medical-forbidden-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const sentinel = join(dir, "private.txt");
    await writeFile(sentinel, "PRIVATE_SENTINEL");
    const attempts = [
      `result=open(${JSON.stringify(sentinel)}).read()`,
      `open(${JSON.stringify(join(dir, "escape.txt"))},"w").write("escape")`,
      'import socket\ns=socket.socket()\ns.connect(("127.0.0.1",8787))\nresult="escaped"',
      "import os\nresult=os.fork()",
      'import subprocess\nresult=subprocess.check_output(["/bin/echo","escaped"]).decode()',
    ];
    for (const code of attempts)
      await assert.rejects(sandbox.run({ code }), {
        code: "SANDBOX_EXECUTION",
      });
  },
);
test(
  "sandbox kills runaway output, deadlines and cancellation without leaking slots",
  { skip: !sandbox.status().available },
  async () => {
    const bounded = new MedicalSandbox({ timeoutMs: 150, maxOutput: 4000 });
    await assert.rejects(bounded.run({ code: "while True: pass" }), {
      code: "SANDBOX_TIMEOUT",
    });
    await assert.rejects(bounded.run({ code: 'result="x"*10000' }), {
      code: "SANDBOX_OUTPUT",
    });
    const controller = new AbortController();
    const pending = sandbox.run({
      code: "while True: pass",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 80);
    await assert.rejects(pending);
    assert.equal(sandbox.active, 0);
    assert.equal((await sandbox.run({ code: "result=7" })).result, 7);
  },
);
