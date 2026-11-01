import test from "node:test";
import assert from "node:assert/strict";
import { installFakeWeb } from "../helpers/fake-web.mjs";
import { createScriptedProvider, textTurn, toolCall } from "../helpers/scripted-provider.mjs";
import { startTestServer } from "../helpers/server.mjs";

// 委派出去的子任务也要经过外发检索词检查：子任务的工具注册表与父任务
// 走同一套领域配置，患者姓名不能借子任务发到外部网站。
test("患者会话委派子任务：子任务的网页检索同样拦截患者身份", async (t) => {
  const web = installFakeWeb({ results: [{ title: "高血压病例", url: "https://example.org/case", snippet: "病例" }] });
  t.after(() => web.restore());
  let childResult;
  const provider = createScriptedProvider([
    toolCall("delegate_task", { task: "上网查一下这位患者疾病的资料" }, "call_delegate"),
    toolCall("web_search", { query: "示例·张沪生 原发性高血压" }, "call_child_search"),
    ({ messages }) => {
      childResult = messages.find((m) => m.role === "tool" && m.tool_call_id === "call_child_search")?.content;
      return textTurn("子任务：检索词被拦截。");
    },
    textTurn("已汇总。"),
  ]);
  const app = await startTestServer({ provider });
  t.after(() => app.close());
  const patient = (await app.patients()).find((p) => p.name === "示例·张沪生");
  assert.ok(patient);
  const run = await app.request("/api/agent/run", {
    method: "POST",
    body: { sessionId: patient.sessionId, message: "请委派一个子任务上网查一下高血压的最新资料", mode: "model", externalConsent: true },
  });
  assert.equal(run.body.status, "completed", JSON.stringify(run.body));
  assert.ok(provider.calls[0].tools.some((tool) => tool.function.name === "delegate_task"), "父任务应能委派");
  assert.ok(childResult, "子任务应收到 web_search 的结果");
  assert.equal(JSON.parse(childResult).code, "OUTBOUND_PRIVACY", childResult);
  assert.ok(!web.requests.some((url) => url.includes(encodeURIComponent("张沪生"))), "患者姓名不能发出");
});
