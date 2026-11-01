import { RememberedNotice } from './learning-loop';
import { ResultCard, usePluginActive, usePluginConnected, useSlot } from "./plugin-slots";
import { patientAgeLabel, patientIdentityLabel, patientOptionLabel } from "./patient-labels";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronDown,
  Loader2,
  Search,
} from "lucide-react";
import { api } from "./agent-runtime";
import { artifactLines } from "../shared/medical.mjs";
import { diffLines } from "diff";
import { hasCurrentArtifactReview } from "../shared/artifact-review-display.mjs";
import { eventDateWarnings } from "../shared/timeline-display.mjs";
import { diagnosisStatus, DIAGNOSIS_STATUS_SHORT } from "../shared/diagnoses.mjs";
import { recentLabs } from "../shared/recent-labs.mjs";
import { MISSED_ALERT_NOTE } from "../server/medical/med-safety-rules.mjs";

/* ---------- 工具名中文名（医疗 + 通用） ---------- */
const TOOL_NAMES = {
  extract_clinical_timeline: "整理病历时间线",
  extract_observations: "摘录检验数值",
  medication_safety_check: "用药辅助提醒",
  make_review_checklist: "生成复核清单",
  draft_treatment_review: "起草治疗评估",
  finish_similar_case_search: "整理相似病例结果",
  guideline_search: "检索指南知识库",
  guideline_read: "精读指南段落",
  read_patient_profile: "读取患者档案",
  read_patient_brief: "读取当前患者近况",
  list_skills: "发现可用技能",
  read_skill: "读取技能说明",
  read_source: "读取资料片段",
  web_search: "检索网页",
  document_create: "生成文档",
  sandbox_run: "本地沙箱计算",
  terminal_check: "运行检查并核对退出码",
};
const toolName = (tool) => TOOL_NAMES[tool] || tool || "工具";

/* ---------- 步骤流（对话内可折叠执行过程） ---------- */
export function StepsFlow({ events, running, fallbackText }) {
  const [open, setOpen] = useState(false);
  const tools = useMemo(() => {
    const seen = new Map();
    for (const e of events || []) {
      if (e.type === "tool.start" || e.type === "tool.complete" || e.type === "tool.failed") {
        const p = e.payload || {};
        const key = p.call_id || `${p.tool}-${e.seq ?? e.id ?? seen.size}`;
        const row = seen.get(key) || { tool: p.tool, status: "running" };
        if (e.type === "tool.complete") row.status = "ok";
        if (e.type === "tool.failed") row.status = "failed";
        seen.set(key, row);
      }
    }
    return [...seen.values()];
  }, [events]);
  const failed = tools.some((t) => t.status === "failed");
  const visible = open ? tools : tools.slice(-4);
  const memories = (events || []).filter(e => e.type === 'tool.complete' && e.payload?.notification?.type === 'remembered').map(e => e.payload.notification);
  if (!tools.length && !running) return null;
  return (
    <div className={`steps-flow ${running ? "running" : ""} ${failed ? "has-failed" : ""}`}>
      {!!memories.length && <RememberedNotice key={memories.map(m => m.id).join(",")} memories={memories} />}
      <button type="button" className="steps-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {running ? (
          <Loader2 className="spin" size={13} />
        ) : failed ? (
          <AlertCircle size={13} />
        ) : (
          <Check size={13} />
        )}
        <b>
          {running
            ? `正在执行 · ${toolName(events?.filter((e) => e.type === "tool.start").at(-1)?.payload?.tool)}`
            : failed
              ? "执行完成 · 有告警"
              : `已执行 ${tools.length} 步`}
        </b>
        <span className="steps-count">{tools.length} 项操作</span>
        <ChevronDown className={`chev ${open ? "open" : ""}`} size={13} />
      </button>
      {(open || running) && (
        <ul className="steps-list">
          {visible.map((t, i) => (
            <li key={i}>
              <span className={`st-ic ${t.status}`}>
                {t.status === "ok" ? <Check size={12} /> : t.status === "failed" ? <AlertCircle size={12} /> : <Loader2 className="spin" size={12} />}
              </span>
              <span className="st-tool">{toolName(t.tool)}</span>
              <span className="st-status">
                {t.status === "failed" ? "失败" : t.status === "ok" ? "完成" : "运行中"}
              </span>
            </li>
          ))}
          {!tools.length && <li className="st-empty">{fallbackText || "正在思考…"}</li>}
        </ul>
      )}
    </div>
  );
}

/* ---------- 产物行文本（预览/diff 用） ---------- */
export function artifactToLines(a, { preview = false } = {}) {
  if (!a) return [];
  const lines = [];
  if (!preview) lines.push(`【${a.title || "未命名产物"}】`);
  const sectionCount = [a.events?.length, a.items?.length, a.observations?.length, a.pico].filter(Boolean).length;
  const showSectionHeading = !preview || sectionCount > 1;
  if (a.events?.length) {
    if (showSectionHeading) lines.push("— 时间线 —");
    for (const e of a.events) lines.push([`${e.date} ${e.event}`, ...eventDateWarnings(e).map(warning => `【${warning}】`)].join(" "));
  }
  if (a.items?.length) {
    if (showSectionHeading) lines.push("— 条目 —");
    for (const it of a.items) lines.push(it);
  }
  if (a.observations?.length) {
    if (showSectionHeading) lines.push("— 检验摘录 —");
    for (const o of a.observations) lines.push(`${o.name}: ${o.value}${o.unit || ""}`);
  }
  if (a.pico) {
    if (showSectionHeading) lines.push("— PICO —");
    lines.push(`P ${a.pico.population || ""}`);
    lines.push(`I ${a.pico.intervention || ""}`);
    lines.push(`C ${a.pico.comparison || ""}`);
    lines.push(`O ${a.pico.outcome || ""}`);
  }
  if (!a.events?.length && !a.items?.length && !a.observations?.length && !a.pico) {
    for (const l of artifactLines(a)) lines.push(l);
  }
  if (a.missing?.length) {
    lines.push("— 待补充 —");
    for (const m of a.missing) lines.push(m);
  }
  return lines;
}

/* ---------- 结果阅读（叠加层） ---------- */
const STATUS_TEXT = { draft: "草稿", approved: "已复核", rejected: "需修订" };
function ArtifactReview({ artifact, onReview }) {
  const [note, setNote] = useState("");
  const [attested, setAttested] = useState(false);
  const [decision, setDecision] = useState("approved");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const [editing, setEditing] = useState(false);
  const currentReview = hasCurrentArtifactReview(artifact);
  const expanded = !currentReview || editing || Boolean(error);
  useEffect(() => { setAttested(false); }, [artifact.version]);
  if (!onReview) return null;
  return <form className="artifact-review" aria-label="本机复核结果" onSubmit={async event => {
    event.preventDefault();
    if (inFlight.current || !attested || !note.trim()) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await onReview({ version: artifact.version, decision, note: note.trim(), attested: true });
      setAttested(false); setNote(""); setEditing(false); setNotice("本机复核记录已保存。");
    } catch (err) {
      setError(err.code === "REVISION_CONFLICT" ? "结果版本已更新，复核说明已保留。请重新查看当前内容并确认后提交。" : err.message);
      if (err.code === "REVISION_CONFLICT") setAttested(false);
    } finally { inFlight.current = false; setBusy(false); }
  }}>
    <h4>本机复核</h4>
    {artifact.review && <div className="artifact-review-summary">
      <p><b>{currentReview ? STATUS_TEXT[artifact.review.decision] : `上次复核：${STATUS_TEXT[artifact.review.decision] || artifact.review.decision}（非当前版本）`}</b> · 已核对第 {artifact.review.reviewedVersion} 版</p>
      <p>{artifact.review.note}</p>
      <small>{artifact.review.reviewer || "本机使用者"}{artifact.review.at ? ` · ${new Date(artifact.review.at).toLocaleString()}` : ""}</small>
    </div>}
    {!expanded && <button type="button" className="secondary" onClick={() => setEditing(true)}>重新复核</button>}
    {expanded && <fieldset disabled={busy}>
      <label>复核决定<select value={decision} onChange={event => setDecision(event.target.value)}><option value="approved">已复核</option><option value="rejected">需修订</option></select></label>
      <label>复核说明（必填）<textarea required maxLength={3000} rows={3} value={note} onChange={event => setNote(event.target.value)} /></label>
      <label><input type="checkbox" checked={attested} onChange={event => setAttested(event.target.checked)} />我已检查当前第 {artifact.version} 版的原文与适用范围</label>
      <button type="submit" className="primary" disabled={!note.trim() || !attested}>{busy ? "保存中…" : "保存复核记录"}</button>
    </fieldset>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </form>;
}
export function AcceptanceView({ artifact, previous, onSource, onClose, onReview }) {
  const [view, setView] = useState(previous ? "diff" : "preview");
  const resultCards = useSlot("chat.resultCards");
  if (!artifact) return null;
  const cur = artifactToLines(artifact);
  const prev = previous ? artifactToLines(previous) : null;
  const diff = prev
    ? diffLines(prev.join("\n") + "\n", cur.join("\n") + "\n")
    : null;
  const changed = diff ? diff.filter((p) => p.added || p.removed).length : 0;
  const checklist = [
    ...(artifact.missing || []).map((m) => ({ ok: false, text: m })),
    ...(artifact.limitations || []).map((m) => ({ ok: true, warn: true, text: m })),
  ];
  // A plugin result card may own the whole reading surface. This stays generic:
  // any artifact type with a registered card uses the reader shell, and the
  // shell falls back to the ordinary artifact view when no card is registered.
  const resultCard = resultCards.find((item) => item.type === artifact.type);
  if (resultCard) return (
    <div className="acceptance case-reader" role="region" aria-label={resultCard.label || "查看结果"}>
      <div className="accept-bar"><button className="text-button accept-close" onClick={onClose} aria-label="关闭结果，回到对话">× 关闭</button><h3>{resultCard.label || artifact.title || "查看结果"}</h3></div>
      <div className="case-reader-body">
        <ResultCard artifact={artifact} fallback={artifactToLines(artifact, { preview: true }).map((line, index) => (
          <p key={index} className={line.startsWith("【") || line.startsWith("—") ? "acc-head" : ""}>{line}</p>
        ))} />
        <ArtifactReview key={artifact.id + "-review"} artifact={artifact} onReview={onReview} />

      </div>
    </div>
  );
  return (
    <div className="acceptance" role="region" aria-label="查看结果">
      <div className="accept-bar">
        <button className="text-button accept-close" onClick={onClose} aria-label="关闭结果，回到对话">× 关闭</button>
        <h3>{artifact.title} · v{artifact.version}</h3>
        <span className={`acc-badge ${artifact.status}`}>{STATUS_TEXT[artifact.status] || artifact.status}</span>
        <div className="seg">
          <button className={view === "preview" ? "on" : ""} onClick={() => setView("preview")}>预览</button>
          <button className={view === "diff" ? "on" : ""} onClick={() => setView("diff")}>
            与上一版差异{previous && changed ? ` (${changed})` : ""}
          </button>
          <button className={view === "source" ? "on" : ""} onClick={() => setView("source")}>出处对照</button>
        </div>
      </div>
      <div className="accept-body">
        <div className="accept-main">
          {view === "preview" && (
            <div className="acc-doc">
              <ResultCard artifact={artifact} fallback={artifactToLines(artifact, { preview: true }).map((l, i) => (
                <p key={i} className={l.startsWith("【") || l.startsWith("—") ? "acc-head" : ""}>{l}</p>
              ))} />
            </div>
          )}
          {view === "diff" && (
            <div className="acc-doc">
              {!prev && <p className="muted">这是第一版，暂无上一版可比。</p>}
              {diff?.map((part, i) =>
                part.added ? (
                  part.value.split("\n").filter(Boolean).map((l, j) => (
                    <p className="row-add" key={`${i}-${j}`}>+ {l}</p>
                  ))
                ) : part.removed ? (
                  part.value.split("\n").filter(Boolean).map((l, j) => (
                    <p className="row-del" key={`${i}-${j}`}>− {l}</p>
                  ))
                ) : (
                  part.value.split("\n").filter(Boolean).slice(0, 40).map((l, j) => (
                    <p className="row-same" key={`${i}-${j}`}>{l}</p>
                  ))
                ),
              )}
            </div>
          )}
          {view === "source" && (
            <div className="acc-doc">
              {[...(artifact.events || []), ...(artifact.observations || []).map(o=>({event:`${o.name}：${o.value} ${o.unit || ""}`, source:o.source}))].filter(e=>e.source).map((e, i) => (
                <div className="src-row" key={i}>
                  <span>{e.date} · {e.event}{eventDateWarnings(e).map(warning => <small className="error-text" key={warning}>{warning}</small>)}</span>
                  <button className="source-link" onClick={() => onSource(e.source)}>
                    {e.source.sourceName}{e.source.page ? ` · P${e.source.page}` : ""} · L{e.source.line}
                    <ArrowUpRight size={12} />
                  </button>
                </div>
              ))}
              {(artifact.matches || []).map((m, i) => (
                <div className="src-row" key={`m${i}`}>
                  <span>{m.quote}</span>
                  {/^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/$/.test(m.url || "") ?
                    <a className="source-link" href={m.url} target="_blank" rel="noreferrer">{m.sourceName} · PubMed</a> :
                    m.evidence?.type === "local-record" ? <span>{m.sourceName} · 本地记录</span> :
                    <button className="source-link" onClick={() => onSource(m)}>{m.sourceName}{m.line ? ` · L${m.line}` : ""}</button>}
                  {m.scope && <small>{m.scope}</small>}
                  {m.evidence?.text && <details><summary>查看检索时保存的{m.evidence.type === "abstract" ? "摘要" : "记录"}</summary><p>{m.evidence.text}</p></details>}

                </div>
              ))}
              {!artifact.events?.length && !artifact.observations?.length && !artifact.matches?.length && (
                <p className="muted">这份已保存结果没有记录原文出处。</p>
              )}
            </div>
          )}
        </div>
        <aside className="accept-side">
          <ArtifactReview key={artifact.id} artifact={artifact} onReview={onReview} />
          <p className="side-label">信息缺口与适用范围</p>
          {checklist.length ? (
            checklist.map((c, i) => (
              <div className={`check-item ${c.ok ? (c.warn ? "warn" : "ok") : "miss"}`} key={i}>
                <span className="ic">{c.warn ? "⚠" : c.ok ? "✓" : "⚠"}</span>
                {c.text}
              </div>
            ))
          ) : (
            <div className="check-item ok"><span className="ic">✓</span>未列出信息缺口</div>
          )}
          {artifact.history?.length > 0 && (
            <details className="acc-history">
              <summary>{artifact.history.length} 次修订历史</summary>
              {artifact.history.map((h) => (
                <div key={h.version} className="acc-h-row">
                  <b>v{h.version} · {STATUS_TEXT[h.status] || h.status}</b>
                  {h.review && <small>{h.review.note}</small>}
                </div>
              ))}
            </details>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ---------- 患者速览卡 ---------- */
export function PatientSummaryCard({ patient, detail, session, onOpenDetail, onOpenWorkspace, onOpenLabs, compact }) {
  const followupActive = usePluginActive("followup");
  const messaging = usePluginConnected("followup");
  if (!patient && !detail) return null;
  const p = detail || patient;
  const allergies = (p.allergies || []).map((a) => (typeof a === "string" ? a : a.substance || a.name || "")).filter(Boolean);
  const diagnoses = (p.diagnoses || []).map((d) => {
    const name = typeof d === "string" ? d : d.name || d.diagnosis || "";
    return name ? `${name}（${DIAGNOSIS_STATUS_SHORT[diagnosisStatus(typeof d === "string" ? d : { ...d, name })]}）` : "";
  }).filter(Boolean);
  const meds = p.medications || [];
  const labs = p.labs || [];
  const displayedLabs = recentLabs(labs);
  const counts = p.counts || {};
  return (
    <div className={`patient-summary ${compact ? "compact" : ""}`}>
      <div className="ps-head">
        <span className="p-ava" title={patientIdentityLabel(p)}>{(p.name || "?").slice(0, 1)}</span>
        <div className="p-id">
          <b>{[p.name, p.gender === "female" ? "女" : p.gender === "male" ? "男" : "", patientAgeLabel(p)].filter(Boolean).join(" · ")}</b>
          {session?.patientId && <span className="ps-patient-number">编号：{p.patientNumber || '未编号'}</span>}
          <span>
            {[...(diagnoses || []), ...(p.tags || []), ...(p.groups || [])]
              .slice(0, 3)
              .join(" · ") || "未补充诊断与标签"}
          </span>
        </div>
        <div className="ps-badges">
          {allergies.length > 0 && <span className="badge no">过敏：{allergies.join("、")}</span>}
          <span className="pill local">◈ 本地</span>
        </div>
      </div>
      <div className="ps-grid">
        <div className="ps-col">
          <h5>用药记录（{meds.length}）</h5>
          {!!meds.length && <span className="ps-empty">当前在用 {meds.filter(m=>m.status === "active").length} 条 · 已停用 {meds.filter(m=>m.status === "stopped").length} 条</span>}
          {meds.length ? (
            meds.slice(0, 4).map((m, i) => {
              const name = typeof m === "string" ? m : `${m.name || ""}${m.dose ? ` ${m.dose}` : ""}${m.frequency ? ` ${m.frequency}` : ""}`;
              return <span className="med-chip" key={i}>{name} · {m.status === "active" ? "正在使用" : m.status === "stopped" ? "已停用" : "状态未记录"}</span>;
            })
          ) : (
            <span className="ps-empty">暂无用药记录</span>
          )}
        </div>
        <div className="ps-col">
          <h5>最近检验</h5>
          <span className="ps-empty">已展示 {displayedLabs.length} / 共 {labs.length} 条</span>
          {labs.length ? (
            displayedLabs.map((l, i) => (
              <div className="vital" key={i}>
                <div className="row1"><b>{l.value}</b><span className="u">{l.item}{l.unit ? ` · ${l.unit}` : ""}</span></div>
                <div className="row2"><span className="d">{l.date || "日期未记录"}</span></div>
              </div>
            ))
          ) : (
            <span className="ps-empty">暂无检验记录</span>
          )}
          {onOpenLabs && <button type="button" className="text-button" onClick={onOpenLabs}>查看全部检验</button>}
        </div>
        <div className="ps-col">
          <h5>待办与成果</h5>
          <ul className="tl">
            {messaging && counts.unprocessedMessages > 0 && <li><i />{counts.unprocessedMessages} 条未处理消息</li>}
            {followupActive && counts.dueFollowups > 0 && <li><i />{counts.dueFollowups} 项随访到期</li>}
            <li><i />{session ? `${session.files.length} 份材料 · ${session.artifacts.length} 份已保存结果` : `${p.counts?.artifacts ?? "—"} 份已保存结果`}</li>
          </ul>
        </div>
      </div>
      {!compact && (
        <div className="ps-actions">
          <button className="mini-btn" onClick={onOpenDetail}>打开详情</button>
          {onOpenWorkspace && (
            <button className="mini-btn plain" onClick={onOpenWorkspace}>病例工作区</button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- 顶栏患者切换器 ---------- */
export function PatientSwitcher({ patients, currentId, onSwitch, onManage }) {
  const followupActive = usePluginActive("followup");
  const messaging = usePluginConnected("followup");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const current = patients.find((p) => p.id === currentId);
  const list = patients
    .filter((p) => !q || `${p.name} ${p.patientNumber || ""} ${p.phone || ""} ${p.id}`.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 8);
  return (
    <div className="pt-switcher" ref={ref} onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        setOpen(false);
        ref.current?.querySelector(".patient-pill")?.focus();
      }
    }}>
      <button className={`pill patient-pill ${current ? "" : "empty"}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="dot" />
        {current ? `患者：${current.name}` : "未选择患者"}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="pt-switch-menu">
          <label className="ps-search">
            <Search size={13} />
            <input autoFocus aria-label="搜索并切换患者" placeholder="搜索姓名、编号或电话" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <p className="ps-group">最近</p>
          {list.map((p) => (
            <button
              key={p.id}
              className={`ps-item ${p.id === currentId ? "on" : ""}`}
              onClick={() => {
                onSwitch(p);
                setOpen(false);
              }}
            >
              {p.id === currentId ? "✓" : ""} {patientOptionLabel(p, patients)}
              <span className="sub">
                {followupActive
                  ? p.counts?.dueFollowups
                    ? `${p.counts.dueFollowups} 项随访到期`
                    : messaging && p.counts?.unprocessedMessages
                      ? `${p.counts.unprocessedMessages} 条新消息`
                      : ""
                  : ""}
              </span>
            </button>
          ))}
          {!list.length && <p className="ps-empty-row">没有匹配的患者</p>}
          <div className="ps-foot">
            <button onClick={() => { onManage(); setOpen(false); }}>患者管理</button>
            <span>点卡片切换 · @患者 = 引用不切换</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- 风险卡列表 ---------- */
// draftBlocked：草稿依赖模型；未配置时禁用并在提示里说明原因。
export function RiskList({ alerts, onAck, onResolve, onDraft, draftBlocked = "", busy }) {
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const actionPending = useRef(false);
  const act = async (operation) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setActionBusy(true);
    setActionError("");
    try { await operation(); }
    catch (error) { setActionError(error.message); }
    finally { actionPending.current = false; setActionBusy(false); }
  };
  if (!alerts?.length) return null;
  const order = { critical: 0, warning: 1, info: 2 };
  const sorted = [...alerts].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  const card = (r) => (
        <div className={`risk-card ${r.severity === "critical" && r.status === "active" ? "red" : ""}`} key={r.id}>
          <div className="r-head">
            {r.severity === "critical" ? "辅助提醒 · 高" : r.severity === "warning" ? "辅助提醒 · 中" : "辅助提醒 · 提示"}
            {r.status === "acknowledged" && <span className="badge ok">已确认</span>}
            {r.status === "resolved" && <span className="badge ok">{r.autoResolved ? "当前资料未触发" : "已处理"}</span>}
          </div>
          <div className="r-body">
            <b>{r.title}</b> · {r.message}
            {r.evidence?.length > 0 && (
              <small className="r-evidence">
                依据：{r.evidence.map((e) => `${e.item || e.medication || e.name || ""}${e.allergy ? `（过敏史：${e.allergy}）` : ""}${e.value != null ? ` ${e.value}${e.unit || ""}` : ""}${e.date ? `（${e.date}）` : ""}`).join("；")}
              </small>
            )}
          </div>
          <div className="r-acts">
            {onDraft && r.status === "active" && (
              <button className="mini-btn" disabled={busy || actionBusy || Boolean(draftBlocked)} title={draftBlocked || undefined} onClick={() => act(() => onDraft(r))}>
                生成处理建议草稿
              </button>
            )}
            {r.status === "active" && onAck && (
              <button className="mini-btn plain" disabled={busy || actionBusy} onClick={() => act(() => onAck(r))}>知道了</button>
            )}
            {r.status !== "resolved" && onResolve && (
              <button className="mini-btn plain" disabled={busy || actionBusy} onClick={() => act(() => onResolve(r))}>标记已处理</button>
            )}
            {r.status === "resolved" && onResolve && (
              <button className="mini-btn plain" disabled={busy || actionBusy} onClick={() => act(() => onResolve(r, true))}>重新打开</button>
            )}
          </div>
        </div>
  );
  const active = sorted.filter(r => r.status === "active");
  const history = sorted.filter(r => r.status !== "active");
  return <section className="risk-list" aria-label="风险提醒">
    {actionError && <p className="form-error" role="alert">{actionError}</p>}
    {active.map(card)}
    {history.length > 0 && <details className="risk-history workspace-optional"><summary>已确认与已处理记录 · {history.length}</summary>{history.map(card)}</details>}
    <p className="risk-note">{MISSED_ALERT_NOTE}</p>
  </section>;
}

/* ---------- 时间线 ---------- */
export function Timeline({ items }) {
  if (!items?.length) return <p className="muted">暂无事件。</p>;
  return (
    <ul className="tlv">
      {items.map((it, i) => (
        <li key={i}>
          <span className={`t-dot ${it.tone || ""}`} />
          <span className="t-date">{it.date}</span>
          <span className="t-text">{it.text}</span>
          {it.action}
        </li>
      ))}
    </ul>
  );
}

/* ---------- Goal 卡（长任务目标 × 证据） ---------- */
const GOAL_KEYWORDS = [
  { re: /相似|类似|相近/, label: "相似病例检索" },
  { re: /出院小结/, label: "出院小结" },
  { re: /时间线/, label: "病历时间线" },
  { re: /检验|数值|摘录/, label: "检验数值摘录" },
  { re: /用药/, label: "用药资料核对" },
  { re: /随访/, label: "随访计划" },
  { re: /循证|PICO|检索式/, label: "循证检索准备" },
  { re: /治疗评估|治疗方案/, label: "治疗方案评估" },
];
export function GoalCard({ message = "", running, runStatus, artifacts = [], onStop, round = 1 }) {
  const rows = useMemo(() => {
    let rows = GOAL_KEYWORDS.filter((k) => k.re.test(message)).map((k) => ({
      label: k.label,
      done: false,
      evidence: "",
    }));
    if (!rows.length)
      rows = [{ label: "按需求整理材料", done: false, evidence: "" }];
    for (const row of rows) {
      const hit = artifacts.find((a) => {
        const t = (a.title || "").trim();
        // 空标题产物（未产出内容的空壳）不应匹配任何目标行
        if (!t) return false;
        return t.includes(row.label.slice(0, 2)) || row.label.includes(t.slice(0, 2));
      });
      if (hit) {
        const sourceCount = (hit.events || []).length + (hit.matches || []).length;
        if (hit.cases || hit.searches) {
          row.done = true;
          const cases = hit.cases || [];
          const metadata = cases.filter(c => c.evidence?.type === "metadata" || /仅题录/.test(c.scope)).length;
          const failed = (hit.searches || []).filter(s => s.status === "failed").length;
          row.evidence = `检索已结束 · ${cases.length} 条候选${metadata ? ` · ${metadata} 条仅题录` : ""}${failed ? ` · ${failed} 次来源请求失败` : ""}`;
          continue;
        }
        row.done = hit.type !== "treatment_review" || sourceCount > 0;
        row.evidence = `已生成草稿 v${hit.version || 1} · 出处 ${sourceCount} 条 · ${sourceCount || hit.type !== "treatment_review" ? "已保存" : "缺少出处，尚未完成"}`;
      }
    }
    return rows;
  }, [message, artifacts, running]);
  const doneCount = rows.filter((r) => r.done).length;
  const incomplete = ["failed", "cancelled", "interrupted"].includes(runStatus);
  return (
    <div className={`goal-card ${running ? "running" : incomplete ? "incomplete" : "done"}`}>
      <div className="g-head">
        <span className="g-ico">🎯</span>
        <b>目标：{rows.map((r) => r.label).join(" + ")}</b>
        <span className={`badge ${running ? "run" : incomplete ? "failed" : "ok"}`}>
          {running ? `第 ${round} 轮执行中 · ${doneCount}/${rows.length}` : incomplete ? "执行未完成，已保留结果" : doneCount === rows.length ? "本轮已结束" : "未完成"}
        </span>
        {running && onStop && (
          <button className="mini-btn plain" style={{ marginLeft: "auto" }} onClick={onStop}>
            停止
          </button>
        )}
      </div>
      <ul className="g-list">
        {rows.map((r, i) => (
          <li key={i}>
            <span className={`g-mark ${r.done ? "g-ok" : running ? "g-run" : "g-todo"}`}>
              {r.done ? "✓" : running ? "●" : "○"}
            </span>
            {r.label}
            <span className="ev">{r.evidence}</span>
          </li>
        ))}
      </ul>
      <div className="g-foot">可在本任务中查看结果与来源，并继续对话补充或修改。</div>
    </div>
  );
}

/* ---------- 记忆注入标注 ---------- */
export function MemoryNote({ count }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  if (!count) return null;
  return (
    <div className="memory-note">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          if (!items && open === false)
            api("/api/doctor/memories?status=confirmed")
              .then((v) => setItems(v.memories || []))
              .catch(() => setItems([]));
        }}
      >
        🧠 已结合 {count} 条医生记忆 {open ? "▾" : "▸"}
      </button>
      {open && (
        <ul>
          {(items || []).slice(0, 8).map((m) => (
            <li key={m.id}>{m.content}</li>
          ))}
          {items && !items.length && <li>暂无已确认记忆</li>}
        </ul>
      )}
    </div>
  );
}
