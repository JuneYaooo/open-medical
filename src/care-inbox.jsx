import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bell, Inbox, Loader2, MessageSquare, RefreshCw, Send, Settings2, Stethoscope, UserCog } from "lucide-react";
import { api } from "./agent-runtime";
import { Modal } from "./components";
import { CareSetup, setupProgress, takeCareSetupRequest } from "./care-setup";
import "./care.css";

const TABS = [["alerts", "提醒", Bell], ["drafts", "待回复草稿", MessageSquare], ["messages", "全部消息", Inbox], ["settings", "设置", Settings2]];
const LEVEL = { urgent: "紧急", attention: "需关注", routine: "常规" };
const CATEGORY = { emergency: "急症", clinical: "病情", medication: "用药", report: "报告", education: "科普", admin: "行政", followup_reply: "随访回复", chitchat: "寒暄", other: "其他" };
const STATUS = { pending: "待分诊", unassigned: "未关联患者", auto_replied: "已自动回复", drafted: "已生成草稿", alerted: "已提醒医生", recorded: "已记录", handled: "已处理", skipped: "已跳过", failed: "处理失败" };
const STEP = { scheduled: "待发送", draft: "草稿待发送", sending: "发送中", sent: "已发送", awaiting_member: "待成员确认", unknown: "发送结果未知", replied: "已回复", recorded: "已记录", no_reply: "未回复", failed: "失败", skipped: "已跳过", cancelled: "已取消" };
const CAMPAIGN = { active: "进行中", paused: "已暂停", completed: "已完成", cancelled: "已取消" };
const AUTO_CATEGORIES = [["education", "科普问答"], ["admin", "就诊/行政"], ["followup_reply", "随访回复确认"], ["chitchat", "寒暄致谢"]];
const MODES = [["off", "关闭", "只记录、分诊和提醒，不生成回复"], ["draft", "草稿（推荐）", "生成回复草稿，由你一键发送"], ["auto", "自动", "科普/行政类在允许的渠道自动发送，其余转草稿或提醒"]];
const fmt = (value) => value ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

function Empty({ children }) {
  return <div className="care-empty"><p>{children}</p><p className="care-hint">消息来源：企业微信微信客服回调、会话存档采集器，或通过 <code>/api/ingest/messages</code> 导入。也可以在对话中问「今天有哪些患者消息需要我处理？」。</p></div>;
}

export function CareInbox({ onOpenPatient }) {
  const [tab, setTab] = useState("alerts");
  const [overview, setOverview] = useState(null);
  const [data, setData] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [sending, setSending] = useState(null);
  const [patientSettings, setPatientSettings] = useState(null);
  const [patients, setPatients] = useState(null);
  const [setupOpen, setSetupOpen] = useState(takeCareSetupRequest);
  const [setup, setSetup] = useState(null);
  const [setupLater, setSetupLater] = useState(() => { try { return sessionStorage.getItem("omw-care-setup-later") === "1"; } catch { return false; } });
  const loadSetup = useCallback(() => api("/api/care/settings").then((value) => setSetup(setupProgress(value))).catch(() => {}), []);
  useEffect(() => { loadSetup(); }, [loadSetup]);

  const load = useCallback(async () => {
    const paths = { alerts: "/api/care/alerts?status=open", drafts: "/api/care/replies?status=draft", messages: "/api/care/inbox?limit=100", settings: "/api/care/settings" };
    try {
      const [ov, value] = await Promise.all([api("/api/care/overview"), api(paths[tab])]);
      setOverview(ov);
      setData((d) => ({ ...d, [tab]: value }));
      setError("");
    } catch (e) { setError(e.message); }
  }, [tab]);

  useEffect(() => {
    load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, 15000);
    return () => clearInterval(timer);
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
  const counts = { alerts: stats.openAlerts, drafts: stats.drafts };
  return <main id="main" className="work-directory care-inbox">
    <header className="directory-heading"><div><h1>患者消息</h1><p>实时记录企业微信患者消息；AI 分诊、科普回复草稿、重要消息提醒与自动随访。所有操作也可以直接在对话中完成。</p></div></header>
    {setup && !setup.essential && !setupLater && <section className="care-setup-banner" aria-label="企业微信接入">
      <div><strong>{setup.count ? "企业微信还没接入完成" : "先接入企业微信，才能自动收集和回复患者消息"}</strong>
        <span>已完成 {setup.count}/{setup.total} 项 · 约 10 分钟，按向导一步步在企业微信管理后台操作</span></div>
      <button type="button" className="primary" onClick={() => setSetupOpen(true)}>{setup.count ? "继续设置" : "开始设置"}</button>
      <button type="button" className="secondary" onClick={() => { setSetupLater(true); try { sessionStorage.setItem("omw-care-setup-later", "1"); } catch { /* storage unavailable */ } }}>稍后</button>
    </section>}
    {setupOpen && <CareSetup onClose={() => { setSetupOpen(false); loadSetup(); load(); }} onChanged={loadSetup} />}
    <section className="care-stats" aria-label="今日统计">
      {[["今日消息", stats.messagesToday], ["待处理", stats.pending], ["未处理提醒", stats.openAlerts, stats.urgentAlerts ? "urgent" : ""], ["今日自动回复", stats.autoRepliedToday], ["待发送草稿", stats.drafts], ["进行中随访", stats.activeCampaigns]].map(([label, value, tone]) =>
        <div key={label} className={`care-stat ${tone || ""}`}><strong>{value ?? "—"}</strong><span>{label}</span></div>)}
    </section>
    {overview && <p className="care-channels">
      自动回复：<b>{MODES.find(([id]) => id === overview.settings?.autoReply?.mode)?.[1] || "未设置"}</b>
      {(overview.channels || []).map((c) => <span key={c.id} className={c.configured ? "ok" : ""}>{c.label}{c.configured ? (c.autoSend ? " · 可自动发送" : " · 需确认发送") : " · 未配置"}</span>)}
      {overview.channels?.find((c) => c.id === "wecom-kf")?.configured && <button className="secondary care-sync" disabled={Boolean(busy)}
        onClick={() => act("sync", async () => { const r = await api("/api/care/sync", "POST", {}); setNotice(`已同步 ${r.synced || 0} 条新消息。`); })}><RefreshCw size={14} />同步微信客服</button>}
      {overview.kfSync?.polling && <span className={overview.kfSync.lastError ? "care-warn" : ""}>{overview.kfSync.lastError ? `微信客服拉取失败：${overview.kfSync.lastError}` : `微信客服每 ${overview.kfSync.pollSeconds} 秒自动拉取 · 上次 ${fmt(overview.kfSync.lastSyncAt)}`}</span>}
      {overview.processing && <span>{overview.processing.enabled ? `处理中 · 上次 ${fmt(overview.processing.lastTickAt)}` : "自动处理已暂停"}</span>}
    </p>}
    <nav className="care-tabs" aria-label="患者消息分类">
      {TABS.map(([id, label, Icon]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}><Icon size={16} />{label}{counts[id] ? <em>{counts[id]}</em> : null}</button>)}
    </nav>
    {error && <p role="alert" className="care-error">{error}</p>}
    {notice && <p role="status" className="care-notice">{notice}</p>}
    {!data[tab] && !error && <p role="status" className="care-loading"><Loader2 size={16} className="spin" />正在读取…</p>}
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
    {tab === "settings" && data.settings && <CareSettings key={JSON.stringify(data.settings)} settings={data.settings} busy={busy === "settings"} onSetup={() => setSetupOpen(true)}
      onSave={(value) => act("settings", () => api("/api/care/settings", "PUT", value), "设置已保存，新消息将按此处理。")} />}
    {patientSettings && <PatientCareSettings patient={patientSettings} onClose={() => setPatientSettings(null)} onSaved={() => { setPatientSettings(null); setNotice("患者自动回复设置已保存。"); load(); }} />}
    {sending && <Modal title="确认发送给患者" onClose={() => setSending(null)}>
      <div className="care-confirm">
        <p>收件人：<b>{sending.patientName || "患者"}</b> · 渠道：{sending.channel || "默认渠道"}</p>
        <pre>{sending.text}</pre>
        <p className="care-hint">发送后无法撤回。需成员确认的渠道会在企业微信生成待发送任务。</p>
        <footer><button className="secondary" onClick={() => setSending(null)}>取消</button>
          <button disabled={Boolean(busy)} onClick={() => { const r = sending; setSending(null); act(r.id + "send", () => api(`/api/care/replies/${r.id}/send`, "POST", { confirmed: true }), "已提交发送。"); }}><Send size={15} />确认发送</button></footer>
      </div>
    </Modal>}
  </main>;
}

function PatientLink({ id, name, onOpenPatient }) {
  if (!id) return <span className="care-patient unassigned">未关联患者</span>;
  return <button className="care-patient" onClick={() => onOpenPatient?.(id)}><Stethoscope size={14} />{name || "患者档案"}</button>;
}

function AlertList({ alerts, busy, onAction, onOpenPatient }) {
  if (!alerts.length) return <Empty>没有未处理的提醒。AI 无法处理或命中红旗规则的消息会出现在这里。</Empty>;
  return <ul className="care-list">{alerts.map((a) => <li key={a.id} className={`care-card level-${a.level}`}>
    <header><span className={`care-level ${a.level}`}><AlertTriangle size={14} />{LEVEL[a.level] || a.level}</span><PatientLink id={a.patientId} name={a.patientName} onOpenPatient={onOpenPatient} /><time>{fmt(a.createdAt)}</time></header>
    <p className="care-reason">{a.reason}</p>
    {a.messageText && <blockquote>{a.messageText}</blockquote>}
    <footer>
      {a.status === "open" && <button className="secondary" disabled={Boolean(busy)} onClick={() => onAction(a, "acknowledge")}>我已知晓</button>}
      <button disabled={Boolean(busy)} onClick={() => onAction(a, "resolve")}>已处理</button>
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
    <header><PatientLink id={reply.patientId} name={reply.patientName} onOpenPatient={onOpenPatient} /><span className="care-tag">{reply.mode === "campaign" ? "随访" : "回复"} · {reply.channel || "默认渠道"}</span><time>{fmt(reply.createdAt)}</time></header>
    {reply.reason && <p className="care-reason">{reply.reason}</p>}
    <textarea aria-label="回复内容" rows={Math.min(10, Math.max(3, text.split("\n").length + 1))} value={text} onChange={(e) => setText(e.target.value)} />
    {reply.sources?.length > 0 && <p className="care-sources">依据：{reply.sources.map((s) => <span key={s.id}>{s.title || s.id}</span>)}</p>}
    {reply.detail && <p className="care-hint">{reply.detail}</p>}
    <footer>
      <button className="secondary" disabled={Boolean(busy)} onClick={() => onDiscard(reply)}>丢弃</button>
      {dirty && <button className="secondary" disabled={Boolean(busy) || !text.trim()} onClick={() => onSave(reply, text)}>保存修改</button>}
      <button disabled={Boolean(busy) || dirty || !text.trim()} title={dirty ? "请先保存修改" : undefined} onClick={() => onSend(reply)}><Send size={15} />发送</button>
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
    <button disabled={Boolean(busy) || !patientId} onClick={() => onAssign(message, patientId)}>关联患者</button>
  </span>;
}

function MessageList({ messages, patients, busy, onProcess, onMark, onAssign, onPatientSettings, onOpenPatient }) {
  if (!messages.length) return <Empty>还没有患者消息。</Empty>;
  return <ul className="care-list compact">{messages.map((m) => {
    const s = m.state || {};
    return <li key={m.id} className={`care-card level-${s.level || "routine"}`}>
      <header><PatientLink id={m.patientId} name={m.patientName} onOpenPatient={onOpenPatient} /><span className="care-tag">{m.direction === "out" ? "发出" : "收到"} · {m.channel}</span>
        {s.level && s.level !== "routine" && <span className={`care-level ${s.level}`}>{LEVEL[s.level]}</span>}
        {s.category && <span className="care-tag">{CATEGORY[s.category] || s.category}</span>}
        <span className="care-status">{STATUS[s.status] || s.status || "—"}</span><time>{fmt(m.time)}</time></header>
      <p className="care-text">{m.text}</p>
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
    // Secrets are write-only: blank keeps the stored value.
    channels: { corp: { corpId: settings.channels?.corp?.corpId || "", corpSecret: "", callbackToken: "", aesKey: "" }, kf: { openKfId: settings.channels?.kf?.openKfId || "", secret: "" }, app: { agentId: settings.channels?.app?.agentId || "", secret: "" } },
    processing: { enabled: true, modelConsent: false, ...settings.processing },
  }));
  const setChannel = (kind, changes) => setForm((f) => ({ ...f, channels: { ...f.channels, [kind]: { ...f.channels[kind], ...changes } } }));
  const saved = settings.channels || {};
  const set = (section, changes) => setForm((f) => ({ ...f, [section]: { ...f[section], ...changes } }));
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(null);
  async function testConnection() {
    setTesting(true);
    try { setTested(await api("/api/care/settings/test", "POST", {})); }
    catch (e) { setTested({ error: e.message }); }
    finally { setTesting(false); }
  }
  const corp = saved.corp || {};
  const secretHint = (has, from) => !has ? "未配置" : from === "env" ? "已由配置文件提供，填写后以此处为准" : from === "options" ? "由启动参数提供" : "已保存，留空不修改";
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
      <label>企业微信提醒对象（成员 UserID，逗号分隔）<input value={form.alerts.notifyUserIds.join(",")} onChange={(e) => set("alerts", { notifyUserIds: e.target.value.split(/[,，\s]+/).filter(Boolean) })} /></label>
      <label>未处理多久后再次提醒（分钟）<input type="number" min="5" max="1440" value={form.alerts.escalateAfterMinutes} onChange={(e) => set("alerts", { escalateAfterMinutes: Number(e.target.value) })} /></label>
      <label>自定义关注词（出现即提醒，逗号分隔）<input value={form.redFlags.extra.join(",")} onChange={(e) => set("redFlags", { extra: e.target.value.split(/[,，]+/).map((w) => w.trim()).filter(Boolean) })} placeholder="如：伤口渗液,黄疸" /></label>
    </fieldset>
    <fieldset disabled={busy}>
      <legend>企业微信连接</legend>
      <p className="care-setup-entry"><span>第一次配置，或不知道去哪里找这些信息？</span><button type="button" className="secondary" onClick={onSetup}>打开接入向导</button></p>
      <p className="care-hint">建议用助理的企业微信账号对接患者。保存后立即生效，无需重启；可在企业微信管理后台「应用管理」「微信客服」中找到以下信息，并把本机出口 IP 加入各应用的可信 IP。</p>
      <label>企业 ID（CorpID）<input value={form.channels.corp.corpId} onChange={(e) => setChannel("corp", { corpId: e.target.value })} placeholder="ww开头" disabled={corp.from?.corpId === "options"} /></label>
      <label>客户联系 Secret<small className="care-hint">用于同步客户、客户群，生成需成员确认的群发任务</small><input type="password" autoComplete="off" value={form.channels.corp.corpSecret} onChange={(e) => setChannel("corp", { corpSecret: e.target.value })} placeholder={secretHint(corp.hasContactSecret, corp.from?.corpSecret)} /></label>
      <label>微信客服账号 ID（open_kfid）<input value={form.channels.kf.openKfId} onChange={(e) => setChannel("kf", { openKfId: e.target.value })} placeholder="wkxxxxxxxx" /></label>
      <label>微信客服 Secret<small className="care-hint">患者通过客服链接发来的消息会被自动拉取记录；48 小时内可自动回复，每次最多 5 条</small><input type="password" autoComplete="off" value={form.channels.kf.secret} onChange={(e) => setChannel("kf", { secret: e.target.value })} placeholder={saved.kf?.hasSecret ? "已保存，留空不修改" : "未配置"} /></label>
      <label>提醒应用 AgentId<input value={form.channels.app.agentId} onChange={(e) => setChannel("app", { agentId: e.target.value })} placeholder="1000002" /></label>
      <label>提醒应用 Secret<small className="care-hint">重要消息通过此应用推送给医生</small><input type="password" autoComplete="off" value={form.channels.app.secret} onChange={(e) => setChannel("app", { secret: e.target.value })} placeholder={saved.app?.hasSecret ? "已保存，留空不修改" : "未配置"} /></label>
      <details className="care-advanced"><summary>回调设置（需要公网服务器，桌面版暂不需要）</summary>
        <p className="care-hint">桌面版通过定时拉取接收微信客服消息，无需回调。将来部署常驻服务、配置公网 HTTPS 地址 <code>/api/wecom/callback</code> 后再填写。{corp.callbackConfigured ? "当前回调密钥已配置。" : ""}</p>
        <label>回调 Token<input type="password" autoComplete="off" value={form.channels.corp.callbackToken} onChange={(e) => setChannel("corp", { callbackToken: e.target.value })} placeholder={secretHint(corp.hasCallbackToken, corp.from?.callbackToken)} /></label>
        <label>EncodingAESKey<input type="password" autoComplete="off" value={form.channels.corp.aesKey} onChange={(e) => setChannel("corp", { aesKey: e.target.value })} placeholder={secretHint(corp.hasAesKey, corp.from?.aesKey)} /></label>
      </details>
      {kfSync?.polling && <p className="care-hint">微信客服：每 {kfSync.pollSeconds} 秒自动拉取 · 上次成功 {fmt(kfSync.lastSyncAt)}{kfSync.lastError ? ` · 最近错误：${kfSync.lastError}（下次 ${fmt(kfSync.nextAt)}）` : ""}</p>}
      <div className="care-test">
        <button type="button" className="secondary" disabled={testing} onClick={testConnection}>{testing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}测试已保存的连接</button>
        <small className="care-hint">只检查凭据，不会发送任何消息。修改后请先保存。</small>
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
        <label>微信客服客户 ID（external_userid）<input value={form.kfExternalUserId} onChange={(e) => set({ kfExternalUserId: e.target.value })} placeholder="关联消息后自动填写" /></label>
      </fieldset>
      <footer><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" disabled={saving}>{saving ? "正在保存…" : "保存"}</button></footer>
    </form>}
  </Modal>;
}
