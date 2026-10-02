import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { WxCliClient } from "../server/chat-connectors/wx-cli.mjs";
import { fixture } from "./helpers.mjs";
import { ChatFollowups } from "../server/chat-followups.mjs";

const config = {
  endpoint: "http://127.0.0.1:9100",
  accountId: "wxid_self",
  token: "synthetic-token",
  conversations: ["wxid_patient"],
};
const health = {
  ready: true,
  worker_id: "worker-one",
  current_account: { wxid: "wxid_self" },
};
const message = (id = "9007199254740993", talker = "wxid_patient") => ({
  server_id: id,
  sort_seq: "9007199254740995",
  talker,
  sender: "wxid_patient",
  msg_type: 1,
  create_time: 100,
  content: { Text: "合成消息：已经预约复查" },
  snippet: "合成消息：已经预约复查",
});
const page = (items, more = false, offset = 0) => ({
  items,
  paging: { limit: 100, offset, has_more: more },
  stats: { skipped: 0, shard_warnings: [] },
});
const client = (reply) =>
  new WxCliClient({
    now: () => 1000000,
    fetch: async (url, init) => {
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.authorization, "Bearer synthetic-token");
      assert.equal(url.searchParams.has("show_hidden"), false);
      return reply(url, init);
    },
  });
test("wx-cli preserves Rust i64 IDs, content, group scope and exact account identity", async () => {
  const c = client((url) =>
    url.pathname.endsWith("/health")
      ? Response.json(health)
      : new Response(
          JSON.stringify(page([message()])).replace(
            '"9007199254740993"',
            "9007199254740993",
          ),
        ),
  );
  const result = await c.read(config, "0");
  assert.equal(result.messages[0].evidence.serverId, "9007199254740993");
  assert.equal(result.messages[0].text, message().snippet);
  assert.equal(result.messages[0].direction, "in");
  const other = client(() =>
    Response.json({ ...health, current_account: { wxid: "different" } }),
  );
  await assert.rejects(other.read(config, "0"), /账号/);
  const group = client((url) =>
    Response.json(
      url.pathname.endsWith("/health")
        ? health
        : page([message("10", "group@chatroom")]),
    ),
  );
  assert.equal(
    (
      await group.read(
        { ...config, conversations: ["room:group@chatroom"] },
        "0",
      )
    ).messages[0].conversationId,
    "room:group@chatroom",
  );
});
test("wx-cli keeps fixed time windows and advances over hidden rows before rotating chats", async () => {
  const seen = [];
  const c = client((url) => {
    if (url.pathname.endsWith("/health")) return Response.json(health);
    seen.push(Object.fromEntries(url.searchParams));
    return Response.json(
      page(
        [],
        url.searchParams.get("offset") === "0",
        Number(url.searchParams.get("offset")),
      ),
    );
  });
  const first = await c.read({ ...config, conversations: ["a", "b"] }, "0");
  assert.equal(first.hasMore, true);
  const second = await c.read(
    { ...config, conversations: ["a", "b"] },
    first.nextCursor,
  );
  assert.equal(second.hasMore, true);
  await c.read({ ...config, conversations: ["a", "b"] }, second.nextCursor);
  assert.deepEqual(
    seen.map((v) => [v.contact, v.offset, v.since, v.until]),
    [
      ["a", "0", "0", "1000"],
      ["a", "100", "0", "1000"],
      ["b", "0", "0", "1000"],
    ],
  );
});
test("wx-cli rejects worker changes, wrong conversations, partial databases and errors without leaking response text", async () => {
  let count = 0;
  const restart = client((url) =>
    Response.json(
      url.pathname.endsWith("/health")
        ? { ...health, worker_id: ++count === 1 ? "first" : "second" }
        : page([message()]),
    ),
  );
  await assert.rejects(restart.read(config, "0"), /重启/);
  for (const bad of [
    page([message("2", "wrong")]),
    { ...page([]), stats: { shard_warnings: ["private db path"] } },
  ]) {
    const c = client((url) =>
      Response.json(url.pathname.endsWith("/health") ? health : bad),
    );
    await assert.rejects(
      c.read(config, "0"),
      (e) => !e.message.includes("private db path"),
    );
  }
  const denied = client(
    () => new Response("secret upstream data", { status: 401 }),
  );
  await assert.rejects(
    denied.status(config),
    (e) => /密钥/.test(e.message) && !e.message.includes("secret"),
  );
  const cancelled = new AbortController();
  cancelled.abort();
  const abortClient = new WxCliClient({
    fetch: async (_url, init) => {
      init.signal.throwIfAborted();
    },
  });
  await assert.rejects(abortClient.status(config, cancelled.signal), /连接/);
  const oversized = client(() => new Response("x".repeat(4000001)));
  await assert.rejects(oversized.status(config), /4 MB/);
});
test("wx-cli sessions use IDs and indicate truncated lists", async () => {
  const c = client((url) =>
    Response.json(
      url.pathname.endsWith("/health")
        ? health
        : page([
            {
              username: "group@chatroom",
              display_name: "合成群",
              sort_timestamp: 100,
            },
          ]),
    ),
  );
  assert.deepEqual((await c.conversations(config)).conversations, [
    {
      id: "room:group@chatroom",
      title: "合成群",
      lastMessageAt: "1970-01-01T00:01:40.000Z",
    },
  ]);
});
async function connected(t, overrides = {}) {
  const wxcli = client((url) =>
    Response.json(
      url.pathname.endsWith("/health")
        ? health
        : page([{ ...message(), create_time: 900 }]),
    ),
  );
  const f = await fixture(t, { chatFollowups: { wxcli, ...overrides } });
  const p = (await f.json("/api/patients", "POST", { name: "合成微信患者" }))
    .data;
  const conn = (
    await f.json("/api/chat-followups/connections/wx-cli/connect", "POST", {
      ...config,
      revision: 0,
    })
  ).data;
  assert.equal(conn.enabled, true);
  const bind = async (channel = "wx-cli", conversationId = "wxid_patient") =>
    (
      await f.json("/api/chat-followups/bindings", "POST", {
        channel,
        patientId: p.id,
        conversationId,
        title: "合成会话",
        speakerName: "合成家属",
        relationship: "family",
        senderId: "wxid_patient",
        confirmed: true,
      })
    ).data;
  return { ...f, p, conn, bind };
}
test("wx-cli API sync creates review drafts once; rescan, disable and account change retain safe boundaries", async (t) => {
  const f = await connected(t);
  await f.bind();
  const s = f.server.chatFollowups;
  assert.equal(
    (await f.json("/api/chat-followups/connections/wx-cli/sync", "POST", {}))
      .status,
    412,
  );
  assert.equal((await s.sync("wx-cli", { consent: true })).added, 1);
  assert.equal((await s.sync("wx-cli", { consent: true })).added, 0);
  let state = s.list(f.p.id);
  assert.equal(state.drafts.length, 1);
  assert.match(state.drafts[0].sourceText, /家属转述/);
  assert.doesNotMatch(JSON.stringify(s.settings()), /synthetic-token/);
  let c = s.config("wx-cli");
  assert.throws(() => s.resetCursor("wx-cli", { revision: c.revision }));
  s.resetCursor("wx-cli", { revision: c.revision, confirmed: true });
  assert.equal((await s.sync("wx-cli", { consent: true })).added, 0);
  c = s.config("wx-cli");
  s.save("wx-cli", { ...c, enabled: false, token: "" });
  await assert.rejects(s.sync("wx-cli", { consent: true }), /启用/);
  c = s.config("wx-cli");
  s.save("wx-cli", {
    ...c,
    enabled: true,
    accountId: "changed",
    token: "synthetic-token",
  });
  assert.equal(s.list(f.p.id).bindings[0].currentAccount, false);
  assert.equal(s.evidence(state.drafts[0].id).messages.length, 1);
});
test("wx-cli group binding normalizes raw IDs and does not auto-attribute messages", async (t) => {
  const f = await connected(t);
  const b = await f.bind("wx-cli", "group@chatroom");
  assert.equal(b.conversationId, "room:group@chatroom");
  f.server.chatFollowups.ingest(f.server.chatFollowups.config("wx-cli"), [
    {
      id: "group",
      conversationId: b.conversationId,
      senderId: "wxid_patient",
      text: "群消息",
      direction: "in",
      type: "text",
      sentAt: null,
    },
  ]);
  assert.equal(f.server.chatFollowups.list(f.p.id).drafts.length, 0);
  assert.equal(f.server.chatFollowups.list(f.p.id).inbox.length, 1);
});
test("declarative plugins persist across restart, remove credentials and preserve collected records", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "medical-connector-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = await fixture(t, { database: join(dir, "test.sqlite") });
  const s = f.server.chatFollowups;
  const manifest = {
    manifestVersion: 1,
    id: "second-wechat",
    name: "另一台微信",
    protocol: "wx-cli",
  };
  assert.equal(
    (
      await f.json("/api/chat-followups/plugins", "POST", {
        ...manifest,
        command: "anything",
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.json("/api/chat-followups/plugins", "POST", manifest)).status,
    201,
  );
  assert.equal(
    (await f.json("/api/chat-followups/plugins", "POST", manifest)).status,
    400,
  );
  s.save(manifest.id, { ...config, enabled: true, revision: 0 });
  const p = (await f.json("/api/patients", "POST", { name: "插件合成患者" }))
    .data;
  await s.bind({
    patientId: p.id,
    channel: manifest.id,
    title: "家属",
    speakerName: "家属",
    relationship: "family",
    conversationId: "wxid_patient",
    confirmed: true,
  });
  s.ingest(s.config(manifest.id), [
    {
      id: "history",
      conversationId: "wxid_patient",
      text: "已采集记录",
      senderId: "wxid_patient",
      direction: "in",
      type: "text",
      sentAt: null,
    },
  ]);
  const reopened = new ChatFollowups({
    store: s.store,
    patients: s.patients,
    followups: s.followups,
    provider: s.provider,
    directory: dir,
  });
  assert.equal(reopened.registry.get(manifest.id).name, manifest.name);
  assert.equal(
    (await f.json("/api/chat-followups/plugins/wechat", "DELETE")).status,
    400,
  );
  assert.equal(
    (await f.json("/api/chat-followups/plugins/" + manifest.id, "DELETE"))
      .status,
    200,
  );
  assert.equal(s.vault.get(`chat:${manifest.id}`).token, undefined);
  assert.equal(s.list(p.id).drafts.length, 1);
  assert.equal(s.list(p.id).bindings[0].currentAccount, false);
  assert.equal(
    (
      await f.json("/api/chat-followups/plugins", "POST", {
        ...manifest,
        protocol: "archive-v1",
      })
    ).status,
    400,
  );
});
test("removing a plugin cancels in-flight reads before commit", async (t) => {
  let start, release;
  const started = new Promise((r) => (start = r));
  const f = await fixture(t, {
    chatFollowups: {
      plugins: [
        {
          id: "custom",
          name: "自定义连接",
          protocol: "archive-v1",
          client: {
            status: async () => ({ ready: true }),
            conversations: async () => ({ conversations: [] }),
            read: async () => {
              start();
              return new Promise((r) => (release = r));
            },
          },
        },
      ],
    },
  });
  const s = f.server.chatFollowups;
  s.save("custom", { ...config, revision: 0, enabled: true });
  const p = (await f.json("/api/patients", "POST", { name: "取消测试" })).data;
  await s.bind({
    channel: "custom",
    patientId: p.id,
    conversationId: "wxid_patient",
    title: "会话",
    speakerName: "家属",
    relationship: "family",
    confirmed: true,
  });
  const pending = s.sync("custom", { consent: true });
  await started;
  s.removePlugin("custom");
  release({ messages: [], nextCursor: "1", hasMore: false });
  await assert.rejects(pending);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM chat_messages").get().n, 0);
});

test("native HTTP: authentication, failed-page resume, exact i64 IDs, deduplication and account-switch rejection", async (t) => {
  let failSecondPage = true,
    account = "wxid_self";
  const requests = [];
  const upstream = createHttpServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body).replace(/"(900719925474\d+)"/g, "$1"));
    };
    if (req.headers.authorization !== "Bearer synthetic-token")
      return reply(401, { error: "synthetic auth failure" });
    if (url.pathname === "/api/v1/health")
      return reply(200, { ...health, current_account: { wxid: account } });
    if (url.pathname === "/api/v1/sessions")
      return reply(
        200,
        page([
          {
            username: "wxid_patient",
            display_name: "HTTP 合成会话",
            sort_timestamp: 900,
          },
        ]),
      );
    if (url.pathname !== "/api/v1/messages")
      return reply(404, { error: "not found" });
    requests.push(Object.fromEntries(url.searchParams));
    const offset = Number(url.searchParams.get("offset"));
    if (offset === 100 && failSecondPage)
      return reply(503, { error: "synthetic interrupted database" });
    const all = Array.from({ length: 101 }, (_, i) => ({
      ...message(String(9007199254740993n + BigInt(i))),
      create_time: 900,
      sort_seq: String(9007199254740993n + BigInt(i)),
    }));
    return reply(
      200,
      page(all.slice(offset, offset + 100), offset + 100 < all.length, offset),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const endpoint = `http://127.0.0.1:${upstream.address().port}`;
  const f = await fixture(t, {
    chatFollowups: { wxcli: new WxCliClient({ now: () => 1000000 }) },
  });
  const s = f.server.chatFollowups;
  const input = {
    endpoint,
    accountId: "wxid_self",
    token: "wrong-token",
    revision: 0,
  };
  let connection = (
    await f.json(
      "/api/chat-followups/connections/wx-cli/connect",
      "POST",
      input,
    )
  ).data;
  assert.equal(connection.enabled, false);
  assert.match(connection.status.message, /密钥/);
  connection = (
    await f.json("/api/chat-followups/connections/wx-cli/connect", "POST", {
      ...input,
      token: "synthetic-token",
      revision: connection.revision,
    })
  ).data;
  assert.equal(connection.enabled, true);
  const sessions = await f.json(
    "/api/chat-followups/conversations?channel=wx-cli",
  );
  assert.equal(sessions.status, 200);
  assert.equal(sessions.data.conversations[0].title, "HTTP 合成会话");
  const patient = (
    await f.json("/api/patients", "POST", { name: "HTTP 合成患者" })
  ).data;
  const binding = await f.json("/api/chat-followups/bindings", "POST", {
    channel: "wx-cli",
    patientId: patient.id,
    conversationId: "wxid_patient",
    title: "HTTP 会话",
    speakerName: "家属",
    relationship: "family",
    senderId: "wxid_patient",
    confirmed: true,
  });
  assert.equal(binding.status, 201);
  const sync = () =>
    f.json("/api/chat-followups/connections/wx-cli/sync", "POST", {
      consent: true,
    });
  assert.equal((await sync()).status, 502);
  const checkpoint = s.config("wx-cli").cursor;
  assert.equal(JSON.parse(checkpoint).chats.wxid_patient.offset, 100);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM chat_messages").get().n,
    100,
  );
  failSecondPage = false;
  const recovered = await sync();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.added, 1);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM chat_messages").get().n,
    101,
  );
  assert.equal((await sync()).data.added, 0);
  const exactIds = s.db
    .prepare("SELECT data FROM chat_messages")
    .all()
    .map((row) => JSON.parse(row.data).evidence.serverId);
  assert.equal(new Set(exactIds).size, 101);
  assert.ok(exactIds.includes("9007199254740993"));
  assert.ok(exactIds.includes("9007199254740994"));
  const settled = s.config("wx-cli").cursor;
  account = "different-account";
  assert.equal((await sync()).status, 409);
  assert.equal(s.config("wx-cli").cursor, settled);
  assert.ok(
    requests.every(
      (r) =>
        r.contact === "wxid_patient" &&
        r.order === "asc" &&
        !("show_hidden" in r),
    ),
  );
  assert.deepEqual(
    requests.slice(0, 3).map((r) => r.offset),
    ["0", "100", "100"],
  );
});
