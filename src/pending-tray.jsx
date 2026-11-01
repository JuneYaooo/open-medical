import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardCheck, X } from "lucide-react";
import { api, PENDING_REFRESH_EVENT } from "./agent-runtime";
import "./care.css";
import { RememberedNotice } from "./learning-loop";
import { PatientProposalComparison } from "./patient-proposal";
import { SlotItem, useSlot } from "./plugin-slots";

const TYPES = { "patient-create": "建档提案", "patient-update": "档案更新", "followup-create": "随访提醒", "case-save": "病例入库", "care-message": "发送消息", "care-campaign": "随访计划", "care-settings": "自动化设置", "care-bind": "关联微信客户", "care-group-message": "客户群群发", "care-education-broadcast": "患教群发", "patient-group-suggest": "分组建议", "patient-grouping": "患者分组", "trial-batch": "批量 AI 初筛", "trial-enrollment": "试验入组状态", "trial-screening-conditions": "试验筛选条件", "trial-protocol": "导入试验方案", "ext-change": "工作台扩展", "ext-install": "技能安装" };
// 「全部确认」只覆盖不写临床事实的提案：随访提醒与患者分组。
const BULK_TYPES = new Set(["followup-create", "patient-group-suggest", "patient-grouping"]);
export { PENDING_REFRESH_EVENT } from "./agent-runtime";
const PENDING_OPEN_EVENT = "care-pending-open";
export function requestPendingReview(actionId) {
  window.dispatchEvent(new CustomEvent(PENDING_OPEN_EVENT, { detail: { actionId } }));
}

// 长摘要默认折叠，避免几千字病历全文把确认按钮顶出视野；展开后仍可滚动。
function TogglePre({ text }) {
  const [expanded, setExpanded] = useState(false);
  const long = (text || "").length > 500;
  return <>
    <pre className={long && !expanded ? "clamped" : ""}>{text}</pre>
    {long && <button className="text-button pre-toggle" onClick={() => setExpanded((v) => !v)}>
      {expanded ? "收起全文" : "展开全文"}
    </button>}
  </>;
}

function Preview({ action }) {
  const p = action.payload || {};
  const proposalRenderers = useSlot("proposal.renderers");
  const customRenderer = proposalRenderers.find((item) => item.type === action.type);
  if (customRenderer) return <SlotItem contribution={customRenderer} action={action} />;
  if (action.type === "patient-create") return <><p className="care-hint">新建患者：<b>{p.name}</b> · {({ male: "男", female: "女" })[p.gender] || "性别待补"}{p.birthYear ? ` · ${p.birthYear} 年生` : ""} · 过敏：{({ none_known: "无已知过敏", recorded: "已记录过敏原" })[p.allergyStatus] || "待核对"}</p>
    {p.clinicalSummary?.text && <TogglePre text={p.clinicalSummary.text} />}
    {(p.diagnoses?.length || p.medications?.length || p.labs?.length || p.visits?.length) ? <p className="care-hint">诊断 {p.diagnoses?.length || 0} 条 · 用药 {p.medications?.length || 0} 条 · 检验 {p.labs?.length || 0} 条 · 就诊 {p.visits?.length || 0} 次</p> : null}
    {p.note && <p className="care-hint">备注：{p.note}</p>}</>;
  if (action.type === "patient-update") {
    const genderLabel = { male: "男", female: "女", unknown: "未知" };
    const identity = [
      p.name !== undefined && `姓名改为「${p.name}」`,
      p.gender !== undefined && `性别改为${genderLabel[p.gender] || p.gender}`,
      p.birthYear !== undefined && `出生年改为 ${p.birthYear}`,
      p.patientNumber !== undefined && `病历号改为「${p.patientNumber || "（清空）"}」`,
      p.phone !== undefined && `电话改为「${p.phone || "（清空）"}」`,
    ].filter(Boolean);
    return <><p className="care-hint">写入内容：{identity.length ? `身份信息 ${identity.length} 项 · ` : ""}诊断 {p.diagnoses?.length || 0} 条 · 用药 {p.medications?.length || 0} 条 · 过敏 {p.allergies?.length || 0} 条 · 检验 {p.labs?.length || 0} 条 · 就诊 {p.visits?.length || 0} 条</p>
      {identity.length > 0 && <ul className="care-hint">{identity.map((text, i) => <li key={i}>{text}</li>)}</ul>}
      {p.clinicalSummary?.text && <TogglePre text={p.clinicalSummary.text} />}</>;
  }
  if (action.type === "followup-create") return <p className="care-hint">随访「{p.name}」{p.firstDueAt ? ` · 首次到期 ${p.firstDueAt}` : ""}{p.intervalDays ? ` · 每 ${p.intervalDays} 天` : ""}{p.once ? " · 单次" : " · 周期"}</p>;
  if (action.type === "case-save") return <>{p.diagnosis && <p className="care-hint">诊断：{p.diagnosis}</p>}{p.summary && <TogglePre text={p.summary} />}{p.lessons && <p className="care-hint">经验教训：{p.lessons}</p>}{(p.tags || []).length > 0 && <p className="care-hint">标签：{p.tags.join("、")}</p>}</>;
  if (action.type === "care-message") return <><p className="care-hint">渠道：{p.channel || "默认渠道"}</p><TogglePre text={p.text} /></>;
  if (action.type === "care-campaign") return <><p className="care-hint">{p.name} · 开始 {p.startDate}</p>
    <ol className="care-steps">{(p.steps || []).map((s, i) => <li key={s.id || i}><div><b>第 {s.dayOffset} 天</b>{s.time ? ` ${s.time}` : ""}</div><p>{s.text}</p></li>)}</ol></>;
  if (action.type === "care-bind") return <p className="care-hint">把企业微信客户「{p.contactName}」关联为该患者的{p.relationship === "family" ? "家属" : "本人"}（负责成员 {p.member}）{p.reasons?.length ? `。依据：${p.reasons.join("；")}` : ""}</p>;
  if (action.type === "ext-change") return <><p className="care-hint">{p.id ? `修改（当前第 ${p.previousVersion} 版）` : "新建"}{p.kind === "skill" ? "技能" : "自动化规则"}：{p.summary}{p.reason ? ` · 原因：${p.reason}` : ""}</p>
    {p.preview?.samples ? <><p className="care-hint">试算：{p.preview.note} 现在会产生 {p.preview.count} 条</p>{p.preview.samples.length > 0 && <ul className="care-hint">{p.preview.samples.map((x, i) => <li key={i}>{x}</li>)}</ul>}</> : p.preview?.skill && <pre>{p.preview.skill}</pre>}</>;
  if (action.type === "ext-install") return <><p className="care-hint">来自 {p.install?.source?.url}{p.reason ? ` · 原因：${p.reason}` : ""}</p>
    <ul className="care-hint">{(p.install?.skills || []).map((s) => <li key={s.id}><b>{s.title || s.name}</b>（{s.id}，{s.fileCount ?? s.files ?? 0} 个文件）：{String(s.description || "").slice(0, 160)}{s.update ? `（更新已装的技能，当前第 ${s.update} 版）` : ""}</li>)}</ul>
    {(p.preview?.stale || []).length > 0 && <p className="care-hint">注意：{p.preview.stale.join("、")}在提案生成后有变化，确认时会要求重新生成。</p>}
    <p className="care-hint">技能装入后只作为 AI 的工作说明与参考资料，其中的脚本和外部程序不会被执行。</p></>;
  if (action.type === "trial-batch") return <p className="care-hint">「{p.trialTitle}」· 确认后把以下 {p.patientIds?.length} 位患者的病历交给当前模型逐条核对纳排条件：{(p.patientNames || []).join("、")}</p>;
  if (action.type === "trial-enrollment") return <p className="care-hint">「{p.trialTitle}」· 入组状态改为 <b>{p.label}</b>{p.consentDate ? ` · 知情同意签署 ${p.consentDate}` : ""}{p.note ? ` · ${p.note}` : ""}</p>;
  if (action.type === "care-group-message") return <><p className="care-hint">客户群「{p.groupName}」· 确认后由群主 {p.owner} 在企业微信中点发送</p><TogglePre text={p.text} /></>;
  if (action.type === "care-education-broadcast") return <><p className="care-hint">患教素材「{p.materialTitle || "自定义内容"}」· 将为 {p.recipients?.length} 位患者创建企业微信单发任务（成员仍需在企业微信中手动点发送）</p><TogglePre text={p.text} /></>;
  if (action.type === "patient-group-suggest") return <ul className="care-hint">{(p.assignments || []).map((a) => <li key={a.patientId}><b>{a.name}</b> 追加分组：{a.addTags.join("、")}</li>)}</ul>;
  if (action.type === "patient-grouping") return <><p className="care-hint">把 {(p.patients || []).length} 位患者加入分组「{p.groupName}」{p.note ? ` · ${p.note}` : ""}</p>
    <ul className="care-hint">{(p.patients || []).map((x, i) => <li key={x.patientId || i}>{x.name}{x.groups?.length ? `（已分组：${x.groups.join("、")}）` : ""}：{x.reason}</li>)}</ul></>;
  return <pre>{JSON.stringify(p.changes ?? p, null, 2)}</pre>;
}

// 聊天中由 care_* 工具发起的外发/计划/设置提案；医生在此一键确认。
// 全屏审核：临床类提案（建档/档案更新）在这里逐节核对，不再挤在角标小窗里。
function ReviewSection({ title, items, render }) {
  if (!items?.length) return null;
  return <section className="pending-review-section">
    <h4>{title}<em>{items.length}</em></h4>
    <ul>{items.map((item, i) => <li key={i}>{render ? render(item) : String(item)}</li>)}</ul>
  </section>;
}

function PendingReviewOverlay({ action, busy, error, onConfirm, onReject, onClose }) {
  const p = action.payload || {};
  const [record, setRecord] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const updating = action.type === "patient-update";
  const [excluded, setExcluded] = useState({ id: action.id, keys: new Set() });
  const skipped = excluded.id === action.id ? excluded.keys : new Set();
  const toggleSection = (key) => {
    const keys = new Set(skipped);
    if (keys.has(key)) keys.delete(key); else keys.add(key);
    setExcluded({ id: action.id, keys });
  };
  const reviewed = updating ? Object.fromEntries(Object.entries(p).filter(([key]) => !skipped.has(key))) : undefined;
  useEffect(() => {
    let active = true;
    setRecord(null); setLoadError("");
    if (updating) api(`/api/patients/${encodeURIComponent(action.patientId)}`)
      .then(patient => { if (active) setRecord({ actionId: action.id, patient }); })
      .catch(e => { if (active) setLoadError(e.message); });
    return () => { active = false; };
  }, [updating, action.id, action.patientId, reload]);
  const patient = record?.actionId === action.id ? record.patient : null;
  const stale = updating && patient && patient.revision !== action.baseRevision;
  const gender = { male: "男", female: "女", unknown: "待补" }[p.gender] || "待补";
  const identity = [
    ["姓名", p.name],
    ["性别", gender],
    ["出生年", p.birthYear],
    ["电话", p.phone],
    ["过敏", ({ none_known: "无已知过敏", recorded: "已记录过敏原" })[p.allergyStatus] || "待核对"],
  ].filter(([, v]) => v !== undefined && v !== null && v !== "");
  const identityChanges = action.type === "patient-update" ? [
    p.name !== undefined && `姓名改为「${p.name}」`,
    p.gender !== undefined && `性别改为${gender}`,
    p.birthYear !== undefined && `出生年改为 ${p.birthYear}`,
    p.patientNumber !== undefined && `病历号改为「${p.patientNumber || "（清空）"}」`,
    p.phone !== undefined && `电话改为「${p.phone || "（清空）"}」`,
  ].filter(Boolean) : [];
  const clinical = action.type === "patient-create" || action.type === "patient-update";
  const confirmDisabled = busy || (updating && (!patient || stale || Boolean(loadError) || !Object.keys(reviewed).length));
  const confirm = () => onConfirm(updating && skipped.size ? reviewed : undefined);
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") { if (!busy) onClose(); }
      else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !confirmDisabled) { event.preventDefault(); confirm(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  return <div className="pending-review-overlay" role="dialog" aria-label={`全屏审核：${TYPES[action.type] || action.type}`}>
    <header>
      <div>
        <span className="care-tag">{TYPES[action.type] || action.type}</span>
        <strong>{action.summary}</strong>
        <time>提出于 {new Date(action.createdAt).toLocaleString("zh-CN")}</time>
      </div>
      <button className="icon-button" aria-label="关闭全屏审核" onClick={onClose}><X size={18} /></button>
    </header>
    <div className="pending-review-body">
      {updating && <>
        {loadError ? <p role="alert">读取当前档案失败：{loadError} <button disabled={busy} onClick={() => setReload(value => value + 1)}>重试读取档案</button></p>
          : !patient && <p role="status">正在读取当前档案，准备核对变更…</p>}
        {patient && <PatientProposalComparison patient={patient} proposal={action} excluded={skipped} onToggle={toggleSection} />}
        {stale && <p role="alert" className="error-text">档案在提案后已变化，请关闭并重新生成提案，避免覆盖新记录。</p>}
      </>}
      {clinical && !updating && <>
        <section className="pending-review-section">
          <h4>{action.type === "patient-create" ? "患者基本信息" : "身份信息变更"}</h4>
          {action.type === "patient-update" && identityChanges.length
            ? <ul>{identityChanges.map((t, i) => <li key={i}>{t}</li>)}</ul>
            : action.type === "patient-update"
              ? <p className="care-hint">本次不改身份信息。</p>
              : <ul>{identity.map(([k, v]) => <li key={k}>{k}：{v}</li>)}</ul>}
        </section>
        <ReviewSection title="诊断" items={p.diagnoses} render={(d) => typeof d === "string" ? d : [d.name, d.status === "needs_review" ? "（待核对）" : ""].filter(Boolean).join(" ")} />
        <ReviewSection title="用药" items={p.medications} render={(m) => typeof m === "string" ? m : [m.name || m.drug, m.dose, m.frequency, m.status === "active" ? "（正在使用）" : ""].filter(Boolean).join(" · ")} />
        <ReviewSection title="过敏" items={p.allergies} render={(a) => typeof a === "string" ? a : [a.substance, a.reaction].filter(Boolean).join("（") + (a.reaction ? "）" : "")} />
        <ReviewSection title="检验" items={p.labs} render={(l) => `${l.item || ""} ${l.value ?? ""}${l.unit || ""}（${l.date || "日期未记录"}）`} />
        <ReviewSection title="就诊" items={p.visits} render={(v) => `${v.date || ""} ${v.note || v.summary || ""}`} />
        {p.clinicalSummary?.text && <section className="pending-review-section">
          <h4>病历摘要</h4>
          <pre>{p.clinicalSummary.text}</pre>
        </section>}
        {p.note && <section className="pending-review-section"><h4>AI 备注（含待核对点）</h4><pre>{p.note}</pre></section>}
      </>}
      {!clinical && <Preview action={action} />}
      {error && <p role="alert" className="care-error">{error}</p>}
      <section className="pending-review-section pending-review-consequence">
        <h4>确认与拒绝的后果</h4>
        <p>确认执行：{clinical
          ? "上述内容立即写入患者档案，之后你可以在档案中继续修改。"
          : "按提案内容执行。"}</p>
        <p>拒绝：{p._provenance?.kind === "local-rule" && p._provenance.entry === "patient-group-suggestions"
          ? "本次建议不会应用；可调整患者记录后重新生成分组建议。"
          : "本次提案作废，不应用提案变更；如需调整，请回到原操作重新提出。"}</p>
      </section>
    </div>
    <footer>
      <button className="secondary" disabled={busy} onClick={onReject}>拒绝</button>
      <button disabled={confirmDisabled} onClick={confirm}>{busy ? "处理中…" : "确认执行"}</button>
    </footer>
  </div>;
}

export function PendingTray() {
  const tray = useRef(null);
  const requestGeneration = useRef(0);
  const reviewGeneration = useRef(0);
  const pages = useRef(1);
  const resolving = useRef(false);
  const [actions, setActions] = useState([]);
  const [total, setTotal] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [rejecting, setRejecting] = useState(null);
  const [reviewing, setReviewing] = useState(null);
  const [remembered, setRemembered] = useState(null);
  const [note, setNote] = useState("");
  const [bulkResult, setBulkResult] = useState("");
  const [bulking, setBulking] = useState(false);
  const load = useCallback(async ({ actionId } = {}) => {
    const request = ++requestGeneration.current;
    setLoading(true);
    try {
      // Refresh every loaded page together so a resolved row cannot shift the
      // offset and silently hide the next proposal.
      const rows = [];
      let data, offset = 0;
      for (let page = 0; page < pages.current || (actionId && !rows.some(action => action.id === actionId)); page++) {
        data = await api(`/api/pending-actions?status=pending&limit=100&offset=${offset}`);
        if (request !== requestGeneration.current) return;
        rows.push(...data.actions);
        offset = data.nextOffset;
        if (offset === null || rows.length >= data.counts.pending) break;
      }
      setActions([...new Map(rows.map(action => [action.id, action])).values()]);
      setTotal(data.counts.pending); setHasMore(offset !== null && rows.length < data.counts.pending); setLoadError("");
      return rows;
    } catch (e) {
      if (request === requestGeneration.current) { setLoadError(e.message); setTotal(null); }
    } finally { if (request === requestGeneration.current) setLoading(false); }
  }, []);
  useEffect(() => {
    const openReview = async (event) => {
      const request = ++reviewGeneration.current;
      setOpen(true); setError(""); setReviewing(null); setRejecting(null);
      const actionId = event.detail?.actionId;
      const rows = await load({ actionId });
      if (!actionId || !rows || request !== reviewGeneration.current) return;
      const action = rows.find(row => row.id === actionId);
      if (!action) { setError("这条提案已处理，请查看当前待确认队列。"); return; }
      setReviewing(action);
    };
    load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, 20000);
    window.addEventListener(PENDING_REFRESH_EVENT, load);
    window.addEventListener(PENDING_OPEN_EVENT, openReview);
    return () => { requestGeneration.current++; reviewGeneration.current++; clearInterval(timer); window.removeEventListener(PENDING_REFRESH_EVENT, load); window.removeEventListener(PENDING_OPEN_EVENT, openReview); };
  }, [load]);
  useEffect(() => {
    if (!open || reviewing) return;
    const dismiss = (event) => {
      if (event.type === "keydown" ? event.key === "Escape" : !tray.current?.contains(event.target)) { reviewGeneration.current++; setOpen(false); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open, reviewing]);
  async function resolve(action, decision, withNote, payload) {
    if (resolving.current) return false;
    resolving.current = true;
    setBusy(action.id); setError("");
    try {
      const result = await api(`/api/pending-actions/${action.id}/${decision}`, "POST", { ...(withNote ? { note } : {}), ...(payload ? { payload } : {}) });
      if (result.remembered?.length) setRemembered({ key: `${action.id}:${decision}`, memories: result.remembered });
      // Multi-patient proposals report patients they could not change.
      const skipped = result.applied?.skipped;
      if (Array.isArray(skipped) && skipped.length)
        setBulkResult(`${skipped.length} 位患者未处理：${skipped.slice(0, 5).map((s) => `${s.name || "患者"}（${s.reason}）`).join("、")}${skipped.length > 5 ? " 等" : ""}`);
      setRejecting(null); setNote("");
      // api() emits PENDING_REFRESH_EVENT after successful decisions, updating
      // this tray and the home preview from the same source of truth.
      await load();
      return true;
    }
    catch (e) { setError(e.message); }
    finally { resolving.current = false; setBusy(""); }
  }
  const bulk = actions.filter((a) => BULK_TYPES.has(a.type));
  async function confirmAll() {
    setBulking(true); setBulkResult("");
    let ok = 0, failed = 0;
    for (const a of bulk) { if (await resolve(a, "confirm")) ok++; else failed++; }
    setBulking(false);
    setBulkResult((previous) => `已确认 ${ok} 项，${failed} 项失败${previous ? `；${previous}` : ""}`);
  }
  if (!actions.length && !remembered && !open && !reviewing) return null;
  return <div className="pending-tray" ref={tray}>
    {remembered && <RememberedNotice key={remembered.key} memories={remembered.memories} />}
    {open && <section className="pending-panel" aria-label="待确认的操作">
      <header><strong>待你确认（{total ?? "—"}）</strong><button className="icon-button" aria-label="收起" onClick={() => { reviewGeneration.current++; setOpen(false); }}><X size={16} /></button></header>
      {loadError && <p role="alert" className="care-error">提案加载失败：{loadError}<button className="text-button" disabled={loading} onClick={load}>重试</button></p>}
      {loading && <p role="status">正在读取提案…</p>}
      {!loading && !loadError && total === 0 && <p role="status">没有待确认提案。新的提案会在这里等待核对，查看队列不会修改档案。</p>}
      {total > 0 && <p className="care-hint">已展示 {actions.length} / 共 {total} 条</p>}
      {bulk.length > 0 && <button type="button" className="secondary" disabled={Boolean(busy) || bulking} onClick={confirmAll}>{bulking ? "处理中…" : `全部确认（${bulk.length}）`}</button>}
      {bulkResult && <p role="status" className="care-hint">{bulkResult}</p>}
      {error && <p role="alert" className="care-error">{error}</p>}
      <ul>{actions.map((a) => <li key={a.id} className="care-card">
        <header><span className="care-tag">{TYPES[a.type] || a.type}</span><time>{new Date(a.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></header>
        <p className="care-reason">{a.summary}</p>
        <Preview action={a} />
        {rejecting === a.id ? <div className="pending-feedback">
          <input
            aria-label={`拒绝原因（${TYPES[a.type] || a.type}）`}
            placeholder="顺带说一句为什么拒绝（可选）。说得多了，它下次起草就更对你的路子。"
            value={note}
            autoFocus
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") resolve(a, "reject", true); }}
          />
          <div className="care-hint-actions">
            <button className="text-button" disabled={Boolean(busy)} onClick={() => resolve(a, "reject", true)}>记录并拒绝</button>
            <button className="text-button" disabled={Boolean(busy)} onClick={() => resolve(a, "reject", false)}>不填了，直接拒绝</button>
          </div>
        </div> : <footer>
          <button className="text-button" disabled={Boolean(busy)} onClick={() => { setError(""); setReviewing(a); }}>全屏审核</button>
          <button className="secondary" disabled={Boolean(busy)} onClick={() => { setRejecting(a.id); setNote(""); }}>拒绝</button>
          {a.type === "patient-update"
            ? <button disabled={Boolean(busy)} onClick={() => { setError(""); setReviewing(a); }}>核对变更</button>
            : <button disabled={Boolean(busy)} onClick={() => resolve(a, "confirm")}>{busy === a.id ? "处理中…" : "确认执行"}</button>}
        </footer>}
      </li>)}</ul>
      {hasMore && <button type="button" className="secondary" disabled={loading} onClick={() => { pages.current++; load(); }}>加载更多提案</button>}
    </section>}
    {reviewing && <PendingReviewOverlay
      action={actions.find((a) => a.id === reviewing.id) || reviewing}
      busy={Boolean(busy)}
      error={error}
      onConfirm={(payload) => resolve(reviewing, "confirm", false, payload).then(ok => { if (ok) setReviewing(null); })}
      onReject={() => { resolve(reviewing, "reject").then(ok => { if (ok) setReviewing(null); }); }}
      onClose={() => { reviewGeneration.current++; setReviewing(null); }}
    />}
    {!!actions.length && <button className="pending-badge" aria-expanded={open} onClick={() => { reviewGeneration.current++; setOpen((v) => !v); }}><ClipboardCheck size={18} />待确认<em>{total ?? "—"}</em></button>}
  </div>;
}
