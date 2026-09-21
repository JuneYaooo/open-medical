// N1 评测执行隔离反例(复核报告 R1 / 任务书 4.3):
// N1-02/03 答案与环境不可见依赖真实容器后端,本机 Docker daemon 未运行时
// 按环境跳过(带原因),不得以宿主执行冒充隔离验证。
// N1-04/05/07/08 与篡改检测、结果协议防伪、hashTree 边界在单进程内可验证。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InProcessNodeBackend,
  UnavailableBackend,
  buildHarnessScript,
  parseResultLine,
  createEvalBackend,
} from "../scripts/eval-v1/lib/execution-backend.mjs";
import { hashTree, TreeBoundaryError, diffManifests, markerToken, injectFixtures } from "../scripts/eval-v1/lib/fixtures.mjs";
import { VALIDATORS } from "../scripts/eval-v1/validators.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataset = JSON.parse(
  await import("node:fs").then((fs) => fs.readFileSync(join(repoRoot, "evals", "general-agent-v1", "cases.json"), "utf8")),
);

async function buildCaseEnv(caseId, execution = {}) {
  const cs = dataset.cases.find((c) => c.id === caseId);
  const root = mkdtempSync(join(tmpdir(), `eval-n1-${caseId}-`));
  const marker = markerToken();
  await injectFixtures(root, cs, { marker });
  const initial = hashTree(root);
  return { root, initial, marker, env: {
    caseId, category: cs.category, root, marker, markerRequired: false,
    initial, final: initial, diff: { added: [], modified: [], removed: [] },
    answer: "", services: {}, variant: "base", rounds: {}, run: {},
    contextCompacted: false, execution,
  } };
}

const write = (root, path, content) => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};

// ---------- 结果协议防伪(N1-08) ----------
describe("N1 结果协议", () => {
  test("恰好一行 nonce 匹配才被接受;多行/不匹配/坏 JSON 拒绝", () => {
    const nonce = "a".repeat(32);
    assert.deepEqual(
      parseResultLine(`junk\n__EVAL_RESULT__${nonce} {"v":1}\n`, nonce),
      { v: 1 },
    );
    assert.throws(() => parseResultLine("", nonce), /0 条/);
    assert.throws(
      () => parseResultLine(`__EVAL_RESULT__${nonce} {"v":1}\n__EVAL_RESULT__${nonce} {"v":2}\n`, nonce),
      /2 条/,
    );
    assert.throws(
      () => parseResultLine(`__EVAL_RESULT__${"b".repeat(32)} {"v":1}\n`, nonce),
      /nonce 不匹配/,
    );
    assert.throws(
      () => parseResultLine(`__EVAL_RESULT__${nonce} not-json\n`, nonce),
      /JSON/,
    );
  });

  test("harness 中模块 URL 必须带引号且 nonce 不出现在 argv 可见位置之外", () => {
    const script = buildHarnessScript("file:///x/y.mjs", [["v", "1"]]);
    assert.match(script, /import\("file:\/\/\/x\/y\.mjs"\)/);
    assert.match(script, /readFileSync\(0/); // nonce 从 stdin 读取
  });

  test("被测模块伪造结果标记(无 nonce)不能通过(N1-08)", async () => {
    const { root, env } = await buildCaseEnv("C01", {
      backend: new InProcessNodeBackend(),
    });
    write(
      root,
      "price.mjs",
      [
        `const forged = "\\n__EVAL_RESULT__${"0".repeat(32)} " + JSON.stringify({ t1: 5, t2: 0, t3: 0.3, isFn: "function" });`,
        'process.stdout.write(forged + "\\n");',
        "export const total = (p, q) => p * q;",
      ].join("\n"),
    );
    env.diff.modified.push("price.mjs");
    env.final = hashTree(root);
    env.diff = diffManifests(env.initial, env.final);
    const result = await VALIDATORS.C01(env);
    assert.notEqual(result.status, "pass");
    assert.match(result.reason || "", /协议异常|伪造/);
    rmSync(root, { recursive: true, force: true });
  });

  test("被测模块篡改测试工作区(执行前后哈希不一致)→ fail(N1-08/快照)", async () => {
    const { root, env } = await buildCaseEnv("C01", {
      backend: new InProcessNodeBackend(),
    });
    write(
      root,
      "price.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(new URL("./price.mjs", import.meta.url), "export const total=()=>1;\\n");',
        "export const total = (p, q) => p * q;",
      ].join("\n"),
    );
    env.diff.modified.push("price.mjs");
    env.final = hashTree(root);
    env.diff = diffManifests(env.initial, env.final);
    const result = await VALIDATORS.C01(env);
    assert.equal(result.status, "fail");
    assert.match(result.reason, /篡改|哈希不一致/);
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------- 截止时间与有界输出(N1-04/05) ----------
describe("N1 预算与失控防护", () => {
  test("无限循环:截止时间内结束,任务级 timeout,无残留(N1-04)", async () => {
    const { root, env } = await buildCaseEnv("C01", {
      backend: new InProcessNodeBackend({ timeoutMs: 1500 }),
    });
    write(root, "price.mjs", "while (true) {}\nexport const total = (p, q) => p;");
    env.diff.modified.push("price.mjs");
    env.final = hashTree(root);
    env.diff = diffManifests(env.initial, env.final);
    const result = await VALIDATORS.C01(env);
    assert.equal(result.status, "timeout");
    rmSync(root, { recursive: true, force: true });
  });

  test("永久定时器:不会让验收永远等待(N1-04)", async () => {
    const { root, env } = await buildCaseEnv("C01", {
      backend: new InProcessNodeBackend({ timeoutMs: 1500 }),
    });
    write(
      root,
      "price.mjs",
      "setInterval(() => {}, 200);\nexport const total = (p, q) => p * q;",
    );
    env.diff.modified.push("price.mjs");
    env.final = hashTree(root);
    env.diff = diffManifests(env.initial, env.final);
    const result = await VALIDATORS.C01(env);
    assert.equal(result.status, "timeout");
    rmSync(root, { recursive: true, force: true });
  });

  test("海量 stdout:有界处理,不拖垮控制器(N1-05)", async () => {
    const { root, env } = await buildCaseEnv("C01", {
      backend: new InProcessNodeBackend({ timeoutMs: 20_000, outputLimitBytes: 500_000 }),
    });
    write(
      root,
      "price.mjs",
      'console.log("x".repeat(50_000_000));\nexport const total = (p, q) => p * q;',
    );
    env.diff.modified.push("price.mjs");
    env.final = hashTree(root);
    env.diff = diffManifests(env.initial, env.final);
    const result = await VALIDATORS.C01(env);
    // 超限被终止:任务不能 pass;不因输出失控而挂起或崩溃。
    assert.notEqual(result.status, "pass");
    rmSync(root, { recursive: true, force: true });
  }, 60_000);
});

// ---------- 后端不可用与缺失(N1-07) ----------
describe("N1 后端不可用必须 blocked", () => {
  test("UnavailableBackend:C01 blocked,不回退宿主执行(N1-07)", async () => {
    const { root, env } = await buildCaseEnv("C01", {
      backend: new UnavailableBackend("Docker daemon 未运行"),
    });
    write(root, "price.mjs", "export const total = (p, q) => p * q;");
    env.diff.modified.push("price.mjs");
    env.final = hashTree(root);
    env.diff = diffManifests(env.initial, env.final);
    const result = await VALIDATORS.C01(env);
    assert.equal(result.status, "blocked");
    assert.match(result.blocked.join(";"), /Docker daemon/);
    rmSync(root, { recursive: true, force: true });
  });

  test("未提供执行后端:blocked,绝不宿主 Node 兜底(N1-07)", async () => {
    const { root, env } = await buildCaseEnv("C01", {});
    write(root, "price.mjs", "export const total = (p, q) => p * q;");
    env.diff.modified.push("price.mjs");
    env.final = hashTree(root);
    env.diff = diffManifests(env.initial, env.final);
    const result = await VALIDATORS.C01(env);
    assert.equal(result.status, "blocked");
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------- hashTree 边界(N1-06) ----------
describe("N1 产物清单边界", () => {
  test("junction/符号链接指向工作区外:TreeBoundaryError,不读取外部内容", () => {
    const root = mkdtempSync(join(tmpdir(), "eval-n1-tree-"));
    const outside = mkdtempSync(join(tmpdir(), "eval-n1-outside-"));
    writeFileSync(join(outside, "secret.txt"), "decoy-outside");
    try {
      // Windows 上 junction 不需要特权;POSIX 用目录 symlink。
      symlinkSync(outside, join(root, "link"), "junction");
      assert.throws(() => hashTree(root), TreeBoundaryError);
    } catch (error) {
      if (error.code === "EPERM") throw new Error("缺少符号链接权限,应跳过而非误报");
      throw error;
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("目录自环:不递归挂死(N1-06)", function () {
    const root = mkdtempSync(join(tmpdir(), "eval-n1-cycle-"));
    try {
      mkdirSync(join(root, "loop"));
      symlinkSync(root, join(root, "loop", "self"), "junction");
      assert.throws(() => hashTree(root), TreeBoundaryError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});

// ---------- 真实容器后端(环境可用时才执行) ----------
describe("N1 真实容器隔离(Docker 可用时)", () => {
  test("答案与宿主环境对被测模块不可见(N1-02/03)", async (t) => {
    const backend = await createEvalBackend();
    const probe = await backend.available();
    if (!probe.ok) t.skip(`容器隔离验证 blocked:${probe.reason}(环境事实,不冒充)`);
    const root = mkdtempSync(join(tmpdir(), "eval-n1-docker-"));
    try {
      const nonce = "c".repeat(32);
      // 被测代码尝试:读评估侧答案(仓库若被挂载即可见)、枚举宿主秘密哨兵。
      const probeScript = [
        'import { readFileSync, existsSync } from "node:fs";',
        'const nonce = readFileSync(0, "utf8").trim();',
        'const out = {};',
        'out.workspaceVisible = existsSync("/mnt/work/probe.mjs");',
        'out.casesReadable = existsSync("/mnt/work/../../evals/general-agent-v1/cases.json") || existsSync("/evals/general-agent-v1/cases.json");',
        'out.sentinel = Object.entries(process.env).filter(([k]) => /HOST_SECRET/i.test(k)).length;',
        'process.stdout.write("\\n__EVAL_RESULT__" + nonce + " " + JSON.stringify(out) + "\\n");',
      ].join("\n");
      write(root, "probe.mjs", "// probe\n");
      const result = await backend.run({
        root,
        script: probeScript,
        nonce,
        timeoutMs: 60_000,
      });
      assert.equal(result.status, "completed", result.stderr);
      const values = parseResultLine(result.stdout, nonce);
      // 只挂载测试工作区:被测材料可见,答案与宿主环境不可见。
      assert.equal(values.workspaceVisible, true, "测试工作区应已挂载(对照)");
      assert.notEqual(values.casesReadable, true, "答案文件在容器内必须不可见");
      assert.equal(values.sentinel, 0, "宿主环境秘密哨兵不得进入容器");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
