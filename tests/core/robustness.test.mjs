import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { sqliteTransaction } from "../../server/sqlite-transaction.mjs";
import { WorkspaceStore } from "../../server/core/workspace-store.mjs";
import { ToolRegistry } from "../../server/core/tool-registry.mjs";
import { createScriptedProvider } from "../helpers/scripted-provider.mjs";
import { startTestServer } from "../helpers/server.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("事务：SQLite 已自行回滚时保留原始错误", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (v INTEGER)");
  assert.throws(
    () =>
      sqliteTransaction(db, () => {
        db.exec("INSERT INTO t VALUES (1)");
        db.exec("ROLLBACK");
        throw new Error("原始错误");
      }),
    /原始错误/,
  );
  assert.equal(db.isTransaction, false);
});

test("删除工作区：连同上下文归档与运行历史一起删除，且旧残留在启动时清理", () => {
  const db = new DatabaseSync(":memory:");
  const store = new WorkspaceStore(db);
  const w = store.create({ title: "临时" });
  db.prepare("INSERT INTO agent_context_archives VALUES (?,?,?,?,?,?,?)").run("a1", w.id, "r1", "x", "x", "h", "{}");
  db.prepare("INSERT INTO agent_run_history(workspace_id,run_id,request_id,authority,identity,data,messages) VALUES (?,?,?,?,?,?,?)").run(w.id, "r1", "q", "x", "x", "{}", "[]");
  store.remove(w.id);
  for (const table of ["agent_context_archives", "agent_run_history", "agent_events", "agent_trace"])
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);

  db.prepare("INSERT INTO agent_context_archives VALUES (?,?,?,?,?,?,?)").run("a2", "gone", "r1", "x", "x", "h", "{}");
  new WorkspaceStore(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_context_archives").get().n, 0);
});

test("工作区列表：单条损坏数据不阻断启动", () => {
  const db = new DatabaseSync(":memory:");
  const store = new WorkspaceStore(db);
  store.create({ title: "正常" });
  db.prepare("INSERT INTO agent_workspaces VALUES (?,?)").run("bad", "{not json");
  assert.equal(new WorkspaceStore(db).list().length, 1);
});

test("工具不响应取消信号时，运行仍能在取消后结束", async () => {
  const registry = new ToolRegistry([
    {
      definition: { type: "function", function: { name: "hang", description: "", parameters: { type: "object", properties: {}, additionalProperties: false } } },
      execute: () => new Promise(() => {}),
      permission: "tools.execute",
    },
  ]);
  const controller = new AbortController();
  const permissions = { require() {}, allows: () => true, has: () => true };
  const pending = registry.execute("hang", {}, { signal: controller.signal }, permissions);
  setTimeout(() => controller.abort(new Error("已取消")), 10);
  await assert.rejects(pending, /已取消/);
});

test("检验导入确认后自动计算风险预警；删除患者清除其待确认提案", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]) });
  t.after(() => app.close());
  const [patient] = await app.patients();
  const text = ["姓名,项目,数值,单位,日期", `${patient.name},血钾,6.8,mmol/L,2024-05-20`].join("\n");
  const preview = await app.request("/api/patients/lab-import/preview", { method: "POST", body: { text } });
  const commit = await app.request("/api/patients/lab-import/commit", {
    method: "POST",
    body: { text, selectedRows: [preview.body.rows[0].row], fingerprint: preview.body.fingerprint, requestId: "robust-k" },
  });
  assert.equal(commit.status, 201);
  const confirmed = await app.request(`/api/pending-actions/${commit.body.proposals[0].id}/confirm`, { method: "POST", body: {} });
  assert.equal(confirmed.status, 200);
  await wait(20);
  const alerts = await app.request(`/api/risk-alerts?patientId=${patient.id}`);
  assert.ok(alerts.body.alerts.some((a) => a.ruleKey === "lab_potassium_high"), "确认高钾检验后应出现危急预警");

  // A second proposal left pending must not survive the patient.
  const again = await app.request("/api/patients/lab-import/commit", {
    method: "POST",
    body: { text, selectedRows: [preview.body.rows[0].row], fingerprint: preview.body.fingerprint, requestId: "robust-k2" },
  });
  if (again.status === 201 && again.body.proposals.length) {
    const removed = await app.request(`/api/patients/${patient.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const left = app.server.store.db.prepare("SELECT COUNT(*) n FROM pending_actions WHERE patient_id=?").get(patient.id).n;
    assert.equal(left, 0);
  }
});

test("请求体：可选请求体为空时视为 {}，JSON 损坏时报错而不是静默确认", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]) });
  t.after(() => app.close());
  const response = await fetch(`${app.url}/api/pending-actions/missing/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Medical-Token": app.token, Origin: app.url },
    body: "{bad",
  });
  assert.equal(response.status, 400);
});

test("单实例锁：同一数据库不能被打开两次；进程被强杀后可立即重新打开", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { Store } = await import("../../server/store.mjs");
  const dir = mkdtempSync(join(tmpdir(), "om-lock-"));
  const file = join(dir, "m.sqlite");
  try {
    const first = new Store(file);
    assert.throws(() => new Store(file), (error) => error.code === "DATABASE_LOCK");
    first.close();
    new Store(file).close();

    const storeUrl = new URL("../../server/store.mjs", import.meta.url).href;
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e",
      `import { Store } from ${JSON.stringify(storeUrl)}; new Store(${JSON.stringify(file)}); console.log("ready"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => { if (String(chunk).includes("ready")) resolve(); });
      child.on("exit", () => reject(new Error("子进程提前退出")));
    });
    assert.throws(() => new Store(file), (error) => error.code === "DATABASE_LOCK");
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
    new Store(file).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("工作区检查点：同组只保留最近一个已完成 run 的上下文，数据量随轮数线性增长", async () => {
  const { pruneStaleContexts } = await import("../../server/core/workspace-store.mjs");
  const context = (n) => Array.from({ length: n }, (_, i) => ({ role: "user", content: `第 ${i} 轮` }));
  const runs = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, status: "completed", authority: "a", contextIdentity: "c", contextMessages: context(i + 1), runtimeState: {} }));
  runs.push({ id: "other", status: "completed", authority: "b", contextIdentity: "c", contextMessages: context(3) });
  runs.push({ id: "latest", status: "interrupted", authority: "a", contextIdentity: "c", contextMessages: context(60), resumeOnRestart: true });
  const workspace = { runs };
  pruneStaleContexts(workspace);
  const kept = workspace.runs.filter((r) => r.contextMessages).map((r) => r.id);
  // Latest completed of group a, latest of group b, and the resumable last run.
  assert.deepEqual(kept, ["r49", "other", "latest"]);
  assert.equal(workspace.runs[0].runtimeState, undefined);
});

test("后台失败进入今日待办工作栏：每日提醒发送失败", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]) });
  t.after(() => app.close());
  const day = new Date().toISOString().slice(0, 10);
  app.server.store.db.prepare("INSERT INTO doctor_notification_deliveries VALUES (?,?,?,?)")
    .run("wechat", "c1", day, JSON.stringify({ id: "d1", status: "failed", message: "连接已失效", at: Date.now() }));
  const overview = await app.request("/api/doctor/overview?limit=100");
  assert.equal(overview.status, 200);
  assert.ok(overview.body.work.items.some((item) => item.id === `notification:wechat:${day}`), "发送失败应出现在工作栏");
  assert.ok(!overview.body.kinds.some((k) => k.kind === "notification-failure"), "不应新增待办分类");
});
