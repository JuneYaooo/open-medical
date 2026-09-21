// N3 通用交付契约接入主路径(复核报告 R3 / 任务书 6.3):
// WorkspaceService.execute 真实执行链路(非仅 AgentRuntime 钩子)下的
// N3-01…N3-09 场景;合成脚本模型,无外部依赖。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceDatabase,
  WorkspaceService,
  publicWorkspace,
} from "../server/core/index.mjs";
import { scanFileClaims, scanFileTargets } from "../server/core/delivery.mjs";

const answer = (content) => ({ message: { role: "assistant", content } });
const toolCall = (id, name, args) => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args ?? {}) } }],
  },
});

async function fixture(t, provider, { policy = "workspace-write" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omw-n3-"));
  const db = new WorkspaceDatabase(":memory:");
  const service = new WorkspaceService(db.db, provider);
  const w = service.create({ root, directoryConsent: true });
  service.update(w.id, {
    revision: service.get(w.id).revision,
    profile: "standard",
    allowWrite: true,
    approvalPolicy: policy,
    autoApplyConsent: true,
  });
  await service.extensions.operation(w.id, {
    action: "configure",
    revision: service.get(w.id).revision,
    consent: true,
    origins: [],
    terminal: false,
    browser: false,
    plugins: false,
    mcp: false,
    memoryRead: false,
    memoryWrite: false,
    memory: { provider: "lsa" },
  });
  const cleanup = async () => {
    try {
      await service.extensions.close();
    } catch {}
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  if (t) t.after(cleanup);
  return { root, service, db, id: w.id, cleanup };
}

async function runTask(service, id, message, { maxRounds = 12 } = {}) {
  const handle = service.prepare(id, {
    revision: service.get(id).revision,
    message,
    externalConsent: true,
    limits: { maxRounds, timeoutMs: 60_000, maxContextChars: 100_000 },
  });
  return handle;
}

// N3-01 普通问答、零工具:正常回答,不强制生成文件,delivery/outcome 为空。
test("N3-01:普通问答不触发交付检查", async (t) => {
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    complete: async () => answer("血糖偏高的常见原因包括饮食、压力等,具体请咨询医生。"),
  };
  const f = await fixture(t, provider);
  const handle = await runTask(f.service, f.id, "血糖偏高是怎么回事?");
  const result = await f.service.execute(handle);
  assert.equal(result.status, "completed");
  assert.equal("delivery" in result, false);
  assert.equal(result.outcome, undefined);
  const saved = f.service.get(f.id).runs[0];
  assert.equal(saved.delivery, undefined);
  assert.equal(saved.outcome, undefined);
});

// N3-02 要求创建文件,模型只说完成:文件缺失被识别;重试预算耗尽后
// delivery_failed 且缺口持久化;绝不 answered+completed。
test("N3-02:声称已创建但无写入回执 → 重试后 delivery_failed", async (t) => {
  let calls = 0;
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    complete: async () => {
      calls++;
      // 三轮都只口头声称(重试上限 2 次),始终不调用工具。
      return answer(`已创建 report.txt,内容为总结。(${calls})`);
    },
  };
  const f = await fixture(t, provider);
  const handle = await runTask(f.service, f.id, "请创建报告文件 report.txt,内容写“总结”。");
  const result = await f.service.execute(handle);
  assert.equal(result.status, "completed");
  assert.equal(result.delivery.delivered, false);
  assert.equal(result.outcome, "delivery_failed");
  assert.ok(existsSync(join(f.root, "report.txt")) === false, "文件必须真的不存在");
  const gap = result.delivery.gaps.find(
    (g) => g.reason === "claimed_file_missing" || g.reason === "target_not_fulfilled",
  );
  assert.ok(gap, "缺口必须持久化");
  const saved = f.service.get(f.id).runs[0];
  assert.equal(saved.outcome, "delivery_failed");
  assert.ok(saved.delivery.gaps.length >= 1);
  assert.ok(calls >= 3, `重试反馈应发生(实际模型调用 ${calls} 次)`);
});

// N3-03 正确创建并检查文件:delivered,证据对应本次产物哈希。
test("N3-03:真实写入 → delivered 且证据含本次哈希", async (t) => {
  let calls = 0;
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    complete: async () => {
      calls++;
      if (calls === 1)
        return toolCall("w1", "propose_file_write", { path: "report.txt", content: "总结内容v1" });
      return answer("已创建 report.txt。");
    },
  };
  const f = await fixture(t, provider);
  const handle = await runTask(f.service, f.id, "请创建报告文件 report.txt,内容写总结。");
  const result = await f.service.execute(handle);
  assert.equal(result.status, "completed");
  assert.equal(result.delivery.delivered, true);
  assert.equal(result.outcome, "delivered");
  assert.equal(existsSync(join(f.root, "report.txt")), true);
  const receipt = result.delivery.evidence.find((e) => e.source === "file-write");
  assert.ok(receipt, "必须有本次写入回执");
  assert.equal(receipt.hash, await fileHash(join(f.root, "report.txt")));
});

// N3-04 要求两份产物,只完成一份:第一轮缺口被反馈,执行循环补齐后 delivered。
test("N3-04:两份产物先缺一,反馈补齐后 delivered;证据齐全", async (t) => {
  let calls = 0;
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    complete: async () => {
      calls++;
      if (calls === 1)
        return toolCall("w1", "propose_file_write", { path: "报告.txt", content: "报告" });
      if (calls === 2)
        return answer("已创建 报告.txt 和 汇总.txt。");
      if (calls === 3)
        return toolCall("w2", "propose_file_write", { path: "汇总.txt", content: "汇总" });
      return answer("两份文件均已写入。");
    },
  };
  const f = await fixture(t, provider);
  const handle = await runTask(f.service, f.id, "请创建 报告.txt 和 汇总.txt 两份文件。");
  const result = await f.service.execute(handle);
  assert.equal(result.status, "completed");
  assert.equal(result.delivery.delivered, true, JSON.stringify(result.delivery?.gaps || ""));
  assert.equal(result.outcome, "delivered");
  const sources = result.delivery.evidence.filter((e) => e.source === "file-write");
  assert.equal(sources.length, 2);
  assert.ok(calls >= 4, "验证缺口应反馈执行循环补齐");
});

// N3-05 已存在旧文件,模型没执行要求的更新:旧文件不冒充本次完成。
test("N3-05:旧文件存在但本次未更新 → delivery_failed", async (t) => {
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    complete: async () => answer("已更新 report.txt(实际上什么都没做)。"),
  };
  const f = await fixture(t, provider);
  writeFileSync(join(f.root, "report.txt"), "旧内容", "utf8");
  const handle = await runTask(f.service, f.id, "请更新 report.txt,写入新结论。");
  const result = await f.service.execute(handle);
  assert.equal(result.delivery.delivered, false);
  assert.equal(result.outcome, "delivery_failed");
  assert.equal(readFileSync(join(f.root, "report.txt"), "utf8"), "旧内容");
  assert.ok(
    result.delivery.gaps.some((g) => g.reason === "target_not_fulfilled"),
    "旧文件存在不得算本次更新完成",
  );
});

// N3-06 验证器异常:保留明确 unverified 状态,不静默回退成功。
test("N3-06:验证器异常 → unverified 持久化", async (t) => {
  let calls = 0;
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    complete: async () => {
      calls++;
      if (calls === 1)
        return toolCall("w1", "propose_file_write", { path: "report.txt", content: "内容" });
      return answer("已创建 report.txt。");
    },
  };
  const f = await fixture(t, provider);
  const handle = await runTask(f.service, f.id, "请创建报告文件 report.txt。");
  handle.deliveryVerifier = () => {
    throw new Error("证据服务不可用");
  };
  const result = await f.service.execute(handle);
  assert.equal(result.status, "completed");
  assert.equal(result.delivery?.unverified, true);
  assert.equal(result.outcome, "unverified");
  const saved = f.service.get(f.id).runs[0];
  assert.equal(saved.outcome, "unverified");
  assert.ok(saved.delivery.gaps.some((g) => g.reason === "delivery_check_failed"));
});

// N3-07 验证期间取消:最终取消,晚到的成功结论不覆盖状态。
test("N3-07:验证期间取消 → cancelled,不被晚到验证覆盖", async (t) => {
  let calls = 0;
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    complete: async () => {
      calls++;
      if (calls === 1)
        return toolCall("w1", "propose_file_write", { path: "report.txt", content: "内容" });
      return answer("已创建 report.txt。");
    },
  };
  const f = await fixture(t, provider);
  const handle = await runTask(f.service, f.id, "请创建报告文件 report.txt。");
  let resolveEntered;
  const entered = new Promise((r) => (resolveEntered = r));
  handle.deliveryVerifier = async () => {
    resolveEntered();
    await new Promise((r) => setTimeout(r, 250));
    return { delivered: true, evidence: [{ kind: "file", path: "late" }], gaps: [] };
  };
  const execution = f.service.execute(handle);
  await entered;
  handle.controller.abort(new Error("RUN_INTERRUPTED"));
  const result = await execution;
  assert.equal(result.status, "cancelled");
  const saved = f.service.get(f.id).runs[0];
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.outcome, undefined);
  assert.equal(saved.delivery, undefined);
});

// N3-08 服务重启/重载:查询接口看到与事件一致的持久化事实。
test("N3-08:重启后 delivery/outcome 持久可查,publicWorkspace 一致", async () => {
  const root = mkdtempSync(join(tmpdir(), "omw-n3-restart-"));
  const dbFile = join(root, "ws.sqlite");
  let calls = 0;
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    complete: async () => {
      calls++;
      if (calls === 1)
        return toolCall("w1", "propose_file_write", { path: "report.txt", content: "总结" });
      return answer("已创建 report.txt。");
    },
  };
  {
    const db = new WorkspaceDatabase(dbFile);
    const service = new WorkspaceService(db.db, provider);
    const w = service.create({ root, directoryConsent: true });
    service.update(w.id, {
      revision: service.get(w.id).revision,
      profile: "standard",
      allowWrite: true,
      approvalPolicy: "workspace-write",
      autoApplyConsent: true,
    });
    const handle = await runTask(service, w.id, "请创建报告文件 report.txt。");
    const result = await service.execute(handle);
    assert.equal(result.outcome, "delivered");
    await service.extensions.close();
    db.close();
  }
  {
    // 模拟重启:重新打开同一数据库。
    const db = new WorkspaceDatabase(dbFile);
    const service = new WorkspaceService(db.db, provider);
    const w = service.list()[0];
    const run = service.get(w.id).runs[0];
    assert.equal(run.outcome, "delivered");
    assert.equal(run.delivery?.delivered, true);
    const projected = publicWorkspace(service.get(w.id));
    assert.equal(projected.runs[0].delivery?.delivered, true);
    assert.equal(projected.runs[0].outcome, "delivered");
    await service.extensions.close();
    db.close();
  }
  rmSync(root, { recursive: true, force: true });
});

// N3-09 执行中修改要求:按运行事实核对新目标,不沿用旧结论。
test("N3-09:执行中追加修改要求,新写入按事实核对", async (t) => {
  let calls = 0;
  let releaseModel, modelEntered;
  const entered = new Promise((resolve) => { modelEntered = resolve; });
  const release = new Promise((resolve) => { releaseModel = resolve; });
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    complete: async () => {
      calls++;
      if (calls === 1) { modelEntered(); await release; }
      if (calls === 1)
        return toolCall("w1", "propose_file_write", { path: "plan-a.txt", content: "A案" });
      if (calls === 2)
        return toolCall("w2", "propose_file_write", { path: "plan-b.txt", content: "B案" });
      return answer("已按新要求创建 plan-b.txt(并保留了 plan-a.txt)。");
    },
  };
  const f = await fixture(t, provider);
  const handle = await runTask(f.service, f.id, "请创建 plan-a.txt。");
  const execution = f.service.execute(handle);
  // 执行中追加:改要求为创建 plan-b.txt(经 steer 队列)。
  await entered;
  f.service.steer(f.id, {
    runId: handle.run.id,
    externalConsent: true,
    message: "要求变更:再创建 plan-b.txt。",
  });
  releaseModel();
  const result = await execution;
  assert.equal(result.status, "completed");
  assert.equal(result.delivery.delivered, true, JSON.stringify(result.delivery?.gaps || ""));
  const paths = result.delivery.evidence
    .filter((e) => e.source === "file-write")
    .map((e) => e.path.split("/").pop());
  assert.deepEqual(paths.sort(), ["plan-a.txt", "plan-b.txt"]);
});

// 目标/声明提取的确定性单测(判定不依赖模型自评)。
test("scanFileTargets/scanFileClaims 判定边界", () => {
  assert.deepEqual(scanFileTargets("请创建报告文件 report.txt,汇总成 summary.md"), [
    { verb: "创建", file: "report.txt" },
    { verb: "汇总成", file: "summary.md" },
  ]);
  assert.deepEqual(scanFileTargets("对比 a.txt 与 b.txt 哪个更长"), []);
  assert.deepEqual(scanFileTargets("report.txt 里说了什么?"), []);
  assert.equal(scanFileClaims("您可以创建 report.txt 来解决这个问题").length, 0);
  assert.equal(scanFileClaims("请创建 report.txt").length, 0);
  assert.equal(scanFileClaims("已创建 report.txt。").length, 1);
  assert.equal(scanFileClaims("已创建了 report.txt").length, 1);
  assert.equal(scanFileClaims("成功生成 summary.md").length, 1);
  assert.equal(scanFileClaims("未创建 report.txt").length, 0);
});

import { createHash } from "node:crypto";
async function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
