import { definePlugin } from "../../server/plugin-host/define.mjs";
import { createChannelService } from "./service.mjs";
import { MessageGateway, messagingApi } from "./server/gateway.mjs";

// The channel foundation owns the generic message gateway only. Concrete
// WeCom/WeChat adapters are separate plugins that register through the
// `channel` service, so this plugin has no business-specific adapters yet.
export default definePlugin({
  id: "channel",
  version: "1.0.0",
  title: "消息渠道",
  enabledByDefault: true,
  provides: { service: "channel", apiVersion: 1 },
  legacyTables: ["message_channels", "message_peers", "message_inbox"],
  legacyApiPaths: [
    { method: "*", path: "/api/message-channels" },
    { method: "*", path: "/api/message-channels/*" },
  ],
  // Disconnected channels and replies that failed to send show in the agenda
  // work lane; otherwise they are only visible on the settings page.
  agendaSources: [
    {
      kind: "channel-failure",
      label: "消息渠道",
      order: 900,
      workOnly: true,
      read(ctx) {
        const gateway = ctx.plugins.channel?.service?.gateway;
        if (!gateway) return [];
        const items = [];
        for (const c of gateway.rows("message_channels")) {
          const state = gateway.states.get(c.id);
          if (!c.enabled || !["failed", "conflict"].includes(state)) continue;
          items.push({
            id: `channel:${c.id}`, kind: "failure", lane: "work",
            title: `消息渠道「${c.name || c.platform}」${state === "conflict" ? "与医生分身使用了同一个应用" : "连接失败"}`,
            detail: state === "conflict" ? "同一个飞书应用只能用于一处，请更换应用" : "检查网络和凭据后重新连接",
            at: Date.parse(c.updatedAt || "") || 0, fallbackName: "消息渠道",
            action: { type: "view", view: "settings", settingsTab: "channels", label: "去设置" },
          });
        }
        const failed = ctx.db.prepare("SELECT data FROM message_inbox WHERE json_extract(data,'$.status') IN ('failed','unknown')").all().map((row) => JSON.parse(row.data));
        if (failed.length) items.push({
          id: "channel-replies-failed", kind: "failure", lane: "work",
          title: `${failed.length} 条渠道回复未发出`,
          detail: "可在消息渠道设置中查看并重试", count: failed.length,
          at: Math.max(...failed.map((row) => Number(row.at) || 0)), fallbackName: "消息渠道",
          action: { type: "view", view: "settings", settingsTab: "channels", label: "查看并重试" },
        });
        return items;
      },
    },
  ],
  setup(ctx) {
    const host = ctx.services.channelHost || {};
    const gateway = new MessageGateway({
      store: ctx.services.store,
      vault: host.vault,
      bridge: host.bridge,
      getProvider: host.getProvider,
      getKnowledgeBot: host.getKnowledgeBot,
      ...(host.options || {}),
    });
    return createChannelService({ gateway });
  },
  lifecycle: {
    // Lifecycle must still be able to clean up after a plugin is disabled at
    // runtime, so use the provided-service record rather than ctx.service(),
    // which correctly rejects disabled plugins for request-time calls.
    start(ctx) {
      ctx.plugins.channel.service.gateway.start();
    },
    async stop(ctx) {
      await ctx.plugins.channel.service.gateway.stop();
    },
  },
  async api(ctx, req, url, io) {
    return messagingApi(ctx.service("channel").gateway, req, url, {
      body: io.body,
      send: io.send,
    });
  },
});
