import { followupDate } from "../../../shared/followup-display.mjs";
import { messageChannelLabel, messageSpeakerLabel } from "../../../shared/message-provenance.mjs";
import { usePluginEnabled } from "../../../src/plugin-slots.jsx";
import { WeComPanel } from "../../channel-wecom/ui/WeComPanel.jsx";
import { ChatFollowupsPanel } from "./ChatConnectionSettings.jsx";
import { AiConsentNote, useAiConsent } from "../../../src/ai-consent.jsx";
import "./followup-clarity.css";

const fmtDate = followupDate;

// The historical messages tab body. It stays a plugin component so disabling
// followup removes the tab and all of its panels together.
export default function PatientMessagesTab({
  patient: detail,
  config,
  messages,
  paste,
  setPaste,
  importMessages,
  digest,
  busy,
  consent,
}) {
  const wecomEnabled = usePluginEnabled("channel-wecom");
  const { granted: aiGranted } = useAiConsent();
  const unprocessed = detail.counts.unprocessedMessages || 0;
  const digestBlocked = !config?.modelConfigured
    ? "需先连接模型"
    : !unprocessed
      ? "暂无待整理消息"
      : !consent
        ? "需先勾选上方的外发授权"
        : "";
  return (
            <div className="detail-panel patient-messages">
              <header className="msg-head">
                <div>
                  <h2>消息记录</h2>
                  <p>{messages.length ? `共 ${messages.length} 条` : "暂无消息"}{unprocessed ? ` · ${unprocessed} 条待整理` : ""}</p>
                </div>
                <div className="digest-row digest-action">
                  <small className="muted">
                    {!unprocessed
                      ? "暂无待整理消息。"
                      : digestBlocked
                        ? `${unprocessed} 条待整理 · ${digestBlocked}。`
                        : "总结存入任务记录，只把本次纳入的消息标为已整理；回复草稿单独核对。"}
                  </small>
                  <button
                    className="primary"
                    disabled={busy || Boolean(digestBlocked)}
                    title={digestBlocked || undefined}
                    onClick={digest}
                  >
                    AI 总结
                  </button>
                  {aiGranted && config?.modelConfigured && <AiConsentNote />}
                </div>
              </header>
              <div className="msg-list">
                {messages.map((m) => (
                  <div className={`msg-row${m.processed ? "" : " is-unprocessed"}`} key={m.id}>
                    <span className={`msg-dir ${m.direction}`}>
                      {messageSpeakerLabel(m)}
                    </span>
                    <span>
                      {m.text}
                      <small>
                        {m.timeUnknown ? `时间待核对（原文：${m.rawTime || "未提供"}；导入于 ${fmtDate(m.collectedAt)}）` : fmtDate(m.time)} · {messageChannelLabel(m.channel)}
                        {m.processed ? " · 已整理" : ""}
                        {messageSpeakerLabel(m) === "身份待核对" ? " · 原记录未核实说话人" : ""}
                      </small>
                    </span>
                    {!m.processed && <em className="pill warn">待整理</em>}
                  </div>
                ))}
                {!messages.length && (
                  <p className="muted msg-empty">
                    还没有消息。可以直接粘贴聊天记录导入；连接微信后，新消息也会自动同步到这里。
                  </p>
                )}
              </div>
              <details className="msg-import" open={!messages.length}>
                <summary>粘贴导入聊天记录</summary>
                <label className="paste-box">
                  <b>粘贴消息记录</b>
                  <small className="muted">
                    直接粘贴整段聊天记录；按「时间 | 患者/医生 | 内容」逐行粘贴更精确。
                  </small>
                  <textarea
                    rows={4}
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    placeholder="2026-09-07 09:12 | 患者 | 今天血压 150/95，偶有头晕"
                  />
                  <button
                    className="secondary"
                    disabled={!paste.trim() || busy}
                    onClick={importMessages}
                  >
                    导入到该患者
                  </button>
                </label>
              </details>
              <ChatFollowupsPanel key={`chats-${detail.id}`} patients={[detail]} initialPatientId={detail.id} />
              {wecomEnabled && <WeComPanel key={`wecom-${detail.id}`} patientId={detail.id} />}
            </div>
  );
}
