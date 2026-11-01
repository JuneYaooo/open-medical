import test from "node:test";
import assert from "node:assert/strict";
import {
  createScriptedProvider,
  textTurn,
  toolCall,
} from "../../../tests/helpers/scripted-provider.mjs";
import { startTestServer } from "../../../tests/helpers/server.mjs";
import { installFakeWeb } from "../../../tests/helpers/fake-web.mjs";

const GUIDE = "https://www.yiigle.com/guide/hypertension-2024";
const OTHER = "https://www.cma.org.cn/never-fetched";
const fakeLiterature = {
  async search() { throw new Error("不应调用"); },
  async fetchArticle() { throw new Error("不应调用"); },
  materialText: () => "",
};
const fakeWeb = () => installFakeWeb({
  results: [
    { title: "中国高血压防治指南", url: GUIDE, snippet: "高血压 指南 降压目标" },
    { title: "高血压 共识", url: OTHER, snippet: "高血压 共识 摘要" },
  ],
  pages: { [GUIDE]: { title: "中国高血压防治指南", text: "一般高血压患者降压目标为低于140/90 mmHg。" } },
});
const runResearch = (app, sessionId, message) => app.request("/api/agent/run", {
  method: "POST",
  body: { sessionId, message, workflow: "literature-research", mode: "model", externalConsent: true },
});

test("文献研究：可用 web_search/web_fetch 检索中文指南，引用已读取网页即通过核验", async (t) => {
  const web = fakeWeb();
  t.after(() => web.restore());
  const provider = createScriptedProvider([
    toolCall("web_search", { query: "高血压 指南 降压目标", domains: ["yiigle.com", "cma.org.cn"] }),
    toolCall("web_fetch", { url: GUIDE }),
    textTurn(`中国指南建议一般高血压患者降压目标低于140/90 mmHg（[中国高血压防治指南](${GUIDE})，指南原文网页）。`),
  ]);
  const app = await startTestServer({ provider, seedDemoPack: false, serverOptions: { literature: fakeLiterature } });
  t.after(() => app.close());
  const session = await app.request("/api/sessions", { method: "POST", body: { title: "文献研究 · 降压目标" } });
  const response = await runResearch(app, session.body.id, "中国指南对高血压降压目标怎么推荐？");
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "completed");
  const tools = provider.calls[0].tools.map((tool) => tool.function.name);
  assert.ok(tools.includes("web_search") && tools.includes("web_fetch") && tools.includes("literature_search"));
  assert.match(provider.calls[0].messages.map((m) => m.role === "system" ? m.content : "").join("\n"), /yiigle\.com/);
  assert.equal(provider.remaining, 0);
});

test("文献研究：引用未读取的网页链接会被打回重写", async (t) => {
  const web = fakeWeb();
  t.after(() => web.restore());
  const provider = createScriptedProvider([
    toolCall("web_search", { query: "高血压 指南 降压目标", domains: ["yiigle.com", "cma.org.cn"] }),
    toolCall("web_fetch", { url: GUIDE }),
    textTurn(`见 [共识](${OTHER}) 与 [指南](${GUIDE})。`),
    textTurn(`依据已读取的 [中国高血压防治指南](${GUIDE})：降压目标低于140/90 mmHg；另有一条共识仅见搜索摘要，未读取原文。`),
  ]);
  const app = await startTestServer({ provider, seedDemoPack: false, serverOptions: { literature: fakeLiterature } });
  t.after(() => app.close());
  const session = await app.request("/api/sessions", { method: "POST", body: { title: "文献研究 · 降压目标" } });
  const response = await runResearch(app, session.body.id, "中国指南对高血压降压目标怎么推荐？");
  assert.equal(response.body.status, "completed");
  assert.equal(provider.calls.length, 4);
  assert.ok(provider.calls[3].messages.some((m) => typeof m.content === "string" && m.content.includes("文献研究核验：")), "未读取网页链接应触发核验提示");
});

test("文献研究：患者会话的外发检索词不得含患者身份", async (t) => {
  const web = fakeWeb();
  t.after(() => web.restore());
  const provider = createScriptedProvider([
    toolCall("literature_search", { queries: ["hypertension Zhang", "示例·张沪生 hypertension"] }, "call_lit"),
    toolCall("web_search", { query: "张沪生 高血压" }, "call_web"),
    toolCall("web_search", { query: "高血压 指南 降压目标", domains: ["yiigle.com"] }, "call_ok"),
    toolCall("web_fetch", { url: GUIDE }),
    textTurn(`据 [中国高血压防治指南](${GUIDE})，一般降压目标低于140/90 mmHg；与该患者的适用性需医生核对。`),
  ]);
  const app = await startTestServer({ provider, serverOptions: { literature: fakeLiterature } });
  t.after(() => app.close());
  const patient = (await app.patients()).find((p) => p.name === "示例·张沪生");
  const response = await runResearch(app, patient.sessionId, "这位患者的降压目标，指南怎么说？");
  assert.equal(response.body.status, "completed");
  assert.equal(provider.remaining, 0);
  const output = (index, id) => JSON.parse(provider.calls[index].messages.find((m) => m.role === "tool" && m.tool_call_id === id).content);
  assert.equal(output(1, "call_lit").code, "OUTBOUND_PRIVACY");
  assert.equal(output(2, "call_web").code, "OUTBOUND_PRIVACY");
  assert.ok(output(3, "call_ok").results.length > 0);
  assert.ok(!web.requests.some((url) => url.includes(encodeURIComponent("张沪生"))));
});
