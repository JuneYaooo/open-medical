import { messageChannelLabel, messageSpeakerLabel, messageTimeLabel } from "../../../shared/message-provenance.mjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Bell, Contact, Inbox, Loader2, MessageSquare, RefreshCw, Send, Settings2, Stethoscope, UserCog } from "lucide-react";
import { api } from "../../../src/agent-runtime";
import { Modal } from "../../../src/components";
import { takePluginIntent } from "../../../src/plugin-navigation";
import { CareContacts } from "../../channel-wecom/ui/CareContacts.jsx";
import { CareSetup } from "./CareSetup.jsx";
import { usePluginConnected } from "../../../src/plugin-slots.jsx";
import "../../../src/care.css";
import "./followup-clarity.css";

const TABS = [["alerts", "提醒", Bell], ["drafts", "待回复草稿", MessageSquare], ["messages", "全部消息", Inbox], ["contacts", "客户与群", Contact], ["settings", "设置", Settings2]];
const LEVEL = { urgent: "紧急", attention: "需关注", routine: "常规" };
const CATEGORY = { emergency: "急症", clinical: "病情", medication: "用药", report: "报告", education: "科普", admin: "行政", followup_reply: "随访回复", survey_reply: "问卷回复", chitchat: "寒暄", other: "其他" };
const STATUS = { pending: "待分诊", unassigned: "未关联患者", auto_replied: "已自动回复", drafted: "已生成草稿", alerted: "已提醒医生", recorded: "已记录", handled: "已处理", skipped: "已跳过", failed: "处理失败" };
const STEP = { scheduled: "待发送", draft: "草稿待发送", sending: "发送中", sent: "已发送", awaiting_member: "待成员确认", unknown: "发送结果未知", replied: "已回复", recorded: "已记录", no_reply: "未回复", failed: "失败", skipped: "已跳过", cancelled: "已取消" };
const CAMPAIGN = { active: "进行中", paused: "已暂停", completed: "已完成", cancelled: "已取消" };
const AUTO_CATEGORIES = [["education", "科普问答"], ["admin", "就诊/行政"], ["followup_reply", "随访回复确认"], ["chitchat", "寒暄致谢"]];
const MODES = [["off", "关闭", "只记录、分诊和提醒，不生成回复"], ["draft", "草稿（推荐）", "生成回复草稿，由你一键发送"], ["auto", "自动", "科普/行政类在允许的渠道自动发送，其余转草稿或提醒"]];
const fmt = (value) => value ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

function Empty({ children }) {
  return <div className="care-empty"><p>{children}</p></div>;
}

// The agenda/overview publish a generic intent; this plugin owns the tab
// grammar and defaults.
function takeCareTab() {
  const intent = takePluginIntent("followup", "care-tab") || {};
  const tab = TABS.some(([id]) => id === intent.tab) ? intent.tab : "alerts";
  return { tab, ...(["alerts", "drafts", "messages"].includes(tab) && typeof intent.patientId === "string" && intent.patientId ? { patientId: intent.patientId, patientName: intent.patientName } : {}) };
}

export function CareInbox({ onOpenPatient }) {
  const [intent] = useState(takeCareTab);
  const [tab, setTab] = useState(intent.tab);
  const [patientFilter, setPatientFilter] = useState(intent.patientId ? { id: intent.patientId, name: intent.patientName } : null);
  const loadGeneration = useRef(0);
  const [overview, setOverview] = useState(null);
  const [data, setData] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [sending, setSending] = useState(null);
  const [patientSettings, setPatientSettings] = useState(null);
  const [patients, setPatients] = useState(null);
  const [setupOpen, setSetupOpen] = useState(() => Boolean(takePluginIntent("followup", "care-setup")));
  const [setupLater, setSetupLater] = useState(() => { try { return sessionStorage.getItem("omw-care-setup-later") === "1"; } catch { return false; } });
  // The banner follows the host's verdict: any connected patient channel
  // (desktop WeChat, WeCom bot, archive…) counts, not only the WeCom 客服 pieces.
  const connected = usePluginConnected("followup");

  const load = useCallback(async () => {
    const request = ++loadGeneration.current;
    const paths = { alerts: "/api/care/alerts?status=open", drafts: "/api/care/replies?status=draft", messages: "/api/care/inbox?limit=100", settings: "/api/care/settings" };
    const path = paths[tab] && `${paths[tab]}${patientFilter && ["alerts", "drafts", "messages"].includes(tab) ? `&patientId=${encodeURIComponent(patientFilter.id)}` : ""}`;
    try {
      const [ov, value] = await Promise.all([api("/api/care/overview"), path ? api(path) : null]);
      if (request !== loadGeneration.current) return;
      setOverview(ov);
      if (value) setData((d) => ({ ...d, [tab]: value }));
      setError("");
    } catch (e) { if (request === loadGeneration.current) setError(e.message); }
  }, [tab, patientFilter]);

  useEffect(() => {
    load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, 15000);
    return () => { loadGeneration.current++; clearInterval(timer); };
  }, [load]);

  useEffect(() => {
    if (tab !== "messages" || patients) return;
    api("/api/patients?summary=1").then((value) => setPatients(value.patients || [])).catch(() => setPatients([]));
  }, [tab, patients]);

  async function act(key, run, message) {
    setBusy(key); setError(""); setNotice("");
    try { await run(); if (message) setNotice(message); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  }

  const stats = overview?.stats || {};
  const counts = patientFilter ? {} : { alerts: stats.openAlerts, drafts: stats.drafts, contacts: stats.contactMatches };
  return <main id="main" className="work-directory care-inbox">
    <header className="directory-heading om-page-head care-head"><div><h1>患者消息</h1>
      <span className="om-page-meta">{overview ? [stats.openAlerts ? `${stats.openAlerts} 条提醒待处理` : "暂无未处理提醒", stats.drafts ? `${stats.drafts} 份草稿待发送` : "", stats.pending ? `${stats.pending} 条消息待处理` : ""].filter(Boolean).join(" · ") : "正在读取…"}</span></div></header>
    {patientFilter && <section className="care-notice" aria-label="患者筛选"><span>当前患者：{patientFilter.name || patientFilter.id}</span><button type="button" className="text-button" onClick={() => { loadGeneration.current++; setData({}); setError(""); setPatientFilter(null); }}>清除患者筛选</button></section>}
    {!connected && !setupLater && <section className="care-setup-banner" aria-label="企业微信接入">
      <div><strong>患者消息连接尚未就绪</strong>
        <span>新消息不会自动进入；可先在患者「消息记录」中粘贴聊天记录整理随访。</span></div>
      <button type="button" className="primary" onClick={() => setSetupOpen(true)}>查看连接方式</button>
      <button type="button" className="secondary" onClick={() => { setSetupLater(true); try { sessionStorage.setItem("omw-care-setup-later", "1"); } catch { /* storage unavailable */ } }}>稍后</button>
    </section>}
    {setupOpen && <CareSetup onClose={() => { setSetupOpen(false); load(); }} />}
    {!patientFilter && <section className="care-stats" aria-label="今日统计（全部患者）">
      {[["未处理提醒", stats.openAlerts, stats.urgentAlerts ? "urgent" : stats.openAlerts ? "attention" : "", stats.urgentAlerts ? `其中 ${stats.urgentAlerts} 条紧急` : ""], ["待处理消息", stats.pending, stats.pending ? "attention" : ""], ["待发送草稿", stats.drafts, stats.drafts ? "attention" : ""], ["今日消息", stats.messagesToday], ["今日自动回复", stats.autoRepliedToday], ["进行中随访", stats.activeCampaigns]].filter(([, value], index) => index < 4 || value > 0).map(([label, value, tone, note]) =>
        <div key={label} className={`care-stat ${tone || ""}`}><span>{label}</span><strong>{value ?? "—"}</strong>{note && <small>{note}</small>}</div>)}
    </section>}
    {overview && <details className="care-channel-details"><summary>连接状态 · {MODES.find(([id]) => id === overview.settings?.autoReply?.mode)?.[1] || "未设置"}</summary><div className="care-channels">
      自动回复：<b>{MODES.find(([id]) => id === overview.settings?.autoReply?.mode)?.[1] || "未设置"}</b>
      {(overview.channels || []).map((c) => <span key={c.id} className={c.configured ? "ok" : ""}>{c.label}{c.configured ? (c.autoSend ? " · 可自动发送" : " · 需确认发送") : " · 未配置"}</span>)}
      {overview.channels?.find((c) => c.id === "wecom-kf")?.configured && <button className="secondary care-sync" disabled={Boolean(busy)}
        onClick={() => act("sync", async () => { const r = await api("/api/care/sync", "POST", {}); setNotice(`已同步 ${r.synced || 0} 条新消息。`); })}><RefreshCw size={14} />同步微信客服</button>}
      {overview.kfSync?.polling && <span className={overview.kfSync.lastError ? "care-warn" : ""}>{overview.kfSync.lastError ? `微信客服拉取失败：${overview.kfSync.lastError}` : `微信客服每 ${overview.kfSync.pollSeconds} 秒自动拉取 · 上次 ${fmt(overview.kfSync.lastSyncAt)}`}</span>}
      {overview.processing && <span>{overview.processing.enabled ? `处理中 · 上次 ${fmt(overview.processing.lastTickAt)}` : "自动处理已暂停"}</span>}
    </div></details>}
    {overview?.kfSync?.lastError && <p role="alert" className="care-error">微信客服拉取失败：{overview.kfSync.lastError}</p>}
    {overview?.processing && !overview.processing.enabled && <p role="status" className="care-notice">自动处理已暂停</p>}
    <nav className="care-tabs" aria-label="患者消息分类">
      {TABS.map(([id, label, Icon]) => <button key={id} aria-pressed={tab === id} onClick={() => { if (id === tab) { load(); return; } loadGeneration.current++; setData({}); setError(""); setTab(id); if (["settings", "contacts"].includes(id)) setPatientFilter(null); }}><Icon size={16} />{label}{counts[id] ? <em>{counts[id]}</em> : null}</button>)}
    </nav>
    {error && <p role="alert" className="care-error">{error}<button type="button" className="text-button" onClick={load}>重试</button></p>}
    {notice && <p role="status" className="care-notice">{notice}</p>}
    {!data[tab] && tab !== "contacts" && !error && <p role="status" className="care-loading"><Loader2 size={16} className="spin" />正在读取…</p>}
    {tab === "alerts" && data.alerts && <AlertList alerts={data.alerts.alerts || []} busy={busy} onOpenPatient={onOpenPatient}
      onAction={(a, action) => act(a.id + action, () => api(`/api/care/alerts/${a.id}/${action}`, "POST", {}), action === "resolve" ? "提醒已标记解决。" : "提醒已确认。")} />}
    {tab === "drafts" && data.drafts && <DraftList replies={data.drafts.replies || []} busy={busy} onOpenPatient={onOpenPatient}
      onSave={(r, text) => act(r.id + "save", () => api(`/api/care/replies/${r.id}`, "PUT", { text }), "草稿已保存。")}
      onSend={(r) => setSending(r)}
      onDiscard={(r) => act(r.id + "discard", () => api(`/api/care/replies/${r.id}/discard`, "POST", {}), "草稿已丢弃。")} />}
    {tab === "messages" && data.messages && <MessageList messages={data.messages.messages || []} busy={busy} onOpenPatient={onOpenPatient} patients={patients || []}
      onPatientSettings={(m) => setPatientSettings({ id: m.patientId, name: m.patientName })}
      onAssign={(m, patientId) => act(m.id + "assign", () => api(`/api/care/messages/${m.id}/assign`, "POST", { patientId }), "已关联患者，后续该客户的消息会自动归档到此患者。")}
      onProcess={(m) => act(m.id + "process", () => api(`/api/care/messages/${m.id}/process`, "POST", {}), "已重新分诊。")}
      onMark={(m) => act(m.id + "mark", () => api(`/api/care/messages/${m.id}/mark`, "POST", { status: "handled" }), "已标记处理。")} />}
    {tab === "contacts" && <CareContacts onOpenPatient={onOpenPatient} onSetup={() => setSetupOpen(true)} />}
    {tab === "settings" && data.settings && <CareSettings key={JSON.stringify(data.settings)} settings={data.settings} busy={busy === "settings"} onSetup={() => setSetupOpen(true)}
      onSave={(value) => act("settings", () => api("/api/care/settings", "PUT", value), "设置已保存，新消息将按此处理。")} />}
    {patientSettings && <PatientCareSettings patient={patientSettings} onClose={() => setPatientSettings(null)} onSaved={() => { setPatientSettings(null); setNotice("患者自动回复设置已保存。"); load(); }} />}
    {sending && <Modal title="确认发送给患者" onClose={() => setSending(null)}>
      <div className="care-confirm">
        <p>收件人：<b>{sending.patientName || "患者"}</b> · 渠道：{sending.channel || "默认渠道"}</p>
        <pre>{sending.text}</pre>
        <p className="care-hint">发送后无法撤回。需成员确认的渠道会在企业微信生成待发送任务。</p>
        <footer><button className="secondary" onClick={() => setSending(null)}>取消</button>
          <button className="primary" disabled={Boolean(busy)} onClick={() => { const r = sending; setSending(null); act(r.id + "send", () => api(`/api/care/replies/${r.id}/send`, "POST", { confirmed: true }), "已提交发送。"); }}><Send size={15} />确认发送</button></footer>
      </div>
    </Modal>}
  </main>;
}

function PatientLink({ id, name, onOpenPatient }) {
  if (!id) return <span className="care-patient unassigned">未关联患者</span>;
  return <button className="care-patient" onClick={() => onOpenPatient?.(id)}><Stethoscope size={14} />{name || "患者档案"}</button>;
}

function AlertList({ alerts, busy, onAction, onOpenPatient }) {
  if (!alerts.length) return <Empty>没有未处理的提醒。命中红旗症状或需要医生判断的消息会出现在这里。</Empty>;
  return <ul className="care-list">{alerts.map((a) => <li key={a.id} className={`care-card level-${a.level}`}>
    <header><span className={`care-level ${a.level}`}><AlertTriangle size={14} />{LEVEL[a.level] || a.level}</span><PatientLink id={a.patientId} name={a.patientName} onOpenPatient={onOpenPatient} /><time>{fmt(a.createdAt)}</time></header>
    <p className="care-reason">{a.reason}</p>
    {a.messageText && <blockquote>{a.messageText}</blockquote>}
    <footer>
      {a.status === "open" && <button className="secondary" disabled={Boolean(busy)} onClick={() => onAction(a, "acknowledge")}>我已知晓</button>}
      <button className="primary" disabled={Boolean(busy)} onClick={() => onAction(a, "resolve")}>已处理</button>
    </footer>
  </li>)}</ul>;
}

function DraftList({ replies, busy, onSave, onSend, onDiscard, onOpenPatient }) {
  if (!replies.length) return <Empty>没有待发送的回复草稿。</Empty>;
  return <ul className="care-list">{replies.map((r) => <DraftCard key={r.id + r.text} reply={r} busy={busy} onSave={onSave} onSend={onSend} onDiscard={onDiscard} onOpenPatient={onOpenPatient} />)}</ul>;
}

function DraftCard({ reply, busy, onSave, onSend, onDiscard, onOpenPatient }) {
  const [text, setText] = useState(reply.text || "");
  const dirty = text !== reply.text;
  return <li className="care-card">
    <header><PatientLink id={reply.patientId} name={reply.patientName} onOpenPatient={onOpenPatient} /><span className="care-tag">{reply.mode === "campaign" ? "随访" : "回复"} · {reply.channel === "manual" ? "人工发送" : messageChannelLabel(reply.channel)}</span><time>{fmt(reply.createdAt)}</time></header>
    {reply.reason && <p className="care-reason">{reply.reason}</p>}
    <textarea aria-label="回复内容" rows={Math.min(10, Math.max(3, text.split("\n").length + 1))} value={text} onChange={(e) => setText(e.target.value)} />
    {reply.sources?.length > 0 && <p className="care-sources">依据：{reply.sources.map((s) => <span key={s.id}>{s.title || s.id}</span>)}</p>}
    {reply.detail && <p className="care-hint">{reply.detail}</p>}
    <footer>
      <button className="text-button care-discard" disabled={Boolean(busy)} onClick={() => onDiscard(reply)}>丢弃</button>
      {dirty && <button className="secondary" disabled={Boolean(busy) || !text.trim()} onClick={() => onSave(reply, text)}>保存修改</button>}
      <button className="primary" disabled={Boolean(busy) || dirty || !text.trim()} title={dirty ? "请先保存修改" : undefined} onClick={() => onSend(reply)}><Send size={15} />发送</button>
    </footer>
  </li>;
}

function AssignControl({ message, patients, busy, onAssign }) {
  const [patientId, setPatientId] = useState("");
  return <span className="care-assign">
    <select aria-label="关联到患者" value={patientId} onChange={(e) => setPatientId(e.target.value)}>
      <option value="">选择患者…</option>
      {patients.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
    <button className="secondary" disabled={Boolean(busy) || !patientId} onClick={() => onAssign(message, patientId)}>关联患者</button>
  </span>;
}

function MessageList({ messages, patients, busy, onProcess, onMark, onAssign, onPatientSettings, onOpenPatient }) {
  if (!messages.length) return <Empty>还没有患者消息。微信桌面读取和导入的聊天记录在患者「消息记录」或「随访 → 聊天随访」中核对归档。</Empty>;
  return <ul className="care-list compact">{messages.map((m) => {
    const s = m.state || {};
    return <li key={m.id} className={`care-card level-${s.level || "routine"}`}>
      <header><PatientLink id={m.patientId} name={m.patientName} onOpenPatient={onOpenPatient} /><span className="care-tag">{m.direction === "out" ? "发出" : "收到"} · {messageSpeakerLabel(m)} · {messageChannelLabel(m.channel)}</span>
        {s.level && s.level !== "routine" && <span className={`care-level ${s.level}`}>{LEVEL[s.level]}</span>}
        {s.category && <span className="care-tag">{CATEGORY[s.category] || s.category}</span>}
        <span className="care-status">{STATUS[s.status] || s.status || "—"}</span><time>{m.timeUnknown ? messageTimeLabel(m) : fmt(m.time)}</time></header>
      <p className="care-text">{m.text}</p>
      {messageSpeakerLabel(m) === "身份待核对" && <p className="care-hint">原记录未核实说话人。</p>}
      {m.attachments?.length > 0 && <p className="care-sources">附件：{m.attachments.map((f, i) => <span key={i}>{f.name || f.type}</span>)}</p>}
      {s.reasons?.length > 0 && <p className="care-hint">{s.reasons.join("；")}</p>}
      {m.direction !== "out" && <footer>
        {!m.patientId && <AssignControl message={m} patients={patients} busy={busy} onAssign={onAssign} />}
        {m.patientId && <button className="secondary" disabled={Boolean(busy)} onClick={() => onPatientSettings(m)}><UserCog size={15} />患者设置</button>}
        {m.patientId && <button className="secondary" disabled={Boolean(busy)} onClick={() => onProcess(m)}>重新分诊</button>}
        {!["handled", "skipped"].includes(s.status) && <button className="secondary" disabled={Boolean(busy)} onClick={() => onMark(m)}>标记已处理</button>}
      </footer>}
    </li>;
  })}</ul>;
}

// Automatic follow-up plans: sent to the patient on schedule, replies are
// collected and written into the follow-up records. Used on the 随访 page
// (all patients) and in a patient's 随访计划 tab.
export function CampaignPanel({ patientId, onOpenPatient }) {
  const [campaigns, setCampaigns] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => api(`/api/care/campaigns${patientId ? `?patientId=${encodeURIComponent(patientId)}` : ""}`).then((r) => setCampaigns(r.campaigns || [])).catch((e) => setError(e.message)), [patientId]);
  useEffect(() => { load(); }, [load]);
  const onAction = async (c, action) => {
    if (action === "cancel" && !window.confirm(`取消「${c.name}」？尚未发送的消息和草稿将一并撤回。`)) return;
    setBusy(c.id + action); setError("");
    try { await api(`/api/care/campaigns/${c.id}/${action}`, "POST", {}); await load(); } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  if (!campaigns) return error ? <p className="form-error" role="alert">{error}</p> : <p role="status">正在读取自动随访…</p>;
  return <>{error && <p className="form-error" role="alert">{error}</p>}<CampaignList campaigns={campaigns} busy={busy} onAction={onAction} onOpenPatient={patientId ? null : onOpenPatient} /></>;
}

function CampaignList({ campaigns, busy, onAction, onOpenPatient }) {
  if (!campaigns.length) return <div className="care-empty"><p>还没有自动随访。</p><p className="care-hint">在对话中说「给张三安排一个术后 30 天随访」，确认后会按天通过企业微信发送问题、收集回复，并自动写入随访记录。</p></div>;
  return <ul className="care-list">{campaigns.map((c) => <li key={c.id} className="care-card">
    <header><strong>{c.name}</strong>{onOpenPatient && <PatientLink id={c.patientId} name={c.patientName} onOpenPatient={onOpenPatient} />}<span className="care-status">{CAMPAIGN[c.status] || c.status}</span>{c.detail && <span className="care-hint">{c.detail}</span>}<span className="care-tag">开始 {c.startDate} · {c.channel || "默认渠道"}</span></header>
    <ol className="care-steps">{(c.steps || []).map((s) => <li key={s.id} className={`step-${s.status}`}>
      <div><b>第 {s.dayOffset} 天</b>{s.time ? ` ${s.time}` : ""}<span className="care-status">{STEP[s.status] || s.status}</span><time>{fmt(s.sentAt || s.dueAt)}</time></div>
      <p>{s.text}</p>
      {s.questions?.length > 0 && <p className="care-hint">收集：{s.questions.join("、")}</p>}
      {s.detail && !["sent", "recorded", "replied"].includes(s.status) && <p className="care-hint">{s.detail}</p>}
      {s.result?.summary && <p className={`care-result ${s.result.needsDoctor ? "attention" : ""}`}>{s.result.needsDoctor && <AlertTriangle size={14} />}{s.result.summary}</p>}
    </li>)}</ol>
    <footer>
      {c.status === "active" && <button className="secondary" disabled={Boolean(busy)} onClick={() => onAction(c, "pause")}>暂停</button>}
      {c.status === "paused" && <button className="secondary" disabled={Boolean(busy)} onClick={() => onAction(c, "resume")}>恢复</button>}
      {["active", "paused"].includes(c.status) && <button className="secondary" disabled={Boolean(busy)} onClick={() => onAction(c, "cancel")}>取消计划</button>}
    </footer>
  </li>)}</ul>;
}

function CareSettings({ settings, busy, onSave, onSetup }) {
  const [form, setForm] = useState(() => ({
    autoReply: { mode: "draft", categories: [], disclaimer: true, ...settings.autoReply },
    alerts: { notifyUserIds: [], escalateAfterMinutes: 30, ...settings.alerts },
    redFlags: { extra: [], ...settings.redFlags },
    processing: { enabled: true, modelConsent: false, ...settings.processing },
  }));
  const set = (section, changes) => setForm((f) => ({ ...f, [section]: { ...f[section], ...changes } }));
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(null);
  async function testConnection() {
    setTesting(true);
    try { setTested(await api("/api/care/settings/test", "POST", {})); }
    catch (e) { setTested({ error: e.message }); }
    finally { setTesting(false); }
  }
  const kfSync = settings.channels?.kfSync;
  const toggleCategory = (id) => set("autoReply", { categories: form.autoReply.categories.includes(id) ? form.autoReply.categories.filter((c) => c !== id) : [...form.autoReply.categories, id] });
  return <form className="care-settings" onSubmit={(e) => { e.preventDefault(); onSave(form); }}>
    <fieldset disabled={busy}>
      <legend>自动回复模式</legend>
      {MODES.map(([id, label, hint]) => <label key={id} className="care-check"><input type="radio" name="care-mode" checked={form.autoReply.mode === id} onChange={() => set("autoReply", { mode: id })} /><span>{label}<small>{hint}</small></span></label>)}
      <p className="care-hint">红旗症状（胸痛、呼吸困难、意识改变等）始终立即提醒你，不受此设置影响；未确认知情同意的患者不会被自动回复。</p>
    </fieldset>
    <fieldset disabled={busy}>
      <legend>允许自动回复的类别</legend>
      {AUTO_CATEGORIES.map(([id, label]) => <label key={id} className="care-check"><input type="checkbox" checked={form.autoReply.categories.includes(id)} onChange={() => toggleCategory(id)} /><span>{label}</span></label>)}
      <label className="care-check"><input type="checkbox" checked={form.autoReply.disclaimer} onChange={(e) => set("autoReply", { disclaimer: e.target.checked })} /><span>回复末尾附 AI 提示<small>（AI 助手回复，仅供参考；如症状加重请及时就医或联系医生）</small></span></label>
    </fieldset>
    <fieldset disabled={busy}>
      <legend>提醒</legend>

      <label>未处理多久后再次提醒（分钟）<input type="number" min="5" max="1440" value={form.alerts.escalateAfterMinutes} onChange={(e) => set("alerts", { escalateAfterMinutes: Number(e.target.value) })} /></label>
      <label>自定义关注词（出现即提醒，逗号分隔）<input value={form.redFlags.extra.join(",")} onChange={(e) => set("redFlags", { extra: e.target.value.split(/[,，]+/).map((w) => w.trim()).filter(Boolean) })} placeholder="如：伤口渗液,黄疸" /></label>
    </fieldset>
    <fieldset disabled={busy}>
      <legend>企业微信连接</legend>
      <button type="button" className="secondary care-setup-start" onClick={onSetup}>查看患者消息连接</button>
      {kfSync?.polling && <p className="care-hint">微信客服：每 {kfSync.pollSeconds} 秒自动拉取 · 上次成功 {fmt(kfSync.lastSyncAt)}{kfSync.lastError ? ` · 最近错误：${kfSync.lastError}（下次 ${fmt(kfSync.nextAt)}）` : ""}</p>}
      <div className="care-test">
        <button type="button" className="secondary" disabled={testing} onClick={testConnection}>{testing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}测试已保存的连接</button>
        <small className="care-hint">检查现有连接状态，不发送消息。</small>
      </div>
      {tested?.error && <p role="alert" className="care-error">{tested.error}</p>}
      {tested?.results && <ul className="care-test-results">{tested.results.map((r) => <li key={r.id} className={r.ok === true ? "ok" : r.ok === false ? "bad" : ""}><b>{r.label}</b>{r.ok === true ? "✓ " : r.ok === false ? "✗ " : "— "}{r.detail}</li>)}</ul>}
    </fieldset>
    <fieldset disabled={busy}>
      <legend>处理</legend>
      <label className="care-check"><input type="checkbox" checked={form.processing.enabled} onChange={(e) => set("processing", { enabled: e.target.checked })} /><span>自动处理新消息与到期随访<small>关闭后只记录消息，不分诊、不发送。</small></span></label>
      <label className="care-check"><input type="checkbox" checked={form.processing.modelConsent} onChange={(e) => set("processing", { modelConsent: e.target.checked })} /><span>允许把患者消息发送给已配置的模型做分诊与起草<small>发送内容不含姓名和电话；未开启时只做规则识别（红旗症状仍会提醒）。</small></span></label>
    </fieldset>
    <footer><button type="submit" className="primary" disabled={busy}>{busy ? "正在保存…" : "保存设置"}</button></footer>
  </form>;
}

const PATIENT_MODES = [["inherit", "跟随全局设置"], ["off", "关闭"], ["draft", "仅草稿"], ["auto", "允许自动发送"]];
const CHANNELS = [["", "自动选择"], ["wecom-kf", "微信客服"], ["wecom-contact", "客户联系（成员确认）"], ["manual", "手动发送"]];

export function PatientCareSettings({ patient, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api(`/api/care/patients/${patient.id}/settings`).then((s) => setForm({ consent: Boolean(s.consent), consentAt: s.consentAt, autoReplyMode: s.autoReplyMode || "inherit", channel: s.channel || "", kfExternalUserId: s.kfExternalUserId || "" })).catch((e) => setError(e.message));
  }, [patient.id]);
  async function save(e) {
    e.preventDefault(); setSaving(true); setError("");
    try {
      await api(`/api/care/patients/${patient.id}/settings`, "PUT", { consent: form.consent, autoReplyMode: form.autoReplyMode, channel: form.channel || null, kfExternalUserId: form.kfExternalUserId.trim() || null });
      onSaved?.();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  const set = (changes) => setForm((f) => ({ ...f, ...changes }));
  return <Modal title={`${patient.name || "患者"} · 自动回复设置`} onClose={onClose}>
    {!form && !error && <p role="status" className="care-loading"><Loader2 size={16} className="spin" />正在读取…</p>}
    {error && <p role="alert" className="care-error">{error}</p>}
    {form && <form className="care-settings" onSubmit={save}>
      <fieldset disabled={saving}>
        <label className="care-check"><input type="checkbox" checked={form.consent} onChange={(e) => set({ consent: e.target.checked })} /><span>患者已知情同意接收 AI 辅助回复<small>{form.consentAt ? `上次变更：${fmt(form.consentAt)}` : "未同意时只生成草稿，不会自动发送。"}</small></span></label>
        <label>自动回复<select value={form.autoReplyMode} onChange={(e) => set({ autoReplyMode: e.target.value })}>{PATIENT_MODES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>发送渠道<select value={form.channel} onChange={(e) => set({ channel: e.target.value })}>{CHANNELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <p>患者的客服会话会在关联消息时自动识别。</p>
      </fieldset>
      <footer><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" className="primary" disabled={saving}>{saving ? "正在保存…" : "保存"}</button></footer>
    </form>}
  </Modal>;
}
