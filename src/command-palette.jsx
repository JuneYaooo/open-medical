import { useEffect, useMemo, useRef, useState } from "react";
import { usePluginConnected } from "./plugin-slots";
import { Activity, ArrowRight, CalendarClock, FolderOpen, Inbox, Search, Stethoscope, UserPlus } from "lucide-react";
import { patientIdentityLabel, patientQuickMatch, recentPatientIds, rememberRecentPatient } from "./patient-labels";

// 命令面板（Cmd/Ctrl+K）：患者快速检索（姓名 / 编号 / 拼音首字母 / 电话后四位）
// 与常用导航。门诊场景下医生不该为找一位患者多点三次。
// 拼音首字母见 pinyin-initials.js：输入「zs」可找到张三；手机号可输后四位。
// 空查询时列出最近打开的患者（最多 5 位）。
const patientResult = (p) => ({ kind: "patient", id: p.id, label: p.name, hint: [patientIdentityLabel(p), p.groups?.length ? p.groups.join("、") : ""].filter(Boolean).join(" · "), patient: p });

const COMMANDS = (medical, followupActive) => [
  { id: "home", label: "新建任务", hint: "回到任务入口", icon: UserPlus, run: "home" },
  ...(medical ? [
    { id: "agenda", label: "今日待办", hint: "今天要处理的患者与事项", icon: CalendarClock, run: "agenda" },
    { id: "patients", label: "患者列表", hint: "全部在管患者", icon: Stethoscope, run: "patients" },
    ...(followupActive ? [{ id: "care", label: "患者消息", hint: "微信 / 企微收件与回复", icon: Inbox, run: "care" }] : []),
    { id: "review", label: "待复核", hint: "AI 草稿复核队列", icon: Activity, run: "review" },
  ] : [
    { id: "tasks", label: "任务记录", hint: "历史任务", icon: Activity, run: "tasks" },
    { id: "projects", label: "项目文件", hint: "项目工作区", icon: FolderOpen, run: "projects" },
  ]),
];

export function CommandPalette({ open, onClose, patients, medical, onOpenPatient, onNavigate, onCreatePatient }) {
  // The only followup command here is 患者消息, which needs a connected channel.
  const followupActive = usePluginConnected("followup");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null), listRef = useRef(null);

  useEffect(() => { if (open) { setQuery(""); setCursor(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const commands = COMMANDS(medical, followupActive)
      .filter(c => !q || c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q))
      .map(c => ({ kind: "command", ...c }));
    if (!q) {
      const recent = recentPatientIds().map((id) => patients.find((p) => p.id === id)).filter(Boolean).map(patientResult);
      return [...recent, ...commands];
    }
    const matches = patients.filter((p) => patientQuickMatch(p, q)).slice(0, 7).map(patientResult);
    return [...matches, ...commands];
  }, [query, patients, medical, followupActive, open]);

  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => {
    const node = listRef.current?.children[cursor];
    node?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;
  const pick = item => {
    onClose();
    if (item.kind === "patient") { rememberRecentPatient(item.patient.id); onOpenPatient(item.patient); }
    else if (item.run === "patients") onNavigate("patients");
    else onNavigate(item.run);
  };
  return <div className="palette-scrim" onClick={onClose}>
    <div className="palette" role="dialog" aria-label="命令面板" onClick={e => e.stopPropagation()}>
      <div className="palette-input">
        <Search size={16} />
        <input
          ref={inputRef}
          aria-label="搜索患者或功能"
          placeholder="患者姓名 / 编号 / 拼音首字母 / 电话后四位，或功能名…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === "ArrowDown") { e.preventDefault(); setCursor(c => Math.min(c + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
            else if (e.key === "Enter" && results[cursor]) { e.preventDefault(); pick(results[cursor]); }
            else if (e.key === "Escape") onClose();
          }}
        />
        <kbd>esc</kbd>
      </div>
      {results.length ? <ul ref={listRef} className="palette-list">
        {results.map((item, i) => <li key={item.kind + (item.id || item.run)}>
          <button className={i === cursor ? "active" : ""} onMouseEnter={() => setCursor(i)} onClick={() => pick(item)}>
            {item.kind === "patient"
              ? <><Stethoscope size={15} /><b>{item.label}</b><small>{item.hint}</small><ArrowRight size={13} className="palette-go" /></>
              : <><item.icon size={15} /><b>{item.label}</b><small>{item.hint}</small></>}
          </button>
        </li>)}
      </ul> : <div className="palette-empty">
        <p>没有匹配「{query}」的患者或功能。</p>
        {medical && onCreatePatient && <button onClick={() => { onClose(); onCreatePatient(); }}><UserPlus size={14} />新建患者「{query}」</button>}
      </div>}
      <footer className="palette-footer"><span><kbd>↑↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>esc</kbd> 关闭</span></footer>
    </div>
  </div>;
}

// 全局 Cmd/Ctrl+K 热键钩子；避开输入框内的原生场景（面板自身输入除外）。
export function usePaletteHotkey(setOpen) {
  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen(v => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
}
