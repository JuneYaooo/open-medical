// N4 医疗交付按目标核对(复核报告 R4 / 任务书 7.3):
// - 全部子任务失败 → 无交付(失败回执仅诊断,不作成功证据)
// - 无关沙箱成功 → 目标仍未完成(动作成功≠任务完成)
// - 有效草稿 → delivered 且标记待复核语义;子任务 completed 但无产物 → 不交付
// - SessionBridge 主医疗入口投影与运行时事实一致
// 全部使用合成脚本模型,无真实患者资料。
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";
import { MedicalRuntime } from "../server/runtime.mjs";
import { SessionBridge } from "../server/session-bridge.mjs";
import { WorkspaceService } from "../server/core/workspace-service.mjs";

const answer = (content) => ({ message: { role: "assistant", content } });
const toolCall = (id, name, args) => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args ?? {}) } }],
  },
});

// 场景1(7.3):全部子任务失败 → 无交付。
test("N4:全部子任务失败时 delivered=false,失败回执只进缺口不进证据", async () => {
  const store = new Store(":memory:");
  try {
    let calls = 0;
    const provider = {
      apiKey: "synthetic",
      model: "synthetic",
      async complete() {
        calls++;
        if (calls === 1)
          return toolCall("call-del-1", "delegate_medical_task", {
            profile: "observations",
            task: "摘录检验数值",
            sourceIds: [],
          });
        if (calls === 2) throw new Error("synthetic-subagent-failure");
        return answer("子任务执行失败,我未能完成检验数值整理。");
      },
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
    assert.equal(result.delivery.delivered, false);
    const gap = result.delivery.gaps.find((g) => g.reason === "subagent_failed");
    assert.ok(gap, "失败子任务必须记录为缺口");
    assert.equal(
      result.delivery.evidence.some((e) => e.source === "subagent"),
      false,
      "失败回执不得进入成功证据",
    );
    assert.equal(result.outcome, "delivery_failed");
    const saved = store.get(session.id).runs[0];
    assert.equal(saved.outcome, "delivery_failed");
  } finally {
    store.close();
  }
});

// 场景2(7.3):无关沙箱成功 → 目标仍未完成。
test("N4:与目标无关的沙箱成功不能当作任务完成", async () => {
  const store = new Store(":memory:");
  try {
    let calls = 0;
    const provider = {
      apiKey: "synthetic",
      model: "synthetic",
      async complete() {
        calls++;
        if (calls === 1)
          return toolCall("call-sb-1", "sandbox_python", { code: "result = 1 + 1" });
        return answer("我运行了一个计算,但没有整理检验数值。");
      },
    };
    const fakeSandbox = {
      status: () => ({ available: true, backend: "test-sandbox" }),
      run: async () => ({ result: 2, backend: "test-sandbox" }),
    };
    const runtime = new MedicalRuntime(store, provider, { sandbox: fakeSandbox });
    const session = store.create({});
    const handle = runtime.prepare(session.id, {
      message: "请整理本次材料的检验数值",
      mode: "model",
      externalConsent: true,
      fileIds: [],
    });
    const result = await runtime.execute(handle);
    assert.equal(result.status, "completed");
    assert.equal(result.delivery.delivered, false);
    assert.ok(
      result.delivery.gaps.some((g) => g.reason === "sandbox_without_deliverable"),
      "沙箱成功必须说明与目标的缺口",
    );
    assert.equal(result.outcome, "delivery_failed");
  } finally {
    store.close();
  }
});

// 场景3(7.3):子任务 completed 但没有产物 → 父目标不视为完成。
test("N4:子任务 completed 但无可核对产物时不交付", async () => {
  const store = new Store(":memory:");
  try {
    let calls = 0;
    const provider = {
      apiKey: "synthetic",
      model: "synthetic",
      async complete() {
        calls++;
        if (calls === 1)
          return toolCall("call-del-2", "delegate_medical_task", {
            profile: "observations",
            task: "摘录检验数值",
            sourceIds: [],
          });
        // 子代理轮:纯文字完成,零产物。
        return answer("子任务文字汇报:完成。");
      }
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
    assert.equal(result.delivery.delivered, false);
    assert.ok(
      result.delivery.gaps.some((g) => g.reason === "no_artifact_deliverable"),
      "completed 子任务无产物必须记为缺口(completed≠父目标完成)",
    );
    assert.equal(result.outcome, "delivery_failed");
  } finally {
    store.close();
  }
});

// 场景4(7.3):有效草稿 → delivered,语义为“已生成待复核”,不是医生已确认。
test("N4:有效结构化草稿交付并携带待复核语义说明", async () => {
  const store = new Store(":memory:");
  try {
    let calls = 0;
    const provider = {
      apiKey: "synthetic",
      model: "synthetic",
      async complete() {
        calls++;
        if (calls === 1)
          return toolCall("call-obs-9", "extract_observations", {});
        return answer("已摘录检验数值,草稿待复核。");
      },
    };
    const runtime = new MedicalRuntime(store, provider, {});
    const session = store.create({});
    const handle = runtime.prepare(session.id, {
      message: "请摘录检验数值:血糖 8.9 mmol/L",
      mode: "model",
      externalConsent: true,
      fileIds: [],
    });
    const result = await runtime.execute(handle);
    assert.equal(result.delivery.delivered, true);
    assert.equal(result.outcome, "delivered");
    assert.match(result.delivery.note || "", /待复核/);
    assert.match(
      result.delivery.note || "",
      /不代表医生已确认/,
      "交付语义必须明确不代表医生已确认",
    );
  } finally {
    store.close();
  }
});

// SessionBridge 主医疗入口:投影必须携带与运行时一致的 delivery/outcome。
test("N4:SessionBridge 投影医疗运行结果与运行时事实一致", async () => {
  const store = new Store(":memory:");
  try {
    let calls = 0;
    const provider = {
      apiKey: "synthetic",
      model: "synthetic",
      async complete() {
        calls++;
        if (calls === 1) return toolCall("call-obs-br", "extract_observations", {});
        return answer("已摘录检验数值。");
      },
    };
    const runtime = new MedicalRuntime(store, provider, {});
    const workspaces = new WorkspaceService(store.db, provider, {});
    const bridge = new SessionBridge(store, runtime, workspaces, {});
    const session = store.create({});
    const handle = runtime.prepare(session.id, {
      message: "请摘录检验数值:血糖 8.9 mmol/L",
      mode: "model",
      externalConsent: true,
      fileIds: [],
    });
    const result = await runtime.execute(handle);
    assert.equal(result.delivery.delivered, true);
    const projected = bridge.project(store.get(session.id));
    const projectedRun = projected.runs.find((r) => r.id === result.runId);
    assert.ok(projectedRun, "投影必须包含该 run");
    assert.equal(projectedRun.delivery?.delivered, true);
    assert.equal(projectedRun.outcome, "delivered");
    // 恢复/重载后同一事实:store 中持久化的 run 携带相同 delivery。
    const persisted = store.get(session.id).runs.find((r) => r.id === result.runId);
    assert.equal(persisted.delivery?.delivered, true);
    assert.equal(persisted.outcome, "delivered");
  } finally {
    store.close();
  }
});
