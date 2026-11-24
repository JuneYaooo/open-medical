import { useEffect, useState } from "react";
import { api } from "../../../src/agent-runtime";

const percent = (value) => value === null ? "—" : `${Math.round(value * 100)}%`;

// Panel-level picture of follow-up work, above the follow-up tabs: who is
// being followed, which fired reminders still need a contact result, how
// many recent reminders got one, and how many risk items are open.
export function FollowupStats({ reloadKey, onPending }) {
  const [stats, setStats] = useState(null);
  const [risk, setRisk] = useState(null);
  useEffect(() => {
    let alive = true;
    api("/api/followups/stats").then((value) => alive && setStats(value)).catch(() => alive && setStats(null));
    // Risk items come from the agenda (survey alerts, lab monitors); optional.
    api("/api/doctor/overview?kind=risk&limit=1").then((value) => alive && setRisk(value?.counts?.risk ?? null)).catch(() => alive && setRisk(null));
    return () => { alive = false; };
  }, [reloadKey]);
  if (!stats) return null;
  const { window: w } = stats;
  const tiles = [
    { key: "patients", label: "随访中", value: stats.patients, unit: "位患者", note: "有进行中的随访计划" },
    { key: "pending", label: "待登记", value: stats.pending, unit: "条", note: stats.overdue ? `其中 ${stats.overdue} 条超过 ${stats.overdueDays} 天` : "提醒已到期、还没登记联系结果", tone: stats.overdue ? "caution" : "", action: stats.pending ? onPending : null },
    { key: "rate", label: `近 ${stats.days} 天登记率`, value: percent(w.recordRate), unit: "", note: w.fired ? `${w.fired} 条到期 · 联系上 ${w.completed} · 未联系到 ${w.unreachable} · 拒绝 ${w.declined}` : "这段时间没有到期的提醒" },
    ...(risk === null ? [] : [{ key: "risk", label: "高危风险", value: risk, unit: "项", note: "问卷预警与检验监测，在今日待办处理", tone: risk ? "danger" : "" }]),
  ];
  return <dl className="followup-stats" aria-label="随访概况">
    {tiles.map((tile) => {
      const body = <><dt>{tile.label}</dt><dd><b>{tile.value}</b>{tile.unit && <span>{tile.unit}</span>}</dd><dd className="followup-stat-note">{tile.note}</dd></>;
      return <div key={tile.key} className={`followup-stat${tile.tone ? ` is-${tile.tone}` : ""}`}>
        {tile.action ? <button type="button" className="followup-stat-button" onClick={tile.action}>{body}</button> : body}
      </div>;
    })}
  </dl>;
}
