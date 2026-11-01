import test from "node:test";
import assert from "node:assert/strict";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptedProvider } from "../helpers/scripted-provider.mjs";
import { startTestServer } from "../helpers/server.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures/plugins", import.meta.url));
const HELLO = join(FIXTURES, "hello");
const NEEDS_MISSING = join(FIXTURES, "needs-missing");

test("MEDICAL_PLUGIN_DIRS 按 path.delimiter 追加到默认 plugins/ 目录，并进入 bootstrap", async (t) => {
  const previous = process.env.MEDICAL_PLUGIN_DIRS;
  process.env.MEDICAL_PLUGIN_DIRS = [HELLO, NEEDS_MISSING].join(delimiter);
  t.after(() => {
    if (previous === undefined) delete process.env.MEDICAL_PLUGIN_DIRS;
    else process.env.MEDICAL_PLUGIN_DIRS = previous;
  });

  const app = await startTestServer({
    provider: createScriptedProvider([]),
  });
  t.after(() => app.close());

  assert.equal(
    app.server.pluginHost.pluginDirs[0],
    resolve(ROOT, "plugins"),
    "默认 plugins/ 目录必须排在环境变量目录之前",
  );
  assert.deepEqual(app.server.pluginHost.pluginDirs.slice(1), [
    HELLO,
    NEEDS_MISSING,
  ]);

  const bootstrap = await app.request("/api/bootstrap");
  assert.equal(bootstrap.status, 200);
  assert.ok(Array.isArray(bootstrap.body.plugins), "bootstrap 必须返回 plugins");
  const byId = Object.fromEntries(
    bootstrap.body.plugins.map((plugin) => [plugin.id, plugin]),
  );
  assert.equal(byId.hello.status, "disabled");
  assert.equal(byId["needs-missing"].status, "unavailable");
  assert.equal(byId.channel.status, "ready");
  assert.equal(byId["channel-wecom"].status, "ready");
  assert.equal(byId["channel-wechat"].status, "ready");
  assert.equal(byId.followup.status, "ready");
  assert.equal(byId.learning.status, "ready");
  assert.equal(byId.literature.status, "ready");
  assert.equal(byId["research-stats"].status, "ready");
  assert.equal(byId["clinical-ref"].status, "ready");
  assert.equal(byId.drg.status, "ready");
  assert.equal(byId["similar-cases"].status, "ready");
  assert.equal(byId["care-tasks"].status, "ready");
  assert.equal(byId["risk-rules"].status, "ready");
  assert.equal(byId.trials.status, "ready");

  const list = await app.request("/api/plugins");
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.body.plugins.map((plugin) => plugin.id),
    [
      "care-packs",
      "care-tasks",
      "channel",
      "channel-wechat",
      "channel-wecom",
      "clinical-ref",
      "doctor-notifications",
      "drg",
      "feishu-knowledge-bot",
      "followup",
      "hello",
      "learning",
      "literature",
      "needs-missing",
      "research-stats",
      "risk-rules",
      "similar-cases",
      "trials",
    ],
  );
});
