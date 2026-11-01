import { definePlugin } from "../../server/plugin-host/define.mjs";
import { FeishuKnowledgeBot } from "./server/feishu-knowledge-bot.mjs";
import { avatarAgendaSources } from "./agenda.mjs";

const REPLY = (send, status, value) => {
  send(status, value);
  return true;
};

const botOf = (ctx) => ctx.plugins["feishu-knowledge-bot"]?.service;

// Historical knowledge-bot routes. The scan binding endpoints stay here
// because they only operate on this bot's registration; the registration
// implementation itself comes from the channel plugin service.
function createKnowledgeBotApi(ctx) {
  return async function knowledgeBotApi(req, url, io) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "knowledge-bot") return false;
    const bot = botOf(ctx);
    if (!bot) return false;

    if (parts.length === 2 && req.method === "GET")
      return REPLY(io.send, 200, bot.settings());
    if (parts.length === 2 && req.method === "DELETE")
      return REPLY(
        io.send,
        200,
        await bot.disconnect((await io.body()).expectedRevision),
      );
    if (parts.length === 3 && parts[2] === "reset-context" && req.method === "POST")
      return REPLY(
        io.send,
        200,
        await bot.resetContext((await io.body()).expectedRevision),
      );
    if (parts.length === 3 && parts[2] === "feishu-binding") {
      const binding = bot.bindingOrNull();
      if (!binding) return false;
      if (req.method === "POST") return REPLY(io.send, 200, await binding.begin());
      if (req.method === "DELETE")
        return REPLY(io.send, 200, binding.cancel((await io.body()).id));
      return false;
    }
    if (
      parts.length === 4 &&
      parts[2] === "feishu-binding" &&
      parts[3] === "status" &&
      req.method === "POST"
    ) {
      const binding = bot.bindingOrNull();
      if (!binding) return false;
      return REPLY(io.send, 200, await binding.poll((await io.body()).id));
    }
    if (parts[2] === "conversations") return conversationRoutes(bot, req, url, io, parts);
    if (parts[2] === "insights") return insightRoutes(bot, req, io, parts);
    if (parts.length === 3 && parts[2] === "unanswered" && req.method === "GET")
      return REPLY(
        io.send,
        200,
        bot.unanswered(
          Number(url.searchParams.get("rangeDays") || 30),
          url.searchParams.get("chatId") || "",
        ),
      );
    if (parts.length === 2 && req.method === "PUT") {
      const input = await io.body();
      // The knowledge bot must not share a Feishu app with the doctor chat
      // assistant; reading the channel's public rows keeps table ownership
      // inside the channel plugin.
      const channels = ctx.service("channel").rows("message_channels") || [];
      if (
        input.enabled &&
        channels.some(
          (channel) =>
            channel.enabled &&
            channel.platform === "feishu" &&
            channel.appId === input.appId,
        )
      )
        return REPLY(io.send, 409, {
          error: "该应用正在用于医生助手，请为医生分身使用独立的应用。",
          code: "CONNECTION_CONFLICT",
        });
      return REPLY(io.send, 200, await bot.save(input));
    }
    return false;
  };
}

const intParam = (url, name, fallback) =>
  url.searchParams.has(name) ? Number(url.searchParams.get(name)) : fallback;

// 分身会话记录: list/search, thread, handled, pause ("我来回复"), patient link,
// later follow-up, manual doctor reply and delete.
async function conversationRoutes(bot, req, url, io, parts) {
  if (parts.length === 3 && req.method === "GET")
    return REPLY(
      io.send,
      200,
      bot.conversations({
        q: url.searchParams.get("q") || "",
        filter: url.searchParams.get("filter") || "all",
        limit: intParam(url, "limit", 30),
        offset: intParam(url, "offset", 0),
      }),
    );
  const chatId = parts[3];
  if (parts.length === 4) {
    if (req.method === "GET") return REPLY(io.send, 200, bot.thread(chatId));
    if (req.method === "DELETE")
      return REPLY(io.send, 200, bot.deleteConversation(chatId));
    return false;
  }
  if (parts.length !== 5) return false;
  const action = parts[4];
  if (action === "handled" && req.method === "POST")
    return REPLY(io.send, 200, bot.markHandled(chatId));
  if (action === "pause" && req.method === "POST")
    return REPLY(io.send, 200, bot.setPaused(chatId, (await io.body()).paused));
  if (action === "patient" && req.method === "PUT")
    return REPLY(io.send, 200, bot.linkPatient(chatId, await io.body()));
  if (action === "follow-up" && req.method === "POST")
    return REPLY(io.send, 200, bot.followUp(chatId, await io.body()));
  if (action === "reply" && req.method === "POST")
    return REPLY(io.send, 200, await bot.manualReply(chatId, await io.body()));
  return false;
}

// AI 会话洞察: saved reports can be reopened later.
async function insightRoutes(bot, req, io, parts) {
  if (parts.length === 3 && req.method === "GET")
    return REPLY(io.send, 200, bot.insights());
  if (parts.length === 3 && req.method === "POST") {
    const input = await io.body();
    return REPLY(
      io.send,
      201,
      await bot.insight({
        chatId: input.chatId || "",
        rangeDays: input.rangeDays ?? 7,
      }),
    );
  }
  if (parts.length === 4 && req.method === "GET")
    return REPLY(io.send, 200, bot.getInsight(parts[3]));
  if (parts.length === 4 && req.method === "DELETE")
    return REPLY(io.send, 200, bot.deleteInsight(parts[3]));
  return false;
}

export default definePlugin({
  id: "feishu-knowledge-bot",
  version: "1.0.0",
  title: "医生分身",
  enabledByDefault: true,
  requires: { plugins: { channel: "*" } },
  provides: { service: "feishu-knowledge-bot", apiVersion: 1 },
  migrations: "./migrations",
  tablePrefix: "knowledge_bot_",
  agendaSources: avatarAgendaSources,
  legacyApiPaths: [
    { method: "*", path: "/api/knowledge-bot" },
    { method: "*", path: "/api/knowledge-bot/*" },
  ],
  setup(ctx) {
    const host = ctx.services.knowledgeBotHost || {};
    return new FeishuKnowledgeBot(ctx.services.store, host.vault, host.library, {
      getProvider: host.getProvider,
      // The doctor's confirmed preferences and habits (doctor_memories), the
      // same digest the medical system prompt uses. The persona switch decides
      // whether the avatar uses it.
      getDoctorDigest: () => ctx.services.doctor?.digest?.() || "",
      // The scan registration belongs to the channel plugin; resolve it
      // through the public service rather than importing plugin files.
      createFeishuRegistration: (input) =>
        ctx.service("channel").createFeishuRegistration(input),
      ...(host.options || {}),
    });
  },
  lifecycle: {
    start(ctx) {
      const bot = ctx.plugins["feishu-knowledge-bot"]?.service;
      bot?.bindingOrNull()?.start();
      bot?.start();
    },
    async stop(ctx) {
      const bot = ctx.plugins["feishu-knowledge-bot"]?.service;
      await bot?.bindingOrNull()?.stop();
      await bot?.stop();
    },
  },
  api: (ctx, req, url, io) => createKnowledgeBotApi(ctx)(req, url, io),
});
