import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CheckCheck, Search, RotateCw, UserPlus } from "lucide-react";
import { api } from "./agent-runtime";
import { publishAgendaViewIntent } from "./plugin-navigation";
import { requestSettingsTab } from "./extension-center";
import { usePluginActive, usePluginConnected } from "./plugin-slots";
import "./doctor-agenda.css";

// The server returns the enabled agenda kinds (including "all") in display
// order. Keep this fallback only for the first paint before that response.
const defaultKinds = [
  { kind: "all", label: "全部" },
  { kind: "risk", label: "高危风险" },
  { kind: "visit", label: "复诊" },
  { kind: "plan-review", label: "方案复评" },
  { kind: "followup", label: "随访" },
  { kind: "tracking", label: "检查检验" },
  { kind: "messages", label: "患者消息" },
  { kind: "trial", label: "试验入组" },
  { kind: "custom", label: "我的规则" },
];
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const workKinds = { evolve: "进化", proposal: "待确认", review: "待复核", failure: "未完成" };
// 非当年的日期带上年份，避免「9/13」分不清是今年还是往年。
const date = (value) => {
  if (!value) return "待认领";
  const parsed = new Date(value);
  const options = { month: "numeric", day: "numeric" };
  if (parsed.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
  return parsed.toLocaleDateString("zh-CN", options);
};

export function DoctorAgenda({ onPatient, onOpenTask, onView }) {
  const followupActive = usePluginActive("followup");
  // Follow-up reminders need only the plugin; patient messages need a channel.
  const messaging = usePluginConnected("followup");
  const hiddenKinds = [...(followupActive ? [] : ["followup"]), ...(messaging ? [] : ["messages"])];
  const [data, setData] = useState(null);
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [groups, setGroups] = useState([]);
  const [offset, setOffset] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (hiddenKinds.includes(kind)) setKind("all");
  }, [followupActive, messaging, kind]);
  const [hasUpdates, setHasUpdates] = useState(false);
  const displayed = useRef(null);
  const loadedScope = useRef("");
  const allKinds = data?.kinds?.length ? data.kinds : defaultKinds;
  const kindOptions = allKinds.filter((item) => !hiddenKinds.includes(item.kind));
  const kindLabels = Object.fromEntries(kindOptions.map((item) => [item.kind, item.label]));
  useEffect(() => {
    // 分组筛选项来自患者列表的在用分组（全局助手确认的分组会出现在这里）。
    api("/api/patients?summary=1&archived=1")
      .then((result) => setGroups([...new Set((result.patients || []).flatMap((p) => p.groups || []))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))))
      .catch(() => {});
  }, [refreshKey]);
  useEffect(() => {
    let live = true;
    let generation = 0;
    let fetching = false;
    const scope = JSON.stringify([kind, query, group, offset]);
    if (loadedScope.current !== scope) {
      loadedScope.current = scope;
      displayed.current = null;
      setData(null); setHasUpdates(false);
    }
    setLoading(true); setError("");
    const load = async (background = false) => {
      if (fetching) return;
      fetching = true;
      const request = ++generation;
      const silently = background && Boolean(displayed.current);
      if (!silently) setLoading(true);
      try {
        const result = await api(`/api/doctor/overview?kind=${kind}&q=${encodeURIComponent(query)}${group ? `&group=${encodeURIComponent(group)}` : ""}&offset=${offset}&limit=6`);
        if (live && request === generation) {
          if (silently) {
            setHasUpdates(JSON.stringify({ ...result, generatedAt: 0 }) !== JSON.stringify({ ...displayed.current, generatedAt: 0 }));
            setError("");
            return;
          }
          if (offset && offset >= result.total) { setOffset(Math.max(0, Math.floor((result.total - 1) / 6) * 6)); return; }
          displayed.current = result;
          setData(result); setHasUpdates(false); setError("");
        }
      } catch (err) { if (live && request === generation) setError(err.message); }
      finally { fetching = false; if (live && request === generation && !silently) setLoading(false); }
    };
    const delay = setTimeout(load, query ? 200 : 0);
    const interval = setInterval(() => { if (!document.hidden) load(true); }, 15000);
    return () => { live = false; clearTimeout(delay); clearInterval(interval); };
  }, [kind, query, group, offset, refreshKey]);
  const open = async (item) => {
    setOpening(item.id);
    setError("");
    try {
      if (item.action.type === "task") await onOpenTask(item.action.sessionId, { tab: item.action.tab || "materials" });
      else if (item.action.type === "patient") await onPatient({ id: item.patientId, tab: item.action.tab });
      else if (item.action.type === "patients") await onPatient({});
      else await onView(publishAgendaViewIntent(item, requestSettingsTab));
    } catch (err) { setError(err.message); }
    finally { setOpening(null); }
  };
  const [notice, setNotice] = useState("");
  const [acting, setActing] = useState(null);
  const quick = async (item, request, message) => {
    if (acting) return;
    setActing(item.id); setError(""); setNotice("");
    try { await request(); setNotice(message); setRefreshKey((value) => value + 1); }
    catch (err) { setError(err.message); }
    finally { setActing(null); }
  };
  const resolve = (item, status) => quick(item, () => api(`/api/extensions/items/${item.itemId}`, "POST", { status }), "");
  // 随访提醒推迟 N 天后再进今日待办；随访计划本身不变。
  const snooze = (item, days) => quick(item, () => api(`/api/reminders/${item.reminderId}/snooze`, "POST", { days, requestId: crypto.randomUUID() }),
    `已推迟 ${days} 天，${item.patientName}的随访到时会重新出现在今日待办。`);
  // 今天或已过期的复诊可直接登记到诊结果；带上版本号，别处改过会提示刷新。
  const visitOutcome = (item, status) => quick(item, () => api(`/api/appointments/${item.appointmentId}`, "PATCH", { expectedRevision: item.revision, status, requestId: crypto.randomUUID() }),
    status === "attended" ? `已登记${item.patientName}到诊。可在患者档案「复诊预约」里约下次复诊。` : `已登记${item.patientName}未到诊，可在患者档案里重新预约。`);
  const inlineActions = (item) => {
    const busy = loading || Boolean(acting);
    // Items from the doctor's own rules are closed here; the outcome tells the rule whether it helps.
    if (item.resolvable) return <>
      <button className="text-button" disabled={busy} onClick={() => resolve(item, "done")}>完成</button>
      <button className="text-button" disabled={busy} onClick={() => resolve(item, "dismissed")}>忽略</button></>;
    if (item.kind === "followup" && item.reminderId) return <select className="agenda-snooze" aria-label={`推迟${item.patientName}的随访`} disabled={busy} value=""
      onChange={(e) => { if (e.target.value) snooze(item, Number(e.target.value)); }}>
      <option value="">推迟…</option>
      {[1, 3, 7].map((days) => <option key={days} value={days}>推迟 {days} 天</option>)}
    </select>;
    // 明天的复诊还不能登记结果；今天和已过期的可以。
    if (item.kind === "visit" && item.appointmentId && localDay(item.at) <= localDay(Date.now())) return <>
      <button className="text-button" disabled={busy} onClick={() => visitOutcome(item, "attended")}>已到诊</button>
      <button className="text-button" disabled={busy} onClick={() => visitOutcome(item, "missed")}>未到诊</button></>;
    return null;
  };
  return (
    <section className="doctor-agenda" aria-label="今日待办" aria-busy={loading}>
      <div className="agenda-heading om-page-head">
        <div><h1>今日待办 <span>{data?.counts.all ?? "—"}</span></h1>
          <span className="om-page-meta agenda-context">{data?.criticalCount > 0 ? <><em className="om-chip is-danger">{data.criticalCount} 项高优先级</em> 已排在最前，</> : "按优先级排列，"}点击事项即可继续处理。</span></div>
        <div className="agenda-heading-actions">
          <button className="text-button" onClick={() => onView("schedule")}>复诊名单 <ArrowUpRight size={14} /></button>
          {followupActive && <button className="text-button" onClick={() => onView("followups")}>全部随访计划 <ArrowUpRight size={14} /></button>}
          {messaging && <button className="text-button" onClick={() => onView("care")}>患者消息 <ArrowUpRight size={14} /></button>}
        <button className="icon-button" title="刷新今日待办" aria-label="刷新今日待办" disabled={loading} onClick={() => setRefreshKey((value) => value + 1)}><RotateCw size={16} /></button>
        </div>
      </div>
      <div className="agenda-toolbar">
        <div className="agenda-filters" aria-label="待办分类">{kindOptions.filter((item) => item.kind === "all" || item.kind === kind || !data || data.counts[item.kind] > 0).map((item) => <button key={item.kind} aria-pressed={kind === item.kind} data-zero={data && !data.counts[item.kind] ? "" : undefined} className={kind === item.kind ? "active" : ""} onClick={() => { setKind(item.kind); setOffset(0); }}>{item.label}<span>{data?.counts[item.kind] ?? "—"}</span></button>)}</div>
        <label className="agenda-search"><Search size={14} /><input aria-label="搜索今日待办" placeholder="患者或事项" value={query} onChange={(e) => { setQuery(e.target.value); setOffset(0); }} /></label>
        {groups.length > 0 && <label className="agenda-search agenda-group-filter"><select aria-label="按分组筛选待办" value={group} onChange={(e) => { setGroup(e.target.value); setOffset(0); }}>
          <option value="">全部分组</option>
          {groups.map((name) => <option key={name} value={name}>{name}</option>)}
        </select></label>}
      </div>
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}<button className="text-button" onClick={() => setRefreshKey((value) => value + 1)}>重试</button></p>}
      {hasUpdates && <p className="notice" role="status">今日待办有更新。<button className="text-button" disabled={loading} onClick={() => setRefreshKey(value => value + 1)}>刷新查看更新</button></p>}
      {data?.errors?.length > 0 && <p className="muted agenda-source-errors" role="status">部分待办暂时无法读取（{data.errors.map((item) => kindLabels[item.kind] || item.kind).join("、")}），其余事项照常显示。</p>}
      {!data && !error && <div className="agenda-loading" role="status">正在整理今日待办…</div>}
      {data && !data.items.length && <div className="agenda-empty">
        <CheckCheck size={24} />
        <div><b>{query ? "没有匹配的待办" : !data.patientCount ? "从第一位患者开始" : kind === "all" ? "今天没有需要处理的患者事项" : "当前分类没有待处理事项"}</b>
          <p>{query ? "试试姓名、患者编号或任务关键词。" : !data.patientCount ? "建档后导入材料，整理、复核和随访会围绕同一位患者接续。" : "已完成的记录仍保留在患者档案中。你也可以直接交办新任务。"}</p></div>
        {data.patientCount > 0 && !query && <div className="toolbar-actions"><button className="text-button" onClick={() => { requestSettingsTab("workbench"); onView?.("settings"); }}>设置我的提醒规则</button></div>}
        {!data.patientCount && !query && <div className="toolbar-actions"><button className="secondary" onClick={() => onPatient({ create: true })}><UserPlus size={15} />新建患者</button><button className="text-button" onClick={() => onPatient({ import: true })}>导入已有患者</button></div>}
      </div>}
      <div className="agenda-items">{data?.items.map((item) => {
        const row = <button className={`agenda-item ${item.severity === "critical" ? "urgent" : ""}`} key={item.id} disabled={Boolean(opening) || loading} onClick={() => open(item)}>
          <span className={`agenda-kind kind-${item.kind}`}><em>{kindLabels[item.kind] || item.kind}</em><small>{item.at ? date(item.at) : ""}{item.kind === "visit" && item.time ? ` ${item.time}` : ""}</small></span>
          <span className="agenda-person"><b>{item.patientName}</b><small>{[item.patientNumber, item.birthYear ? `约${new Date().getFullYear() - item.birthYear}岁` : ""].filter(Boolean).join(" · ")}</small></span>
          <span className="agenda-content"><b>{item.title}</b><small>{item.detail}</small></span>
          <span className="agenda-action">{opening === item.id ? "打开中…" : item.action.label}<ArrowUpRight size={14} /></span>
        </button>;
        const actions = inlineActions(item);
        return actions ? <div className="agenda-row" key={item.id}>{row}<span className="agenda-resolve">{actions}</span></div> : row;
      })}</div>
      {(() => {
        // 待确认提案统一收敛到顶栏「待确认」，这里只留待复核/未完成等工作事项。
        const work = {
          total: data?.work?.items.filter((i) => i.kind !== "proposal").length || 0,
          items: data?.work?.items.filter((i) => i.kind !== "proposal") || [],
        };
        if (!work.total) return null;
        return <details className="agenda-work">
          <summary>工作台事项 <span>{work.total}</span><small>{Object.entries(workKinds).map(([key, label]) => { const n = work.items.filter((i) => i.kind === key).length; return n ? `${label} ${n}` : ""; }).filter(Boolean).join(" · ")}</small></summary>
          <div className="agenda-items">{work.items.map((item) => <button className="agenda-item" key={item.id} disabled={Boolean(opening) || loading} onClick={() => open(item)}>
            <span className="agenda-kind">{workKinds[item.kind]}<small>{item.at ? date(item.at) : ""}</small></span>
            <span className="agenda-person"><b>{item.patientName}</b><small>{item.patientNumber}</small></span>
            <span className="agenda-content"><b>{item.title}</b><small>{item.detail}</small></span>
            <span className="agenda-action">{opening === item.id ? "打开中…" : item.action.label}<ArrowUpRight size={14} /></span>
          </button>)}</div>
        </details>;
      })()}
      {data && (offset > 0 || data.hasMore) && <div className="agenda-pagination"><span>{offset + 1}–{Math.min(offset + data.items.length, data.total)} / {data.total} 项</span><button className="text-button" disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - 6))}>上一页</button><button className="text-button" disabled={!data.hasMore || loading} onClick={() => setOffset(offset + 6)}>下一页</button></div>}
    </section>
  );
}
