import "./focused-workspace.css";
import { TASK_TEMPLATES, taskTemplateContext } from "../shared/task-templates.mjs";
import { contextSummary } from "./task-context";
import { BackupStatus } from "./backup-panel";
import { patientOptionLabel } from "./patient-labels";
import { EXAMPLES as CUSTOMIZE_EXAMPLES, requestSettingsTab } from "./extension-center";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  AtSign,
  BookOpen,
  CalendarClock,
  ClipboardList,
  FileHeart,
  FileText,
  Paperclip,
  ShieldCheck,
  FlaskConical,
  FolderOpen,
  History,
  Image,
  Loader2,
  MessageSquare,
  Search,
  Stethoscope,
  X,
} from "lucide-react";
import { careSetupProgress, publishAgendaViewIntent, requestPluginIntent } from "./plugin-navigation";
import { usePluginActive, usePluginConnected } from "./plugin-slots";
import { api, medicalEnabled, PENDING_REFRESH_EVENT } from "./agent-runtime";
import { uploadProgressText } from "./import-material";
import { ComposerModelMenu } from "./composer-model-menu.jsx";
import { requestPendingReview } from "./pending-tray";
import "./home-today.css";

function HomeCockpit({ onView, onPatient, onOpenTask, reloadKey }) {
  const [overview, setOverview] = useState(null);
  const [overviewError, setOverviewError] = useState("");
  const [pendingCount, setPendingCount] = useState(null);
  const [pendingError, setPendingError] = useState("");
  const [todayVisits, setTodayVisits] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const load = () => {
      const request = ++generation;
      return Promise.allSettled([
        api("/api/doctor/overview?limit=6"),
        api("/api/pending-actions?status=pending&limit=5"),
        api("/api/doctor/overview?kind=visit&limit=100"),
      ]).then(([a, b, c]) => {
        if (!alive || request !== generation) return;
        // 今日复诊：今天预约的复诊（按人数），未登记的过期复诊和明天的不算。
        if (c.status === "fulfilled") setTodayVisits(new Set(c.value.items.filter((item) => new Date(item.at).toDateString() === new Date().toDateString()).map((item) => item.patientId)).size);
        if (a.status === "fulfilled") { setOverview(a.value); setOverviewError(""); }
        else { setOverview(null); setOverviewError(a.reason.message); }
        if (b.status === "fulfilled") {
          setPendingCount(b.value.counts.pending); setPendingError("");
        } else {
          setPendingCount(null); setPendingError(b.reason.message);
        }
      });
    };
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 30000);
    window.addEventListener(PENDING_REFRESH_EVENT, load);
    return () => { alive = false; clearInterval(timer); window.removeEventListener(PENDING_REFRESH_EVENT, load); };
  }, [reloadKey, retry]);
  const items = overview?.items || [];
  const open = async (item) => {
    try {
      if (item.action?.type === "patient" && item.patientId) await onPatient?.({ id: item.patientId, tab: item.action.tab });
      else if (item.action?.type === "task" && item.action.sessionId) await onOpenTask?.(item.action.sessionId, { tab: item.action.tab || "materials" });
      else if (item.action?.type === "view" && item.action.view) onView?.(publishAgendaViewIntent(item, requestSettingsTab));
      else onView?.("agenda");
    } catch { onView?.("agenda"); }
  };
  return <section className="home-today" aria-label="今天">
    <div className="home-activity" aria-label="工作提醒">
      <h2>今天</h2>
      <button type="button" onClick={() => onView?.("agenda")}><CalendarClock size={16}/><span>今日待办</span><b>{overview?.total ?? "—"}</b><ArrowUpRight size={14}/></button>
      {todayVisits > 0 && <button type="button" className="home-visits" onClick={() => onView?.("schedule")}><Stethoscope size={16}/><span>今日复诊</span><b>{todayVisits} 位</b><ArrowUpRight size={14}/></button>}
      {overview?.criticalCount > 0 && <span className="home-urgent om-chip is-danger" role="status">其中 {overview.criticalCount} 项高优先级</span>}
      <button type="button" onClick={() => requestPendingReview()}><ClipboardList size={16}/><span className="cockpit-label">待确认提案</span><b className="cockpit-number">{pendingCount ?? "—"}</b><ArrowUpRight size={14}/></button>
    </div>
    {(overviewError || pendingError) && <p role="alert" className="form-error">{overviewError ? `患者事项加载失败：${overviewError}` : `待确认提案加载失败：${pendingError}`}<button type="button" className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {overview && (items.length ? <ul className="home-today-list">
      {items.slice(0, 4).map((item) => <li key={item.id}><button type="button" className={item.severity === "critical" ? "is-critical" : ""} onClick={() => open(item)}>
        <span className="home-today-who"><b>{item.patientName || "工作台"}</b>{item.title && <em>{item.title}{item.kind === "visit" && item.time ? ` ${item.time}` : ""}</em>}</span>
        <span className="home-today-detail">{item.detail}</span>
        <span className="home-today-action">{item.action?.label || "查看"}<ArrowUpRight size={13}/></span>
      </button></li>)}
      {overview.total > 4 && <li className="home-today-more"><button type="button" className="om-link" onClick={() => onView?.("agenda")}>查看全部 {overview.total} 项待办<ArrowUpRight size={13}/></button></li>}
    </ul> : <p className="om-empty home-today-empty">今天没有需要处理的患者事项。</p>)}
  </section>;
}

const materialSize = (bytes) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round((bytes || 0) / 1024))} KB`;
const isImageName = (name) => /\.(png|jpe?g|webp)$/i.test(name || "");

// 带 template 的任务：输入框只放简短请求，详细执行要求（调用哪些工具、
// 输出结构、边界）作为任务上下文随问题发送，见 shared/task-templates.mjs。
export const MEDICAL_WORKFLOWS = [
  {
    id: "intake-full",
    title: "整理收治资料",
    icon: ClipboardList,
    category: "clinical",
    desc: "时间线、检验摘录与用药信息一次整理",
    output: "时间线 · 检验摘录 · 用药信息",
    template: "intake-full",
    prompt: TASK_TEMPLATES["intake-full"].request,
  },
  {
    id: "timeline",
    title: "整理病历",
    icon: History,
    category: "clinical",
    desc: "把零散记录整理成就诊时间线",
    output: "病历时间线 · 原文来源",
    prompt: "请将本次材料整理为病历时间线，保留原文来源和待确认信息。",
  },
  {
    id: "observations",
    title: "摘录检验",
    icon: Activity,
    category: "clinical",
    desc: "提取检验数值，保留单位与出处",
    output: "指标摘录 · 对照原文",
    prompt: "请摘录本次材料的检验数值，保留单位和原始出处，不进行异常判断。",
  },
  {
    id: "medication",
    title: "核对用药资料",
    icon: ClipboardList,
    category: "clinical",
    desc: "找出用药记录中的缺失信息",
    output: "用药信息清单 · 待核对项",
    prompt: "请整理这份用药材料，列出需要专业人员核对的信息和缺失字段。",
  },
  {
    id: "followup",
    title: "安排随访",
    icon: CalendarClock,
    category: "clinical",
    desc: "为患者设置时间、清单和提醒",
    output: "患者随访计划",
    prompt: "",
  },
  {
    id: "record-draft",
    title: "生成病历草稿",
    icon: FileHeart,
    category: "clinical",
    desc: "口述或粘贴的零散信息，整理成结构化病历草稿",
    output: "门诊病历草稿 · 主诉/现病史/查体/计划",
    template: "record-draft",
    prompt: TASK_TEMPLATES["record-draft"].request,
  },
  {
    id: "med-safety",
    title: "用药辅助提醒",
    icon: ShieldCheck,
    category: "clinical",
    desc: "整理已记录用药、过敏史和需要进一步核对的事项",
    output: "用药辅助提醒清单 · 规则提醒，可能漏报",
    template: "med-safety",
    prompt: TASK_TEMPLATES["med-safety"].request,
  },
  {
    id: "patient-edu",
    title: "患教大白话",
    icon: MessageSquare,
    category: "clinical",
    desc: "把诊疗方案或说明书转成患者能懂的语言",
    output: "患教材料草稿 · 通俗解释",
    template: "patient-edu",
    prompt: TASK_TEMPLATES["patient-edu"].request,
  },
  {
    id: "lab-read",
    title: "检验报告解读",
    icon: FlaskConical,
    category: "clinical",
    desc: "对照报告内参考范围，标记异常项并生成解读草稿",
    output: "异常项清单 · 解读草稿",
    template: "lab-read",
    prompt: TASK_TEMPLATES["lab-read"].request,
  },
  {
    id: "discharge-summary",
    title: "出院小结草稿",
    icon: FileText,
    category: "clinical",
    desc: "按出院小结结构整理住院经过、出院诊断与随访医嘱",
    output: "出院小结草稿 · 待医生签署",
    template: "discharge-summary",
    prompt: TASK_TEMPLATES["discharge-summary"].request,
  },
  {
    id: "handoff",
    title: "值班交班记录",
    icon: CalendarClock,
    category: "clinical",
    desc: "接班医生视角的患者要点与夜间注意清单",
    output: "交班要点 · 夜间观察清单",
    template: "handoff",
    prompt: TASK_TEMPLATES["handoff"].request,
  },
  {
    id: "decision-flow",
    title: "诊疗决策流程图",
    icon: ClipboardList,
    category: "clinical",
    desc: "从指南库提炼决策路径，生成可追溯出处的流程图",
    output: "mermaid 决策流程图 · 节点出处对照",
    template: "decision-flow",
    prompt: TASK_TEMPLATES["decision-flow"].request,
  },
  {
    id: "adr-screen",
    title: "不良反应筛查",
    icon: ShieldCheck,
    category: "clinical",
    desc: "用药与表现匹配可疑药物反应，附 Naranjo 因果评估",
    output: "可疑反应清单 · 因果评估建议",
    template: "adr-screen",
    prompt: TASK_TEMPLATES["adr-screen"].request,
  },
  {
    id: "case-report",
    title: "个案报告写作",
    icon: FileText,
    category: "research",
    desc: "按 CARE 框架从病例材料生成个案报告草稿",
    output: "个案报告草稿 · 结构化段落",
    template: "case-report",
    prompt: TASK_TEMPLATES["case-report"].request,
  },
  {
    id: "evidence",
    title: "准备循证检索",
    icon: BookOpen,
    category: "research",
    desc: "从材料提炼问题，准备检索策略",
    output: "PICO · 检索式 · 核查步骤",
    prompt: "请根据材料建立循证检索任务，整理 PICO、检索式与证据核查步骤。",
  },
];
const dateLabel = (value) =>
  new Date(value).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });

const SETUP_HIDDEN_KEY = "omw-setup-checklist-hidden";
// 首次启动检查清单：各项独立探测，接口缺失或失败时显示「未检测」而不阻塞首页。
function SetupChecklist({ modelConfigured, onModelSettings, onView }) {
  // Connecting WeChat/WeCom is optional: follow-up reminders work without it,
  // so the checklist only shows channel progress once one is connected.
  const followupActive = usePluginConnected("followup");
  const [facts, setFacts] = useState({});
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(SETUP_HIDDEN_KEY) === "1"; } catch { return false; } });
  useEffect(() => {
    let alive = true;
    const probe = (key, path, read) => api(path).then((value) => read(value)).catch(() => null).then((value) => { if (alive) setFacts((f) => ({ ...f, [key]: value })); });
    probe("knowledge", "/api/knowledge", (v) => Array.isArray(v?.documents) ? v.documents.length > 0 : null);
    if (followupActive) {
      probe("wecom", "/api/care/settings", (v) => Array.isArray(v?.channels?.list) ? careSetupProgress(v).essential : null);
      probe("autoReply", "/api/care/settings", (v) => typeof v?.autoReply?.mode === "string" ? { mode: v.autoReply.mode, saved: Boolean(v.updatedAt) } : null);
    }
    return () => { alive = false; };
  }, [followupActive]);
  const modeLabel = { off: "已关闭", draft: "草稿模式", auto: "自动回复" };
  const items = [
    { id: "model", label: "连接模型", done: modelConfigured, state: modelConfigured ? "已填写连接" : "未填写连接", action: "去连接", open: onModelSettings },
    { id: "knowledge", label: "导入医生知识库", done: facts.knowledge === true, state: facts.knowledge == null ? "未检测" : facts.knowledge ? "已有资料" : "暂无资料", action: "导入资料", open: () => onView?.("knowledge") },
    // 连接患者微信/企业微信是可选项（随访提醒不需要）；接入后才显示企业微信
    // 接入进度与自动回复边界。
    ...(followupActive && facts.wecom === true ? [{ id: "wecom", label: "企业微信已接入", done: true, state: "已接入", action: "管理", open: () => { requestPluginIntent("followup", "care-setup"); onView?.("care"); } }] : []),
    ...(followupActive && facts.autoReply?.saved ? [{ id: "autoReply", label: "自动回复边界", done: true, state: modeLabel[facts.autoReply.mode] || facts.autoReply.mode, action: "设置自动回复", open: () => onView?.("care") }] : []),
  ];
  const remaining = items.filter((item) => !item.done).length;
  if (!remaining) return null;
  if (hidden) return <button type="button" className="setup-checklist-reopen" onClick={() => { setHidden(false); try { localStorage.removeItem(SETUP_HIDDEN_KEY); } catch { /* storage unavailable */ } }}>开始使用：还有 {remaining} 项未完成</button>;
  return <section className="setup-checklist" aria-label="开始使用检查清单">
    <header><strong>开始使用</strong><span>还有 {remaining} 项未完成{modelConfigured ? " · 也可以直接在对话里让助手引导完成" : ""}</span>
      <button type="button" onClick={() => { setHidden(true); try { localStorage.setItem(SETUP_HIDDEN_KEY, "1"); } catch { /* storage unavailable */ } }}>收起</button></header>
    <ol>{items.map((item) => <li key={item.id} className={item.done ? "done" : ""}>
      <span aria-hidden="true">{item.done ? "✓" : "○"}</span><b>{item.label}</b><em>{item.state}</em>
      {!item.done && item.open && <button type="button" onClick={item.open}>{item.action}</button>}
    </li>)}</ol>
  </section>;
}

export function WorkbenchHome({
  demoEntryHidden = false,
  view,
  config,
  sessions,
  onStart,
  onOpenTask,
  onPatient,
  onRefresh,
  onReconnect,
  onOpenProjects,
  projects = [],
  onClearDraft,
  thinking,
  onThinkingChange,
  draftState = {},
  onDraftChange,
  attachmentError,
  onModelSettings,
  onView,
  onAttach,
  uploading,
  uploadProgress,
  attachedFiles = [],
  attachedCount = 0,
  onRemoveAttachment,
  fileInputRef,
  onFilesPicked,
}) {
  const followupActive = usePluginActive("followup");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("clinical");
  const [showAllFlows, setShowAllFlows] = useState(false);
  const [projectId, setProjectId] = useState(draftState.projectId ?? "");
  const taskType = projectId ? "project" : "medical";
  const availableProjects = projects.filter(p => !p.archived && p.kind !== "session" && p.kind !== "task");
  const [flowId, setFlowId] = useState(draftState.flowId ?? "");
  const [prompt, setPrompt] = useState(draftState.prompt ?? "");
  const [patientId, setPatientId] = useState(draftState.patientId ?? "");
  const [starting, setStarting] = useState(false);
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [skillMention, setSkillMention] = useState(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pickedSkills, setPickedSkills] = useState(draftState.pickedSkills ?? []);
  // 设置页等入口带来的任务上下文（如要修改的技能编号），以标签展示，随任务提交。
  const [homeContexts, setHomeContexts] = useState(draftState.context ?? []);
  useEffect(() => { onDraftChange?.({prompt, patientId, projectId, flowId, pickedSkills, context: homeContexts}); }, [prompt, patientId, projectId, flowId, pickedSkills, homeContexts]);
  useEffect(() => { if (!followupActive && flowId === "followup") setFlowId(""); }, [followupActive, flowId]);
  const inputRef = useRef(null);
  // The doctor's own templates (extension center) and learned ordering.
  const [workbenchPrefs, setWorkbenchPrefs] = useState(null);
  useEffect(() => {
    if (!config || !medicalEnabled(config)) return;
    api("/api/extensions/prefs").then(setWorkbenchPrefs).catch(() => {});
  }, [config]);
  const customFlows = (workbenchPrefs?.quickTasks || []).map((q) => ({ ...q, icon: ClipboardList, category: "mine", output: "按所选模板整理" }));
  const allFlows = [...customFlows, ...MEDICAL_WORKFLOWS]
    .filter((flow) => flow.id !== "followup" || followupActive);
  const starterFlows = (workbenchPrefs?.starters || []).map((id) => allFlows.find((f) => f.id === id)).filter(Boolean);
  const selectedFlow = allFlows.find((flow) => flow.id === flowId);
  const isFollowup = flowId === "followup" && followupActive;
  const isHome = view === "home";
  const skillOptions = config?.skills || [];
  const mentionMatches = skillMention
    ? skillOptions
        .filter(
          (skill) =>
            !pickedSkills.includes(skill.id) &&
            `${skill.title || skill.name} ${skill.name} ${skill.id} ${skill.description || ""}`
              .toLowerCase()
              .includes(skillMention.query.toLowerCase()),
        )
        .slice(0, 8)
    : [];
  // 材料已附加后，本次任务的目标会话已定，锁定类型与患者切换
  const attached = attachedCount > 0 || Boolean(attachedFiles.length);
  useEffect(() => {
    let live = true;
    // 双保险:无医疗能力时不请求患者/提醒/收件/风险接口(通用服务上这些
    // 接口不存在,请求会进入错误态)。外壳也不应在通用模式下渲染本视图。
    if (!config || !medicalEnabled(config)) return () => {};
    const refresh = async () => {
      try {
        const people = await api("/api/patients?summary=1");
        if (live) {
          setData({ patients: people.patients });
          setError("");
        }
      } catch (err) {
        if (live) setError(err.message);
      }
    };
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) {
        refresh();
        onRefresh().catch(() => {});
      }
    }, 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [view, reloadKey]);
  const patients = data?.patients || [];
  const selectedPatient = patients.find((patient) => patient.id === patientId);
  const tasks = sessions.filter(
    (task) =>
      task.title.toLowerCase().includes(query.toLowerCase()),
  );
  const chooseFlow = (flow) => {
    setProjectId("");
    setFlowId(flow.id);
    setPrompt(flow.prompt);
    // A custom template brings its skill along; usage lets the workbench learn what matters.
    if (flow.skillId) setPickedSkills((prev) => prev.includes(flow.skillId) ? prev : [...prev, flow.skillId].slice(-3));
    api("/api/extensions/usage", "POST", { flowId: flow.id }).catch(() => {});
    inputRef.current?.focus();
  };
  const pickSkill = (skill) => {
    setPrompt((value) => value.replace(/@[^\s@]{0,20}$/, ""));
    setPickedSkills((prev) =>
      prev.includes(skill.id) || prev.length >= 3 ? prev : [...prev, skill.id],
    );
    setSkillMention(null);
    inputRef.current?.focus();
  };
  const openSkillMention = () => {
    setPrompt((value) => value + (value && !value.endsWith(" ") ? " @" : "@"));
    setSkillMention({ query: "" });
    setMentionIndex(0);
    inputRef.current?.focus();
  };
  const submit = async (e) => {
    e?.preventDefault();
    if (starting || uploading) return;
    setError("");
    if (patientId && !selectedPatient) {
      setError("所选患者已不可用，请重新选择。");
      return;
    }
    if (isFollowup) {
      if (selectedPatient)
        onPatient({ id: selectedPatient.id, tab: "followups" });
      return;
    }
    if (!prompt.trim()) return;
    if (!config?.modelConfigured) {
      setError("需先连接模型：未连接模型时不能发送任务。输入内容已保留。");
      return;
    }
    if (prompt.trim().length > 200000) {
      setError("任务超过 20 万字符，请拆成多个任务或上传为资料；输入内容已保留。");
      return;
    }
    setStarting(true);
    try {
      if (projectId) {
        if (!availableProjects.some(p => p.id === projectId)) throw new Error("关联项目已不可用，请重新选择。");
        await onOpenProjects({ id: projectId, prompt: prompt.trim() });
        return;
      }
      await onStart({
        prompt: prompt.trim(),
        patient: selectedPatient,
        title: selectedFlow?.title || prompt.trim().slice(0, 32),
        skills: pickedSkills,
        context: [...homeContexts, selectedFlow?.template && taskTemplateContext(selectedFlow.template)].filter(Boolean),
      });
      setPickedSkills([]);
      setSkillMention(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  };
  const taskList = (limit) => (
    <div className="hub-task-list">
      {tasks.slice(0, limit).map((task) => (
        <button
          className="hub-task-row"
          key={task.id}
          onClick={() =>
            onOpenTask(task.id, {
              tab: "materials",
            })
          }
        >
          <span className="hub-task-icon">
            <MessageSquare size={18} />
          </span>
          <span className="hub-task-name">
            <b>{task.title}</b>
            <small>
              {task.patientId
                ? patients.find((p) => p.id === task.patientId)?.name ||
                  "患者工作区"
                : "独立任务"}{" "}
              · {dateLabel(task.updatedAt)}
            </small>
          </span>
          <span
            className="hub-task-state"
          >
            {task.running
              ? "执行中"
              : task.messageCount
                  ? "查看记录"
                  : "待开始"}
          </span>
          <ArrowUpRight size={15} />
        </button>
      ))}
      {!tasks.length && (
        <div className="hub-empty">
          <FolderOpen size={23} />
          <b>
            {query
              ? "没有找到匹配的任务"
              : "暂无任务记录"}
          </b>
          <p>
            {query
              ? "尝试其他关键词。"
              : "选择上方场景，或直接描述需要整理的材料。"}
          </p>
        </div>
      )}
    </div>
  );
  return (
    <main id="main" className={`workbench-hub${isHome ? " hub-home" : ""}`}>
      <div className="hub-page-head">
        <span>
          {isHome
            ? "个人工作空间"
            : "工作空间 / 任务记录"}
        </span>
        <div className="hub-page-actions">
          {isHome && !demoEntryHidden && <button type="button" className="text-button" disabled={starting || uploading} onClick={() => onView("examples")}>示例体验<ArrowUpRight size={13} aria-hidden="true" /></button>}
          <span>{new Date().toLocaleDateString("zh-CN", {
            month: "long",
            day: "numeric",
            weekday: "long",
          })}</span>
        </div>
      </div>
      {attachmentError && <p className="error-text" role="alert">操作未完成：{attachmentError}</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}{" "}
          {error.startsWith("需先连接模型") ? (
            <button className="text-button" onClick={onModelSettings}>
              连接模型
            </button>
          ) : (
            <button
              className="text-button"
              onClick={() => {
                onReconnect()
                  .then(() => setReloadKey((value) => value + 1))
                  .catch((err) => setError(err.message));
              }}
            >
              刷新连接
            </button>
          )}
        </p>
      )}
      {isHome ? (
        <>
          {config && !config.modelConfigured && <div className="agent-setup-note" role="status"><span>需先连接模型：未连接时不能发送任务。患者档案、资料导入和随访计划等本地功能不受影响。</span><button type="button" onClick={onModelSettings}>连接模型</button></div>}
          <form className="hub-composer" onSubmit={submit}>
            <div className="hub-composer-caption">
              <h1>{selectedFlow ? selectedFlow.title : "新任务"}</h1>
              {!selectedFlow && (prompt || attached || patientId || projectId) && <button type="button" disabled={starting || uploading} onClick={onClearDraft}>清空草稿</button>}
              {selectedFlow && (
                <button
                  type="button"
                  onClick={() => {
                    setFlowId("");
                    setPrompt("");
                  }}
                >
                  清除场景
                </button>
              )}
            </div>
            {homeContexts.length > 0 && !isFollowup && (
              <div className="skill-chips task-context-chips" aria-label="随任务附带的上下文">
                {homeContexts.map((context) => (
                  <span className="skill-chip task-context" key={context.kind} title={contextSummary(context)}>
                    <Paperclip size={11} />
                    {context.label}
                    <button type="button" aria-label={`移除附带上下文 ${context.label}`} onClick={() => setHomeContexts((prev) => prev.filter((c) => c.kind !== context.kind))}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {taskType === "medical" && uploading && !isFollowup && (
              <p className="attach-progress" role="status">
                <Loader2 size={13} className="spin" />
                {uploadProgressText(uploadProgress)}
              </p>
            )}
            {taskType === "medical" && attached && !isFollowup && (
              <div className="attach-list" aria-label="已附加材料">
                <span className="attach-list-label">
                  <Paperclip size={12} />
                  {attachedFiles.length
                    ? `本次将发送 ${attachedFiles.length} 份材料`
                    : `已附 ${attachedCount} 份材料`}
                </span>
                {attachedFiles.map((file) => (
                  <span className="attach-chip" key={file.id}>
                    {isImageName(file.name) ? <Image size={12} /> : <FileText size={12} />}
                    <b title={file.name}>{file.name}</b>
                    <small>{materialSize(file.size)}</small>
                    <button
                      type="button"
                      aria-label={`移除材料 ${file.name}`}
                      title="发送前移除这份材料"
                      disabled={uploading}
                      onClick={() => onRemoveAttachment?.(file.id)}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {isFollowup ? (
              <div className="hub-followup-prompt">
                <CalendarClock size={21} />
                <div>
                  <b>继续安排这位患者的随访</b>
                  <p>选择患者，进入随访计划设置时间、间隔与核查清单。</p>
                </div>
              </div>
            ) : (
              <textarea
                ref={inputRef}
                aria-label="任务内容"
                placeholder="例如：整理本次病历，并标出缺失资料。可先添加材料或关联患者。"
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  const matched =
                    taskType === "medical"
                      ? e.target.value.match(/@([^\s@]{0,20})$/)
                      : null;
                  if (matched) {
                    setSkillMention({ query: matched[1] });
                    setMentionIndex(0);
                  } else setSkillMention(null);
                }}
                onKeyDown={(e) => {
                  if (skillMention && mentionMatches.length) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setMentionIndex((i) => (i + 1) % mentionMatches.length);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setMentionIndex(
                        (i) =>
                          (i - 1 + mentionMatches.length) %
                          mentionMatches.length,
                      );
                      return;
                    }
                    if (e.key === "Escape") {
                      setSkillMention(null);
                      return;
                    }
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      pickSkill(mentionMatches[mentionIndex]);
                      return;
                    }
                  }
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    submit(e);
                  }
                }}
                disabled={starting}
                rows={3}
              />
            )}
            {skillMention && (
              <div
                className="mention-menu"
                role="listbox"
                aria-label="技能选择"
              >
                {mentionMatches.length ? (
                  mentionMatches.map((skill, i) => (
                    <button
                      type="button"
                      key={skill.id}
                      className={i === mentionIndex ? "active" : ""}
                      onClick={() => pickSkill(skill)}
                    >
                      <AtSign size={14} />
                      <span>
                        <b>{skill.title || skill.name}</b>
                        <small>{skill.description}</small>
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="mention-empty">没有匹配的技能</p>
                )}
              </div>
            )}
            {Boolean(pickedSkills.length) && (
              <div className="skill-chips">
                {pickedSkills.map((id) => {
                  const skill = skillOptions.find((s) => s.id === id);
                  return (
                    <span className="skill-chip" key={id}>
                      <AtSign size={11} />
                      {skill?.title || skill?.name || customFlows.find((f) => f.skillId === id)?.title || id}
                      <button
                        type="button"
                        aria-label={`移除技能 ${skill?.title || skill?.name || customFlows.find((f) => f.skillId === id)?.title || id}`}
                        onClick={() =>
                          setPickedSkills((prev) =>
                            prev.filter((item) => item !== id),
                          )
                        }
                      >
                        <X size={11} />
                      </button>
                    </span>
                  );
                })}
                <small>本轮固定技能，发送后清除</small>
              </div>
            )}
            <div className="hub-composer-controls">
              {!isFollowup && <label className="hub-patient-picker"><FolderOpen size={15}/><select aria-label="任务关联项目" value={projectId} disabled={attached || Boolean(patientId) || starting || uploading} onChange={e => { setProjectId(e.target.value); setFlowId(""); setPickedSkills([]); setSkillMention(null); }}><option value="">关联项目（可选）</option>{availableProjects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
              {taskType === "medical" && (
                <label className="hub-patient-picker">
                  <Stethoscope size={15} />
                  <select
                    aria-label="任务关联患者"
                    value={patientId}
                    onChange={(e) => e.target.value === "__new" ? onPatient({create:true}) : setPatientId(e.target.value)}
                    disabled={!data || starting || attached || uploading}
                  >
                    <option value="">
                      {isFollowup ? "请选择患者" : "关联患者（可选）"}
                    </option>
                    <option value="__new">＋ 新建患者档案</option>
                    {patients.map((patient) => (
                      <option key={patient.id} value={patient.id}>
                        {patientOptionLabel(patient, patients)}
                        {patient.archived ? "（已归档）" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {taskType === "medical" && !isFollowup && (
                <>
                  <button
                    type="button"
                    className="attach-button"
                    title="添加图片、PDF、Word、Excel、TXT、Markdown、CSV 或 JSON，随本次任务一起发送"
                    onClick={() => onAttach(selectedPatient?.sessionId)}
                    disabled={starting || uploading || !config || !config.modelConfigured}
                  >
                    <Paperclip size={16} />
                    {uploading ? "导入中…" : "添加材料"}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    hidden
                    accept=".png,.jpg,.jpeg,.webp,.txt,.md,.markdown,.csv,.tsv,.json,.pdf,.xlsx,.docx"
                    onChange={onFilesPicked}
                  />
                  <button
                    type="button"
                    className="attach-button"
                    title="输入 @ 或点此固定技能（如出院小结、用药复核）；不固定则自动路由"
                    onClick={openSkillMention}
                    disabled={!config}
                  >
                    <AtSign size={15} />
                    技能
                  </button>
                </>
              )}
              {taskType !== "project" && !isFollowup && (
                <>
                  <ComposerModelMenu config={config} thinking={thinking} onThinkingChange={onThinkingChange} onModelSettings={onModelSettings} disabled={starting} />
                </>
              )}
              <span className="composer-spacer" />
              <button type="submit" className="agent-send" aria-label={isFollowup ? "进入随访" : "发送任务"} disabled={!config || starting || uploading || (isFollowup ? !selectedPatient : !config.modelConfigured || !prompt.trim() || (Boolean(patientId) && !data))} title={config && !isFollowup && !config.modelConfigured ? "需先连接模型" : undefined}>
                {starting ? <Loader2 size={17} className="spin"/> : isFollowup ? <ArrowRight size={17}/> : <ArrowUp size={17}/>}
                {starting ? "正在开始…" : isFollowup ? "进入随访" : "开始任务"}
              </button>
            </div>
          </form>
          <p className="hub-composer-hint">
            {taskType === "project"
              ? `将在「${availableProjects.find(p => p.id === projectId)?.title || "所选项目"}」中新建对话，使用同一文件夹；工具权限在任务中管理。`
              : attached
                ? `已附加 ${attachedCount} 份材料，将随本次任务一起发送。Enter 发送 · Shift + Enter 换行`
                : selectedPatient
                  ? `将沿用「${selectedPatient.name}」的病例材料直接发起任务，发送后仍可在右侧核对范围。Enter 发送 · Shift + Enter 换行`
                  : "Enter 发送 · Shift + Enter 换行"}
          </p>
          <section className="agent-starters" aria-label="常用任务">
            <div className="agent-starter-row">
              {starterFlows.length ? starterFlows.map((flow) => <button key={flow.id} aria-pressed={flowId === flow.id} disabled={starting || uploading} onClick={() => chooseFlow(flow)}>{flow.title}</button>)
                : [["timeline", "整理病历"], ["evidence", "准备循证检索"], ["patient-edu", "撰写患教材料"]].map(([id,label]) => <button key={id} aria-pressed={flowId === id} disabled={starting || uploading} onClick={() => chooseFlow(MEDICAL_WORKFLOWS.find(f => f.id === id))}>{label}</button>)}
              <button disabled={starting || uploading} onClick={() => { setFlowId(""); setPrompt("请分析我提供的数据，先检查字段、缺失值和数据质量，再根据研究问题建议统计方法，输出结果和适用条件。"); inputRef.current?.focus(); }}>分析数据</button>
              <button aria-expanded={showAllFlows} onClick={() => setShowAllFlows(!showAllFlows)}>{showAllFlows ? "收起模板" : "更多任务模板"}</button>
            </div>
            {showAllFlows && <div className="agent-template-library">
              <div className="hub-section-head"><h2>任务模板</h2><div className="hub-category">{[...(customFlows.length ? [["mine","我的模板"]] : []),["clinical","临床与患者"],["research","科研与循证"]].map(([id,label]) => <button key={id} aria-pressed={category === id} onClick={() => setCategory(id)}>{label}</button>)}</div></div>
              <p className="muted">选择后会填入任务要求，你可以修改再发送。</p>
              <div className="agent-template-grid">{allFlows.filter(f => f.category === category).map(flow => <button key={flow.id} disabled={starting || uploading} aria-pressed={flow.id === flowId} onClick={() => chooseFlow(flow)}><flow.icon size={18}/><span><b>{flow.title}</b><small>{flow.desc}</small></span></button>)}</div>
            </div>}
          </section>
          <HomeCockpit onView={onView} onPatient={onPatient} onOpenTask={onOpenTask} reloadKey={reloadKey} />
          <details className="workspace-optional"><summary>模板、连接与工作台设置</summary>
          {medicalEnabled(config) && <section className="hub-customize" aria-label="定制我的工作台">
            <div><b>模板与提醒规则</b><span>{customFlows.length ? `已保存 ${customFlows.length} 个模板。` : ""}填写医院模板或提醒要求，核对后保存。</span></div>
            <div className="hub-customize-actions">{CUSTOMIZE_EXAMPLES.slice(0, 3).map(([label, text]) => <button key={label} disabled={starting || uploading} onClick={() => { setFlowId(""); setPrompt(text); inputRef.current?.focus(); }}>{label}</button>)}
              <button className="text-button" onClick={() => { requestSettingsTab("workbench"); onView?.("settings"); }}>管理自动化规则<ArrowRight size={13} /></button></div>
          </section>}
          <BackupStatus onManage={() => {requestSettingsTab("backup");onView?.("settings");}} />
          {config && <SetupChecklist modelConfigured={Boolean(config.modelConfigured)} onModelSettings={onModelSettings} onView={onView} />}
          </details>
        </>
      ) : (
        <section className="hub-history">
          <h1>任务记录</h1>
          <label className="hub-history-search">
            <Search size={16} />
            <input
              aria-label="搜索任务记录"
              placeholder="搜索任务名称"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {taskList(tasks.length)}
        </section>
      )}
      <footer className="hub-footer">
        <span className="hub-status-dot" />
        对话与成果保存在任务记录中
      </footer>
    </main>
  );
}
