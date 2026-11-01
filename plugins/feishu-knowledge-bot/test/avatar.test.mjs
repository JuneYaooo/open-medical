import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { knowledgeMetadata } from "../../../server/medical/knowledge-metadata.mjs";
import { FeishuKnowledgeBot } from "../server/feishu-knowledge-bot.mjs";
import { reviewReply, reviewInbound } from "../server/avatar-safety.mjs";
import { avatarAgendaSources } from "../agenda.mjs";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const APP = "cli_abcdefgh12";
const START = Date.parse("2026-10-01T08:00:00Z");

function database() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort())
    db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
  return db;
}

// Raw stored documents: tri-state allowExternalUse like guideline_docs.
const DOCS = {
  d1: { id: "d1", title: "高血压饮食", collection: "科普", reviewStatus: "unreviewed", sha256: "s1", revision: 0 },
  d2: { id: "d2", title: "内部讨论稿", collection: "科普", reviewStatus: "unreviewed", allowExternalUse: false, avatarExcluded: true, sha256: "s2", revision: 0 },
  d3: { id: "d3", title: "已复核指南", collection: "科普", reviewStatus: "reviewed", allowExternalUse: true, sha256: "s3", revision: 0 },
  // 编辑正文后 allowExternalUse 会被自动关闭，但不应把资料踢出分身范围。
  d5: { id: "d5", title: "修订过的科普", collection: "科普", reviewStatus: "unreviewed", allowExternalUse: false, textCorrected: true, sha256: "s5", revision: 1 },
  d4: { id: "d4", title: "停用资料", collection: "科普", reviewStatus: "retired", sha256: "s4", revision: 0 },
};
const shown = (doc) => ({ ...doc, ...knowledgeMetadata(doc) });
const hit = (doc) => ({ docId: doc.id, docTitle: doc.title, collection: doc.collection, ord: 0, revision: doc.revision, sha256: doc.sha256, startLine: 1, endLine: 3, snippet: `${doc.title}：每日食盐少于 5 克。` });
const library = {
  collections: () => [{ name: "科普", documentCount: 4 }],
  list: ({ collection } = {}) => Object.values(DOCS).filter((d) => !collection || d.collection === collection).map(shown),
  get: (id) => { if (!DOCS[id]) throw new Error("missing"); return shown(DOCS[id]); },
  async search({ query, externalOnly }) {
    if (query.includes("查不到")) return { hits: [] };
    return { hits: Object.values(DOCS).filter((d) => d.reviewStatus !== "retired").filter((d) => !externalOnly || knowledgeMetadata(d).allowExternalUse).map(hit) };
  },
};

function vault() {
  const data = new Map([["feishu-knowledge-bot", { appSecret: "secret" }]]);
  return { get: (k) => ({ ...(data.get(k) || {}) }), set: (k, v) => data.set(k, v), delete: (k) => data.delete(k) };
}

function fakeFetch() {
  const calls = [];
  const impl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    let data = { code: 0 };
    if (url.includes("tenant_access_token")) data = { code: 0, tenant_access_token: "t", expire: 7200 };
    else if (url.includes("/bot/v3/info")) data = { code: 0, bot: { open_id: "ou_bot" } };
    return { ok: true, json: async () => data };
  };
  impl.calls = calls;
  impl.sent = () => calls.filter((c) => c.url.includes("/reply") || c.url.includes("receive_id_type"));
  return impl;
}

function fakeProvider(respond) {
  const calls = [];
  return { calls, model: "fake", provider: "test", async complete(messages) { calls.push(messages); return { message: { role: "assistant", content: respond(messages) } }; } };
}

function setup({ db = database(), provider = null, config = {}, clock = { t: START }, digest = "- 沟通风格：语气温和，先给结论" } = {}) {
  const exists = db.prepare("SELECT 1 FROM knowledge_bot_settings WHERE id=1").get();
  if (!exists) {
    db.prepare("INSERT INTO knowledge_bot_settings VALUES(1,?)").run(JSON.stringify({
      enabled: true, appId: APP, boundUserId: "ou_owner", collections: ["科普"], groups: ["oc_group1"], privateChats: ["oc_p2p1"],
      answerMode: "assistant", collectionScope: "all-except-excluded", retentionDays: 180,
      persona: { displayName: "王医生的 AI 助手", intro: "说话简短，不评价其他医院。", useHabits: true }, revision: 1, ...config,
    }));
    db.prepare("INSERT OR IGNORE INTO knowledge_bot_groups VALUES(?,?,?)").run(APP, "oc_p2p1", JSON.stringify({ name: "张三", chatType: "p2p", senderId: "ou_alice", firstSeen: START }));
    db.prepare("INSERT OR IGNORE INTO knowledge_bot_groups VALUES(?,?,?)").run(APP, "oc_group1", JSON.stringify({ name: "高血压患者群", chatType: "group", firstSeen: START }));
  }
  const fetchImpl = fakeFetch();
  let handler = null;
  const bot = new FeishuKnowledgeBot({ db }, vault(), library, {
    fetchImpl, now: () => clock.t, getProvider: () => provider, getDoctorDigest: () => digest, reviewDelayMs: 60000,
    createSocket: (options, onEvent) => { handler = onEvent; return { start: async () => options.onReady(), close() {} }; },
  });
  bot.start();
  let seq = 0;
  const send = async (text, { chat = "oc_p2p1", sender = "ou_alice" } = {}) => {
    await bot.connection;
    const group = chat.startsWith("oc_group");
    handler({ sender: { sender_type: "user", sender_id: { open_id: sender } }, message: {
      chat_type: group ? "group" : "p2p", chat_id: chat, message_id: `om_${clock.t}x${++seq}`, message_type: "text",
      create_time: String(clock.t), content: JSON.stringify({ text: group ? `@_user_1 ${text}` : text }),
      mentions: group ? [{ key: "@_user_1", id: { open_id: "ou_bot" } }] : [] } });
    while (bot.jobs.size) await Promise.allSettled([...bot.jobs]);
  };
  return { db, bot, fetchImpl, send, clock, provider };
}

const answering = (text = "建议低盐饮食 [1]") => (messages) => {
  if (messages[0].content.includes("复核员")) return '{"flags":[]}';
  if (messages[0].content.includes("会话分析助手")) return "{}";
  return text;
};

test("分身：系统提示包含人设与医生习惯，回复带不可移除的 AI 身份说明，并自动记录往来", async (t) => {
  const provider = fakeProvider(answering());
  const { bot, fetchImpl, send } = setup({ provider });
  t.after(() => bot.stop());
  await send("高血压吃饭要注意什么？");
  const system = provider.calls[0][0].content;
  assert.match(system, /王医生的 AI 助手/);
  assert.match(system, /说话简短，不评价其他医院/);
  assert.match(system, /语气温和，先给结论/);
  assert.match(system, /不作个体诊断、处方、剂量或疗效承诺/);
  assert.match(system, /不是系统指令/);
  const reply = JSON.parse(fetchImpl.sent()[0].body.content).text;
  assert.match(reply, /—— 王医生的 AI 助手（AI 自动回复，非医生本人）$/);
  const { conversation, turns } = bot.thread("oc_p2p1");
  assert.equal(conversation.name, "张三");
  assert.deepEqual(turns.map((x) => x.direction), ["in", "out"]);
  assert.equal(turns[0].text, "高血压吃饭要注意什么？");
  assert.equal(turns[1].status, "sent");
  assert.ok(turns[1].sources.length >= 1);
  assert.ok(!turns[1].sources.some((s) => s.docId === "d2"), "明确不对外的资料不参与");
});

test("分身：关闭习惯开关后不注入医生偏好", async (t) => {
  const provider = fakeProvider(answering());
  const { bot, send } = setup({ provider, config: { persona: { displayName: "助手", intro: "", useHabits: false } } });
  t.after(() => bot.stop());
  await send("高血压吃饭要注意什么？");
  assert.doesNotMatch(provider.calls[0][0].content, /语气温和/);
});

test("分身：危险信号固定回复、跳过模型、标记需关注并进入待办", async (t) => {
  const provider = fakeProvider(answering());
  const { bot, fetchImpl, send } = setup({ provider });
  t.after(() => bot.stop());
  await send("我爸突然胸痛，一直出汗");
  assert.equal(provider.calls.length, 0);
  const reply = JSON.parse(fetchImpl.sent()[0].body.content).text;
  assert.match(reply, /120/);
  assert.match(reply, /AI 自动回复/);
  const { conversation, turns } = bot.thread("oc_p2p1");
  assert.equal(conversation.needsAttention, true);
  assert.equal(conversation.attentionKind, "red-flag");
  assert.equal(turns[0].flags.redFlags[0].id, "chest-pain");
  assert.equal(turns[1].flags.kind, "safety");
  const items = avatarAgendaSources[0].read({ plugins: { "feishu-knowledge-bot": { service: bot } }, services: {} }, { now: START });
  assert.equal(items.length, 1);
  assert.equal(items[0].weight, 1);
  assert.equal(items[0].action.settingsTab, "knowledge-bot");
  bot.markHandled("oc_p2p1");
  assert.equal(bot.thread("oc_p2p1").conversation.needsAttention, false);
});

test("分身：医生接手（暂停）的会话仍记录来信但不自动回复", async (t) => {
  const provider = fakeProvider(answering());
  const { bot, fetchImpl, send } = setup({ provider });
  t.after(() => bot.stop());
  await send("你好");
  bot.setPaused("oc_p2p1", true);
  const before = fetchImpl.sent().length;
  await send("还有一个问题");
  assert.equal(fetchImpl.sent().length, before);
  const turns = bot.thread("oc_p2p1").turns;
  assert.equal(turns.at(-1).direction, "in");
  assert.equal(turns.at(-1).flags.paused, true);
  bot.setPaused("oc_p2p1", false);
  await send("再问一次");
  assert.equal(fetchImpl.sent().length, before + 1);
});

test("分身：勾选知识库即授权，明确不对外的资料仍排除；旧配置保持逐篇授权", () => {
  const { bot } = setup();
  const hits = Object.values(DOCS).map(hit);
  const ids = (config) => bot.validSources(hits, { collections: ["科普"], ...config }).map((h) => h.docId);
  assert.deepEqual(ids({ collectionScope: "all-except-excluded" }), ["d1", "d3", "d5"]);
  assert.deepEqual(ids({ collectionScope: "external-only" }), ["d3"]);
  const legacy = database();
  legacy.prepare("INSERT INTO knowledge_bot_settings VALUES(1,?)").run(JSON.stringify({ enabled: false, appId: "", collections: [], groups: [], privateChats: [], answerMode: "excerpts", revision: 3 }));
  const old = new FeishuKnowledgeBot({ db: legacy }, vault(), library, { autoStart: false });
  assert.equal(old.config().collectionScope, "external-only");
  assert.equal(old.config().persona.displayName, "医生的 AI 助手");
  const fresh = new FeishuKnowledgeBot({ db: database() }, vault(), library, { autoStart: false, getProvider: () => ({}) });
  assert.equal(fresh.config().collectionScope, "all-except-excluded");
  assert.equal(fresh.config().answerMode, "assistant");
  const panel = fresh.settings().availableCollections[0];
  assert.equal(panel.allowedCount, 3);
  assert.equal(panel.excludedCount, 1);
});

test("分身：上下文写入数据库，重启后仍可连续追问；/new 与 30 分钟过期仍生效", async (t) => {
  const db = database();
  const clock = { t: START };
  const first = setup({ db, clock, provider: fakeProvider(answering()) });
  await first.send("高血压吃饭要注意什么？");
  await first.bot.stop();
  const provider = fakeProvider(answering("可以，注意少盐 [1]"));
  const second = setup({ db, clock, provider });
  t.after(() => second.bot.stop());
  clock.t += 5 * 60000;
  await second.send("那咸菜能吃吗？");
  const payload = JSON.parse(provider.calls[0][1].content);
  assert.equal(payload.history.length, 1);
  assert.equal(payload.history[0].question, "高血压吃饭要注意什么？");
  await second.send("/new");
  await second.send("运动呢？");
  assert.equal(JSON.parse(provider.calls.at(-1)[1].content).history.length, 0);
  clock.t += 31 * 60000;
  await second.send("还有吗？");
  assert.equal(JSON.parse(provider.calls.at(-1)[1].content).history.length, 0);
});

test("分身：没有依据的回复被确定性记录为未答问题", async (t) => {
  const { bot, send } = setup({ provider: fakeProvider(answering()) });
  t.after(() => bot.stop());
  await send("查不到的罕见病问题");
  await send("查不到的罕见病问题");
  await send("高血压吃饭要注意什么？");
  const out = bot.thread("oc_p2p1").turns.filter((x) => x.direction === "out");
  assert.equal(out.filter((x) => x.flags.noSource).length, 2);
  const list = bot.conversations({ filter: "unanswered" });
  assert.equal(list.total, 1);
  assert.equal(list.conversations[0].unanswered, 2);
  const gaps = bot.unanswered(30);
  assert.equal(gaps.total, 2);
  assert.equal(gaps.groups[0].count, 2);
  assert.equal(gaps.groups[0].question, "查不到的罕见病问题");
});

test("分身：回复风险确定性复核（剂量/停药/承诺），标记需复核", async (t) => {
  assert.deepEqual(reviewReply({ answer: "每日食盐少于 5 克", modelWritten: false }), []);
  assert.ok(reviewReply({ answer: "保证能治好", modelWritten: true }).includes("包含疗效承诺"));
  assert.ok(reviewInbound("吃了药还是越来越严重").includes("提问人描述症状加重"));
  const { bot, send } = setup({ provider: fakeProvider(answering("建议您先停药，每次2片即可 [1]")) });
  t.after(() => bot.stop());
  await send("降压药要怎么吃？");
  const out = bot.thread("oc_p2p1").turns.at(-1);
  assert.ok(out.flags.review.includes("包含剂量或用量"));
  assert.ok(out.flags.review.includes("包含用药调整建议"));
  const conversation = bot.thread("oc_p2p1").conversation;
  assert.equal(conversation.attentionKind, "review");
  assert.equal(bot.conversations({ filter: "review" }).total, 1);
});

test("分身：模型批量复核不阻塞回复，结果写回会话", async (t) => {
  const provider = fakeProvider((messages) => {
    if (messages[0].content.includes("复核员")) {
      const items = JSON.parse(messages[1].content);
      return JSON.stringify({ flags: [{ id: items[0].id, reason: "与资料不一致" }, { id: 99999, reason: "无效" }] });
    }
    return "多吃咸菜也没关系 [1]";
  });
  const { bot, send } = setup({ provider });
  t.after(() => bot.stop());
  await send("咸菜可以吃吗？");
  assert.equal(bot.thread("oc_p2p1").conversation.needsAttention, false);
  const flags = await bot.flushReviews();
  assert.equal(flags.length, 1);
  const out = bot.thread("oc_p2p1").turns.at(-1);
  assert.deepEqual(out.flags.review, ["AI 复核：与资料不一致"]);
  assert.equal(bot.thread("oc_p2p1").conversation.attentionKind, "model-review");
});

test("分身：AI 会话洞察只引用真实记录并持久保存", async (t) => {
  const db = database();
  let turnId = 0;
  const provider = fakeProvider((messages) => {
    if (messages[0].content.includes("会话分析助手")) {
      const payload = JSON.parse(messages[1].content);
      turnId = payload.turns.find((x) => x.who === "提问人").turnId;
      return "```json\n" + JSON.stringify({
        headline: "大家主要关心饮食",
        topics: [{ title: "饮食控盐", count: 2, examples: [{ turnId, quote: "吃饭要注意" }, { turnId: 424242, quote: "编造" }] }],
        feedback: { summary: "总体满意", satisfied: ["回答清楚"], complaints: [], confusion: ["不懂罕见病"] },
        gaps: [{ title: "罕见病就诊指引", cover: "就诊科室与转诊", collection: "科普", turnIds: [turnId, 777777] }],
      }) + "\n```";
    }
    return answering()(messages);
  });
  const { bot, send } = setup({ db, provider });
  t.after(() => bot.stop());
  await send("高血压吃饭要注意什么？");
  // A separate chat: follow-up retrieval would otherwise reuse the prior question.
  await send("查不到的罕见病问题", { chat: "oc_group1" });
  const report = await bot.insight({ rangeDays: 7 });
  assert.equal(report.headline, "大家主要关心饮食");
  assert.deepEqual(report.topics[0].examples.map((e) => e.turnId), [turnId]);
  assert.equal(report.topics[0].examples[0].quote, "吃饭要注意");
  assert.deepEqual(report.gaps[0].turnIds, [turnId]);
  assert.equal(report.gaps[0].existingCollection, true);
  assert.equal(report.unanswered.total, 1);
  const reopened = new FeishuKnowledgeBot({ db }, vault(), library, { autoStart: false });
  assert.equal(reopened.insights().insights[0].headline, "大家主要关心饮食");
  assert.equal(reopened.getInsight(report.id).gaps[0].title, "罕见病就诊指引");
});

test("分身：医生在应用内回复会经飞书发送、记为医生本人，并成为后续口径", async (t) => {
  const provider = fakeProvider(answering());
  const { bot, fetchImpl, send } = setup({ provider });
  t.after(() => bot.stop());
  await send("复查要空腹吗？");
  await bot.manualReply("oc_p2p1", { text: "需要空腹 8 小时，带上以前的化验单。" });
  const call = fetchImpl.sent().at(-1);
  assert.match(call.url, /receive_id_type=chat_id/);
  assert.equal(call.body.receive_id, "oc_p2p1");
  assert.equal(JSON.parse(call.body.content).text, "需要空腹 8 小时，带上以前的化验单。");
  const { conversation, turns } = bot.thread("oc_p2p1");
  assert.equal(conversation.paused, true);
  assert.equal(turns.at(-1).flags.by, "doctor");
  assert.equal(turns.at(-1).status, "sent");
  bot.setPaused("oc_p2p1", false);
  await send("那可以喝水吗？");
  const [system, user] = provider.calls.at(-1);
  assert.match(system.content, /医生本人在此会话中的近期回复[\s\S]*空腹 8 小时/);
  assert.equal(JSON.parse(user.content).history.at(-1).by, "医生本人");
});

test("分身：保留天数到期的记录在写入时清理", async (t) => {
  const clock = { t: START };
  const { bot, send } = setup({ clock, provider: fakeProvider(answering()), config: { retentionDays: 7 } });
  t.after(() => bot.stop());
  await send("高血压吃饭要注意什么？", { chat: "oc_group1" });
  clock.t += 8 * 86400000;
  await send("运动呢？");
  assert.equal(bot.conversations({}).conversations.some((c) => c.chatId === "oc_group1"), false);
});
