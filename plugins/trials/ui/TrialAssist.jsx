import { useEffect, useState } from "react";
import { api } from "../../../src/agent-runtime";
import { requestSettingsTab } from "../../../src/extension-center";

// 试验页与患者页共用的小部件：发起助手任务、筛选条件展示、预筛结论、患者匹配列表。
// 判断都在本机按已确认的筛选条件完成；助手只负责把入排标准翻译成条件、回答问题。

export const SCREEN = { match: ["符合筛选条件", "ok"], unclear: ["待核对", "muted"], mismatch: ["不符合", "bad"] };
const ROUGH = { likely: "字面相关", possible: "部分字面相关", unclear: "未见字面相关", mismatch: "年龄/性别可能不符" };
const VERDICT_CLASS = { not_met: "warn", unknown: "" };

// 发起助手任务。未连接模型时不建会话，直接说明并给出设置入口
// （提示统一显示在页面顶部的提问框下）。
export function useTrialAgent({ config, onOpenTask, onSettings, onError }) {
  const [gate, setGate] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = Boolean(config?.modelConfigured) && typeof onOpenTask === "function";
  const launch = async ({ draft, title, trial, task = "ask" }) => {
    if (!draft?.trim() || busy) return false;
    if (!ready) { setGate(true); return false; }
    setBusy(true);
    try {
      const session = await api("/api/sessions", "POST", { title: title.slice(0, 100) });
      await onOpenTask(session.id, {
        draft,
        submit: true,
        context: {
          kind: "trials-protocol",
          label: trial ? `临床试验 · ${trial.title.slice(0, 60)}` : "临床试验",
          scope: { task, ...(trial ? { trialId: trial.id } : {}) },
        },
      });
      return true;
    } catch (e) {
      onError?.(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const gateNotice = gate ? <div className="trial-model-gate" role="alert">
    <span>需先连接模型：用自然语言找患者、整理筛选条件由助手执行，未连接时不能发送。已确认的筛选条件和候选名单不需要模型，可继续使用。</span>
    <button className="secondary" onClick={() => { requestSettingsTab("general"); onSettings?.(); }}>打开 设置 → 模型与运行</button>
    <button className="text-button" onClick={() => setGate(false)}>知道了</button>
  </div> : null;
  return { launch, busy, gateNotice };
}

// 页面顶部的自然语言入口。
export function TrialAskBox({ agent, trial }) {
  const [text, setText] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    const ok = await agent.launch({ draft: text.trim(), title: `临床试验 · ${text.trim().slice(0, 40)}`, trial, task: "ask" });
    if (ok) setText("");
  };
  return <form className="trial-ask" onSubmit={submit}>
    <label htmlFor="trial-ask-input">问助手</label>
    <div className="trial-ask-row">
      <input id="trial-ask-input" value={text} maxLength={500} onChange={(e) => setText(e.target.value)}
        placeholder={trial ? `用一句话说要找什么患者，或让助手整理「${trial.title.slice(0, 20)}」的筛选条件` : "用一句话说要找什么患者，或让助手整理某个试验的筛选条件"} />
      <button className="primary" disabled={agent.busy || !text.trim()}>{agent.busy ? "正在打开…" : "交给助手"}</button>
    </div>
    <small className="muted">例：“近半年 HbA1c ≥ 8% 且没用胰岛素的 2 型糖尿病患者”“在 ClinicalTrials.gov 找国内正在招募的非小细胞肺癌试验”。结果是预筛草稿，需逐项核对。</small>
    {agent.gateNotice}
  </form>;
}

const sourceText = (s) => `${s.sourceLabel}${s.updatedAt ? ` · ${new Date(s.updatedAt).toLocaleString("zh-CN")}` : ""}`;

// 某试验的结构化筛选条件：每条的符合/待核对/不符合人数，可删条、确认为医生设置、清除。
export function TrialConditions({ trial, screening, agent, onChanged, onError }) {
  const [busy, setBusy] = useState(false);
  const draftConditions = () => agent.launch({
    draft: screening ? "请根据入排标准重新检查并修订这个试验的筛选条件。" : "请根据这个试验的入选和排除标准整理筛选条件。",
    title: `整理筛选条件 · ${trial.title.slice(0, 40)}`,
    trial,
    task: "conditions",
  });
  const save = async (body, message) => {
    setBusy(true);
    try { await api(`/api/trials/${trial.id}/screening-conditions`, "PUT", { ...body, expectedRevision: screening?.revision || 0 }); onChanged?.(message); }
    catch (e) { onError?.(e.message); }
    finally { setBusy(false); }
  };
  if (!screening) return <section className="trial-conditions is-empty" aria-label="筛选条件">
    <div>
      <h3>筛选条件</h3>
      <p>这个试验还没有结构化筛选条件，下面的预筛都是“待核对”，只附粗略提示（仅比对字面的年龄、性别和诊断，不看检验和用药，不可靠）。</p>
    </div>
    <button className="primary" disabled={agent.busy} onClick={draftConditions}>让助手根据入排标准整理筛选条件</button>
  </section>;
  // 保存时去掉界面附加的计数字段，只回传条件本身。
  const specWithout = (index) => ({
    title: screening.spec.title,
    conditions: screening.spec.conditions.filter((_, i) => i !== index),
  });
  return <section className="trial-conditions" aria-label="筛选条件">
    <header>
      <div>
        <h3>筛选条件 · {screening.title}</h3>
        <small className="muted">{sourceText(screening)} · 本地确定性判断，缺资料记为待核对</small>
      </div>
      <div className="module-actions">
        <button className="secondary" disabled={agent.busy || busy} onClick={draftConditions}>让助手修订</button>
        {screening.source === "model_draft" && <button className="secondary" disabled={busy} onClick={() => save({ spec: screening.spec, manualCriteria: screening.manualCriteria }, "已标记为医生核定的筛选条件。")}>确认为医生核定</button>}
        <button className="text-button" disabled={busy} onClick={() => { if (window.confirm("清除筛选条件后，候选患者回到“待核对”。确定清除？")) save({ spec: null }, "已清除筛选条件。"); }}>清除</button>
      </div>
    </header>
    <ol className="trial-condition-list">
      {screening.conditions.map((c) => <li key={c.index}>
        <span className={`trial-pill ${c.kind === "exclude" ? "bad" : ""}`}>{c.kind === "exclude" ? "排除" : "纳入"}</span>
        <span className="trial-condition-text"><b>{c.label}</b><small className="muted">{c.description}</small></span>
        <span className="trial-condition-counts" aria-label="人数">
          {c.kind === "exclude" ? `未触发 ${c.met} · 触发 ${c.not_met}` : `符合 ${c.met} · 不符合 ${c.not_met}`} · 待核对 {c.unknown}
        </span>
        {screening.conditions.length > 1 && <button className="text-button" disabled={busy} aria-label={`删除条件：${c.label}`} onClick={() => save({ spec: specWithout(c.index), manualCriteria: screening.manualCriteria }, `已删除条件「${c.label}」。`)}>删除</button>}
      </li>)}
    </ol>
    {screening.manualCriteria.length > 0 && <details className="trial-manual">
      <summary>{screening.manualCriteria.length} 条需人工或 AI 逐人核对（未参与预筛）</summary>
      <ul>{screening.manualCriteria.map((t) => <li key={t}>{t}</li>)}</ul>
    </details>}
  </section>;
}

// 候选表里的预筛单元格。
export function ScreenCell({ candidate }) {
  const s = candidate.screen;
  if (s.source !== "conditions") return <>
    <span className="trial-pill muted">未设置筛选条件</span>
    <small className="muted">粗略提示：{ROUGH[candidate.prefilter.status]}{candidate.prefilter.reasons[0] ? ` · ${candidate.prefilter.reasons[0]}` : ""}</small>
  </>;
  return <>
    <span className={`trial-pill ${SCREEN[s.status][1]}`}>{SCREEN[s.status][0]}</span>
    <small>{s.met}/{s.total} 条符合</small>
    {s.open.slice(0, 2).map((o) => <small key={o.index} className={VERDICT_CLASS[o.verdict]} title={o.evidence}>{o.label}：{o.verdictLabel}（{o.evidence}）</small>)}
    {s.openCount > 2 && <small className="muted">另有 {s.openCount - 2} 条</small>}
  </>;
}

// 一位患者对照各试验的筛选条件（不经模型）。
export function PatientTrialMatches({ patientId, onOpenTrial }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setData(null); setError("");
    if (!patientId) return undefined;
    api(`/api/trials/match/${encodeURIComponent(patientId)}`).then((v) => live && setData(v)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [patientId]);
  if (!patientId) return null;
  if (error) return <p role="alert" className="form-error">{error}</p>;
  if (!data) return <p role="status">正在对照各试验的筛选条件…</p>;
  return <div className="trial-match">
    {data.trials.length ? <ul className="trial-match-list">
      {data.trials.map((t) => <li key={t.trialId}>
        <div className="trial-match-head">
          <span className={`trial-pill ${SCREEN[t.status][1]}`}>{SCREEN[t.status][0]}</span>
          {onOpenTrial ? <button className="text-button" onClick={() => onOpenTrial(t.trialId)}>{t.title}</button> : <b>{t.title}</b>}
          <small className="muted">{[t.registration, t.recruitment, `${t.met}/${t.total} 条符合`, t.enrollment !== "未处理" ? t.enrollment : ""].filter(Boolean).join(" · ")}</small>
        </div>
        {t.open.length > 0 && <ul className="trial-match-open">{t.open.map((o) => <li key={o}>{o}</li>)}</ul>}
        {t.manualCriteria > 0 && <small className="muted">另有 {t.manualCriteria} 条需人工核对，未参与判断。</small>}
      </li>)}
    </ul> : <p className="muted">还没有设置筛选条件的试验。可在临床试验页让助手把入排标准整理成筛选条件。</p>}
    {data.withoutConditions.length > 0 && <p className="muted">未设置筛选条件、未参与对照：{data.withoutConditions.map((t) => t.title).join("、")}</p>}
    {data.closed?.length > 0 && <p className="muted">已结束或不再招募、未参与匹配：{data.closed.map((t) => `${t.title}（${t.recruitment}）`).join("、")}</p>}
    <p className="muted">{data.note}</p>
  </div>;
}
