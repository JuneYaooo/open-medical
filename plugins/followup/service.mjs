import { FollowUpManager } from "./core/followups.mjs";
import { FollowUpSurveys } from "./core/surveys.mjs";
import { ChatFollowups } from "./core/chat.mjs";
import { WechatAutoFollow } from "./core/autofollow.mjs";
import { WecomAibotChannel } from "./core/aibot.mjs";
import { CareEngine } from "./core/care.mjs";
import { check } from "../../server/errors.mjs";

// Followup domain service. The fixed shell only sees this object (and the two
// channel services it consumes); timers and sockets are owned by the plugin
// lifecycle below.
export function createFollowupService({
  store,
  runtime,
  patients,
  host = {},
  channelWecom = null,
  channelWechat = null,
  options = {},
  risks = () => null,
} = {}) {
  check(store, "PLUGIN_SPEC", "followup 插件缺少 store");
  const followups = new FollowUpManager(store, runtime, {
    ...(options.followup || {}),
  });

  const getProvider = () => host.getProvider?.() || null;
  const chatFollowups = new ChatFollowups({
    store,
    patients,
    followups,
    directory: host.vaultDir,
    provider: getProvider,
    aibot: null,
    archive: channelWecom?.archive || null,
    archiveClass: channelWecom?.WecomArchiveClient || null,
    wechat: channelWechat?.reader,
    wxcli: channelWechat?.wxcli,
    createWxCli: channelWechat
      ? () => new channelWechat.WxCliClient()
      : null,
    parseExport: channelWechat?.parseWechatExportBatch,
    validateRegion: channelWechat?.validateRegion,
    flatName: channelWechat?.flatName,
    ...options.chatFollowups,
  });

  const aibot =
    options.chatAibot ||
    new WecomAibotChannel({
      url: channelWecom?.AIBOT_WS_URL || "",
      createSocket: channelWecom
        ? (input) => channelWecom.createAibotSocket(input)
        : null,
      toChatMessage: channelWecom?.toChatMessage || null,
      log: (message) => console.error(`[aibot] ${message}`),
      provider: getProvider,
      guidelines: host.guidelines,
      patientBrief: host.patientBrief,
      skills: host.skills,
    });
  chatFollowups.aibot = aibot;
  chatFollowups.registry.register({
    id: "wecom-aibot",
    name: "企业微信 · 智能机器人",
    protocol: "aibot-ws",
    builtin: true,
    client: aibot,
    defaultEndpoint: aibot.endpoint,
  });
  aibot.attach(chatFollowups);
  // The channel-wecom plugin owns the socket implementation; attaching the
  // business channel lets its lifecycle start/stop the WSS connection.
  channelWecom?.attachAibot(aibot);

  const surveys = new FollowUpSurveys(store, followups, {
    provider: getProvider,
    onCollected(patientId) {
      try {
        risks()?.evaluatePatient(patientId);
      } catch {
        // The survey is saved; the next risk evaluation picks up its alert.
      }
    },
    channels: {
      async sendWechat(patientId, text) {
        const binding = chatFollowups.wechatBindingByPatient(patientId);
        check(
          binding,
          "CHAT_CHANNEL",
          "该患者没有已绑定的微信会话，可改用手动渠道发送",
          409,
        );
        await chatFollowups.sendToBinding({
          bindingId: binding.id,
          text,
          consent: true,
          autoLocate: true,
        });
      },
      async sendAibot(patientId, text) {
        const channel = chatFollowups.registry.get("wecom-aibot")?.client;
        check(
          channel?.live,
          "CHAT_CHANNEL",
          "企微机器人长连接不在线，可改用手动渠道发送",
          409,
        );
        const row = chatFollowups.db
          .prepare(
            "SELECT data FROM chat_bindings WHERE patient_id=? AND channel='wecom-aibot' AND COALESCE(json_extract(data,'$.disabled'),0)=0 ORDER BY rowid DESC LIMIT 1",
          )
          .get(patientId);
        check(row, "CHAT_CHANNEL", "该患者没有已绑定的企微机器人会话", 409);
        await channel.socket.push(JSON.parse(row.data).conversation, {
          msgtype: "text",
          text: { content: text },
        });
      },
      // 企业微信客户联系 / 微信客服：复用 CareEngine 的通道与发送限制。
      async sendCare(channel, patientId, text, requestId) {
        const outcome = await care.channels.send(channel, {
          patientId,
          text,
          requestId,
          targets: care.targets(patientId),
        });
        check(
          outcome.status !== "unknown",
          "CHAT_CHANNEL",
          "发送结果未知，请先在企业微信核实患者是否收到，勿重复发送",
          409,
        );
        check(
          ["sent", "awaiting_member"].includes(outcome.status),
          "CHAT_CHANNEL",
          outcome.detail || "企业微信发送失败",
          409,
        );
        if (outcome.status === "sent") {
          store.db
            .prepare(
              "INSERT OR IGNORE INTO patient_messages(patient_id,channel,direction,time,external_id,processed,data) VALUES (?,?,?,?,?,1,?)",
            )
            .run(patientId, channel, "out", new Date(care.now()).toISOString(), `${requestId}:out`, JSON.stringify({ text }));
          care.discover();
        }
        return outcome;
      },
    },
  });
  followups.surveys = surveys;
  aibot.surveys = surveys;

  const wecom = channelWecom?.connector || null;
  const care = new CareEngine({
    store,
    patients,
    followups,
    // The connector is attached by channel-wecom's lifecycle via onStart.
    wecom: null,
    wecomApi: channelWecom?.WecomApi || null,
    guidelines: host.guidelines,
    patientBrief: host.patientBrief,
    vault: host.vault,
    provider: getProvider,
    fetch: host.fetch || fetch,
    now: host.now || Date.now,
    env: host.env || process.env,
    ...options.care,
    // The channel-wecom plugin lifecycle owns directory due/refresh timing.
    directorySync: false,
  });
  care.surveys = surveys;
  const chatAutoFollow = new WechatAutoFollow({
    chat: chatFollowups,
    followups,
    provider: getProvider,
    guidelines: host.guidelines,
    patientBrief: host.patientBrief,
    store,
    ...options.chatAutoFollow,
  });

  let started = false;
  let starting = false;
  const service = {
    apiVersion: 1,
    followups,
    surveys,
    chatFollowups,
    chatAutoFollow,
    care,
    aibot,
    wecom,
    get started() {
      return started;
    },
    get timer() {
      return followups.timer || null;
    },
    get provider() {
      return getProvider();
    },
    // Fixed-region read model: only aggregate values, no plugin table names
    // cross the boundary. Called from the host's patientSummary extension.
    patientSummary(patientIds = [], { now = Date.now() } = {}) {
      const wanted = new Set(patientIds);
      const result = {};
      const rows = store.db
        .prepare(
          "SELECT patient_id,COUNT(*) n,SUM(CASE WHEN status='active' AND next_due<=? THEN 1 ELSE 0 END) due FROM follow_ups WHERE status IN ('active','running','paused') GROUP BY patient_id",
        )
        .all(now);
      for (const row of rows) {
        if (wanted.size && !wanted.has(row.patient_id)) continue;
        result[row.patient_id] = {
          activeFollowups: row.n,
          dueFollowups: row.due,
        };
      }
      return result;
    },
    // Transactional hook target. Patient-linked care/chat rows cascade when
    // the fixed region deletes the patient; the followup tables without a
    // foreign key are removed explicitly.
    removePatient(patientId) {
      for (const table of [
        "follow_ups",
        "followup_surveys",
        "followup_creation_requests",
        "followup_applications",
      ])
        store.db
          .prepare(`DELETE FROM ${table} WHERE patient_id=?`)
          .run(patientId);
    },
    async start() {
      if (started || starting) return;
      starting = true;
      try {
        followups.start();
        chatFollowups.start();
        care.start();
        started = true;
      } finally {
        starting = false;
      }
    },
    async stop() {
      if (!started) return;
      started = false;
      followups.stop();
      care.stop();
      await chatFollowups.stop();
    },
    async drain() {
      await followups.drain();
      await care.drain();
    },
  };
  return Object.freeze(service);
}
