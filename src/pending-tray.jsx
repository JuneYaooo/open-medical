import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardCheck, X } from "lucide-react";
import { api, PENDING_REFRESH_EVENT } from "./agent-runtime";
import "./care.css";

const TYPES = { "patient-create": "建档提案", "patient-update": "档案更新", "followup-create": "随访提醒", "case-save": "病例入库", "care-message": "发送消息", "care-campaign": "随访计划", "care-settings": "自动化设置", "care-bind": "关联微信客户", "care-group-message": "客户群群发", "care-education-broadcast": "患教群发", "patient-group-suggest": "分组建议", "patient-grouping": "患者分组", "trial-batch": "批量 AI 初筛", "trial-enrollment": "试验入组状态", "ext-change": "工作台扩展", "ext-install": "技能安装" };
export { PENDING_REFRESH_EVENT } from "./agent-runtime";

function Preview({ action }) {
  const p = action.payload || {};
  if (action.type === "patient-create") return <><p className="care-hint">新建患者：<b>{p.name}</b> · {({ male: "男", female: "女" })[p.gender] || "性别待补"}{p.birthYear ? ` · ${p.birthYear} 年生` : ""} · 过敏：{({ none_known: "无已知过敏", recorded: "已记录过敏原" })[p.allergyStatus] || "待核对"}</p>
    {p.clinicalSummary?.text && <pre>{p.clinicalSummary.text}</pre>}
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
      {p.clinicalSummary?.text && <pre>{p.clinicalSummary.text}</pre>}</>;
  }
  if (action.type === "followup-create") return <p className="care-hint">随访「{p.name}」{p.firstDueAt ? ` · 首次到期 ${p.firstDueAt}` : ""}{p.intervalDays ? ` · 每 ${p.intervalDays} 天` : ""}{p.once ? " · 单次" : " · 周期"}</p>;
  if (action.type === "case-save") return <>{p.diagnosis && <p className="care-hint">诊断：{p.diagnosis}</p>}{p.summary && <pre>{p.summary}</pre>}{p.lessons && <p className="care-hint">经验教训：{p.lessons}</p>}{(p.tags || []).length > 0 && <p className="care-hint">标签：{p.tags.join("、")}</p>}</>;
  if (action.type === "care-message") return <><p className="care-hint">渠道：{p.channel || "默认渠道"}</p><pre>{p.text}</pre></>;
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
  if (action.type === "care-group-message") return <><p className="care-hint">客户群「{p.groupName}」· 确认后由群主 {p.owner} 在企业微信中点发送</p><pre>{p.text}</pre></>;
  if (action.type === "care-education-broadcast") return <><p className="care-hint">患教素材「{p.materialTitle || "自定义内容"}」· 将为 {p.recipients?.length} 位患者创建企业微信单发任务（成员仍需在企业微信中手动点发送）</p><pre>{p.text}</pre></>;
  if (action.type === "patient-group-suggest") return <ul className="care-hint">{(p.assignments || []).map((a) => <li key={a.patientId}><b>{a.name}</b> 追加分组：{a.addTags.join("、")}</li>)}</ul>;
  if (action.type === "patient-grouping") return <><p className="care-hint">把 {(p.patients || []).length} 位患者加入分组「{p.groupName}」{p.note ? ` · ${p.note}` : ""}</p>
    <ul className="care-hint">{(p.patients || []).map((x, i) => <li key={x.patientId || i}>{x.name}{x.groups?.length ? `（已分组：${x.groups.join("、")}）` : ""}：{x.reason}</li>)}</ul></>;
  return <pre>{JSON.stringify(p.changes ?? p, null, 2)}</pre>;
}

// 聊天中由 care_* 工具发起的外发/计划/设置提案；医生在此一键确认。
export function PendingTray() {
  const tray = useRef(null);
  const [actions, setActions] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [rejecting, setRejecting] = useState(null);
  const [note, setNote] = useState("");
  const load = useCallback(() => api("/api/pending-actions?status=pending")
    .then((data) => setActions((data.actions || []).filter((a) => ["patient-create", "patient-update", "followup-create", "case-save"].includes(a.type) || a.type === "patient-grouping" || a.type === "patient-group-suggest" || a.type?.startsWith("care-") || a.type?.startsWith("trial-") || a.type?.startsWith("ext-"))))
    .catch(() => {}), []);
  useEffect(() => {
    load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, 20000);
    window.addEventListener(PENDING_REFRESH_EVENT, load);
    return () => { clearInterval(timer); window.removeEventListener(PENDING_REFRESH_EVENT, load); };
  }, [load]);
  useEffect(() => { if (!actions.length) setOpen(false); }, [actions.length]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event) => {
      if (event.type === "keydown" ? event.key === "Escape" : !tray.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open]);
  async function resolve(action, decision, withNote) {
    setBusy(action.id); setError("");
    try {
      await api(`/api/pending-actions/${action.id}/${decision}`, "POST", withNote ? { note } : {});
      setRejecting(null); setNote("");
      await load();
    }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  }
  if (!actions.length) return null;
  return <div className="pending-tray" ref={tray}>
    {open && <section className="pending-panel" aria-label="待确认的操作">
      <header><strong>待你确认（{actions.length}）</strong><button className="icon-button" aria-label="收起" onClick={() => setOpen(false)}><X size={16} /></button></header>
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
        </div> : <footer><button className="secondary" disabled={Boolean(busy)} onClick={() => { setRejecting(a.id); setNote(""); }}>拒绝</button><button disabled={Boolean(busy)} onClick={() => resolve(a, "confirm")}>{busy === a.id ? "处理中…" : "确认执行"}</button></footer>}
      </li>)}</ul>
    </section>}
    <button className="pending-badge" aria-expanded={open} onClick={() => setOpen((v) => !v)}><ClipboardCheck size={18} />待确认<em>{actions.length}</em></button>
  </div>;
}
