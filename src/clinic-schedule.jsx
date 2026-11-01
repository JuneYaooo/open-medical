import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RotateCw } from "lucide-react";
import { api } from "./agent-runtime";
import "./clinic-schedule.css";

// 门诊日程：全部患者的复诊预约（按日 / 按周），以及失访患者。
const LOST_DAYS = 90;
const STATUS = { scheduled: ["已预约", "is-info"], attended: ["已到诊", "is-ok"], missed: ["未到诊", "is-danger"], cancelled: ["已取消", ""] };
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (n) => String(n).padStart(2, "0");
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (day) => new Date(`${day}T12:00:00`);
const addDays = (day, n) => { const d = parse(day); d.setDate(d.getDate() + n); return localDay(d); };
const monday = (day) => addDays(day, -((parse(day).getDay() + 6) % 7));
const short = (day) => { const d = parse(day); return `${d.getMonth() + 1}月${d.getDate()}日`; };

export function ClinicSchedule({ onPatient }) {
  const today = localDay();
  const [mode, setMode] = useState("day");
  const [anchor, setAnchor] = useState(today);
  const [data, setData] = useState(null);
  const [lost, setLost] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(null);
  const [reload, setReload] = useState(0);
  const from = mode === "week" ? monday(anchor) : anchor;
  const to = mode === "week" ? addDays(from, 6) : anchor;

  useEffect(() => {
    let alive = true;
    setLoading(true); setError("");
    const request = mode === "lost"
      ? api(`/api/patients-lost?days=${LOST_DAYS}`).then((result) => alive && setLost(result))
      : api(`/api/appointments?from=${from}&to=${to}`).then((result) => alive && setData(result));
    request.catch((err) => alive && setError(err.message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [mode, from, to, reload]);

  const show = (next) => { setMode(next); setAnchor(today); setNotice(""); };
  const shift = (sign) => setAnchor((day) => addDays(day, sign * (mode === "week" ? 7 : 1)));
  const openPatient = (patientId) => onPatient({ id: patientId, tab: "appointments" });
  // 与今日待办相同：带版本号登记到诊结果，别处改过会提示刷新。
  const outcome = async (a, status) => {
    if (acting) return;
    setActing(a.id); setError(""); setNotice("");
    try {
      await api(`/api/appointments/${a.id}`, "PATCH", { expectedRevision: a.revision || 0, status, requestId: crypto.randomUUID() });
      setNotice(status === "attended" ? `已登记${a.patientName}到诊。` : `已登记${a.patientName}未到诊。`);
      setReload((n) => n + 1);
    } catch (err) { setError(err.message); }
    finally { setActing(null); }
  };
  const chip = (a) => {
    const [label, tone] = a.status === "scheduled" && a.date < today ? ["未登记", "is-caution"] : STATUS[a.status] || [a.status, ""];
    return <em className={`om-chip ${tone}`}>{label}</em>;
  };
  const actions = (a) => a.status === "scheduled" && a.date <= today && <span className="schedule-actions">
    <button className="text-button" disabled={Boolean(acting)} onClick={() => outcome(a, "attended")}>已到诊</button>
    <button className="text-button" disabled={Boolean(acting)} onClick={() => outcome(a, "missed")}>未到诊</button>
  </span>;
  const name = (a) => <button className="om-link schedule-patient" onClick={() => openPatient(a.patientId)}>{a.patientName || "未命名患者"}{a.patientNumber && <small>{a.patientNumber}</small>}</button>;
  const appointments = data?.from === from && data?.to === to ? data.appointments : null;

  return (
    <section className="clinic-schedule" aria-label="门诊日程" aria-busy={loading}>
      <div className="om-page-head schedule-head">
        <div><h1>门诊日程</h1>
          <span className="om-page-meta">{mode === "lost" ? `未到诊后未再预约，或超过 ${LOST_DAYS} 天未复诊且没有随访安排的患者。` : "全部患者的复诊预约，点姓名可打开患者的复诊预约。"}</span></div>
        <button className="icon-button" title="刷新" aria-label="刷新" disabled={loading} onClick={() => setReload((n) => n + 1)}><RotateCw size={16} /></button>
      </div>
      <div className="schedule-toolbar">
        <div className="agenda-filters" role="group" aria-label="查看方式">
          {[["day", "今天"], ["week", "本周"], ["lost", "失访患者"]].map(([id, label]) => <button key={id} aria-pressed={mode === id} className={mode === id ? "active" : ""} onClick={() => show(id)}>{label}{id === "lost" && lost && <span>{lost.patients.length}</span>}</button>)}
        </div>
        {mode !== "lost" && <div className="schedule-nav">
          <button className="icon-button" aria-label={mode === "week" ? "上一周" : "前一天"} onClick={() => shift(-1)}><ChevronLeft size={16} /></button>
          <b>{mode === "week" ? `${short(from)} – ${short(to)}` : `${short(from)} ${WEEKDAYS[parse(from).getDay()]}${from === today ? "（今天）" : ""}`}</b>
          <button className="icon-button" aria-label={mode === "week" ? "下一周" : "后一天"} onClick={() => shift(1)}><ChevronRight size={16} /></button>
        </div>}
      </div>
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}<button className="text-button" onClick={() => setReload((n) => n + 1)}>重试</button></p>}

      {mode === "day" && appointments && (appointments.length ? <ul className="schedule-day">
        {appointments.map((a) => <li key={a.id}>
          <span className="schedule-time">{a.time || "未定时间"}</span>
          {name(a)}
          <span className="schedule-detail">{[a.reason, a.place].filter(Boolean).join(" · ")}</span>
          {chip(a)}
          {actions(a)}
        </li>)}
      </ul> : <p className="om-empty">这一天没有复诊预约。</p>)}

      {mode === "week" && appointments && <div className="schedule-week">
        {Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((day) => {
          const items = appointments.filter((a) => a.date === day);
          return <div key={day} className={day === today ? "schedule-col is-today" : "schedule-col"}>
            <button className="schedule-col-head" onClick={() => { setMode("day"); setAnchor(day); }}>{WEEKDAYS[parse(day).getDay()]} <small>{short(day)}</small>{items.length > 0 && <span>{items.length}</span>}</button>
            {items.map((a) => <div key={a.id} className="schedule-cell">
              <small>{a.time || "未定时间"}</small>
              {name(a)}
              {chip(a)}
            </div>)}
          </div>;
        })}
      </div>}

      {mode === "lost" && lost && (lost.patients.length ? <ul className="schedule-day schedule-lost">
        {lost.patients.map((p) => <li key={p.patientId}>
          {name(p)}
          <span className="schedule-detail">{p.reason === "missed"
            ? <><em className="om-chip is-danger">未到诊</em> {p.lastDate} 预约未到，之后没有再预约</>
            : <><em className="om-chip is-caution">超过 {lost.days} 天未复诊</em> 上次 {p.lastDate}，已 {p.daysSince} 天</>}</span>
          <button className="secondary" onClick={() => openPatient(p.patientId)}>预约复诊</button>
        </li>)}
      </ul> : <p className="om-empty">目前没有失访患者。</p>)}

      {loading && !(mode === "lost" ? lost : appointments) && <p className="muted" role="status">正在读取…</p>}
    </section>
  );
}
