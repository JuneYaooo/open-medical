// W4 状态与事件统一：单一 deriveRunStatus/转移守卫、恢复一致性、
// 桥接复用同一判定、重复请求不重复执行的回归锚点。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRunTransition,
  deriveRunStatus,
  waitingReasonFor,
} from "../server/core/run-status.mjs";
import { Store } from "../server/store.mjs";
import { publicSession } from "../server/runtime.mjs";
import { SessionBridge } from "../server/session-bridge.mjs";
import { WorkspaceDatabase, WorkspaceService } from "../server/core/index.mjs";

test("deriveRunStatus maps durable facts to the unified state vocabulary", () => {
  assert.equal(deriveRunStatus({ status: "queued" }), "queued");
  assert.equal(deriveRunStatus({ status: "running" }), "running");
  assert.equal(deriveRunStatus({ status: "completed" }), "completed");
  assert.equal(deriveRunStatus({ status: "cancelled" }), "cancelled");
  assert.equal(deriveRunStatus({ status: "failed" }), "failed");
  // 等待审批：该 run 关联的 pending 审批是持久事实
  assert.equal(
    deriveRunStatus({ status: "running" }, { pendingApprovals: 1 }),
    "waiting_approval",
  );
  assert.equal(
    deriveRunStatus({ status: "running" }, { pendingApprovals: 0 }),
    "running",
  );
  // 等待输入：只有持久事实 run.awaitingInput 才能触发（当前无写入方）
  assert.equal(deriveRunStatus({ status: "running", awaitingInput: true }), "waiting_input");
  assert.equal(
    deriveRunStatus({ status: "running" }, { awaitingInput: true }),
    "waiting_input",
  );
  // 受阻：重启中断且恢复被挡；或运行记录没有活跃执行体
  assert.equal(deriveRunStatus({ status: "interrupted", recoveryBlocked: "授权已变化" }), "blocked");
  assert.equal(
    deriveRunStatus({ status: "interrupted" }, { recoveryBlocked: "x" }),
    "blocked",
  );
  assert.equal(deriveRunStatus({ status: "interrupted" }), "interrupted");
  assert.equal(
    deriveRunStatus({ status: "running" }, { active: false }),
    "blocked",
  );
  assert.equal(deriveRunStatus({ status: "running" }, { active: true }), "running");
  // 等待原因与状态同源
  assert.equal(
    waitingReasonFor({ status: "running" }, { pendingApprovals: 2 }),
    "approval",
  );
  assert.equal(waitingReasonFor({ status: "running", awaitingInput: true }), "input");
  assert.equal(
    waitingReasonFor({ status: "interrupted", recoveryBlocked: "已达到上限" }),
    "已达到上限",
  );
  assert.equal(waitingReasonFor({ status: "completed" }), null);
});

test("assertRunTransition allows legal transitions and rejects illegal ones", () => {
  // 合法：初始写入、正常生命周期、恢复与取消
  assert.equal(assertRunTransition(undefined, "running"), "running");
  assert.equal(assertRunTransition(undefined, "queued"), "queued");
  assert.equal(assertRunTransition("queued", "running"), "running");
  assert.equal(assertRunTransition("running", "completed"), "completed");
  assert.equal(assertRunTransition("running", "cancelled"), "cancelled");
  assert.equal(assertRunTransition("running", "failed"), "failed");
  assert.equal(assertRunTransition("running", "waiting_approval"), "waiting_approval");
  assert.equal(assertRunTransition("waiting_approval", "running"), "running");
  assert.equal(assertRunTransition("interrupted", "running"), "running");
  assert.equal(assertRunTransition("interrupted", "cancelled"), "cancelled");
  // 幂等重写放行
  assert.equal(assertRunTransition("completed", "completed"), "completed");
  // 非法：终态离开、跨终态、未知状态、非法初始
  assert.throws(() => assertRunTransition("completed", "running"), /非法状态转移/);
  assert.throws(() => assertRunTransition("failed", "completed"), /非法状态转移/);
  assert.throws(() => assertRunTransition("cancelled", "failed"), /非法状态转移/);
  assert.throws(() => assertRunTransition("running", "queued"), /非法状态转移/);
  assert.throws(() => assertRunTransition(undefined, "completed"), /queued 或 running/);
  assert.throws(() => assertRunTransition("paused", "running"), /未知运行状态/);
  assert.throws(() => assertRunTransition("running", "paused"), /未知运行状态/);
});

test("legacy store restart marks running as interrupted; derived status stays consistent", () => {
  const dir = mkdtempSync(join(tmpdir(), "omw-runstatus-legacy-"));
  try {
    const file = join(dir, "legacy.sqlite");
    const store = new Store(file);
    const session = store.create({});
    store.mutate(session.id, (s) => {
      s.runs.push({
        id: "r1",
        requestId: "q1",
        status: "running",
        startedAt: new Date().toISOString(),
        events: [],
        artifacts: [],
        children: [],
      });
    });
    store.close();
    // 模拟服务重启：Store 构造器把 running 改写为 interrupted（既有语义）
    const reopened = new Store(file);
    const saved = reopened.get(session.id).runs[0];
    assert.equal(saved.status, "interrupted");
    assert.equal(deriveRunStatus(saved), "interrupted");
    assert.equal(waitingReasonFor(saved), null);
    // 恢复被挡（如授权变化/次数用尽）→ blocked，等待原因来自持久事实
    reopened.mutate(session.id, (s) => {
      s.runs[0].recoveryBlocked = "已达到 3 次自动恢复上限";
    });
    const blocked = reopened.get(session.id).runs[0];
    assert.equal(deriveRunStatus(blocked), "blocked");
    assert.equal(waitingReasonFor(blocked), "已达到 3 次自动恢复上限");
    // publicSession 投影携带派生字段，status 原值不变
    const projected = publicSession(reopened.get(session.id));
    assert.equal(projected.runs[0].status, "interrupted");
    assert.equal(projected.runs[0].derivedStatus, "blocked");
    assert.equal(projected.runs[0].waitingReason, "已达到 3 次自动恢复上限");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session bridge reuses deriveRunStatus instead of a second judgment", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omw-runstatus-ws-"));
  const db = new WorkspaceDatabase(":memory:");
  const service = new WorkspaceService(db.db, {
    apiKey: "synthetic",
    model: "test",
    complete: async () => ({ message: { role: "assistant", content: "ok" } }),
  });
  // 关闭钩子先注册（先执行），目录清理后注册（后执行），避免 Windows EPERM。
  t.after(async () => {
    await service.extensions.close();
    db.close();
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bridge = new SessionBridge(new Store(":memory:"), {}, service, {
    sessionsRoot: dir,
  });
  const w = service.create({ root: dir, directoryConsent: true, kind: "session" });
  service.store.update(w.id, (current) => {
    current.runs.push(
      {
        id: "run-wait",
        requestId: "q1",
        status: "running",
        startedAt: Date.now(),
        partial: "",
        usage: {},
      },
      {
        id: "run-done",
        requestId: "q2",
        status: "completed",
        startedAt: Date.now(),
        endedAt: Date.now(),
        partial: "文本",
        usage: {},
        delivery: { delivered: true, evidence: [], gaps: [] },
        outcome: "delivered",
      },
    );
    current.approvals.push({
      id: "ap-1",
      runId: "run-wait",
      status: "pending",
      path: "report.md",
    });
  });
  const projected = bridge.project(service.store.get(w.id));
  assert.equal(projected.runs.length, 2);
  const waiting = projected.runs.find((r) => r.id === "run-wait");
  // pending 审批是持久事实 → waiting_approval；等待原因 approval
  assert.equal(waiting.status, "running");
  assert.equal(waiting.derivedStatus, "waiting_approval");
  assert.equal(waiting.waitingReason, "approval");
  const done = projected.runs.find((r) => r.id === "run-done");
  assert.equal(done.derivedStatus, "completed");
  assert.equal(done.waitingReason, undefined);
  // W5 的 delivery/outcome 原样投影（新增字段，不改变既有键）
  assert.equal(done.delivery.delivered, true);
  assert.equal(done.outcome, "delivered");
  // 审批处理完：同一持久记录推导回 running（需该 run 仍是活跃执行；
  // 没有 pending 事实、没有活跃执行体的 running 记录按孤儿推导为 blocked）
  const activeHandle = { run: { id: "run-wait" } };
  service.active.set(w.id, activeHandle);
  service.store.update(w.id, (current) => {
    current.approvals.find((a) => a.id === "ap-1").status = "applied";
  });
  const after = bridge.project(service.store.get(w.id));
  assert.equal(
    after.runs.find((r) => r.id === "run-wait").derivedStatus,
    "running",
  );
  // 活跃执行体消失但记录仍是 running → blocked（事实：无执行体）
  service.active.delete(w.id);
  const orphan = bridge.project(service.store.get(w.id));
  assert.equal(
    orphan.runs.find((r) => r.id === "run-wait").derivedStatus,
    "blocked",
  );
});

test("duplicate requests are rejected instead of re-executing a run", async () => {
  const store = new Store(":memory:");
  try {
    const provider = {
      apiKey: "synthetic",
      model: "synthetic",
      complete: async () => ({ message: { role: "assistant", content: "x" } }),
    };
    const { MedicalRuntime } = await import("../server/runtime.mjs");
    const runtime = new MedicalRuntime(store, provider, {});
    const session = store.create({});
    const handle = runtime.prepare(session.id, {
      message: "整理",
      mode: "local",
      requestId: "dup-1",
    });
    await runtime.execute(handle);
    // 同一 requestId 再提交：拒绝（事件/副作用不会重复执行）
    assert.throws(
      () =>
        runtime.prepare(session.id, {
          message: "整理",
          mode: "local",
          requestId: "dup-1",
        }),
      { code: "DUPLICATE_REQUEST" },
    );
    // 事件日志按 id 游标只读补发，重复读取返回相同事实（不重复执行）
    store.appendEvent({
      seq: 1,
      type: "message.start",
      session_id: session.id,
      run_id: "r-synthetic",
      payload: {},
      time: new Date().toISOString(),
    });
    const first = store.eventLog(session.id);
    const mine = first.filter((e) => e.run_id === "r-synthetic");
    assert.equal(mine.length, 1);
    const again = store.eventLog(session.id, { after: 0 });
    assert.deepEqual(first, again);
    const tail = store.eventLog(session.id, { after: first.at(-1).id });
    assert.equal(tail.length, 0);
  } finally {
    store.close();
  }
});
