import { PersonalReferences, RememberedNotice } from "./learning-loop";
import { IntakeReview } from "./intake-review";
import { intakeUploads } from "./intake-background";
import { useEffect, useRef, useState } from "react";
import { Upload, Loader2 } from "lucide-react";
import { Modal } from "./components";
import { api } from "./agent-runtime";
import { importMaterial, uploadScannedPages, MATERIAL_ACCEPT } from "./import-material";
import { materialQualityLevel } from "./material-details";
import { OCR_QUALITY_LABELS } from "../shared/ocr-quality.mjs";

async function intakeActions(status = "pending", sourceSessionId) {
  const actions = [];
  let offset = 0;
  do {
    const query = new URLSearchParams({ status, type: "patient-create", offset: String(offset) });
    if (sourceSessionId) query.set("sourceSessionId", sourceSessionId);
    const page = await api(`/api/pending-actions?${query}`);
    actions.push(...page.actions); offset = page.nextOffset;
  } while (offset != null);
  return { actions };
}

export function PatientIntakeModal({ onClose, onCreated, onManual, onOpenWorkspace, configured }) {
  const chooser = useRef(null);
  const review = useRef(null);
  const [reviewEditing, setReviewEditing] = useState(false);
  const [editCount, setEditCount] = useState(0);
  const [reorganize, setReorganize] = useState(null);
  const [remembered, setRemembered] = useState([]);
  const [reviewMode, setReviewMode] = useState('preserve');
  const sessionId = useRef(null);
  const materials = useRef([]);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [files, setFiles] = useState([]);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState(null);
  const [reply, setReply] = useState("");
  const [correction, setCorrection] = useState("");
  const [failedUploads, setFailedUploads] = useState([]);
  const [skipped, setSkipped] = useState([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [listing, setListing] = useState(true);
  const [listError, setListError] = useState("");
  const mounted = useRef(true);
  const listVersion = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const controller = useRef(null);
  const cancelled = useRef(false);
  const needsParse = useRef(false);
  const saveFiles = (value) => { materials.current = value; setFiles([...value]); };
  useEffect(() => {
    if (!busy) return;
    const start = Date.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const refreshTasks = async () => {
    const version = ++listVersion.current;
    setListing(true); setListError("");
    try {
      const [sessions, applied, pending] = await Promise.all([
        api("/api/sessions"), intakeActions("applied"), intakeActions(),
      ]);
      const complete = new Set(applied.actions.filter(a => a.type === "patient-create").map(a => a.payload.sourceSessionId));
      const unfinished = sessions.sessions.filter(item => item.title === "上传资料建档" && !item.patientId && !complete.has(item.id) && (item.intake?.fileCount || item.intake?.issueCount))
        .map(item => ({ ...item, draft: pending.actions.find(a => a.type === "patient-create" && a.payload.sourceSessionId === item.id) }));
      if (mounted.current && version === listVersion.current) setTasks(unfinished);
    } catch (err) {
      if (mounted.current && version === listVersion.current) setListError(`读取未完成任务失败：${err.message}`);
    } finally { if (mounted.current && version === listVersion.current) setListing(false); }
  };
  useEffect(() => {
    mounted.current = true;
    refreshTasks();
    const timer = setInterval(() => { if (!sessionId.current) refreshTasks(); }, 2000);
    return () => { mounted.current = false; listVersion.current++; clearInterval(timer); };
  }, []);
  const clearCurrent = () => {
    sessionId.current = null; saveFiles([]); needsParse.current = false; cancelled.current = false;
    setProposal(null); setEditCount(0); setFailedUploads([]); setSkipped([]); setAcknowledged(false);
    setError(""); setReply(""); setCorrection(""); setProgress(""); setElapsed(0);
  };
  const startNew = () => {
    if (inFlight.current || restoring) return;
    clearCurrent(); refreshTasks();
  };
  const resume = async (id) => {
    if (inFlight.current || restoring) return;
    inFlight.current = true; setRestoring(true); setError("");
    try {
      const [saved, pending, applied, sessions] = await Promise.all([
        api(`/api/sessions/${id}`), intakeActions("pending", id), intakeActions("applied", id), api("/api/sessions"),
      ]);
      if (!mounted.current) return;
      if (applied.actions.some(a => a.type === "patient-create" && a.payload.sourceSessionId === id)) throw new Error("该任务已完成建档，请到患者档案查看。");
      const running = saved.intakeJob?.status === "running";
      if (intakeUploads.has(id)) throw new Error("资料仍在上传，请稍候再查看。");
      if (!running && sessions.sessions.find(item => item.id === id)?.running) throw new Error("该任务仍在处理中，请打开资料工作区查看进度。");
      clearCurrent(); sessionId.current = id; saveFiles(saved.files || []);
      setFailedUploads((saved.intakeIssues || []).map(item => ({ ...item, file: { name: item.name } })));
      const drafts = pending.actions.filter(a => a.type === "patient-create" && a.payload.sourceSessionId === id);
      if (drafts.length === 1) setProposal(drafts[0]);
      if (drafts.length > 1) setError("该任务有多个建档草稿，请打开资料工作区核对患者归属。");
      setProgress(`已载入所选任务的 ${saved.files?.length || 0} 份资料，无需重新上传。`);
      if (saved.intakeJob?.reply) setReply(saved.intakeJob.reply);
      if (saved.intakeJob?.error) setError(saved.intakeJob.error);
      if (running) { setRestoring(false); setBusy(true); await watchJob(); }
    } catch (err) { if (mounted.current) { setError(err.message); refreshTasks(); } }
    finally { inFlight.current = false; if (mounted.current) { setRestoring(false); setBusy(false); } }
  };
  const loadProposal = async () => {
    const result = await intakeActions("pending", sessionId.current);
    const found = result.actions.filter(a => a.status === "pending" && a.type === "patient-create" && a.payload.sourceSessionId === sessionId.current);
    if (found.length > 1) throw new Error("资料中生成了多个建档草稿，请打开工作区逐一核对患者归属。");
    setProposal(found[0] || null);
    return found[0];
  };
  const watchJob = async () => {
    while (mounted.current) {
      let job;
      try { ({ job } = await api(`/api/sessions/${sessionId.current}/intake-job`)); }
      catch (err) {
        if (err.status === 404) throw err;
        if (!mounted.current) return;
        setError("暂时无法读取进度，后台任务不会因此停止。正在重新连接…");
        await new Promise(resolve => setTimeout(resolve, 2000)); continue;
      }
      setError("");
      if (!mounted.current) return;
      setProgress(job?.progress || "正在后台处理…");
      if (job?.status !== "running") {
        const saved = await api(`/api/sessions/${sessionId.current}`);
        saveFiles(saved.files || []);
        setFailedUploads((saved.intakeIssues || []).map(item => ({ ...item, file: { name: item.name } })));
        setReply(job?.reply || ""); setError(job?.error || "");
        await loadProposal(); return;
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
  };
  const parse = async (selected = [], resolvedMode) => {
    if (proposal && (review.current?.count || 0) > 0 && !resolvedMode) { setReorganize(selected); return; }
    try { await review.current?.flush(); } catch (err) { setError(err.message); return; }
    if (inFlight.current || restoring) return;
    inFlight.current = true; cancelled.current = false;
    controller.current = new AbortController();
    const signal = controller.current.signal;
    setBusy(true); setError(""); setReply(""); setAcknowledged(false);
    const failures = failedUploads.filter(item => item.stage === "upload" && !selected.some(file => file.name === item.file.name)), duplicates = [];
    const persistIssues = () => api(`/api/sessions/${sessionId.current}/intake-issues`, "PUT", { issues: failures.map(item => ({ name: item.file.name, error: item.error, stage: item.stage })) });
    try {
      if (!sessionId.current) sessionId.current = (await api("/api/sessions", "POST", { title: "上传资料建档" })).id;
      intakeUploads.set(sessionId.current, true);
      for (const [index, file] of selected.entries()) {
        signal.throwIfAborted();
        setProgress(`上传资料 ${index + 1}/${selected.length}：${file.name}`);
        try {
          const input = await importMaterial(file, ({ stage, done, total }) =>
            setProgress(stage === "render"
              ? `上传资料 ${index + 1}/${selected.length} · 读取扫描页 ${done + 1}/${total}：${file.name}`
              : stage === "compress"
                ? `上传资料 ${index + 1}/${selected.length} · 图片较大，正在自动压缩：${file.name}`
                : /\.pdf$/i.test(file.name)
                  ? `上传资料 ${index + 1}/${selected.length} · 正在解析 PDF 文本：${file.name}`
                  : `上传资料 ${index + 1}/${selected.length} · 正在读取：${file.name}`));
          signal.throwIfAborted();
          const finalized = await uploadScannedPages(sessionId.current, input, (done, total) =>
            setProgress(`上传扫描页 ${done + 1}/${total}：${file.name}`));
          signal.throwIfAborted();
          const material = await api(`/api/sessions/${sessionId.current}/files`, { method: "POST", body: JSON.stringify(finalized), signal });
          saveFiles([...materials.current, material]); needsParse.current = true;
        } catch (err) {
          signal.throwIfAborted();
          if (err.code === "DUPLICATE_FILE") {
            duplicates.push(file.name);
            // A repeated upload (including a lost response) already has its durable material.
            saveFiles((await api(`/api/sessions/${sessionId.current}`)).files);
          } else failures.push({ file, error: err.message, stage: "upload" });
        }
      }
      setSkipped(duplicates); setFailedUploads([...failures]);
      await persistIssues();
      if (!materials.current.length) throw new Error("没有可解析的资料。请更换文件后再试。");
      if (!needsParse.current && !failedUploads.length && !failures.length && !correction.trim() && await loadProposal()) {
        setProgress("已恢复建档草稿，请核对后确认"); return;
      }
      const started = await api(`/api/sessions/${sessionId.current}/intake-job`, "POST", { correction, externalConsent: true, reviewMode: resolvedMode || "preserve" });
      setRemembered(started.job?.remembered || []);
      intakeUploads.delete(sessionId.current);
      setProgress("已进入后台处理，你可以关闭窗口或处理其他任务。");
      await watchJob();
      needsParse.current = false;
      setCorrection("");
    } catch (err) {
      if (signal.aborted || cancelled.current) setProgress("已停止，上传资料和识别结果已保存，可继续解析。");
      else { setError(err.message); setProgress("本次处理未完成，已保存的资料无需重新上传。"); }
    } finally { intakeUploads.delete(sessionId.current); inFlight.current = false; setBusy(false); controller.current = null; }
  };
  const stop = () => {
    cancelled.current = true; controller.current?.abort();
    if (sessionId.current) api(`/api/sessions/${sessionId.current}/intake-job`, "DELETE").catch(err => setError(err.message));
  };
  const confirm = async () => {
    if (inFlight.current || (failedUploads.length && !acknowledged)) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await review.current?.flush(); const result = await api(`/api/pending-actions/${proposal.id}/confirm`, "POST", review.current?.value() || {}); if (result.habitSuggestions?.length) sessionStorage.setItem(`habit-suggestion:${result.applied.id}`, JSON.stringify(result.habitSuggestions)); if (result.pausedHabits?.length) sessionStorage.setItem(`habit-paused:${result.applied.id}`, JSON.stringify(result.pausedHabits)); await onCreated(result.applied); }
    catch (err) { setError(err.message); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const closeReview = async () => { try { await review.current?.flush(); onClose(); } catch (err) { setError(err.message); } };
  return <Modal title="上传资料建档" wide onClose={closeReview}>
    <div className="modal-form">
      <p>上传病历、检查报告或病史描述，自动整理为患者档案。你只需核对结果。</p>
      {busy && <><p role="status">可以关闭此窗口，任务会继续处理。资料上传完毕后，刷新页面也不会中断解析。</p><button className="secondary" onClick={closeReview}>后台处理，关闭窗口</button></>}
      <p className="muted">支持图片、PDF、Word、Excel、TXT、Markdown、JSON；可一次选择同一患者的多份资料。选择后自动开始解析，相关内容将交由当前配置的模型处理。</p>
      <h3>{sessionId.current ? "当前患者的建档任务" : "新患者建档"}</h3>
      <p className="muted">{sessionId.current ? "补充的资料仅加入当前任务。要处理另一位患者，请先新建任务。" : "这里上传的资料会创建独立任务，不会加入之前的患者资料。"}</p>
      {!busy && sessionId.current && <button className="secondary" disabled={restoring} onClick={startNew}>为另一位患者新建</button>}
      <input ref={chooser} type="file" accept={MATERIAL_ACCEPT} multiple hidden onChange={event => { const selected = [...event.target.files]; event.target.value = ""; if (selected.length) parse(selected); }} />
      {!busy && !!files.length && !proposal && <button className="primary" disabled={restoring || !configured} onClick={() => parse()}>继续解析已保存资料</button>}
      {<button className={files.length ? "secondary" : "primary"} disabled={busy || restoring || !configured} onClick={() => chooser.current.click()}><Upload size={16} />{sessionId.current ? "补充当前患者资料并重新解析" : "选择资料并自动解析"}</button>}
      {!configured && <p role="alert">请先在设置中配置模型，再上传资料自动建档。</p>}
      {restoring && <p role="status">正在载入所选任务…</p>}
      {!sessionId.current && <section aria-label="未完成的建档任务">
        <h3>建档任务</h3>
        <p className="muted">后台处理、待核对的草稿和未完成任务会分别标明状态。选择后才会载入。</p>
        {listing && <p role="status">正在查找未完成任务…</p>}
        {listError && <p role="alert">{listError}<button className="secondary" onClick={refreshTasks}>刷新任务列表</button></p>}
        {!listing && !listError && !tasks.length && <p className="muted">暂无未完成任务</p>}
        {tasks.map(task => <article key={task.id} aria-label={`建档任务：${task.intake.firstFileName || task.intake.firstIssueName}`}>
          <h4>{task.draft?.payload.name || "未确认患者"}</h4>
          <p>资料：{task.intake.firstFileName || task.intake.firstIssueName} · 已保存 {task.intake.fileCount} 份{task.intake.issueCount ? ` · ${task.intake.issueCount} 份未读取` : ""}</p>
          <p className="muted">{new Date(task.updatedAt).toLocaleString("zh-CN")} · {intakeUploads.has(task.id) ? "资料上传中" : task.intake.job?.status === "running" || task.running ? "后台处理中" : task.draft ? "草稿待确认" : (task.intake.job?.status === "needs_input" || (!task.intake.job && task.lastRunStatus === "completed")) ? "待补充信息" : "处理未完成"}</p>
          <button className="secondary" disabled={busy || restoring || intakeUploads.has(task.id)} onClick={() => task.running && task.intake.job?.status !== "running" ? onOpenWorkspace(task.id) : resume(task.id)}>{task.intake.job?.status === "running" || task.running ? "查看处理进度" : task.draft ? "核对这份草稿" : (task.intake.job?.status === "needs_input" || (!task.intake.job && task.lastRunStatus === "completed")) ? "补充信息" : "继续这个任务"}</button>
        </article>)}
      </section>}
      {!!remembered.length && <RememberedNotice key={remembered.map(m => m.id).join(",")} memories={remembered} />}
      {progress && <p role="status">{busy && <Loader2 size={15} className="spin" />} {progress}{busy && `（已用时 ${elapsed} 秒）`}</p>}
      {!!files.length && <details><summary>已保存 {files.length} 份资料 · {files.filter(f => f.extraction?.ocr?.status === "ready" || (!f.extraction?.artifactId && !f.extraction?.pageImages?.length)).length} 份识别完成</summary><ul aria-label="已上传资料">{files.map(file => { const level = materialQualityLevel(file); return <li key={file.id}>{file.name}{file.extraction?.ocr?.status === "ready" ? ` · 已识别${level && level !== "good" ? `（${OCR_QUALITY_LABELS[level]}，建议在患者档案的资料库里对照原图` : ""}）` : ""}</li>; })}</ul></details>}
      {!!skipped.length && <p>已自动跳过 {skipped.length} 份重复资料，保留已有内容，不影响解析。</p>}
      {!!failedUploads.length && <p>有 {failedUploads.length} 份资料未纳入本次整理，其余有效资料继续处理。可更换文件补充，或重试失败资料。</p>}
      {failedUploads.map(({ file, error }) => <p className="error-text" key={file.name}>{file.name}：{error}</p>)}
      {error && <p className="error-text" role="alert">{error}</p>}
      {proposal && <section aria-label="自动解析的建档草稿">
        <IntakeReview key={proposal.id} action={proposal} ref={review} onEditing={setReviewEditing} onChange={({ count }) => setEditCount(count)} />
        <PersonalReferences action={proposal} />
        <p className="muted">确认后保存档案，并关联本次上传的资料。</p>
        {!!failedUploads.length && <label><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />我已知晓上述资料未纳入，先保存这份不完整草稿</label>}
        <button className="primary" disabled={busy || reviewEditing || (!!failedUploads.length && !acknowledged)} onClick={confirm}>{editCount ? `确认建档（含你的 ${editCount} 处修改）` : "确认建档"}</button>
      </section>}
      {reorganize !== null && <section role="alert" aria-label="重新整理修改处理"><p>重新整理会生成一份新草稿。你手动做的 {review.current?.count || 0} 处修改怎么处理？</p><label><input type="radio" name="reviewMode" checked={reviewMode === 'preserve'} onChange={() => setReviewMode('preserve')} />告诉 AI 我改了什么，让它在新草稿里保留</label><label><input type="radio" name="reviewMode" checked={reviewMode === 'discard'} onChange={() => setReviewMode('discard')} />丢弃我的修改</label><button className="secondary" onClick={() => setReorganize(null)}>取消</button><button onClick={() => { const files = reorganize; setReorganize(null); parse(files, reviewMode); }}>继续重新整理</button></section>}
      {!busy && reply && <p style={{ whiteSpace: "pre-wrap" }}>{reply}</p>}
      {!busy && (!!files.length || !!failedUploads.length) && <>
        <label>需要补充或纠正？直接告诉我<textarea value={correction} onChange={event => setCorrection(event.target.value)} placeholder="例如：第二份报告是术前检查；患者姓名为……" /></label>
        <button className="secondary" disabled={busy || restoring || reviewEditing || (proposal && !correction.trim() && !failedUploads.length)} onClick={() => parse(failedUploads.filter(item => item.stage === "upload" && item.file instanceof File).map(item => item.file))}>{failedUploads.length ? "重试读取资料" : proposal ? "按补充内容重新整理" : "继续解析"}</button>
      </>}
      <div className="toolbar-actions">
        {busy && <button className="secondary" onClick={stop}>停止解析</button>}
        {!busy && sessionId.current && <button className="secondary" onClick={() => onOpenWorkspace(sessionId.current)}>打开资料工作区</button>}
        {!busy && !restoring && !files.length && <button className="secondary" onClick={onManual}>没有资料？手动建档</button>}
      </div>
    </div>
  </Modal>;
}
