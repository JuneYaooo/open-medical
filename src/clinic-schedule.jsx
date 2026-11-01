import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { api } from "./agent-runtime";
import "./clinic-schedule.css";

// 复诊名单：接下来谁要来复诊，以及最近谁来了、谁没来。
const RANGES = [[1, "1个月"], [3, "3个月"], [6, "半年"]];
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (n) => String(n).padStart(2, "0");
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (day) => new Date(`${day}T12:00:00`);
const addDays = (day, n) => { const d = parse(day); d.setDate(d.getDate() + n); return localDay(d); };
const addMonths = (day, n) => { const d = parse(day); d.setMonth(d.getMonth() + n); return localDay(d); };
const dateLabel = (day) => { const d = parse(day); return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`; };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
// 预约日已过但没登记的，往回多看 60 天。
const UNREGISTERED_LOOKBACK = 60;

export function ClinicSchedule({ onPatient }) {
  const today = localDay();
  const [mode, setMode] = useState("upcoming");
  const [months, setMonths] = useState(3);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(null);
  const [reload, setReload] = useState(0);
  const from = mode === "upcoming" ? addDays(today, -UNREGISTERED_LOOKBACK) : addMonths(today, -months);
  const to = mode === "upcoming" ? addMonths(today, months) : today;

  useEffect(() => {
    let alive = true;
    setLoading(true); setError("");
    api(`/api/appointments?from=${from}&to=${to}`)
      .then((result) => alive && setData(result))
      .catch((err) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [from, to, reload]);

  const openPatient = (patientId) => onPatient({ id: patientId, tab: "appointments" });
  // 带版本号登记到诊结果，别处改过会提示刷新。
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

  const all = data?.from === from && data?.to === to ? data.appointments : null;
  const scheduled = all?.filter((a) => a.status === "scheduled") || [];
  const unregistered = scheduled.filter((a) => a.date < today);
  const upcoming = scheduled.filter((a) => a.date >= today);
  const records = (all?.filter((a) => a.status === "attended" || a.status === "missed") || []).reverse();
  const attendedCount = records.filter((a) => a.status === "attended").length;

  const name = (a) => <button className="om-link schedule-patient" onClick={() => openPatient(a.patientId)}>{a.patientName || "未命名患者"}{a.patientNumber && <small>{a.patientNumber}</small>}</button>;
  const register = (a) => <span className="schedule-actions">
    <button className="text-button" disabled={Boolean(acting)} onClick={() => outcome(a, "attended")}>已到诊</button>
    <button className="text-button" disabled={Boolean(acting)} onClick={() => outcome(a, "missed")}>未到诊</button>
  </span>;
  const row = (a, extra) => <li key={a.id}>
    <span className="schedule-date">{dateLabel(a.date)}{a.time && <small>{a.time}</small>}</span>
    {name(a)}
    <span className="schedule-detail">{a.reason || ""}</span>
    {extra}
  </li>;
  const until = (a) => { const n = daysBetween(today, a.date); return <span className="schedule-detail">{n === 0 ? "今天" : `${n} 天后`}</span>; };

  return (
    <section className="clinic-schedule" aria-label="复诊名单" aria-busy={loading}>
      <div className="om-page-head schedule-head">
        <div><h1>复诊名单</h1>
          <span className="om-page-meta">{mode === "upcoming" ? "接下来要来复诊的患者。点姓名打开患者的复诊预约。" : "最近来了和没来的患者。没来的可以点进去重新预约。"}</span></div>
        <button className="icon-button" title="刷新" aria-label="刷新" disabled={loading} onClick={() => setReload((n) => n + 1)}><RotateCw size={16} /></button>
      </div>
      <div className="schedule-toolbar">
        <div className="agenda-filters" role="group" aria-label="查看内容">
          {[["upcoming", "待复诊"], ["records", "到诊记录"]].map(([id, label]) => <button key={id} aria-pressed={mode === id} className={mode === id ? "active" : ""} onClick={() => { setMode(id); setNotice(""); }}>{label}</button>)}
        </div>
        <div className="agenda-filters" role="group" aria-label="时间范围">
          {RANGES.map(([n, label]) => <button key={n} aria-pressed={months === n} className={months === n ? "active" : ""} onClick={() => setMonths(n)}>{mode === "upcoming" ? `未来${label}` : `近${label}`}</button>)}
        </div>
      </div>
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}<button className="text-button" onClick={() => setReload((n) => n + 1)}>重试</button></p>}

      {mode === "upcoming" && all && <>
        {unregistered.length > 0 && <>
          <h2 className="schedule-section">预约日已过，还没登记 <span>{unregistered.length}</span></h2>
          <ul className="schedule-list">{unregistered.map((a) => row(a, register(a)))}</ul>
        </>}
        <h2 className="schedule-section">待复诊 <span>{upcoming.length}</span></h2>
        {upcoming.length
          ? <ul className="schedule-list">{upcoming.map((a) => row(a, a.date === today ? register(a) : until(a)))}</ul>
          : <p className="om-empty">这段时间没有复诊预约。</p>}
      </>}

      {mode === "records" && all && <>
        <h2 className="schedule-section">到诊 {attendedCount} 人次 · 未到 {records.length - attendedCount} 人次</h2>
        {records.length
          ? <ul className="schedule-list">{records.map((a) => row(a, a.status === "attended"
            ? <em className="om-chip is-ok">已到诊</em>
            : <span className="schedule-actions"><em className="om-chip is-danger">未到诊</em><button className="text-button" onClick={() => openPatient(a.patientId)}>重新预约</button></span>))}</ul>
          : <p className="om-empty">这段时间没有到诊记录。</p>}
      </>}

      {loading && !all && <p className="muted" role="status">正在读取…</p>}
    </section>
  );
}
