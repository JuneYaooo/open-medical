import { useCallback, useEffect, useState } from "react";
import { CalendarPlus } from "lucide-react";
import { api } from "./agent-runtime";
import "./care.css";

const STATUS = { scheduled: "已预约", attended: "已到诊", missed: "未到诊", cancelled: "已取消" };
const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

// Return-visit appointments; the day before and the day itself show up in 今日待办.
export function AppointmentsPanel({ patient }) {
  const [data, setData] = useState(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);
  const load = useCallback(() => api(`/api/patients/${patient.id}/appointments`).then(setData).catch((e) => setError(e.message)), [patient.id]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, message) => {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); setNotice(message); setForm(null); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const today = data?.today || localToday();
  const upcoming = (data?.appointments || []).filter((a) => a.status === "scheduled");
  const past = (data?.appointments || []).filter((a) => a.status !== "scheduled").reverse();
  const draftReminder = (a) => act(() => api("/api/care/replies", "POST", { patientId: patient.id,
    text: `您好，提醒您 ${a.date}${a.time ? ` ${a.time}` : ""} 复诊${a.place ? `（${a.place}）` : ""}${a.reason ? `，主要是${a.reason}` : ""}。如需改期请提前告诉我们。` }), "已生成复诊提醒草稿，请到「患者消息 → 待回复草稿」核对后发送。");

  return <section className="detail-panel appointments" aria-label="复诊预约">
    <header className="care-tracking-header"><div><h3>复诊预约</h3><p className="muted">登记下次复诊。前一天和当天会出现在今日待办；过了日期没登记结果也会提醒。这里不会自动通知患者。</p></div>
      <button className="primary" disabled={patient.archived || busy} onClick={() => setForm({ date: "", time: "", reason: "", place: "" })}><CalendarPlus size={14} /> 预约复诊</button></header>
    {error && <p className="error-text" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {form && <form className="appointment-form" onSubmit={(e) => { e.preventDefault(); act(() => api(`/api/patients/${patient.id}/appointments`, "POST", form), "复诊已预约。"); }}>
      <label>日期<input type="date" required min={today} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
      <label>时间（可选）<input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
      <label>复诊事项<input value={form.reason} maxLength={200} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="如：术后一月复查、调整降压药" /></label>
      <label>地点（可选）<input value={form.place} maxLength={100} onChange={(e) => setForm({ ...form, place: e.target.value })} placeholder="如：周三上午专家门诊" /></label>
      <div className="toolbar-actions"><button type="button" className="secondary" onClick={() => setForm(null)}>取消</button><button className="primary" disabled={busy || !form.date}>保存预约</button></div>
    </form>}
    {!data && !error && <p className="muted">正在读取预约…</p>}
    {data && !upcoming.length && !form && <p className="care-empty">还没有待到的复诊。看完诊约好下次时间后在这里登记，系统会按时提醒。</p>}
    {upcoming.map((a) => {
      const due = a.date < today ? "past" : a.date === today ? "today" : null;
      return <article className={`care-tracking-card ${due === "past" ? "overdue" : ""}`} key={a.id} aria-label={`复诊 ${a.date}`}>
        <div className="care-tracking-title"><span className="pill">{due === "past" ? "待登记结果" : due === "today" ? "今天" : STATUS[a.status]}</span><b>{a.date}{a.time ? ` ${a.time}` : ""}</b>{a.place && <small>{a.place}</small>}</div>
        {a.reason && <h4>{a.reason}</h4>}
        <div className="toolbar-actions">
          {a.date <= today && <><button className="secondary" disabled={busy} onClick={() => act(() => api(`/api/appointments/${a.id}`, "PATCH", { status: "attended" }), "已登记到诊。")}>已到诊</button>
            <button className="secondary" disabled={busy} onClick={() => act(() => api(`/api/appointments/${a.id}`, "PATCH", { status: "missed" }), "已登记未到诊，可以重新预约。")}>未到诊</button></>}
          {a.date >= today && <button className="text-button" disabled={busy} onClick={() => draftReminder(a)}>起草提醒消息</button>}
          <button className="text-button" disabled={busy} onClick={() => { const date = window.prompt("改到哪天？（YYYY-MM-DD）", a.date); if (date && date !== a.date) act(() => api(`/api/appointments/${a.id}`, "PATCH", { date }), "已改期。"); }}>改期</button>
          <button className="text-button" disabled={busy} onClick={() => { if (window.confirm(`取消 ${a.date} 的复诊预约？`)) act(() => api(`/api/appointments/${a.id}`, "PATCH", { status: "cancelled" }), "已取消预约。"); }}>取消预约</button>
        </div>
      </article>;
    })}
    {past.length > 0 && <details><summary>历史预约 · {past.length}</summary>{past.map((a) => <p key={a.id} className="muted">{a.date}{a.time ? ` ${a.time}` : ""} · {STATUS[a.status]}{a.reason ? ` · ${a.reason}` : ""}{a.note ? ` · ${a.note}` : ""}</p>)}</details>}
  </section>;
}

// Lab values added since the doctor last marked them read.
export function NewLabsNotice({ patientId, onOpenLabs }) {
  const [labs, setLabs] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const load = useCallback(() => api(`/api/patients/${patientId}/labs/new`).then((v) => setLabs(v.labs)).catch(() => setLabs([])), [patientId]);
  useEffect(() => { load(); }, [load]);
  if (!labs?.length) return null;
  return <div className="new-labs" role="status" aria-label="新检验结果">
    <div><b>新检验结果 {labs.length} 项</b><span>{labs.slice(0, 6).map((l) => `${l.item} ${l.value}${l.unit || ""}（${l.date}）`).join("、")}{labs.length > 6 ? " 等" : ""}</span></div>
    {onOpenLabs && <button className="text-button" onClick={onOpenLabs}>看趋势</button>}
    <button className="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await api(`/api/patients/${patientId}/labs/reviewed`, "POST", {}); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); } }}>已查看，标记已阅</button>
    {error && <p className="error-text">{error}</p>}
  </div>;
}
