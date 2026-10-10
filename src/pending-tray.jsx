import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, X } from "lucide-react";
import { api } from "./agent-runtime";
import "./care.css";

const TYPES = { "care-message": "发送消息", "care-campaign": "随访计划", "care-settings": "自动化设置", "care-bind": "关联微信客户", "care-group-message": "客户群群发", "care-education-broadcast": "患教群发", "patient-group-suggest": "分组建议", "trial-batch": "批量 AI 初筛", "trial-enrollment": "试验入组状态", "ext-change": "工作台扩展" };
export const PENDING_REFRESH_EVENT = "care-pending-refresh";

function Preview({ action }) {
  const p = action.payload || {};
  if (action.type === "care-message") return <><p className="care-hint">渠道：{p.channel || "默认渠道"}</p><pre>{p.text}</pre></>;
  if (action.type === "care-campaign") return <><p className="care-hint">{p.name} · 开始 {p.startDate}</p>
    <ol className="care-steps">{(p.steps || []).map((s, i) => <li key={s.id || i}><div><b>第 {s.dayOffset} 天</b>{s.time ? ` ${s.time}` : ""}</div><p>{s.text}</p></li>)}</ol></>;
  if (action.type === "care-bind") return <p className="care-hint">把企业微信客户「{p.contactName}」关联为该患者的{p.relationship === "family" ? "家属" : "本人"}（负责成员 {p.member}）{p.reasons?.length ? `。依据：${p.reasons.join("；")}` : ""}</p>;
  if (action.type === "ext-change") return <><p className="care-hint">{p.id ? `修改（当前第 ${p.previousVersion} 版）` : "新建"}{p.kind === "skill" ? "技能" : "自动化规则"}：{p.summary}{p.reason ? ` · 原因：${p.reason}` : ""}</p>
    {p.preview?.samples ? <><p className="care-hint">试算：{p.preview.note} 现在会产生 {p.preview.count} 条</p>{p.preview.samples.length > 0 && <ul className="care-hint">{p.preview.samples.map((x, i) => <li key={i}>{x}</li>)}</ul>}</> : p.preview?.skill && <pre>{p.preview.skill}</pre>}</>;
  if (action.type === "trial-batch") return <p className="care-hint">「{p.trialTitle}」· 确认后把以下 {p.patientIds?.length} 位患者的病历交给当前模型逐条核对纳排条件：{(p.patientNames || []).join("、")}</p>;
  if (action.type === "trial-enrollment") return <p className="care-hint">「{p.trialTitle}」· 入组状态改为 <b>{p.label}</b>{p.consentDate ? ` · 知情同意签署 ${p.consentDate}` : ""}{p.note ? ` · ${p.note}` : ""}</p>;
  if (action.type === "care-group-message") return <><p className="care-hint">客户群「{p.groupName}」· 确认后由群主 {p.owner} 在企业微信中点发送</p><pre>{p.text}</pre></>;
  if (action.type === "care-education-broadcast") return <><p className="care-hint">患教素材「{p.materialTitle || "自定义内容"}」· 将为 {p.recipients?.length} 位患者创建企业微信单发任务（成员仍需在企业微信中手动点发送）</p><pre>{p.text}</pre></>;
  if (action.type === "patient-group-suggest") return <ul className="care-hint">{(p.assignments || []).map((a) => <li key={a.patientId}><b>{a.name}</b> 追加分组：{a.addTags.join("、")}</li>)}</ul>;
  return <pre>{JSON.stringify(p.changes ?? p, null, 2)}</pre>;
}

// 聊天中由 care_* 工具发起的外发/计划/设置提案；医生在此一键确认。
export function PendingTray() {
  const [actions, setActions] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => api("/api/pending-actions?status=pending")
    .then((data) => setActions((data.actions || []).filter((a) => a.type?.startsWith("care-") || a.type?.startsWith("trial-") || a.type?.startsWith("ext-") || a.type === "patient-group-suggest")))
    .catch(() => {}), []);
  useEffect(() => {
    load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, 20000);
    window.addEventListener(PENDING_REFRESH_EVENT, load);
    return () => { clearInterval(timer); window.removeEventListener(PENDING_REFRESH_EVENT, load); };
  }, [load]);
  useEffect(() => { if (!actions.length) setOpen(false); }, [actions.length]);
  async function resolve(action, decision) {
    setBusy(action.id); setError("");
    try { await api(`/api/pending-actions/${action.id}/${decision}`, "POST", {}); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  }
  if (!actions.length) return null;
  return <div className="pending-tray">
    {open && <section className="pending-panel" aria-label="待确认的操作">
      <header><strong>待你确认（{actions.length}）</strong><button className="icon-button" aria-label="收起" onClick={() => setOpen(false)}><X size={16} /></button></header>
      {error && <p role="alert" className="care-error">{error}</p>}
      <ul>{actions.map((a) => <li key={a.id} className="care-card">
        <header><span className="care-tag">{TYPES[a.type] || a.type}</span><time>{new Date(a.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></header>
        <p className="care-reason">{a.summary}</p>
        <Preview action={a} />
        <footer><button className="secondary" disabled={Boolean(busy)} onClick={() => resolve(a, "reject")}>拒绝</button><button disabled={Boolean(busy)} onClick={() => resolve(a, "confirm")}>{busy === a.id ? "处理中…" : "确认执行"}</button></footer>
      </li>)}</ul>
    </section>}
    <button className="pending-badge" aria-expanded={open} onClick={() => setOpen((v) => !v)}><ClipboardCheck size={18} />待确认<em>{actions.length}</em></button>
  </div>;
}
