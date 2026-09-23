import { SimilarCases } from "./similar-cases";
import { patientIdentityLabel, patientOptionLabel } from "./patient-labels";
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

/* ---------- 工具名中文名（医疗 + 通用） ---------- */
const TOOL_NAMES = {
  extract_clinical_timeline: "整理病历时间线",
  extract_observations: "摘录检验数值",
  medication_safety_check: "用药安全核查",
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
  if (!tools.length && !running) return null;
  return (
    <div className={`steps-flow ${running ? "running" : ""} ${failed ? "has-failed" : ""}`}>
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
export function artifactToLines(a) {
  if (!a) return [];
  const lines = [];
  lines.push(`【${a.title || "未命名产物"}】`);
  if (a.events?.length) {
    lines.push("— 时间线 —");
    for (const e of a.events) lines.push(`${e.date} ${e.event}`);
  }
  if (a.items?.length) {
    lines.push("— 条目 —");
    for (const it of a.items) lines.push(it);
  }
  if (a.observations?.length) {
    lines.push("— 检验摘录 —");
    for (const o of a.observations) lines.push(`${o.name}: ${o.value}${o.unit || ""}`);
  }
  if (a.pico) {
    lines.push("— PICO —");
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

/* ---------- 验收视图（叠加层） ---------- */
const STATUS_TEXT = { draft: "待复核", approved: "已复核", rejected: "需修订" };
export function AcceptanceView({ artifact, previous, onSource, onClose, onReview }) {
  const [view, setView] = useState(previous ? "diff" : "preview");
  const [reviewing, setReviewing] = useState(null); // 'approved' | 'rejected'
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [reviewer] = useState(() => localStorage.getItem("om.reviewer") || "");
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
  const submitReview = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const f = new FormData(e.currentTarget);
      localStorage.setItem("om.reviewer", f.get("reviewer"));
      await onReview({
        reviewer: f.get("reviewer"),
        note: f.get("note"),
        decision: reviewing || (artifact.type === "similar_cases" ? "approved" : reviewing),
        attested: f.get("attested") === "on",
        version: artifact.version,
      });
      setReviewing(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  if (artifact.type === "similar_cases") return (
    <div className="acceptance case-reader" role="dialog" aria-label="查看相似病例">
      <div className="accept-bar"><button className="text-button" onClick={onClose}>‹ 返回对话</button><h3>查看相似病例</h3></div>
      <div className="case-reader-body">
        <SimilarCases key={artifact.id} artifact={artifact}/>
        <details className="case-review-records"><summary>记录我的核对意见（可选）</summary>
          <p>仅记录你对这些病例资料的核对意见，不代表认可其中的治疗方案。</p>
          {artifact.review && <p>{artifact.review.reviewer}：{artifact.review.note}</p>}
          {artifact.history?.filter(h=>h.review).map(h=><p key={h.version}>{h.review.reviewer}：{h.review.note}</p>)}
          <form className="review-form" onSubmit={submitReview}>
            <input name="reviewer" aria-label="核对医生" placeholder="你的姓名或代号" defaultValue={reviewer} maxLength={80} required/>
            <input name="note" aria-label="核对意见" placeholder="例如：疾病相同，但肝功能不同" required/>
            <label className="attest"><input type="checkbox" name="attested" required/>我已查看原文及适用范围</label>
            <button className="btn" disabled={saving} onClick={()=>setReviewing("approved")}>保存核对意见</button>
          </form>
          {error && <p className="error-text" role="alert">{error}</p>}
        </details>
      </div>
    </div>
  );
  return (
    <div className="acceptance" role="dialog" aria-label="产物验收">
      <div className="accept-bar">
        <button className="text-button" onClick={onClose}>‹ 返回对话</button>
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
              {artifact.type === "similar_cases" ? <SimilarCases key={artifact.id} artifact={artifact} /> : cur.map((l, i) => (
                <p key={i} className={l.startsWith("【") || l.startsWith("—") ? "acc-head" : ""}>{l}</p>
              ))}
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
              {(artifact.events || []).map((e, i) => (
                <div className="src-row" key={i}>
                  <span>{e.date} · {e.event}</span>
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
                    artifact.type === "similar_cases" ? <span>{m.sourceName} · 本地记录</span> :
                    <button className="source-link" onClick={() => onSource(m)}>{m.sourceName}{m.line ? ` · L${m.line}` : ""}</button>}
                  {m.scope && <small>{m.scope}</small>}
                  {m.evidence?.text && <details><summary>查看检索时保存的{m.evidence.type === "abstract" ? "摘要" : "记录"}</summary><p>{m.evidence.text}</p></details>}

                </div>
              ))}
              {!artifact.events?.length && !artifact.matches?.length && (
                <p className="muted">这份已保存结果没有记录原文出处。</p>
              )}
            </div>
          )}
          <div className="review-bar">
            {reviewing ? (
              <form className="review-form" onSubmit={submitReview}>
                <input name="reviewer" placeholder="复核人代号（必填）" defaultValue={reviewer} maxLength={80} required />
                <input name="note" placeholder={reviewing === "approved" ? "复核说明（已核对出处与缺失项）" : "退回原因：哪里需要修订？"} required />
                <label className="attest">
                  <input type="checkbox" name="attested" required /> 已检查原文与适用范围
                </label>
                <button type="button" className="btn" onClick={() => setReviewing(null)}>取消</button>
                <button className={`btn ${reviewing === "approved" ? "primary" : "danger"}`} disabled={saving}>
                  {reviewing === "approved" ? "✓ 确认通过" : "退回并生成修订指令"}
                </button>
              </form>
            ) : (
              <>
                <span className="review-note">
                  确认后标记为已复核，可发起随访；退回将自动生成修订指令。
                </span>
                <div className="review-acts">
                  <button className="btn danger" onClick={() => setReviewing("rejected")}>退回修订</button>
                  <button className="btn primary" onClick={() => setReviewing("approved")}>✓ 确认通过</button>
                </div>
              </>
            )}
            {error && <p className="error-text" role="alert">{error}</p>}
          </div>
        </div>
        <aside className="accept-side">
          <p className="side-label">字段校验清单</p>
          {checklist.length ? (
            checklist.map((c, i) => (
              <div className={`check-item ${c.ok ? (c.warn ? "warn" : "ok") : "miss"}`} key={i}>
                <span className="ic">{c.warn ? "⚠" : c.ok ? "✓" : "⚠"}</span>
                {c.text}
              </div>
            ))
          ) : (
            <div className="check-item ok"><span className="ic">✓</span>必填字段完整</div>
          )}
          <p className="side-label">复核记录</p>
          {artifact.review ? (
            <div className="rcard">
              <div className="r-m">
                {artifact.review.reviewer} · {STATUS_TEXT[artifact.review.decision] || artifact.review.decision}
                <br />
                {artifact.review.note}
              </div>
            </div>
          ) : (
            <div className="rcard"><div className="r-m">尚未复核</div></div>
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
          <p className="acc-disclaimer">
            复核仅代表院内整理流程状态，不构成电子签名或法律意义的医疗文书签发。
          </p>
        </aside>
      </div>
    </div>
  );
}

/* ---------- 患者速览卡 ---------- */
export function PatientSummaryCard({ patient, detail, session, onOpenDetail, onOpenWorkspace, compact }) {
  if (!patient && !detail) return null;
  const p = detail || patient;
  const allergies = (p.allergies || []).map((a) => (typeof a === "string" ? a : a.substance || a.name || "")).filter(Boolean);
  const diagnoses = (p.diagnoses || []).map((d) => (typeof d === "string" ? d : d.name || d.diagnosis || "")).filter(Boolean);
  const meds = (p.medications || []).filter((m) => (typeof m === "string" ? true : m.status !== "stopped"));
  const counts = p.counts || {};
  return (
    <div className={`patient-summary ${compact ? "compact" : ""}`}>
      <div className="ps-head">
        <span className="p-ava" title={patientIdentityLabel(p)}>{(p.name || "?").slice(0, 1)}</span>
        <div className="p-id">
          <b>{p.name}{p.gender || p.birthYear ? ` · ${p.gender === "female" ? "女" : p.gender === "male" ? "男" : ""}${p.birthYear ? ` ${p.birthYear}年生` : ""}` : ""}</b>
          <span>
            {[...(diagnoses || []), ...(p.tags || []), ...(p.groups || [])]
              .slice(0, 3)
              .join(" · ") || "未补充诊断与标签"}
          </span>
        </div>
        <div className="ps-badges">
          {allergies.length > 0 && <span className="badge no">过敏：{allergies.join("、")}</span>}
          {!allergies.length && <span className="badge">{p.allergyStatus === "none_known" ? "已核对：无已知过敏" : "过敏史待核对"}</span>}
          <span className="pill local">◈ 本地</span>
        </div>
      </div>
      <div className="ps-grid">
        <div className="ps-col">
          <h5>用药记录（{meds.length}）</h5>
          {meds.length ? (
            meds.slice(0, 4).map((m, i) => {
              const name = typeof m === "string" ? m : `${m.name || ""}${m.dose ? ` ${m.dose}` : ""}${m.frequency ? ` ${m.frequency}` : ""}`;
              return <span className="med-chip" key={i}>{name}</span>;
            })
          ) : (
            <span className="ps-empty">暂无用药记录</span>
          )}
        </div>
        <div className="ps-col">
          <h5>近期检验</h5>
          {(p.labs || []).length ? (
            (p.labs || []).slice(-3).reverse().map((l, i) => (
              <div className="vital" key={i}>
                <div className="row1"><b>{l.value}</b><span className="u">{l.item}{l.unit ? ` · ${l.unit}` : ""}</span></div>
                <div className="row2"><span className="d">{l.date || ""}</span></div>
              </div>
            ))
          ) : (
            <span className="ps-empty">暂无检验记录</span>
          )}
        </div>
        <div className="ps-col">
          <h5>待办与成果</h5>
          <ul className="tl">
            {counts.unprocessedMessages > 0 && <li><i />{counts.unprocessedMessages} 条未处理消息</li>}
            {counts.dueFollowups > 0 && <li><i />{counts.dueFollowups} 项随访到期</li>}
            <li><i />{session ? `${session.files.length} 份材料 · ${session.artifacts.length} 份已保存结果` : `${p.counts?.artifacts ?? "—"} 份已保存结果`}</li>
            {session?.artifacts.filter((a) => a.status === "draft").length > 0 && (
              <li><i />{session.artifacts.filter((a) => a.status === "draft").length} 份待复核</li>
            )}
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
                {p.counts?.dueFollowups ? `${p.counts.dueFollowups} 项随访到期` : p.counts?.unprocessedMessages ? `${p.counts.unprocessedMessages} 条新消息` : ""}
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

/* ---------- 模式判定（agent 自动，用户不选档位） ---------- */
// 有模型就走模型循环；意图（直接回答 vs 整理成草稿）由服务端 policy
// 引擎判定并写入系统提示词，模型自行决定是否调用文书类工具。
export function modeToRequest(modelEnabled, base) {
  if (!modelEnabled) return { ...base, mode: "local" };
  return { ...base, mode: "model" };
}

/* ---------- 风险卡列表 ---------- */
export function RiskList({ alerts, onAck, onResolve, onDraft, busy }) {
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
  return (
    <div className="risk-list">
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
      {sorted.map((r) => (
        <div className={`risk-card ${r.severity === "critical" ? "red" : ""}`} key={r.id}>
          <div className="r-head">
            {r.severity === "critical" ? "用药/检验风险 · 高" : r.severity === "warning" ? "风险提示" : "提示"}
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
              <button className="mini-btn" disabled={busy || actionBusy} onClick={() => act(() => onDraft(r))}>
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
      ))}
    </div>
  );
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
        if (hit.type === "similar_cases") {
          row.done = true;
          const cases = hit.cases || [];
          const metadata = cases.filter(c => c.evidence?.type === "metadata" || /仅题录/.test(c.scope)).length;
          const failed = (hit.searches || []).filter(s => s.status === "failed").length;
          row.evidence = `检索已结束 · ${cases.length} 条候选${metadata ? ` · ${metadata} 条仅题录` : ""}${failed ? ` · ${failed} 次来源请求失败` : ""} · 待复核`;
          continue;
        }
        row.done = hit.type !== "treatment_review" || sourceCount > 0;
        row.evidence = `已生成草稿 v${hit.version || 1} · 出处 ${sourceCount} 条 · ${sourceCount || hit.type !== "treatment_review" ? "待复核" : "缺少出处，尚未完成"}`;
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
          {running ? `第 ${round} 轮执行中 · ${doneCount}/${rows.length}` : incomplete ? "执行未完成，已保留结果" : doneCount === rows.length ? "本轮已结束 · 待复核" : "未完成"}
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
      <div className="g-foot">完成标准：生成带出处的草稿并结束本次执行；人工复核是后续独立步骤。</div>
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
