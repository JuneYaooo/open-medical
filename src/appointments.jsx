import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarPlus, RotateCw } from "lucide-react";
import { useClinicalDraft } from "./clinical-drafts";
import { api } from "./agent-runtime";
import { usePluginConnected } from "./plugin-slots";
import "./care.css";

const STATUS = { scheduled: "已预约", attended: "已到诊", missed: "未到诊", cancelled: "已取消" };
const appointmentFields = { date: "日期", time: "时间", reason: "复诊事项", place: "地点", status: "预约状态" };
const snapshot = value => Object.fromEntries(Object.keys(appointmentFields).map(key => [key, value[key] || ""]));
const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
// 预约日期快捷选项：从今天起算（月末顺延到下月初由 Date 处理）。
const DATE_CHIPS = [["+2周", 14, 0], ["+1月", 0, 1], ["+3月", 0, 3]];
const shiftDate = (from, days, months) => {
  const [y, m, d] = from.split("-").map(Number);
  const next = new Date(y, m - 1 + months, d + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
};

// Return-visit appointments; the day before and the day itself show up in 今日待办.
export function AppointmentsPanel({ patient }) {
  // Reminder drafts are messages to the patient; they need a connected channel.
  const followupActive = usePluginConnected("followup");
  const [data, setData] = useState(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [form, setForm] = useClinicalDraft(patient.id, "appointment", null);
  const inFlight = useRef(false);
  const updateRequests = useRef(new Map());
  const active = useRef(true), reads = useRef({ appointments: 0, drafts: 0 });
  const [loadError, setLoadError] = useState(""), [draftsError, setDraftsError] = useState(""), [loading, setLoading] = useState(true);
  // Keep only an opaque submission key across reloads, never clinical text.
  const requestKey = `appointment-request:${patient.id}`;
  const clearRequest = () => { try { sessionStorage.removeItem(requestKey); } catch {} };
  const requestId = () => {
    let id;
    try { id = sessionStorage.getItem(requestKey); } catch {}
    id ||= crypto.randomUUID();
    try { sessionStorage.setItem(requestKey, id); } catch {}
    return id;
  };
  const [draft, setDraft] = useState(null), [draftText, setDraftText] = useState("");
  const [drafts, setDrafts] = useState([]);
  const openDraft = (reply) => { setDraft(reply); setDraftText(reply.text); };
  const loadAppointments = useCallback(async () => {
    const request = ++reads.current.appointments;
    setLoading(true); setLoadError("");
    try { const value = await api(`/api/patients/${patient.id}/appointments`); if (active.current && request === reads.current.appointments) setData(value); }
    catch (err) { if (active.current && request === reads.current.appointments) setLoadError(`预约读取失败：${err.message}`); }
    finally { if (active.current && request === reads.current.appointments) setLoading(false); }
  }, [patient.id]);
  const loadDrafts = useCallback(async () => {
    const request = ++reads.current.drafts;
    setDraftsError("");
    if (!followupActive) { setDrafts([]); return; }
    try { const value = await api(`/api/care/replies?status=draft&patientId=${patient.id}`); if (active.current && request === reads.current.drafts) setDrafts(value.replies || []); }
    catch (err) { if (active.current && request === reads.current.drafts) setDraftsError(`提醒草稿读取失败：${err.message}`); }
  }, [patient.id, followupActive]);
  const load = useCallback(() => Promise.all([loadAppointments(), loadDrafts()]), [loadAppointments, loadDrafts]);
  useEffect(() => { active.current = true; load(); return () => { active.current = false; reads.current.appointments++; reads.current.drafts++; }; }, [load]);
  const act = async (fn, message, { closeForm = false } = {}) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(""); setNotice("");
    try { await fn(); setNotice(message); if (closeForm) setForm(null); await load(); return true; } catch (e) { setError(e.message); return false; } finally { inFlight.current = false; setBusy(false); }
  };
  const today = data?.today || localToday();
  const upcoming = (data?.appointments || []).filter((a) => a.status === "scheduled");
  const past = (data?.appointments || []).filter((a) => a.status !== "scheduled").reverse();
  const draftReminder = (a) => act(async () => {
    const reply = await api("/api/care/replies", "POST", { patientId: patient.id,
      text: `您好，提醒您 ${a.date}${a.time ? ` ${a.time}` : ""} 复诊${a.place ? `（${a.place}）` : ""}${a.reason ? `，主要是${a.reason}` : ""}。如需改期请提前告诉我们。` });
    openDraft(reply);
  }, "已生成复诊提醒草稿，请在下方核对；尚未发送。");
  // 新预约默认沿用这位患者最近一次预约的地点（从预约记录里取，不另存）。
  const lastPlace = [...(data?.appointments || [])].reverse().find((a) => a.place)?.place || "";
  const book = (from = {}) => setForm({ date: "", time: "", reason: from.reason || "", place: from.place || lastPlace, requestId: requestId() });
  const update = (a, changes, message) => act(() => {
    const key = JSON.stringify([a.id, a.revision || 0, changes]);
    if (!updateRequests.current.has(key)) updateRequests.current.set(key, crypto.randomUUID());
    return api(`/api/appointments/${a.id}`, "PATCH", { expectedRevision: a.revision || 0, ...changes, requestId: updateRequests.current.get(key) });
  }, message);
  const edit = a => setForm({ ...a, _original: snapshot(a), requestId: crypto.randomUUID(), expectedRevision: a.revision || 0, correctionReason: "" });
  const saveForm = event => {
    event.preventDefault();
    if (form._conflict) return;
    const submission = { ...snapshot(form), correctionReason: form.correctionReason, expectedRevision: form.expectedRevision, requestId: form.requestId || requestId() };
    setForm({ ...form, requestId: submission.requestId });
    act(async () => {
      try { await api(form.id ? `/api/appointments/${form.id}` : `/api/patients/${patient.id}/appointments`, form.id ? "PATCH" : "POST", submission); }
      catch (err) {
        if (form.id && ["REVISION_CONFLICT", "REQUEST_CONFLICT"].includes(err.code)) {
          try {
            const value = await api(`/api/patients/${patient.id}/appointments`);
            const latest = value.appointments.find(item => item.id === form.id);
            if (active.current && latest) {
              setData(value);
              const choices = Object.fromEntries(Object.keys(appointmentFields).map(key => [key, form._original && (form[key] || "") !== form._original[key] ? "local" : "latest"]));
              setForm({ ...form, _conflict: latest, _choices: choices });
            }
          } catch (readError) { throw new Error(`${err.message}；最新预约读取失败：${readError.message}。输入已保留，可再次保存重试核对。`); }
        }
        throw err;
      }
      if (!form.id) clearRequest();
    }, form.id ? "预约已更正，修改记录已保留。" : "复诊已预约。", { closeForm: true });
  };
  const history = a => a.history?.length > 0 && <details><summary>修改记录 · {a.history.length}</summary>{a.history.map((h, i) => <p key={i}>{new Date(h.at).toLocaleString("zh-CN")} · 修改前：{h.date} {h.time} · {STATUS[h.status]} · {h.place || "地点未记录"} · {h.reason}{h.correctionReason ? ` · 更正原因：${h.correctionReason}` : ""}</p>)}</details>;


  return <section className="detail-panel appointments" aria-label="复诊预约">
    <header className="care-tracking-header"><div><h3>复诊预约</h3><p className="muted">前一天和当天会进入今日待办，到期未登记结果会提醒；不会自动通知患者。</p></div>
      <div className="care-tracking-actions"><button className="text-button" disabled={busy || loading} onClick={loadAppointments} aria-label="刷新预约" title="刷新"><RotateCw size={15} /></button><button className="primary" disabled={patient.archived || busy || Boolean(form)} onClick={() => book()}><CalendarPlus size={14} /> 预约复诊</button></div></header>
    {error && <p className="error-text" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    {loadError && <p className="error-text" role="alert">{loadError}<button className="text-button" disabled={loading} onClick={loadAppointments}>重试读取预约</button></p>}
    {form && <form className="appointment-form" onSubmit={saveForm}>
      <p className="muted">请先保存或取消本次编辑，再处理其他预约。</p>
      <fieldset disabled={busy || patient.archived}>
      <label>日期<input type="date" required min={form.id ? undefined : today} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
      <div className="appointment-date-chips" role="group" aria-label="快捷日期" style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>{DATE_CHIPS.map(([label, days, months]) => { const value = shiftDate(today, days, months); return <button key={label} type="button" className="text-button" aria-pressed={form.date === value} onClick={() => setForm({ ...form, date: value })}>{label}</button>; })}</div>
      <label>时间（可选）<input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
      <label>复诊事项<input value={form.reason} maxLength={200} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="如：术后一月复查、调整降压药" /></label>
      <label>地点（可选）<input value={form.place} maxLength={100} onChange={(e) => setForm({ ...form, place: e.target.value })} placeholder="如：周三上午专家门诊" /></label>
      {form.id && <><label>预约状态<select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>{Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>更正原因（必填）<input required value={form.correctionReason} maxLength={500} onChange={e => setForm({ ...form, correctionReason: e.target.value })} /></label></>}
      {form._conflict && <section className="appointment-conflict" aria-label="预约版本核对"><h4>核对最新预约与本地草稿</h4><p>其他窗口已更新预约。未修改的字段默认采用最新记录；核对选择后仍需保存。</p>
        {Object.entries(appointmentFields).map(([key, label]) => <div key={key}><b>{label}</b><p>最新：{(key === "status" ? STATUS[form._conflict[key]] : form._conflict[key]) || "未记录"}</p><p>草稿：{(key === "status" ? STATUS[form[key]] : form[key]) || "未记录"}</p><label>{label}保留版本<select aria-label={`${label}保留版本`} value={form._choices[key]} onChange={event => setForm({ ...form, _choices: { ...form._choices, [key]: event.target.value } })}><option value="latest">采用最新记录</option><option value="local">保留本地草稿</option></select></label></div>)}
        <button type="button" className="secondary" onClick={() => {
          const next = { ...form, expectedRevision: form._conflict.revision || 0, requestId: crypto.randomUUID(), _original: snapshot(form._conflict), _conflict: null, _choices: null };
          for (const key of Object.keys(appointmentFields)) if (form._choices[key] === "latest") next[key] = form._conflict[key] || "";
          setForm(next); setError(""); setNotice("已完成版本核对，请确认后保存预约。");
        }}>确认预约选择并继续编辑</button>
      </section>}
      <div className="toolbar-actions"><button type="button" className="secondary" onClick={() => { if (!form.id) clearRequest(); setForm(null); }}>取消</button><button className="primary" disabled={busy || !form.date || Boolean(form._conflict)}>保存预约</button></div></fieldset>
    </form>}
    {!data && loading && <p className="muted" role="status">正在读取预约…</p>}
    {data && !upcoming.length && !form && <p className="care-empty">还没有待到的复诊。看完诊约好下次时间后在这里登记，系统会按时提醒。</p>}
    {upcoming.map((a) => {
      const due = a.date < today ? "past" : a.date === today ? "today" : null;
      return <article className={`care-tracking-card ${due === "past" ? "overdue" : ""}`} key={a.id} aria-label={`复诊 ${a.date}`}>
        <div className="care-tracking-title"><span className="pill">{due === "past" ? "待登记结果" : due === "today" ? "今天" : STATUS[a.status]}</span><b>{a.date}{a.time ? ` ${a.time}` : ""}</b>{a.place && <small>{a.place}</small>}</div>
        {a.reason && <h4>{a.reason}</h4>}
        <div className="toolbar-actions">
          {a.date <= today && <><button className="secondary" disabled={busy || patient.archived || Boolean(form)} onClick={async () => { if (await update(a, { status: "attended" }, "已登记到诊。请选好下次复诊日期后保存；不需要可点取消。")) book(a); }}>已到诊</button>
            <button className="secondary" disabled={busy || patient.archived || Boolean(form)} onClick={() => update(a, { status: "missed" }, "已登记未到诊，可在下方「历史预约」里点「重新预约」。")}>未到诊</button></>}
          {followupActive && a.date >= today && <button className="text-button" disabled={busy || patient.archived || Boolean(form)} onClick={() => draftReminder(a)}>起草提醒消息</button>}
          <button className="text-button" disabled={busy || patient.archived || Boolean(form)} onClick={() => edit(a)}>改期或更正</button>
          <button className="text-button" disabled={busy || patient.archived || Boolean(form)} onClick={() => { if (window.confirm(`取消 ${a.date} 的复诊预约？`)) update(a, { status: "cancelled" }, "已取消预约。"); }}>取消预约</button>
        </div>{history(a)}
      </article>;
    })}
    {past.length > 0 && <details><summary>历史预约 · {past.length}</summary>{past.map((a) => <article key={a.id} className="care-tracking-card"><p>{a.date} {a.time} · {STATUS[a.status]} · {a.place || "地点未记录"} · {a.reason}{a.note ? ` · ${a.note}` : ""}</p>{a.status === "missed" && <button className="primary" disabled={busy || patient.archived || Boolean(form)} onClick={() => book(a)}>重新预约</button>}<button className="secondary" disabled={busy || patient.archived || Boolean(form)} onClick={() => edit(a)}>更正预约结果</button>{history(a)}</article>)}</details>}
    {followupActive && draftsError && <p className="error-text" role="alert">{draftsError}<button className="text-button" onClick={loadDrafts}>重试读取提醒草稿</button></p>}
    {followupActive && drafts.length > 0 && <details open={Boolean(draft)}><summary>待核对消息草稿 · {drafts.length}</summary>{drafts.map(reply => <p key={reply.id}>{reply.text}<button className="text-button" onClick={() => openDraft(reply)}>核对此草稿</button></p>)}</details>}
    {followupActive && draft && <form className="appointment-draft" aria-label="核对提醒草稿" onSubmit={e => { e.preventDefault(); act(async () => { const saved = await api(`/api/care/replies/${draft.id}`, "PUT", { text: draftText }); openDraft(saved); }, "草稿修改已保存，尚未发送。"); }}><h4>核对提醒草稿 · {patient.name}</h4><p className="muted">请核对预约日期、时间与地点；改期后需同步核对先前草稿。尚未发送</p><label>提醒草稿内容<textarea rows={4} required maxLength={2000} value={draftText} onChange={e => setDraftText(e.target.value)} /></label><div className="toolbar-actions"><button className="primary" disabled={busy || patient.archived}>保存草稿修改</button><button type="button" className="secondary" onClick={() => setDraft(null)}>返回预约</button></div></form>}

  </section>;
}

// Lab values added since the doctor last marked them read.
export function NewLabsNotice({ patientId, onOpenLabs }) {
  const [labs, setLabs] = useState(null), [keys, setKeys] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [loading, setLoading] = useState(true), [expanded, setExpanded] = useState(false);
  const generation = useRef(0), active = useRef(true);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError("");
    try {
      const value = await api(`/api/patients/${patientId}/labs/new`);
      if (active.current && request === generation.current) { setLabs(value.labs); setKeys(value.keys || []); }
    } catch (err) {
      if (active.current && request === generation.current) setError(`待阅检验读取失败：${err.message}`);
    } finally {
      if (active.current && request === generation.current) setLoading(false);
    }
  }, [patientId]);
  useEffect(() => { active.current = true; load(); return () => { active.current = false; generation.current++; }; }, [load]);
  if (!loading && !error && !labs?.length) return null;
  return <div className="new-labs" role="status" aria-label="待阅检验结果" aria-busy={loading || busy}>
    <div><b>{labs?.length ? `待阅检验结果 ${labs.length} 项` : loading ? "正在读取待阅检验…" : "待阅检验状态未读取"}</b>{labs?.length > 0 && <span>{(expanded ? labs : labs.slice(0, 6)).map((l) => `${l.item} ${l.value}${l.unit || ""}（${l.date}）`).join("、")}{labs.length > 6 && <button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : `另 ${labs.length - 6} 项`}</button>}</span>}</div>
    {onOpenLabs && <button className="text-button" onClick={onOpenLabs}>看趋势</button>}
    {labs?.length > 0 && <button className="secondary" disabled={busy || loading || Boolean(error) || !keys.length} onClick={async () => {
      if (busy) return;
      setBusy(true); setError("");
      try { await api(`/api/patients/${patientId}/labs/reviewed`, "POST", { keys }); if (active.current) await load(); }
      catch (err) { if (active.current) setError(`标记已阅未确认，请重新读取后核对：${err.message}`); }
      finally { if (active.current) setBusy(false); }
    }}>{labs.length > 1 ? `${labs.length} 项全部标记已阅` : "标记已阅"}</button>}
    {error && <p className="error-text" role="alert">{error}<button className="text-button" disabled={loading || busy} onClick={load}>重试读取待阅检验</button></p>}
  </div>;
}
