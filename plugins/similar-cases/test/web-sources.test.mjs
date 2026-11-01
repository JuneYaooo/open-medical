import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  createScriptedProvider,
  toolCall,
} from "../../../tests/helpers/scripted-provider.mjs";
import { startTestServer } from "../../../tests/helpers/server.mjs";
import { installFakeWeb } from "../../../tests/helpers/fake-web.mjs";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));
const WECHAT = "https://mp.weixin.qq.com/s/case-abc";
const YIIGLE = "https://www.yiigle.com/case/12345";
const PAGE_TEXT = "患者男，68岁，原发性高血压病史十年，长期服用氨氯地平，血压控制尚可。";
const unknownRows = ["disease", "stage", "treatment", "medications", "demographics"].map((dimension) => ({
  dimension, current: "", currentQuote: "", candidate: "", candidateQuote: "", relation: "unknown", reason: "待核对",
}));
const item = (reference, extra = {}) => ({ reference, reason: "同为原发性高血压", differences: "其余待核对", comparison: unknownRows, ...extra });
const toolOutput = (provider, callIndex, id) => {
  const message = provider.calls[callIndex].messages.find((m) => m.role === "tool" && m.tool_call_id === id);
  assert.ok(message, `第 ${callIndex + 1} 次模型调用应带有 ${id} 的结果`);
  return JSON.parse(message.content);
};

test("相似病例：网页候选须来自本轮搜索/读取，引文须出自已读取网页，外发检索词经隐私闸门", async (t) => {
  const web = installFakeWeb({
    results: [
      { title: "原发性高血压病例报告一例", url: WECHAT, snippet: "原发性高血压 病例报告 公众号" },
      { title: "原发性高血压病例报告（中华医学期刊网）", url: YIIGLE, snippet: "原发性高血压 病例报告 摘要" },
    ],
    pages: { [WECHAT]: { title: "原发性高血压病例报告一例", text: PAGE_TEXT } },
  });
  t.after(() => web.restore());
  const provider = createScriptedProvider([
    toolCall("web_search", { query: "张沪生 原发性高血压", domains: ["mp.weixin.qq.com"] }, "call_name"),
    toolCall("web_search", { query: "原发性高血压 病例 2024-03-05" }, "call_date"),
    toolCall("web_search", { query: "高血压 13812345678" }, "call_phone"),
    toolCall("web_search", { query: "原发性高血压 病例报告", domains: ["mp.weixin.qq.com", "yiigle.com"] }, "call_search"),
    toolCall("finish_similar_case_search", { summary: "s", items: [item(YIIGLE, { quote: "原发性高血压" })], limitations: [] }, "call_unfetched_quote"),
    toolCall("web_fetch", { url: WECHAT }, "call_fetch"),
    toolCall("finish_similar_case_search", { summary: "s", items: [item(WECHAT, { quote: "患者女，45岁，继发性高血压" })], limitations: [] }, "call_bad_quote"),
    toolCall("finish_similar_case_search", { summary: "s", items: [item("https://example.com/not-searched")], limitations: [] }, "call_unknown_ref"),
    toolCall("finish_similar_case_search", {
      summary: "找到两条中文网页线索，均需核对。",
      items: [item(`${WECHAT}#top`, { quote: "原发性高血压病史十年，长期服用氨氯地平" }), item(YIIGLE), item(WECHAT)],
      limitations: [],
    }, "call_finish"),
  ]);
  const app = await startTestServer({ provider, serverOptions: { pluginDirs: [PLUGIN_DIR] } });
  t.after(() => app.close());
  const patient = (await app.patients()).find((p) => p.name === "示例·张沪生");
  assert.ok(patient);

  const response = await app.request("/api/agent/run", {
    method: "POST",
    body: { sessionId: patient.sessionId, message: "请查找这位患者的相似病例", mode: "model", externalConsent: true },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "completed");

  const tools = provider.calls[0].tools.map((tool) => tool.function.name);
  assert.ok(tools.includes("web_search") && tools.includes("web_fetch"), "网上范围应提供 web_search / web_fetch");
  assert.ok(!tools.includes("browser_open"), "相似病例工作流不开放浏览器工具");

  for (const [index, id] of [[1, "call_name"], [2, "call_date"], [3, "call_phone"]]) {
    const output = toolOutput(provider, index, id);
    assert.equal(output.code, "OUTBOUND_PRIVACY", id);
    assert.match(output.error, /脱敏医学关键词/);
  }
  assert.ok(!web.requests.some((url) => /%E5%BC%A0%E6%B2%AA%E7%94%9F|2024-03-05|13812345678/.test(url)), "被拒的检索词不能发出");
  assert.equal(toolOutput(provider, 4, "call_search").results.length, 2);
  assert.equal(toolOutput(provider, 5, "call_unfetched_quote").code, "CASE_QUOTE");
  assert.match(toolOutput(provider, 7, "call_bad_quote").code, /CASE_QUOTE/);
  assert.equal(toolOutput(provider, 8, "call_unknown_ref").code, "CASE_REFERENCE");

  const detail = (await app.request(`/api/sessions/${patient.sessionId}`)).body;
  const run = detail.runs.find((r) => r.id === response.body.runId);
  const artifact = run.artifacts.find((a) => a.type === "similar_cases");
  assert.ok(artifact);
  assert.equal(artifact.cases.length, 2, "同一网址（含 #片段）只保留一条");
  const [page, snippet] = artifact.cases;
  assert.equal(page.reference, WECHAT);
  assert.equal(page.url, WECHAT);
  assert.equal(page.evidence.type, "webpage");
  assert.match(page.evidence.text, /氨氯地平/);
  assert.equal(page.sourceSite, "微信公众号文章");
  assert.equal(page.lowerGrade, true);
  assert.match(page.scope, /网页原文已读取/);
  assert.equal(snippet.reference, YIIGLE);
  assert.equal(snippet.evidence.type, "search-snippet");
  assert.equal(snippet.sourceSite, "中华医学期刊网");
  assert.match(snippet.scope, /仅搜索摘要/);
  assert.ok(!snippet.quote);
  assert.ok(artifact.searches.some((s) => s.requestedSource === "web" && s.status === "ok"));
  assert.ok(artifact.limitations.some((line) => /仅有搜索摘要/.test(line)));
  assert.ok(artifact.limitations.some((line) => /未经同行评审/.test(line)));
  const answer = detail.messages.findLast((m) => m.role === "assistant")?.content || "";
  assert.match(answer, /\[原发性高血压病例报告一例\]\(https:\/\/mp\.weixin\.qq\.com\/s\/case-abc\)/);
  assert.match(answer, /来源：微信公众号文章 · 非同行评审，证据等级较低/);
  assert.match(answer, /中文网页检索 1 次/);
});

test("相似病例：仅本地检索时不提供网页工具", async (t) => {
  const provider = createScriptedProvider([
    toolCall("similar_case_search", { caseText: "原发性高血压", diagnosis: "原发性高血压", limit: 3 }),
    toolCall("finish_similar_case_search", { summary: "仅本地。", items: [], limitations: [] }),
  ]);
  const app = await startTestServer({ provider, serverOptions: { pluginDirs: [PLUGIN_DIR] } });
  t.after(() => app.close());
  const patient = (await app.patients()).find((p) => p.name === "示例·张沪生");
  const response = await app.request("/api/agent/run", {
    method: "POST",
    body: { sessionId: patient.sessionId, message: "请查找这位患者的相似病例，仅本地检索", mode: "model", externalConsent: true },
  });
  assert.equal(response.body.status, "completed");
  const tools = provider.calls[0].tools.map((tool) => tool.function.name);
  for (const name of ["web_search", "web_fetch", "online_case_search", "literature_fetch"]) assert.ok(!tools.includes(name), name);
});
