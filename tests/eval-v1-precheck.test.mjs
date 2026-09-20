// eval-v1 数据集预检器测试:
// 1) 真实数据集 30 项全部通过预检;
// 2) 变异数据集(缺字段/路径穿越/密钥/类别分布错/预算错)必须被检出;
// 3) safeRelativePath 的越界拒绝矩阵。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPrecheck } from "../scripts/eval-v1/precheck.mjs";
import { safeRelativePath } from "../scripts/eval-v1/lib/fixtures.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataset = JSON.parse(
  readFileSync(`${repoRoot}evals/general-agent-v1/cases.json`, "utf8"),
);
const protocol = JSON.parse(
  readFileSync(`${repoRoot}evals/general-agent-v1/protocol.json`, "utf8"),
);
const clone = () => structuredClone(dataset);

test("真实数据集(30 项)预检通过", () => {
  const report = runPrecheck(dataset, protocol);
  assert.deepEqual(report.problems, []);
  assert.equal(report.ok, true);
  assert.equal(report.categoryCount.code, 5);
  assert.equal(report.categoryCount.lifecycle, 2);
});

test("缺少字段、路径穿越与密钥都会被预检拒绝", () => {
  const broken = clone();
  delete broken.cases[0].oracle;
  const r1 = runPrecheck(broken, protocol);
  assert.equal(r1.ok, false);
  assert.ok(r1.problems.some((p) => p.includes("缺少字段 oracle")));

  const escape = clone();
  escape.cases[0].fixtures = { "../evil.txt": "x", ...escape.cases[0].fixtures };
  const r2 = runPrecheck(escape, protocol);
  assert.ok(r2.problems.some((p) => p.includes("路径不安全") || p.includes("..")));

  const abs = clone();
  abs.cases[1].fixtures = { "E:/tmp/abs.txt": "x", ...abs.cases[1].fixtures };
  const r3 = runPrecheck(abs, protocol);
  assert.ok(r3.problems.some((p) => p.includes("盘符") || p.includes("绝对")));

  const secret = clone();
  secret.cases[2].fixtures["leak.txt"] = "token: sk-abcdefghijklmnopqrstuvwx";
  const r4 = runPrecheck(secret, protocol);
  assert.ok(r4.problems.some((p) => p.includes("密钥")));

  const wrongCount = clone();
  wrongCount.cases = wrongCount.cases.slice(0, 29);
  const r5 = runPrecheck(wrongCount, protocol);
  assert.ok(r5.problems.some((p) => p.includes("cases 数量")));

  const wrongRepeats = clone();
  wrongRepeats.cases[3].repeats = 5;
  const r6 = runPrecheck(wrongRepeats, protocol);
  assert.ok(r6.problems.some((p) => p.includes("repeats")));

  const wrongBudget = structuredClone(protocol);
  wrongBudget.budgets.wall_seconds_per_run = -1;
  const r7 = runPrecheck(dataset, wrongBudget);
  assert.ok(r7.problems.some((p) => p.includes("wall_seconds_per_run")));

  const fewerFaults = structuredClone(protocol);
  fewerFaults.fault_cases = fewerFaults.fault_cases.slice(0, 11);
  const r8 = runPrecheck(dataset, fewerFaults);
  assert.ok(r8.problems.some((p) => p.includes("fault_cases")));
});

test("C03 接口约定缺失会被记录为控制器附加动作(而非数据集问题)", () => {
  const report = runPrecheck(dataset, protocol);
  assert.ok(
    report.notes.some((n) => n.includes("C03") && n.includes("接口约定")),
  );
});

test("safeRelativePath 越界矩阵", () => {
  assert.deepEqual(safeRelativePath("inbox/a.txt"), { ok: true, path: "inbox/a.txt" });
  for (const bad of [
    "../escape.txt",
    "a/../../escape.txt",
    "/etc/passwd",
    "E:/x.txt",
    "C:\\Windows\\evil.txt",
    "a\\b.txt",
    "",
  ]) {
    const result = safeRelativePath(bad);
    assert.equal(result.ok, false, `${bad} 应被拒绝`);
  }
  // 规范化差异也拒绝(如 ./a.txt 与 a.txt 不一致的形式)。
  assert.equal(safeRelativePath("./a.txt").ok, false);
});
