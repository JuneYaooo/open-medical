import { useCallback, useEffect, useState } from "react";
import { api } from "../../../src/agent-runtime";
import { Modal } from "../../../src/plugin-kit/index.js";
import { localCalendarDate as today } from "../../../shared/calendar-date.mjs";
import { SCREEN, ScreenCell, TrialConditions } from "./TrialAssist";

export const STAGES = { none: "未处理", shortlisted: "拟邀请", contacted: "已联系", consented: "已签知情同意", enrolled: "已入组", declined: "患者拒绝", ineligible: "不符合", withdrawn: "已退出" };
const FLOW = ["shortlisted", "contacted", "consented", "enrolled"];
const CLOSED = ["declined", "ineligible", "withdrawn"];
const AI = { running: "初筛中", completed: "已完成", failed: "未完成", cancelled: "已停止", interrupted: "已中断" };
const FILTERS = [["todo", "待处理"], ["flow", "入组流程"], ["all", "全部"], ["closed", "已结束"]];
const date = (value) => value ? new Date(value).toLocaleDateString("zh-CN") : "";

const screenPill = (c) => c.screen.source === "conditions" ? SCREEN[c.screen.status] : ["未设置筛选条件", "muted"];

// Stage picker; 已签知情同意 asks for the signing date first.
export function EnrollmentSelect({ trialId, patientId, enrollment, onChanged, onError }) {
  const [consent, setConsent] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async (body) => {
    setBusy(true);
    try { await api(`/api/trials/${trialId}/enrollments/${patientId}`, "PUT", { ...body, expectedRevision: enrollment.revision }); setConsent(null); onChanged?.(); }
    catch (e) { onError?.(e.message); }
    finally { setBusy(false); }
  };
  return <>
    <select aria-label="入组状态" className={`trial-stage stage-${enrollment.stage}`} value={enrollment.stage} disabled={busy} onChange={(e) => {
      const stage = e.target.value;
      if (stage === "consented") setConsent({ stage, consentDate: enrollment.consentDate || today(), note: "" });
      else save({ stage });
    }}>{Object.entries(STAGES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
    {consent && <Modal title="登记知情同意" onClose={() => setConsent(null)}>
      <div className="trial-consent">
        {<>
          <label>知情同意书签署日期<input type="date" value={consent.consentDate} max={today()} onChange={(e) => setConsent({ ...consent, consentDate: e.target.value })} /></label>
          <label>备注（可选）<input value={consent.note} maxLength={1000} onChange={(e) => setConsent({ ...consent, note: e.target.value })} placeholder="如：同意书版本 V2.1，研究护士见证" /></label>
          <p className="muted">请确认患者已签署当前版本的知情同意书，原件按研究中心要求保存。</p>
        </>}
        <footer className="module-actions"><button className="secondary" onClick={() => setConsent(null)}>取消</button>
          <button className="primary" disabled={busy || !consent.consentDate} onClick={() => save(consent)}>登记</button></footer>
      </div>
    </Modal>}
  </>;
}

export function TrialCandidatesPanel({ trial, onScreen, onOpenPatient, agent }) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("todo");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);
  const load = useCallback(() => api(`/api/trials/${trial.id}/candidates`).then((v) => { setData(v); setError(""); }).catch((e) => setError(e.message)), [trial.id]);
  const running = data?.batch?.status === "running" || data?.candidates.some((c) => c.ai?.status === "running");
  useEffect(() => {
    load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, running ? 3000 : 15000);
    return () => clearInterval(timer);
  }, [load, running]);
  if (!data) return error ? <p role="alert" className="form-error">{error}</p> : <p role="status">正在整理候选患者…</p>;

  const { counts, batch } = data, screening = data.trial.screening;
  const list = data.candidates.filter((c) => {
    const s = c.enrollment.stage;
    if (filter === "flow") return FLOW.includes(s);
    if (filter === "closed") return CLOSED.includes(s);
    // 只按已确认的筛选条件隐藏不符合者；未设置条件时全部保留。
    if (filter === "todo") return s === "none" && c.screen.status !== "mismatch" || ["shortlisted", "contacted", "consented"].includes(s);
    return true;
  });
  const b = batch && { ...batch, done: Object.values(batch.results || {}).filter((r) => r.status !== "running").length };
  const current = b?.current && data.candidates.find((c) => c.patientId === b.current);

  return <section className="trial-candidates" aria-label="候选患者">
    {agent && <TrialConditions trial={trial} screening={screening} agent={agent} onChanged={(message) => { setError(""); setNotice(message); load(); }} onError={(message) => { setNotice(""); setError(message); }} />}
    <div className="trial-funnel" aria-label="招募进度">
      {screening ? <div><strong>{counts.screen.match}</strong><span>符合筛选条件{counts.screen.unclear ? `（另 ${counts.screen.unclear} 位待核对）` : ""}</span></div>
        : <div><strong>—</strong><span>未设置筛选条件</span></div>}
      <div><strong>{counts.aiDone}</strong><span>AI 已初筛{counts.awaitingReview ? `（${counts.awaitingReview} 位待核对）` : ""}</span></div>
      {FLOW.map((s) => <div key={s}><strong>{counts.stages[s]}</strong><span>{STAGES[s]}</span></div>)}
    </div>
    <p className="muted">{screening
      ? `按筛选条件逐条预筛：共 ${counts.total} 位患者，符合 ${counts.screen.match}、待核对 ${counts.screen.unclear}、不符合 ${counts.screen.mismatch}。缺资料记为待核对，不是不符合；预筛不能代替逐项核对。`
      : `共 ${counts.total} 位患者。未设置筛选条件时预筛均为待核对，表中“粗略提示”只比对字面年龄、性别和诊断，仅供参考。`}</p>
    {b?.status === "running" ? <div className="trial-batch" role="status">
      <b>正在批量 AI 初筛 {b.done}/{b.patientIds.length}</b>{current && <span>当前：{current.name}</span>}
      <progress aria-label="批量初筛进度" value={b.done} max={b.patientIds.length} />
      <button className="secondary" onClick={() => api(`/api/trials/${trial.id}/batches/${b.id}/cancel`, "POST", {}).then(load).catch((e) => setError(e.message))}>停止</button>
    </div> : b && ["completed", "cancelled", "interrupted", "failed"].includes(b.status) ? <p className="muted">上次批量初筛{b.status === "completed" ? "已完成" : b.status === "cancelled" ? "已停止" : "未完成"}：{b.done}/{b.patientIds.length} 位 · {date(b.updatedAt)}{b.detail ? ` · ${b.detail}` : ""}</p> : null}
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && <p role="status" className="form-notice">{notice}</p>}
    <div className="trial-toolbar">
      <div className="module-actions trial-filters" aria-label="候选筛选">
        {FILTERS.map(([id, label]) => <button key={id} className={filter === id ? "primary" : "secondary"} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
      </div>
      {b?.status !== "running" && <button className="primary" onClick={() => setBatchOpen(true)}>{data.suggested.length ? `批量 AI 初筛（建议 ${data.suggested.length} 位）` : "批量 AI 初筛"}</button>}
    </div>
    {!list.length ? <p className="muted">{filter === "todo" ? "当前没有需要处理的候选患者。" : "没有符合条件的患者。"}</p> :
      <table className="trial-table">
        <thead><tr><th>患者</th><th>{screening ? "条件预筛" : "预筛"}</th><th>AI 初筛</th><th>医生核对</th><th>入组状态</th><th>下一步</th></tr></thead>
        <tbody>{list.map((c) => <tr key={c.patientId}>
          <td><button className="text-button" onClick={() => onOpenPatient?.(c.patientId)}>{c.name}</button>
            <small>{[c.patientNumber, c.gender === "female" ? "女" : c.gender === "male" ? "男" : "", c.birthYear ? `${c.birthYear} 年生` : ""].filter(Boolean).join(" · ")}</small>
            {c.diagnoses.length > 0 && <small>{c.diagnoses.join("、")}</small>}</td>
          <td><ScreenCell candidate={c} /></td>
          <td>{c.ai ? <>{AI[c.ai.status] || c.ai.status}{c.ai.status === "running" ? ` ${c.ai.checked}/${c.ai.total}` : ""}
            {c.ai.status === "completed" && <small>冲突 {c.ai.conflicts} · 待补 {c.ai.missing}</small>}
            {c.ai.stale && <small className="warn">资料已更新，需重新初筛</small>}</> : <span className="muted">未初筛</span>}</td>
          <td>{c.review ? <>{c.review.summary}<small>{date(c.review.updatedAt)}{c.review.stale ? " · 档案已更新" : ""}</small></> : <span className="muted">未核对</span>}</td>
          <td><EnrollmentSelect trialId={trial.id} patientId={c.patientId} enrollment={c.enrollment} onChanged={() => { setError(""); setNotice(`${c.name} 的入组状态已更新。`); load(); }} onError={(message) => { setNotice(""); setError(message); }} />
            {c.enrollment.consentDate && <small>同意书 {c.enrollment.consentDate}</small>}</td>
          <td><b className="trial-next">{c.next}</b><button className="secondary" onClick={() => onScreen(c.patientId)}>逐项核对</button></td>
        </tr>)}</tbody>
      </table>}
    {batchOpen && <BatchDialog trial={trial} data={data} onClose={() => setBatchOpen(false)} onStarted={(n) => { setBatchOpen(false); setNotice(`已开始批量初筛 ${n} 位患者，可以离开此页，结果会自动保存。`); load(); }} />}
  </section>;
}

function BatchDialog({ trial, data, onClose, onStarted }) {
  const pool = data.candidates.filter((c) => !c.archived && !CLOSED.includes(c.enrollment.stage) && c.enrollment.stage !== "enrolled");
  const [picked, setPicked] = useState(() => new Set(data.suggested));
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return <Modal title="批量 AI 初筛" onClose={onClose} wide>
    <div className="trial-batch-dialog">
      <p>AI 会逐位读取所选患者的档案和病历资料，按方案逐条判断入选和排除条件，并标出冲突和待补资料。结果是草稿，仍需你逐项核对。已有有效 AI 结果的患者会自动跳过。</p>
      <div className="module-actions">
        <button className="secondary" onClick={() => setPicked(new Set(data.suggested))}>只选建议的 {data.suggested.length} 位{data.suggestedBy === "rough" ? "（按粗略提示）" : ""}</button>
        {data.suggestedBy === "conditions" && <button className="secondary" onClick={() => setPicked(new Set(pool.filter((c) => c.screen.status !== "mismatch").map((c) => c.patientId).slice(0, 50)))}>选择全部非不符合</button>}
        <button className="secondary" onClick={() => setPicked(new Set())}>清空</button>
      </div>
      <ul className="trial-batch-list">{pool.map((c) => <li key={c.patientId}><label>
        <input type="checkbox" checked={picked.has(c.patientId)} onChange={() => toggle(c.patientId)} />
        <span><b>{c.name}</b> <span className={`trial-pill ${screenPill(c)[1]}`}>{screenPill(c)[0]}</span>
          {c.ai?.status === "completed" && !c.ai.stale ? <small>已有 AI 结果</small> : null}<small>{c.screen.open?.[0] ? `${c.screen.open[0].label}：${c.screen.open[0].verdictLabel}` : c.diagnoses.join("、")}</small></span>
      </label></li>)}</ul>
      <label className="trial-consent-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>同意把所选 {picked.size} 位患者的病历资料交给当前配置的模型分析。档案快照不含姓名和电话，上传的病历文件按原样发送。</span></label>
      {error && <p role="alert" className="form-error">{error}</p>}
      <footer className="module-actions"><button className="secondary" onClick={onClose}>取消</button>
        <button className="primary" disabled={!consent || !picked.size || picked.size > 50 || busy} onClick={async () => {
          setBusy(true); setError("");
          try { const b = await api(`/api/trials/${trial.id}/batches`, "POST", { patientIds: [...picked], externalConsent: true }); onStarted(b.patientIds.length); }
          catch (e) { setError(e.message); }
          finally { setBusy(false); }
        }}>{picked.size > 50 ? "一次最多 50 位" : busy ? "正在开始…" : `开始初筛 ${picked.size} 位`}</button></footer>
    </div>
  </Modal>;
}
