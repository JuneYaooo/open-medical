import { useCallback, useEffect, useState } from "react";
import { History, MessageSquarePlus, Sparkles, Undo2 } from "lucide-react";
import { api } from "./agent-runtime";
import "./care.css";

const SOURCE = { chat: "对话中建立", evolution: "采纳进化建议", manual: "手动建立", rollback: "恢复历史版本", import: "外部安装" };
export const EXAMPLES = [
  ["出院小结按我院模板写", "我们医院的出院小结有固定格式，我把模板发给你，帮我建立一个技能，以后生成出院小结都按这个格式，并放到首页快捷任务里。"],
  ["HbA1c 高的糖尿病患者提醒我", "糖尿病患者出现糖化血红蛋白 > 8% 的新结果时，在今日待办提醒我考虑调整方案。先试算给我看。"],
  ["复诊前一天起草提醒消息", "患者复诊前一天，自动起草一条提醒消息（写明时间和事项），我核对后再发。"],
  ["每周一生成术后患者周报", "每周一早上 8 点，把标签为「术后」的患者汇总成一份周报。"],
];
const fmt = (value) => value ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const SETTINGS_TAB_KEY = "omw-settings-tab";
// Lets the agenda open settings on this section.
export function requestSettingsTab(tab) { try { sessionStorage.setItem(SETTINGS_TAB_KEY, tab); } catch { /* storage unavailable */ } }
export function takeSettingsTab() { try { const tab = sessionStorage.getItem(SETTINGS_TAB_KEY); sessionStorage.removeItem(SETTINGS_TAB_KEY); return tab; } catch { return null; } }

// 我的工作台: the doctor's own skills and rules, what the workbench learned
// from use, and every automatic adjustment with an undo.
export function ExtensionCenter({ onAsk }) {
  const [data, setData] = useState(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState("");
  const [open, setOpen] = useState(null);
  const [installUrl, setInstallUrl] = useState(""), [install, setInstall] = useState(null), [confirmDelete, setConfirmDelete] = useState(null);
  const load = useCallback(() => api("/api/extensions").then((v) => { setData(v); setError(""); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const act = async (key, fn, message) => {
    setBusy(key); setError(""); setNotice("");
    try { await fn(); if (message) setNotice(message); await load(); } catch (e) { setError(e.message); } finally { setBusy(""); }
  };
  // 外部技能包：先下载校验生成提案预览，医生在这里或右下角「待确认」面板确认后安装。
  const stageInstall = () => act("install", async () => {
    const r = await api("/api/extensions/import", "POST", { url: installUrl });
    setInstall(r);
  }, "");
  const resolveInstall = (decision) => act(`install-${install.action.id}`, async () => {
    await api(`/api/pending-actions/${install.action.id}/${decision}`, "POST", {});
    setInstall(null);
    setInstallUrl("");
  }, decision === "confirm" ? `已安装 ${install.staged.preview.skills.length} 个技能，下一轮对话即可使用。` : "已取消这次安装。");
  if (!data) return error ? <p role="alert" className="form-error">{error}</p> : <p role="status">正在读取…</p>;
  const skills = data.extensions.filter((e) => e.kind === "skill"), rules = data.extensions.filter((e) => e.kind === "automation");
  const applied = data.changes.filter((c) => c.status === "applied");

  const card = (e) => <article key={e.id} className={`ext-card ${e.status}`} aria-label={e.name}>
    <header><b>{e.name}</b><span className={`ext-status ${e.status}`}>{e.status === "active" ? "生效中" : "已停用"}</span><small>第 {e.version} 版 · {SOURCE[e.source?.via] || "手动建立"} · {fmt(e.updatedAt)}</small></header>
    <p>{e.kind === "skill" ? e.description : e.summary}</p>
    {e.origin?.url && <p className="muted">来源：<a href={e.origin.url} target="_blank" rel="noreferrer">{e.origin.url}</a>{e.origin.repo ? ` · ${e.origin.repo}` : ""}</p>}
    {e.kind === "skill" && (e.appliesTo?.length > 0 || e.quickTask) && <p className="muted">{[e.appliesTo?.length && `适用：${e.appliesTo.join("、")}`, e.quickTask && `首页快捷任务「${e.quickTask.title}」`].filter(Boolean).join(" · ")}</p>}
    {e.stats && <p className="muted">已产生 {e.stats.produced} 条{e.stats.produced ? `：完成 ${e.stats.done}、忽略 ${e.stats.dismissed}、待处理 ${e.stats.open}` : ""}{e.stats.lastAt ? ` · 最近 ${fmt(e.stats.lastAt)}` : ""}{e.stats.failures ? ` · 失败 ${e.stats.failures} 次` : ""}</p>}
    <footer className="toolbar-actions">
      {!e.imported && <button className="secondary" onClick={() => onAsk?.(`请帮我修改${e.kind === "skill" ? "技能" : "规则"}「${e.name}」（编号 ${e.id}）：`)}><MessageSquarePlus size={14} />在对话中修改</button>}
      <button className="text-button" disabled={Boolean(busy)} onClick={() => act(e.id, () => api(`/api/extensions/${e.id}/status`, "POST", { status: e.status === "active" ? "disabled" : "active" }), e.status === "active" ? `已停用「${e.name}」，随时可以重新启用。` : `已重新启用「${e.name}」。`)}>{e.status === "active" ? "停用" : "启用"}</button>
      {e.kind === "skill" && (confirmDelete === e.id
        ? <span className="toolbar-actions"><button className="text-button" disabled={Boolean(busy)} onClick={() => act(`del-${e.id}`, async () => { await api(`/api/extensions/${e.id}`, "DELETE"); setConfirmDelete(null); }, `已删除「${e.name}」及其历史版本。`)}>确认删除</button><button className="text-button" onClick={() => setConfirmDelete(null)}>再想想</button></span>
        : <button className="text-button" onClick={() => setConfirmDelete(e.id)}>删除</button>)}
      <button className="text-button" onClick={() => open?.id === e.id ? setOpen(null) : api(`/api/extensions/${e.id}`).then(setOpen).catch((x) => setError(x.message))}><History size={14} />历史版本</button>
    </footer>
    {open?.id === e.id && <ol className="ext-versions">{open.versions.map((v) => <li key={v.version}>
      <span>第 {v.version} 版 · {SOURCE[v.source?.via] || ""}{v.source?.reason ? ` · ${v.source.reason}` : ""} · {fmt(v.createdAt)}</span>
      <small>{e.kind === "skill" ? v.spec.body?.slice(0, 120) : v.spec.summary}</small>
      {v.version !== e.version && <button className="text-button" disabled={Boolean(busy)} onClick={() => act(e.id, async () => { setOpen(null); await api(`/api/extensions/${e.id}/rollback`, "POST", { version: v.version }); }, `已恢复到第 ${v.version} 版的内容。`)}>恢复此版本</button>}
    </li>)}</ol>}
  </article>;

  return <section className="ext-center" aria-label="我的工作台">
    <h2>我的工作台</h2>
    <p className="muted">这里是按你的习惯和医院要求长出来的能力：技能决定 AI 怎么写、怎么做；规则决定什么时候提醒你、替你准备什么。直接在对话里说出要求就能新建或修改，确认后生效，每一版都能恢复。系统也会根据你的使用情况提出建议。</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && <p role="status" className="form-notice">{notice}</p>}

    {data.suggestions.length > 0 && <div className="ext-block">
      <h3><Sparkles size={16} />进化建议</h3>
      {data.suggestions.map((s) => <article key={s.id} className="ext-suggestion">
        <div><b>{s.title}</b><p className="muted">{s.evidence}</p></div>
        <div className="toolbar-actions">
          <button className="primary" onClick={() => onAsk?.(`${s.prompt}\n\n（这是工作台的进化建议，提交时 suggestionId 填 ${s.id}）`)}>在对话中完善</button>
          <button className="text-button" disabled={Boolean(busy)} onClick={() => act(s.id, () => api(`/api/extensions/suggestions/${s.id}`, "POST", { status: "dismissed" }), "已忽略这条建议。")}>不需要</button>
        </div>
      </article>)}
    </div>}

    {applied.length > 0 && <div className="ext-block">
      <h3>系统自动做的调整</h3>
      {applied.map((c) => <p key={c.id} className="ext-change"><span>{fmt(c.createdAt)} · {c.title}{c.detail ? `（${c.detail}）` : ""}</span>
        <button className="text-button" disabled={Boolean(busy)} onClick={() => act(c.id, () => api(`/api/extensions/changes/${c.id}/undo`, "POST", {}), "已撤销，并停止自动调整这一项。")}><Undo2 size={14} />撤销</button></p>)}
    </div>}

    <div className="ext-block">
      <h3>新建</h3>
      <p className="muted">在对话里说出你的要求，比如：</p>
      <div className="ext-examples">{EXAMPLES.map(([label, prompt]) => <button key={label} className="secondary" onClick={() => onAsk?.(prompt)}>{label}</button>)}</div>
    </div>

    <div className="ext-block">
      <h3>我的技能 <small>{skills.length}</small></h3>
      {skills.length ? skills.map(card) : <p className="muted">还没有自建技能。医院文书格式、写作习惯、质控必写项都可以做成技能。</p>}
      <div className="ext-install">
        <h4>从外部安装技能包</h4>
        <p className="muted">粘贴 GitHub 仓库或 tar.gz 压缩包地址（技能须包含 SKILL.md）。安装的技能只作为 AI 的工作说明与参考文件，其中的脚本不会被执行。</p>
        {install ? <div className="ext-suggestion" role="status">
          <div><b>待安装（{install.staged.preview.skills.length} 个）· {install.staged.source.url}</b>
            <ul className="care-hint">{install.staged.preview.skills.map((s) => <li key={s.id}><b>{s.title}</b>（{s.id}{s.update ? `，更新第 ${s.update} 版` : ""}，{s.files} 个文件）：{s.description}</li>)}</ul>
            {install.staged.skipped.length > 0 && <p className="muted">跳过：{install.staged.skipped.map((s) => `${s.id}（${s.reason}）`).join("；")}</p>}
          </div>
          <div className="toolbar-actions">
            <button className="primary" disabled={Boolean(busy)} onClick={() => resolveInstall("confirm")}>{busy ? "处理中…" : "确认安装"}</button>
            <button className="text-button" disabled={Boolean(busy)} onClick={() => resolveInstall("reject")}>取消</button>
          </div>
        </div>
        : <div className="toolbar-actions">
          <input type="url" value={installUrl} onChange={(e) => setInstallUrl(e.target.value)} placeholder="https://github.com/用户名/仓库" aria-label="技能包地址" />
          <button className="secondary" disabled={!installUrl.trim() || Boolean(busy)} onClick={stageInstall}>{busy === "install" ? "正在下载校验…" : "获取并预览"}</button>
        </div>}
      </div>
    </div>
    <div className="ext-block">
      <h3>我的规则 <small>{rules.length}</small></h3>
      {rules.length ? rules.map(card) : <p className="muted">还没有自动化规则。定时提醒、检验阈值提醒、复诊前起草消息、定期汇总都可以做成规则。</p>}
    </div>
    <p className="muted">安全规则不会被定制改变：红旗症状提醒、发给患者前的确认、知情同意和引用出处始终有效。</p>
  </section>;
}
