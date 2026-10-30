import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ResearchPython, quoteWindowsArg } from "../../server/core/research-python.mjs";

// 真实科研沙箱（macOS Seatbelt / Windows AppContainer）。设置
// MEDICAL_RESEARCH_PYTHON 指向装好科研包的解释器时运行；CI 的
// research-sandbox 工作流在 macOS 和 Windows 上各跑一次。
// 只依赖 Node 内置模块，不需要 npm 依赖。
const python = process.env.MEDICAL_RESEARCH_PYTHON;

test("Windows 参数转义符合 CommandLineToArgvW 规则", () => {
  assert.equal(quoteWindowsArg("C:\\Program Files\\a.py"), '"C:\\Program Files\\a.py"');
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArg("C:\\dir\\"), '"C:\\dir\\\\"');
});

test("真实科研沙箱：回归、画图可用", { skip: !python }, async () => {
  const research = new ResearchPython();
  assert.equal(research.status().supported, true, JSON.stringify(research.status()));
  const rows = Array.from({ length: 120 }, (_, i) => ({ pid: `R${i}`, age: 40 + (i % 40), y: (i * 13) % 7 < 3 ? 1 : 0 }));
  const output = await research.run({
    tables: { patients: rows },
    code: `import statsmodels.formula.api as smf
from lifelines import KaplanMeierFitter
m=smf.logit("y ~ age", tables["patients"]).fit(disp=0)
print("fitted")
plt.plot([1,2],[3,4]); plt.title("中文标题")
result={"n":int(m.nobs),"p":float(m.pvalues["age"])}`,
  });
  assert.equal(output.result.n, 120);
  assert.match(output.log, /fitted/);
  assert.equal(output.figures.length, 1);
  assert.ok(output.environment.modules.statsmodels);
});

test("真实科研沙箱：联网、读写用户目录、启动子进程都被拒绝", { skip: !python }, async () => {
  const research = new ResearchPython();
  const secretDir = mkdtempSync(join(homedir(), "om-research-secret-"));
  const secret = join(secretDir, "secret.txt");
  writeFileSync(secret, "patient-secret");
  const escape = join(homedir(), "om-research-escape.txt");
  try {
    const probe = await research.run({
      tables: {},
      code: `import os, socket, subprocess, sys
def attempt(fn):
    try:
        fn(); return "allowed"
    except Exception as e:
        return type(e).__name__
result={
 "net": attempt(lambda: socket.create_connection(("1.1.1.1",80),timeout=3)),
 "dns": attempt(lambda: socket.getaddrinfo("example.com",80)),
 "read": attempt(lambda: open(${JSON.stringify(secret)}).read()),
 "write": attempt(lambda: open(${JSON.stringify(escape)},"w").write("x")),
 "spawn": attempt(lambda: subprocess.run([sys.executable,"-c","print(1)"],check=True,capture_output=True)),
}`,
    });
    const allowed = Object.entries(probe.result).filter(([, v]) => v === "allowed");
    assert.deepEqual(allowed, [], JSON.stringify(probe.result));
    assert.ok(!existsSync(escape), "沙箱外不应出现写入的文件");
  } finally {
    rmSync(secretDir, { recursive: true, force: true });
    rmSync(escape, { force: true });
  }
});

test("真实科研沙箱：超时会终止并报错", { skip: !python }, async () => {
  const research = new ResearchPython({ timeoutMs: 3000 });
  await assert.rejects(research.run({ tables: {}, code: "while True: pass" }), (error) => ["SANDBOX_TIMEOUT", "SANDBOX_EXECUTION", "SANDBOX_RESULT"].includes(error.code));
});
