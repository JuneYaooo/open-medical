import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, X } from "lucide-react";
import { api } from "./agent-runtime";
import "./care.css";

const TYPES = { "care-message": "发送消息", "care-campaign": "随访计划", "care-settings": "自动化设置" };
export const PENDING_REFRESH_EVENT = "care-pending-refresh";

function Preview({ action }) {
  const p = action.payload || {};
  if (action.type === "care-message") return <><p className="care-hint">渠道：{p.channel || "默认渠道"}</p><pre>{p.text}</pre></>;
  if (action.type === "care-campaign") return <><p className="care-hint">{p.name} · 开始 {p.startDate}</p>
    <ol className="care-steps">{(p.steps || []).map((s, i) => <li key={s.id || i}><div><b>第 {s.dayOffset} 天</b>{s.time ? ` ${s.time}` : ""}</div><p>{s.text}</p></li>)}</ol></>;
  return <pre>{JSON.stringify(p.changes ?? p, null, 2)}</pre>;
}

// 聊天中由 care_* 工具发起的外发/计划/设置提案；医生在此一键确认。
export function PendingTray() {
  const [actions, setActions] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => api("/api/pending-actions?status=pending")
    .then((data) => setActions((data.actions || []).filter((a) => a.type?.startsWith("care-"))))
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
