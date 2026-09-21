// W5 交付证据 seam：AgentRuntime onDelivery 钩子（含异常兼容）、
// 合成脚本模型下的三场景（空口完成 / 真实产物 / 纯问答）、
// 文件证据（存在+可读+哈希）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../server/core/agent-runtime.mjs";
import { ToolRegistry } from "../server/core/tool-registry.mjs";
import { PermissionEngine } from "../server/core/permissions.mjs";
import {
  fileDeliveryEvidence,
  normalizeDelivery,
} from "../server/core/delivery.mjs";
import { Store } from "../server/store.mjs";
import { MedicalRuntime } from "../server/runtime.mjs";

const answer = (content) => ({ message: { role: "assistant", content } });
const permissions = () =>
  new PermissionEngine({ profile: "standard", grants: { "model.external": true } });

test("AgentRuntime delivery seam: hook result is normalized and attached", async () => {
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    complete: async () => answer("已创建文件 report.md"),
  };
  const runtime = new AgentRuntime({ provider });
  const events = [];
  const result = await runtime.run({
    messages: [{ role: "user", content: "创建 report.md" }],
    registry: new ToolRegistry(),
    permissions: permissions(),
    emit: (type, payload) => events.push({ type, payload }),
    onDelivery: () => ({
      delivered: false,
      evidence: [],
      gaps: ["没有任何工具调用产物，文件不存在"],
    }),
  });
  assert.equal(result.delivery.delivered, false);
  // 字符串缺口被归一为结构化条目
  assert.equal(result.delivery.gaps[0].reason, "gap");
  assert.ok(result.delivery.gaps[0].detail.includes("文件不存在"));
  assert.ok(result.delivery.verifiedAt);
  assert.ok(
    events.some((e) => e.type === "delivery.gaps" && e.payload.delivered === false),
  );
});

test("AgentRuntime delivery seam: domain.verifyDelivery supported; failure keeps compat", async () => {
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    complete: async () => answer("完成"),
  };
  const runtime = new AgentRuntime({ provider });
  const base = {
    messages: [{ role: "user", content: "任务" }],
    registry: new ToolRegistry(),
    permissions: permissions(),
    emit: () => {},
  };
  // domain.verifyDelivery 提供交付证据（文件路径+哈希）
  const delivered = await runtime.run({
    ...base,
    domain: {
      verifyDelivery: () => ({
        delivered: true,
        evidence: [{ kind: "file", path: "report.md", hash: "a".repeat(64), readable: true }],
        gaps: [],
      }),
    },
  });
  assert.equal(delivered.delivery.delivered, true);
  assert.equal(delivered.delivery.evidence[0].kind, "file");
  // 检查异常须保留结构化缺口，不能把验证失败当成未请求验证。
  const events = [];
  const unverified = await runtime.run({
    ...base,
    emit: (type, payload) => events.push({ type, payload }),
    domain: {
      verifyDelivery: () => {
        throw new Error("证据服务不可用");
      },
    },
  });
  assert.equal(unverified.delivery.delivered, false);
  assert.equal(unverified.delivery.gaps[0].reason, "delivery_check_failed");
  assert.ok(events.some((e) => e.type === "delivery.unverified"));
  // 无钩子：既有行为完全不变
  const untouched = await runtime.run(base);
  assert.equal("delivery" in untouched, false);
  // 归一器对无效返回返回 null（不产生伪证据）
  assert.equal(normalizeDelivery(null), null);
  assert.equal(normalizeDelivery("done"), null);
  const bare = normalizeDelivery({ delivered: false });
  assert.equal(bare.delivered, false);
  assert.equal(bare.gaps[0].reason, "no_verifiable_output");
});

test("medical runtime: execution task with empty claim gets delivered=false and answered outcome", async () => {
  const store = new Store(":memory:");
  try {
    const provider = {
      apiKey: "synthetic",
      model: "synthetic",
      // 脚本模型：零工具调用，直接宣称已完成（路线文档 §4.2 合成探针）
      complete: async () => answer("已完成，报告文件已创建。"),
    };
    const runtime = new MedicalRuntime(store, provider, {});
    const session = store.create({});
    const handle = runtime.prepare(session.id, {
      message: "请整理本次材料的检验数值",
      mode: "model",
      externalConsent: true,
      fileIds: [],
    });
    const result = await runtime.execute(handle);
    assert.equal(result.status, "completed");
    assert.equal(handle.run.policy.intent, "observations");
    // 状态仍是 completed，但结果分类是 answered（回答而非交付）
    assert.equal(result.delivery.delivered, false);
    assert.equal(result.outcome, "answered");
    assert.ok(
      result.delivery.gaps.some((g) => g.reason === "no_verifiable_output"),
    );
    const saved = store.get(session.id).runs[0];
    assert.equal(saved.status, "completed");
    assert.equal(saved.outcome, "answered");
    assert.equal(saved.delivery.delivered, false);
    assert.equal(store.get(session.id).messages.at(-1).outcome, "answered");
    // 事件流包含缺口事实与完成分类
    const log = store.eventLog(session.id);
    assert.ok(log.some((e) => e.type === "delivery.gaps"));
    const complete = log.find((e) => e.type === "message.complete");
    assert.equal(complete.payload.delivery.delivered, false);
    // 旧字段语义未变：publicSession 投影保留原 status 并携带派生字段
    const projected = store.get(session.id);
    assert.equal(projected.runs[0].status, "completed");
    assert.equal(projected.runs[0].outcome, "answered");
  } finally {
    store.close();
  }
});

test("medical runtime: real tool artifact delivers with runtime evidence hash", async () => {
  const store = new Store(":memory:");
  try {
    let calls = 0;
    const provider = {
      apiKey: "synthetic",
      model: "synthetic",
      async complete() {
        calls++;
        if (calls === 1)
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-obs",
                  function: {
                    name: "extract_observations",
                    arguments: "{}",
                  },
                },
              ],
            },
          };
        return answer("已摘录检验数值，请复核。");
      },
    };
    const runtime = new MedicalRuntime(store, provider, {});
    const session = store.create({});
    const handle = runtime.prepare(session.id, {
      message: "请摘录检验数值：血糖 8.9 mmol/L，血红蛋白 105 g/L",
      mode: "model",
      externalConsent: true,
      fileIds: [],
    });
    const result = await runtime.execute(handle);
    assert.equal(result.status, "completed");
    assert.equal(result.delivery.delivered, true);
    assert.equal(result.outcome, "delivered");
    assert.equal(result.delivery.gaps.length, 0);
    // 证据来自运行时事实：产物回执（含内容哈希）
    const artifactReceipt = result.delivery.evidence.find(
      (e) => e.source === "artifact",
    );
    assert.ok(artifactReceipt, "artifact receipt evidence expected");
    assert.ok(artifactReceipt.artifactId);
    assert.match(artifactReceipt.hash, /^[0-9a-f]{64}$/);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].id, artifactReceipt.artifactId);
    const log = store.eventLog(session.id);
    assert.ok(log.some((e) => e.type === "delivery.verified"));
  } finally {
    store.close();
  }
});

test("medical runtime: pure consultation is not subject to delivery checks", async () => {
  const store = new Store(":memory:");
  try {
    const provider = {
      apiKey: "synthetic",
      model: "synthetic",
      complete: async () => answer("血糖偏高时请结合复诊结果判断。"),
    };
    const runtime = new MedicalRuntime(store, provider, {});
    const session = store.create({});
    const handle = runtime.prepare(session.id, {
      message: "血糖偏高怎么办？",
      mode: "model",
      externalConsent: true,
      fileIds: [],
    });
    assert.equal(handle.run.policy.intent, "consultation");
    const result = await runtime.execute(handle);
    assert.equal(result.status, "completed");
    assert.equal("delivery" in result, false);
    assert.equal(result.outcome, undefined);
    const saved = store.get(session.id).runs[0];
    assert.equal(saved.delivery, undefined);
    assert.equal(saved.outcome, undefined);
    assert.ok(!store.eventLog(session.id).some((e) => e.type.startsWith("delivery.")));
  } finally {
    store.close();
  }
});

test("file delivery evidence verifies existence, readability and content hash", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omw-delivery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "report.md");
  writeFileSync(file, "# 交付内容\n", "utf8");
  const evidence = await fileDeliveryEvidence(file);
  assert.equal(evidence.readable, true);
  assert.equal(evidence.bytes, Buffer.byteLength("# 交付内容\n"));
  assert.equal(
    evidence.hash,
    createHash("sha256").update("# 交付内容\n").digest("hex"),
  );
  // 文件不存在 → 缺口事实，而不是伪证据
  const missing = await fileDeliveryEvidence(join(dir, "absent.md"));
  assert.equal(missing.gap, "not_found");
  assert.equal(missing.readable, undefined);
  // 验证后内容被改：重新核对话术不同但哈希事实由调用方比对（此处验证
  // 哈希确实随内容变化）
  writeFileSync(file, "# 被篡改\n", "utf8");
  const changed = await fileDeliveryEvidence(file);
  assert.notEqual(changed.hash, evidence.hash);
});
