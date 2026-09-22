import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { briefDraft } from "../shared/patient-brief.mjs";
import { api } from "./agent-runtime";

const medStatus = { active: "正在使用", stopped: "已停用", unknown: "状态待核对" };
const outcomeStatus = { completed: "已联系", unreachable: "未联系到", declined: "患者拒绝" };
const when = (value) => value ? new Date(value).toLocaleDateString("zh-CN") : "日期未记录";
const allergyText = (brief) => brief.allergyStatus === "none_known" ? "已核对：无已知过敏" : brief.allergyStatus === "recorded" ? brief.allergies.join("、") : "过敏史尚未核对";

export function PatientBriefPanel({ patient, onOpenTask, onNavigate, onEditIdentity }) {
  const [brief, setBrief] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const load = async () => {
    const request = ++generation.current;
    setBusy(true); setError("");
    try {
      const value = await api(`/api/patients/${patient.id}/brief`);
      if (request === generation.current) { setBrief(value); return value; }
    } catch (err) { if (request === generation.current) setError(err.message); }
    finally { if (request === generation.current) setBusy(false); }
  };
  useEffect(() => { setBrief(null); load(); return () => { generation.current++; }; }, [patient.id, patient.revision]);
  const prepare = async (purpose) => {
    // Refresh immediately before drafting: a follow-up may have been recorded
    // since opening this panel without changing the patient chart revision.
    const current = await load();
    if (current) onOpenTask(current.sessionId, { draft: briefDraft(current, purpose) });
  };
  return <section className="patient-brief" aria-label="诊前速览">
    <header className="brief-heading"><div><span className="eyebrow">当前档案 · 本地读取</span><h3>诊前速览</h3><p className="muted">先看近况，再继续接诊与随访。</p></div>
      <button className="icon-button" aria-label="刷新诊前速览" onClick={load} disabled={busy}><RefreshCw size={16} /></button></header>
    {error && <p className="error" role="alert">{error} <button onClick={load}>重试</button></p>}
    {!brief && !error && <p className="muted">正在读取患者近况…</p>}
    {brief && <>
      <div className="brief-facts">
        <div><h4>已登记诊断 <small>{brief.counts.diagnoses}</small></h4>{brief.diagnoses.length ? brief.diagnoses.map((d, i) => <p key={i}><b>{d.name}</b><small>{d.date || "日期未记录"} · {d.source}</small></p>) : <p className="muted">尚未登记</p>}</div>
        <div><h4>用药与过敏</h4><p className={`brief-allergy ${brief.allergyStatus === "unknown" ? "unverified" : ""}`}>{allergyText(brief)}</p>{brief.medications.slice(0, 5).map((m, i) => <p key={i}><b>{m.name}</b> <span className="brief-state">{medStatus[m.status]}</span><small>{[m.dose, m.frequency, m.source].filter(Boolean).join(" · ")}</small></p>)}{brief.counts.medications > 5 && <button className="text-button" onClick={() => onNavigate("clinical")}>查看全部 {brief.counts.medications} 条用药</button>}</div>
      </div>
      {brief.gaps.length > 0 && <div className="brief-gaps"><b>接诊时顺手核对</b>{brief.gaps.map((gap) => <button key={gap.field} onClick={() => gap.tab === "info" ? onEditIdentity?.() : onNavigate(gap.tab)}>{gap.label}<ArrowUpRight size={13} /></button>)}</div>}
      {brief.labs.length > 0 && <div className="brief-labs"><h4>最近检验 <small>同项目、同单位比较；数值变化不代表临床结论</small></h4><div className="brief-lab-grid">{brief.labs.slice(0, 4).map((lab, i) => <div key={i}><span>{lab.item}</span><b>{lab.conflict ? "同日记录待核对" : `${lab.value} ${lab.unit || "单位未记录"}`}</b><small>{lab.date} · {lab.source}</small>{lab.conflict ? <small>{lab.observations.map((v) => `${v.value} ${v.unit || ""}（${v.source}）`).join("；")}</small> : lab.delta !== null ? <small>较 {lab.previous.date} {lab.delta > 0 ? "+" : ""}{lab.delta} {lab.unit}</small> : <small>暂无可比较的更早记录</small>}</div>)}</div>{brief.counts.labGroups > 4 && <button className="text-button" onClick={() => onNavigate("clinical")}>查看全部检验</button>}</div>}
      {(brief.visits.length > 0 || brief.outcomes.length > 0) && <div className="brief-recent"><h4>最近联系与就诊</h4>{[...brief.visits.map((v, i) => ({ key: `visit-${i}`, at: v.date, title: v.reason, note: v.note, label: "就诊记录" })), ...brief.outcomes.map((o) => ({ key: o.id, at: o.contactedAt || o.recordedAt, title: o.title, note: `${o.note}${o.addenda?.length ? ` · 最新补充：${o.addenda.at(-1).note}` : ""}`, label: outcomeStatus[o.status] }))].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 3).map((item) => <div key={item.key}><time>{when(item.at)}</time><p><b>{item.title}</b><small>{item.label} · {item.note || "无补充记录"}</small></p></div>)}</div>}
      {brief.counts.careTasks > 0 && <div className="brief-gaps"><b>{brief.counts.careTasks} 项检查或转诊还需跟进</b>{brief.careTasks.slice(0, 3).map((task) => <button key={task.id} onClick={() => onNavigate("tracking")}>{task.title} · {{ waiting_result: "等待结果", awaiting_review: "待核对", awaiting_communication: "待告知" }[task.status]}<ArrowUpRight size={13} /></button>)}</div>}
      <footer className="brief-actions"><div><button className="primary" disabled={busy || patient.archived} onClick={() => prepare("previsit")}>准备本次接诊 <ArrowUpRight size={14} /></button><button className="secondary" disabled={busy || patient.archived} onClick={() => prepare("postvisit")}>准备诊后文书</button></div><small>填入任务草稿后由你发送 · 快照 {brief.fingerprint.slice(0, 8)}</small></footer>
    </>}
  </section>;
}
