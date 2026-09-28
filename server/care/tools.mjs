// Chat tools for patient care. Reads and low-risk bookkeeping run
// directly; anything that reaches a patient or changes automation policy
// only files a pending action the doctor confirms in the UI.
const definition = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});
const text = { type: "string" };
const channel = { type: "string", enum: ["wecom-kf", "wecom-contact", "manual"], description: "可省略，系统按患者可达渠道自动选择" };

export function careTools(getCare, pending) {
  const care = () => {
    const engine = getCare();
    if (!engine) throw new Error("患者管理模块未启用");
    return engine;
  };
  const summaryOf = (msg) => ({ id: msg.id, patientId: msg.patientId, patientName: msg.patientName, direction: msg.direction, time: msg.time, text: msg.text.slice(0, 500), attachments: msg.attachments.length, state: msg.state });
  const propose = (type, patientId, payload, summary) => ({
    ...pending.propose({ type, patientId, payload, summary }),
    note: "已生成待确认提案。请提醒医生在工作台右下角「待确认」面板核对后确认；确认前不会发送或生效。",
  });
  return [
    {
      definition: definition("care_overview", "患者消息总览：今日来消息数、待处理、未处理提醒（含紧急）、自动回复数、草稿、进行中随访计划、渠道配置与自动处理状态。回答“今天有什么要处理的”时先调用。"),
      execute: () => care().overview(),
    },
    {
      definition: definition("care_inbox", "列出患者消息及分诊状态。status 可用逗号分隔：pending,unassigned,drafted,alerted,auto_replied,recorded,handled,skipped,failed；level：urgent/attention/routine。", {
        status: text, level: { type: "string", enum: ["urgent", "attention", "routine"] }, patientId: text, limit: { type: "integer" },
      }),
      execute: (args) => ({ messages: care().inbox({ ...args, limit: Math.min(args.limit || 30, 100) }).messages.map(summaryOf) }),
    },
    {
      definition: definition("care_patient_thread", "读取某患者最近的往来消息、回复草稿、随访计划和自动回复设置（同意状态、渠道）。起草回复前先读上下文。", { patientId: text, limit: { type: "integer" } }, ["patientId"]),
      execute: ({ patientId, limit }) => {
        const t = care().patientThread(patientId, Math.min(limit || 30, 100));
        return { ...t, messages: t.messages.map(summaryOf) };
      },
    },
    {
      definition: definition("care_alerts", "列出需要人工关注的提醒（红旗症状、模型判断需医生处理、随访未回复、发送失败等）。status：open/acknowledged/resolved，可逗号分隔。", { status: text, patientId: text }),
      execute: (args) => care().alerts({ status: args.status || "open,acknowledged", patientId: args.patientId }),
    },
    {
      definition: definition("care_campaigns", "列出随访计划及每一步的发送、回复与自动整理结果。", { status: { type: "string", enum: ["active", "paused", "completed", "cancelled"] }, patientId: text }),
      execute: (args) => care().campaigns(args),
    },
    {
      definition: definition("care_settings_get", "读取患者管理设置：自动回复模式（off/draft/auto）与允许类别、提醒对象、自定义关注词、模型分诊授权，以及渠道配置状态（不含密钥）。传 patientId 时同时返回该患者的同意与渠道设置。", { patientId: text }),
      execute: ({ patientId }) => ({ settings: care().publicSettings(), ...(patientId ? { patient: care().patientSettings(patientId) } : {}) }),
    },
    {
      definition: definition("care_alert_update", "医生明确表示已知晓或已处理某条提醒时调用。acknowledge=已知晓（停止升级提醒），resolve=已处理。", { alertId: text, action: { type: "string", enum: ["acknowledge", "resolve"] }, note: text }, ["alertId", "action"]),
      execute: ({ alertId, action, note }) => care().updateAlert(alertId, action, note),
    },
    {
      definition: definition("care_message_mark", "把消息标记为已处理（handled）、无需处理（skipped），或重新放回待分诊（pending）。", { messageId: { type: "integer" }, status: { type: "string", enum: ["handled", "skipped", "pending"] } }, ["messageId", "status"]),
      execute: ({ messageId, status }) => summaryOf(care().markMessage(messageId, status)),
    },
    {
      definition: definition("care_reply_draft", "为患者保存一条回复草稿（不发送）。草稿出现在「患者消息」页，医生可修改后发送。不得包含诊断结论、处方或剂量调整。", { patientId: text, text, messageId: { type: "integer" }, channel }, ["patientId", "text"]),
      execute: ({ patientId, text: body, messageId, channel: ch }) => care().createReply({ patientId, text: body, messageId: messageId ?? null, channel: ch, mode: "draft", reason: "对话中起草" }),
    },
    {
      definition: definition("care_send_propose", "提议给患者发送一条消息（或发送已有草稿 replyId）。只创建待确认提案，医生确认后才发送。不得包含诊断结论、处方或剂量调整。", { patientId: text, text, messageId: { type: "integer" }, replyId: text, channel, summary: text }, ["patientId", "text"]),
      execute: ({ patientId, text: body, messageId, replyId, channel: ch, summary }) =>
        propose("care-message", patientId, { text: body, messageId, replyId, channel: ch }, summary || `给患者发送消息：${body.slice(0, 40)}`),
    },
    {
      definition: definition("care_campaign_propose", "提议为患者建立自动随访（通过企业微信发给患者）。与 followup_create_propose（只提醒医生）不同。每步在 startDate + dayOffset 天的 time 发送 text 与 questions，回复窗口内自动收集并整理为随访记录。医生确认后才生效。", {
        patientId: text, name: text, startDate: { type: "string", description: "YYYY-MM-DD，默认今天" }, channel,
        replyWindowHours: { type: "integer", description: "默认 48" }, requireConfirm: { type: "boolean", description: "true 时每步只生成草稿，由医生逐条确认发送" },
        steps: { type: "array", items: { type: "object", properties: { dayOffset: { type: "integer" }, time: { type: "string", description: "HH:MM，默认 09:00" }, text, questions: { type: "array", items: text } }, required: ["dayOffset", "text"], additionalProperties: false } },
        summary: text,
      }, ["patientId", "name", "steps"]),
      execute: ({ patientId, summary, ...payload }) => propose("care-campaign", patientId, payload, summary || `建立随访计划「${payload.name}」（${payload.steps?.length || 0} 步）`),
    },
    {
      definition: definition("care_settings_propose", "提议修改自动回复/提醒设置。scope=global 时 changes 可含 autoReply{mode,categories,disclaimer}、alerts{notifyUserIds,escalateAfterMinutes}、redFlags{extra}、processing{enabled,modelConsent}；scope=patient 时 changes 可含 consent、autoReplyMode(inherit/off/draft/auto)、channel、kfExternalUserId。渠道密钥只能在设置页填写。医生确认后才生效。", {
        scope: { type: "string", enum: ["global", "patient"] }, patientId: text, changes: { type: "object" }, summary: text,
      }, ["scope", "changes"]),
      execute: ({ scope, patientId, changes, summary }) => propose("care-settings", scope === "patient" ? patientId : undefined, { scope, changes }, summary || (scope === "global" ? "修改患者管理设置" : "修改患者自动回复设置")),
    },
  ];
}
