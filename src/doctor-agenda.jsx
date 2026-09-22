import { useEffect, useState } from "react";
import { ArrowUpRight, CheckCheck, Search, RotateCw, UserPlus } from "lucide-react";
import { api } from "./agent-runtime";

const kinds = { all: "全部", review: "待复核", followup: "随访", tracking: "检查与转诊", messages: "患者消息", risk: "风险提示", attention: "需要继续" };
const date = (value) => value ? new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) : "待认领";

export function DoctorAgenda({ onPatient, onOpenTask, onView }) {
  const [data, setData] = useState(null);
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    let generation = 0;
    const load = async () => {
      const request = ++generation;
      setLoading(true);
      try {
        const result = await api(`/api/doctor/overview?kind=${kind}&q=${encodeURIComponent(query)}&offset=${offset}&limit=6`);
        if (live && request === generation) {
          if (offset && offset >= result.total) { setOffset(Math.max(0, Math.floor((result.total - 1) / 6) * 6)); return; }
          setData(result); setError("");
        }
      } catch (err) { if (live && request === generation) setError(err.message); }
      finally { if (live && request === generation) setLoading(false); }
    };
    const delay = setTimeout(load, query ? 200 : 0);
    const interval = setInterval(() => { if (!document.hidden) load(); }, 15000);
    return () => { live = false; clearTimeout(delay); clearInterval(interval); };
  }, [kind, query, offset, refreshKey]);
  const open = async (item) => {
    setOpening(item.id);
    setError("");
    try {
      if (item.action.type === "task") await onOpenTask(item.action.sessionId, { tab: item.action.tab || "materials" });
      else if (item.action.type === "patient") await onPatient({ id: item.patientId, tab: item.action.tab });
      else if (item.action.type === "patients") await onPatient({});
      else await onView(item.action.view);
    } catch (err) { setError(err.message); }
    finally { setOpening(null); }
  };
  return (
    <section className="doctor-agenda" aria-label="今日待办" aria-busy={loading}>
      <div className="agenda-heading">
        <div><span className="hub-kicker">把后续工作接起来</span><h2>今天要处理的事 <span>{data?.counts.all ?? "—"}</span></h2><p>患者消息、随访和复核集中在这里，打开即可继续。</p></div>
        <button className="icon-button" title="刷新今日待办" disabled={loading} onClick={() => setRefreshKey((value) => value + 1)}><RotateCw size={16} /></button>
      </div>
      <div className="agenda-toolbar">
        <div className="agenda-filters" aria-label="待办分类">{Object.entries(kinds).map(([key, label]) => <button key={key} aria-pressed={kind === key} className={kind === key ? "active" : ""} onClick={() => { setKind(key); setOffset(0); }}>{label}<span>{data?.counts[key] ?? "—"}</span></button>)}</div>
        <label className="agenda-search"><Search size={14} /><input aria-label="搜索今日待办" placeholder="患者或事项" value={query} onChange={(e) => { setQuery(e.target.value); setOffset(0); }} /></label>
      </div>
      {error && <p className="form-error" role="alert">{error}<button className="text-button" onClick={() => setRefreshKey((value) => value + 1)}>重试</button></p>}
      {!data && !error && <div className="agenda-loading" role="status">正在整理今日待办…</div>}
      {data && !data.items.length && <div className="agenda-empty">
        <CheckCheck size={24} />
        <div><b>{query ? "没有匹配的待办" : !data.patientCount ? "从第一位患者开始" : "当前分类没有待处理事项"}</b>
          <p>{query ? "试试姓名、患者编号或任务关键词。" : !data.patientCount ? "建档后导入材料，整理、复核和随访会围绕同一位患者接续。" : "已完成的记录仍保留在患者档案中。你也可以直接交办新任务。"}</p></div>
        {!data.patientCount && !query && <div className="toolbar-actions"><button className="secondary" onClick={() => onPatient({ create: true })}><UserPlus size={15} />新建患者</button><button className="text-button" onClick={() => onPatient({ import: true })}>导入已有患者</button></div>}
      </div>}
      <div className="agenda-items">{data?.items.map((item) => <button className={`agenda-item ${item.severity === "critical" ? "urgent" : ""}`} key={item.id} disabled={Boolean(opening) || loading} onClick={() => open(item)}>
        <span className="agenda-kind">{kinds[item.kind]}<small>{date(item.at)}</small></span>
        <span className="agenda-person"><b>{item.patientName}</b><small>{item.patientNumber || (item.patientId ? item.patientId.slice(0, 8) : "通用会话")}{item.birthYear ? ` · ${item.birthYear} 年生` : ""}</small></span>
        <span className="agenda-content"><b>{item.title}</b><small>{item.detail}</small></span>
        <span className="agenda-action">{opening === item.id ? "打开中…" : item.action.label}<ArrowUpRight size={14} /></span>
      </button>)}</div>
      {data && (offset > 0 || data.hasMore) && <div className="agenda-pagination"><span>{offset + 1}–{Math.min(offset + data.items.length, data.total)} / {data.total} 项</span><button className="text-button" disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - 6))}>上一页</button><button className="text-button" disabled={!data.hasMore || loading} onClick={() => setOffset(offset + 6)}>下一页</button></div>}
    </section>
  );
}
