// 分身会话需关注: conversations the doctor should look at (red flags, replies
// needing review, failed sends) and chats the doctor chose to contact later.
const moment = (now) => (typeof now === "number" ? now : Date.parse(now) || Date.now());

// Only attach a patient id that still resolves; the overview drops rows whose
// patient is missing or archived, and a red flag must never disappear.
function linkedPatient(ctx, id) {
  if (!id) return undefined;
  try {
    const patient = ctx.services.patients?.row?.(id);
    return patient && !patient.archived ? id : undefined;
  } catch {
    return undefined;
  }
}

const action = { type: "view", view: "settings", settingsTab: "knowledge-bot", label: "查看会话" };

export const avatarAgendaSources = Object.freeze([
  {
    kind: "avatar",
    label: "分身会话需关注",
    order: 45,
    // Advertised only once a Feishu app is bound, so installs without the
    // avatar keep their agenda kinds and counts unchanged.
    available: (ctx) => Boolean(ctx.plugins["feishu-knowledge-bot"]?.service?.config().appId),
    read(ctx, { now } = {}) {
      const bot = ctx.plugins["feishu-knowledge-bot"]?.service;
      if (!bot) return [];
      const current = moment(now);
      const items = [];
      for (const c of bot.agendaItems(current)) {
        const patientId = linkedPatient(ctx, c.patientId);
        const who = c.name || (c.chatType === "p2p" ? "单聊" : "群聊");
        if (c.needsAttention)
          items.push({
            id: `avatar:${c.chatId}`,
            kind: "avatar",
            ...(patientId ? { patientId } : {}),
            title: `分身会话需关注：${who}`,
            detail: c.attentionReason || "请查看会话记录",
            at: c.attentionAt || c.lastAt,
            weight: c.attentionKind === "red-flag" ? 1 : 3,
            fallbackName: "飞书分身",
            action,
          });
        if (c.followUpAt && c.followUpAt <= current)
          items.push({
            id: `avatar-later:${c.chatId}`,
            kind: "avatar",
            ...(patientId ? { patientId } : {}),
            title: `稍后联系：${who}`,
            detail: c.followUpNote || "你在分身会话记录中设置了稍后联系",
            at: c.followUpAt,
            weight: 4,
            fallbackName: "飞书分身",
            action,
          });
      }
      return items;
    },
  },
]);
