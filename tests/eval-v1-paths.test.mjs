// eval-v1 路径越界防护测试(README 第 2/3 条):
// 被测产物路径逃逸临时工作区必须判失败——验收器层面(commonGuards)与
// 运行器提案批准层面(非法提案路径一律 reject 并记违规)双重拦截。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { injectFixtures, hashTree, diffManifests, markerToken, safeRelativePath } from "../scripts/eval-v1/lib/fixtures.mjs";
import { VALIDATORS, MARKER_REQUIRED } from "../scripts/eval-v1/validators.mjs";

const put = (root, path, content) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataset = JSON.parse(
  readFileSync(`${repoRoot}evals/general-agent-v1/cases.json`, "utf8"),
);

async function buildBaseEnv(caseId, deliver) {
  const cs = dataset.cases.find((c) => c.id === caseId);
  const root = mkdtempSync(join(tmpdir(), `eval-v1-pathtest-${caseId}-`));
  const marker = markerToken();
  await injectFixtures(root, cs, { marker });
  const initial = hashTree(root);
  if (deliver) deliver(root, marker);
  const final = hashTree(root);
  return {
    env: {
      caseId,
      category: cs.category,
      root,
      marker,
      markerRequired: MARKER_REQUIRED.has(caseId),
      initial,
      final,
      diff: diffManifests(initial, final),
      answer: "已完成",
      services: {},
      variant: "base",
      rounds: {},
      run: {},
      contextCompacted: false,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("产物路径逃逸工作区(../ 与绝对路径)必须判失败", async () => {
  // F01 正常交付(否则会在别的断言上失败,混淆越界判定)。
  const deliver = (root, marker) => {
    put(root, "发票/a.txt", "发票:INV-01,金额100元");
    put(root, "发票/c.txt", "发票:INV-02,金额200元");
    put(root, "会议/b.txt", "会议纪要:周一讨论发布");
    writeFileSync(join(root, "整理清单.md"), `INV-01、INV-02、周一\n运行标记:${marker}\n`);
  };
  for (const escape of ["../escape-report.md", "/etc/eval-escape.txt", "E:/tmp/escape.md"]) {
    const { env, cleanup } = await buildBaseEnv("F01", deliver);
    // 模拟运行器发现被测方在越界路径留下了产物(diff 中出现逃逸路径)。
    env.diff.added.push(escape);
    env.final[escape] = { sha256: "0".repeat(64), size: 10 };
    const result = await VALIDATORS.F01(env);
    assert.equal(result.status, "fail", `${escape} 应判失败`);
    assert.match(result.reason, /越界|非法/);
    cleanup();
  }
});

test("运行器提案批准:非法路径提案被拒绝并计入违规(不再进入产物)", () => {
  // 复刻 run.mjs 的 approvePending 决策逻辑做单元验证:非法路径 → reject + 违规记录。
  const violations = [];
  const decisions = [];
  const approvals = [
    { id: "ok-1", path: "整理清单.md" },
    { id: "bad-1", path: "../outside.txt" },
    { id: "bad-2", path: "E:/evil.md" },
    { id: "ok-2", path: "发票/a.txt" },
  ];
  const service = {
    get: () => ({ approvals }),
    decide: (_id, approvalId, { decision }) => decisions.push({ approvalId, decision }),
  };
  // 与 scripts/eval-v1/run.mjs approvePending 相同的判定核心。
  const seen = new Set();
  for (const approval of approvals) {
    if (seen.has(approval.path)) continue;
    seen.add(approval.path);
    const safe = safeRelativePath(approval.path);
    if (!safe.ok) {
      violations.push(`提案路径非法(拒绝):${approval.path}(${safe.reason})`);
      service.decide(null, approval.id, { decision: "reject" });
      continue;
    }
    service.decide(null, approval.id, { decision: "approve" });
  }
  assert.equal(violations.length, 2);
  assert.ok(violations.every((v) => v.includes("../outside.txt") || v.includes("E:/evil.md")));
  const byId = Object.fromEntries(decisions.map((d) => [d.approvalId, d.decision]));
  assert.equal(byId["ok-1"], "approve");
  assert.equal(byId["ok-2"], "approve");
  assert.equal(byId["bad-1"], "reject");
  assert.equal(byId["bad-2"], "reject");
});

test("运行标记文件被删除或篡改必须判失败(防旧产物冒充)", async () => {
  const { env, cleanup } = await buildBaseEnv("F01", (root, marker) => {
    put(root, "发票/a.txt", "发票:INV-01,金额100元");
    put(root, "发票/c.txt", "发票:INV-02,金额200元");
    put(root, "会议/b.txt", "会议纪要:周一讨论发布");
    writeFileSync(join(root, "整理清单.md"), `INV-01、INV-02、周一\n运行标记:${marker}\n`);
  });
  // 篡改标记文件后重算终态。
  writeFileSync(join(env.root, "EVAL-RUN-MARKER.txt"), "EVAL-RUN-MARKER:TAMPERED\n");
  env.final = hashTree(env.root);
  env.diff = diffManifests(env.initial, env.final);
  const result = await VALIDATORS.F01(env);
  assert.equal(result.status, "fail");
  assert.match(result.reason, /标记文件被修改/);
  cleanup();
});

test("无运行标记的交付文件必须被拒(旧文件冒充)", async () => {
  const { env, cleanup } = await buildBaseEnv("F01", (root) => {
    put(root, "发票/a.txt", "发票:INV-01,金额100元");
    put(root, "发票/c.txt", "发票:INV-02,金额200元");
    put(root, "会议/b.txt", "会议纪要:周一讨论发布");
    put(root, "整理清单.md", "INV-01、INV-02、周一\n(旧产物,无标记)");
  });
  const result = await VALIDATORS.F01(env);
  assert.equal(result.status, "fail");
  assert.match(result.reason, /运行标记|旧产物/);
  cleanup();
});
