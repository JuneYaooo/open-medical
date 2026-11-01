import test from "node:test";
import assert from "node:assert/strict";
import { createScriptedProvider } from "../../../tests/helpers/scripted-provider.mjs";
import { startTestServer } from "../../../tests/helpers/server.mjs";

test("feishu-knowledge-bot：设置接口来自插件，停用后接口与面板贡献一起消失", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]) });
  t.after(() => app.close());

  const settings = await app.request("/api/knowledge-bot");
  assert.equal(settings.status, 200);
  assert.equal(typeof settings.body.revision, "number");
  assert.deepEqual(settings.body.collections, []);
  assert.ok(Array.isArray(settings.body.availableCollections));
  assert.equal(typeof settings.body.feishuBinding, "object");
  assert.equal(settings.body.persona.useHabits, true);
  assert.equal(settings.body.collectionScope, "all-except-excluded");

  // 分身会话记录 and insights routes come from the same plugin API.
  const conversations = await app.request("/api/knowledge-bot/conversations?filter=attention");
  assert.equal(conversations.status, 200);
  assert.deepEqual(conversations.body.conversations, []);
  assert.equal((await app.request("/api/knowledge-bot/insights")).status, 200);
  assert.equal(
    (await app.request("/api/knowledge-bot/conversations/oc_missing")).status,
    409,
    "未连接时查看单个会话返回未配置",
  );

  const bootstrap = await app.request("/api/bootstrap");
  const plugin = bootstrap.body.plugins.find(
    (item) => item.id === "feishu-knowledge-bot",
  );
  assert.equal(plugin.status, "ready");

  const disabled = await app.request("/api/plugins/feishu-knowledge-bot", {
    method: "PUT",
    body: { enabled: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.plugin.status, "disabled");

  assert.equal((await app.request("/api/knowledge-bot")).status, 404);
  assert.equal((await app.request("/api/knowledge-bot/conversations")).status, 404);
  assert.equal(
    (await app.request("/api/knowledge-bot/feishu-binding", { method: "POST" }))
      .status,
    404,
  );
  // Disabling one optional plugin never breaks the rest of the shell.
  assert.equal((await app.request("/api/doctor/overview")).status, 200);
  assert.equal((await app.request("/api/patients")).status, 200);

  const enabled = await app.request("/api/plugins/feishu-knowledge-bot", {
    method: "PUT",
    body: { enabled: true },
  });
  assert.equal(enabled.status, 200);
  assert.equal((await app.request("/api/knowledge-bot")).status, 200);
});
