import { patientOptionLabel } from "./patient-labels";
import { DoctorAgenda } from "./doctor-agenda";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  AtSign,
  BookOpen,
  CalendarClock,
  CheckCheck,
  ClipboardList,
  FileHeart,
  FileText,
  Paperclip,
  ShieldCheck,
  FlaskConical,
  FolderOpen,
  History,
  Loader2,
  MessageSquare,
  Search,
  Stethoscope,
  UserPlus,
  X,
} from "lucide-react";
import { api, medicalEnabled } from "./agent-runtime";

export const MEDICAL_WORKFLOWS = [
  {
    id: "intake-full",
    title: "收治病例全流程",
    icon: ClipboardList,
    category: "clinical",
    desc: "时间线、检验摘录、用药核查、复核清单一次完成",
    output: "成套草稿 · 环环相扣待复核",
    prompt:
      "请对本次材料完成收治整理全流程，依次调用工具并保留原文出处：1) extract_clinical_timeline 生成时间线；2) extract_observations 摘录检验数值；3) 整理当前用药清单与过敏史，调用 medication_safety_check 做确定性核查；4) 用 make_review_checklist 生成需要医生逐项核对的清单。所有产物均为待复核草稿，材料缺失的信息标注「待补充」，不要推断诊断。",
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
    prompt:
      "请根据我口述或粘贴的就诊信息，生成一份结构化门诊病历草稿（主诉、现病史、既往史、查体、辅助检查、初步诊断意向、处理计划）。所有内容标注为待医生核对；材料中没有的信息明确写「待补充」，不要编造查体阳性发现或诊断。",
  },
  {
    id: "med-safety",
    title: "用药安全核查",
    icon: ShieldCheck,
    category: "clinical",
    desc: "整理已记录用药、过敏史和需要进一步核对的事项",
    output: "用药安全提示清单 · 内置规则（非穷尽）",
    prompt:
      "请从材料中提取当前用药清单和过敏史，调用 medication_safety_check 工具做确定性核查（过敏匹配、相互作用、重复用药），把工具结果整理成安全提示清单。内置规则集非穷尽，结果为提示性草稿，需药师或医生复核。",
  },
  {
    id: "patient-edu",
    title: "患教大白话",
    icon: MessageSquare,
    category: "clinical",
    desc: "把诊疗方案或说明书转成患者能懂的语言",
    output: "患教材料草稿 · 通俗解释",
    prompt:
      "请把材料中的诊疗方案/用药说明改写为患者能看懂的患教材料：避免专业术语、用类比解释、仅复述来源已有的用药时间与就医提示，缺失项列为待医生补充，不自行生成剂量、时间表或诊療计划。结尾注明「本材料为医生生成的参考，具体遵医嘱」。",
  },
  {
    id: "lab-read",
    title: "检验报告解读",
    icon: FlaskConical,
    category: "clinical",
    desc: "对照报告内参考范围，标记异常项并生成解读草稿",
    output: "异常项清单 · 解读草稿（待复核）",
    prompt:
      "请提取检验报告中的项目、结果、单位和报告内打印的参考范围，标记超出参考范围的项目，并逐项生成通俗解读草稿。只使用报告内信息，不引入外部判断；结论标注为待医生结合临床复核。",
  },
  {
    id: "discharge-summary",
    title: "出院小结草稿",
    icon: FileText,
    category: "clinical",
    desc: "按出院小结结构整理住院经过、出院诊断与随访医嘱",
    output: "出院小结草稿 · 待医生签署",
    prompt:
      "请根据本次住院材料生成出院小结草稿，结构为：入院日期/出院日期（缺失标待补充）、入院诊断、出院诊断、住院经过摘要（调用 extract_clinical_timeline 提取关键节点）、出院时情况、出院带药（含用法，调用用药清单整理并做 medication_safety_check 核查）、出院注意事项与随访计划（复诊时间、复查项目）。全部为待医生核对签署的草稿，缺失信息标「待补充」。",
  },
  {
    id: "handoff",
    title: "值班交班记录",
    icon: CalendarClock,
    category: "clinical",
    desc: "接班医生视角的患者要点与夜间注意清单",
    output: "交班要点 · 夜间观察清单",
    prompt:
      "请把材料整理为值班交班记录草稿：患者一览（床号/姓名/诊断，缺失标待补充）、目前问题清单（按优先级）、近 24 小时关键事件（调用 extract_clinical_timeline 与 extract_observations）、当前用药与需关注的相互作用（调用 medication_safety_check）、夜间需要重点观察的项目与预警信号、危急值与处理预案。面向接班医生，简洁条目化。",
  },
  {
    id: "decision-flow",
    title: "诊疗决策流程图",
    icon: ClipboardList,
    category: "clinical",
    desc: "从指南库提炼决策路径，生成可追溯出处的流程图",
    output: "mermaid 决策流程图 · 节点出处对照",
    prompt:
      "请针对指定病种生成诊疗决策流程图：先用 knowledge_search 检索诊断标准、分级与治疗决策条件并用 knowledge_read 核对原文，然后按 clinical-decision-flow 技能输出 mermaid 流程图与节点出处对照表。指南库未覆盖的分支标注「需补充来源」，不得凭记忆编造路径。",
  },
  {
    id: "adr-screen",
    title: "不良反应筛查",
    icon: ShieldCheck,
    category: "clinical",
    desc: "用药与表现匹配可疑药物反应，附 Naranjo 因果评估",
    output: "可疑反应清单 · 因果评估建议",
    prompt:
      "请从材料整理当前用药清单和可疑临床表现，调用 assess_adverse_reaction 做不良反应匹配筛查；对每条疑似关联，建议医生用 medical_scale_calculate（scaleId=naranjo）完成 Naranjo 因果评估。结果为提示性筛查，不构成因果判定，需结合用药时间线核实。",
  },
  {
    id: "case-report",
    title: "个案报告写作",
    icon: FileText,
    category: "research",
    desc: "按 CARE 框架从病例材料生成个案报告草稿",
    output: "个案报告草稿 · 结构化段落",
    prompt:
      "请基于病例材料（或病例库中引用的病例）按 CARE 框架生成个案报告草稿：标题建议、摘要（背景/病例要点/结论）、引言、病例资料（主诉/现病史/查体/辅助检查/诊疗经过，调用 extract_clinical_timeline 与 extract_observations 并保留出处）、讨论要点（提示可结合文献检索补充证据）、结论。全部为草稿，患者信息需脱敏，发表前需按目标期刊要求核对。",
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

export function WorkbenchHome({
  view,
  config,
  sessions,
  onStart,
  onOpenTask,
  onPatient,
  onView,
  onRefresh,
  onReconnect,
  onOpenProjects,
  accessMode,
  onAccessModeChange,
  thinking,
  onThinkingChange,
  consent,
  onConsentChange,
  onModelSettings,
  onAttach,
  uploading,
  attachedCount = 0,
  fileInputRef,
  onFilesPicked,
}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("clinical");
  const [showAgenda, setShowAgenda] = useState(false);
  const [showAllFlows, setShowAllFlows] = useState(false);
  const [runtimeOptions, setRuntimeOptions] = useState(false);
  const [taskType, setTaskType] = useState("medical");
  const [flowId, setFlowId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [patientId, setPatientId] = useState("");
  const [starting, setStarting] = useState(false);
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [skillMention, setSkillMention] = useState(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pickedSkills, setPickedSkills] = useState([]);
  const inputRef = useRef(null);
  const selectedFlow = MEDICAL_WORKFLOWS.find((flow) => flow.id === flowId);
  const isFollowup = flowId === "followup";
  const isHome = view === "home";
  const skillOptions = config?.skills || [];
  const mentionMatches = skillMention
    ? skillOptions
        .filter(
          (skill) =>
            !pickedSkills.includes(skill.id) &&
            `${skill.name} ${skill.id} ${skill.description || ""}`
              .toLowerCase()
              .includes(skillMention.query.toLowerCase()),
        )
        .slice(0, 8)
    : [];
  // 材料已附加后，本次任务的目标会话已定，锁定类型与患者切换
  const attached = attachedCount > 0;
  const consentRequired =
    Boolean(config?.modelConfigured) && accessMode === "each";
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
  const reviewCount = sessions.reduce((sum, task) => sum + task.reviewCount, 0);
  const tasks = sessions.filter(
    (task) =>
      (view !== "review" || task.reviewCount > 0) &&
      task.title.toLowerCase().includes(query.toLowerCase()),
  );
  const chooseFlow = (flow) => {
    setTaskType("medical");
    setFlowId(flow.id);
    setPrompt(flow.prompt);
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
    if (starting) return;
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
    if (taskType === "project") {
      // 项目任务进入融合后的工作区视图，与临床任务同一套外壳。
      onOpenProjects({ prompt: prompt.trim() });
      return;
    }
    if (!prompt.trim()) return;
    setStarting(true);
    try {
      await onStart({
        prompt: prompt.trim(),
        patient: selectedPatient,
        title: selectedFlow?.title || prompt.trim().slice(0, 32),
        skills: pickedSkills,
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
              tab: view === "review" ? "results" : "materials",
            })
          }
        >
          <span className="hub-task-icon">
            {view === "review" ? (
              <CheckCheck size={18} />
            ) : (
              <MessageSquare size={18} />
            )}
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
            className={`hub-task-state ${task.reviewCount ? "pending" : ""}`}
          >
            {task.running
              ? "执行中"
              : task.reviewCount
                ? `${task.reviewCount} 份待复核`
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
              : view === "review"
                ? "目前没有待复核的成果"
                : "你的第一项医疗任务，从这里开始"}
          </b>
          <p>
            {query
              ? "尝试其他关键词。"
              : view === "review"
                ? "生成的草稿会汇集到这里，核对原文后再记录复核结果。"
                : "选择上方场景，或直接描述需要整理的材料。"}
          </p>
        </div>
      )}
    </div>
  );
  return (
    <main id="main" className="workbench-hub">
      <div className="hub-page-head">
        <span>
          {isHome
            ? "个人工作空间"
            : view === "review"
              ? "成果 / 待复核"
              : "工作空间 / 任务记录"}
        </span>
        <span>
          {new Date().toLocaleDateString("zh-CN", {
            month: "long",
            day: "numeric",
            weekday: "long",
          })}
        </span>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}{" "}
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
        </p>
      )}
      {isHome ? (
        <>
          <nav className="hub-start-nav" aria-label="工作入口">
            <button className="text-button" onClick={() => setShowAgenda(!showAgenda)}>
              {showAgenda ? "返回新建任务" : "今日待办"}<ArrowRight size={14} />
            </button>
            <button className="text-button" onClick={() => onView("tasks")}>任务记录<History size={14} /></button>
          </nav>
          {showAgenda ? <DoctorAgenda onPatient={onPatient} onOpenTask={onOpenTask} onView={onView} /> : <>
          <section className="hub-intro hub-intro-compact">
            <h1>这次需要做什么？</h1>
            <p>直接描述需求，或添加材料开始。患者相关任务可关联档案。</p>
          </section>
          <form className="hub-composer" onSubmit={submit}>
            <div className="hub-composer-caption">
              <span>{selectedFlow ? selectedFlow.title : "开始一项任务"}</span>
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
                aria-label="医疗任务内容"
                placeholder={taskType === "project" ? "例如：整理文件夹中的资料，制作一份带来源的报告…" : "例如：整理这位患者的复诊材料，列出近期变化和待核对问题…"}
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
                maxLength={12000}
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
                        <b>{skill.name}</b>
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
                      {skill?.name || id}
                      <button
                        type="button"
                        aria-label={`移除技能 ${skill?.name || id}`}
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
              <div
                className="hub-task-type"
                role="tablist"
                aria-label="任务类型"
              >
                <button
                  type="button"
                  aria-pressed={taskType === "medical"}
                  className={taskType === "medical" ? "active" : ""}
                  title="患者与临床场景：可用医疗工具（整理病历/随访/知识库/文献等），产出走草稿复核"
                  onClick={() => setTaskType("medical")}
                  disabled={attached}
                >
                  临床任务
                </button>
                <button
                  type="button"
                  aria-pressed={taskType === "project"}
                  className={taskType === "project" ? "active" : ""}
                  title="通用 Agent 工作区：本地文件夹、终端、Git 等，适合写代码、整理文档等非患者任务"
                  onClick={() => { setTaskType("project"); setFlowId(""); setSkillMention(null); setPickedSkills([]); }}
                  disabled={attached}
                >
                  通用任务
                </button>
              </div>
              {taskType === "medical" && (
                <label className="hub-patient-picker">
                  <Stethoscope size={15} />
                  <select
                    aria-label="任务关联患者"
                    value={patientId}
                    onChange={(e) => setPatientId(e.target.value)}
                    disabled={!data || starting || attached}
                  >
                    <option value="">
                      {isFollowup ? "请选择患者" : "独立任务 · 不关联患者"}
                    </option>
                    {patients.map((patient) => (
                      <option key={patient.id} value={patient.id}>
                        {patientOptionLabel(patient, patients)}
                        {patient.archived ? "（已归档）" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {taskType === "medical" && (
                <button
                  type="button"
                  className="hub-add-patient"
                  onClick={() => onPatient({ create: true })}
                  disabled={attached}
                >
                  <UserPlus size={15} />
                  上传资料建档
                </button>
              )}
              {taskType === "medical" && !isFollowup && (
                <>
                  <button
                    type="button"
                    className="attach-button"
                    title="添加图片、PDF、Word、Excel、TXT、Markdown、CSV 或 JSON，随本次任务一起发送"
                    onClick={() => onAttach(selectedPatient?.sessionId)}
                    disabled={uploading || !config}
                  >
                    <Paperclip size={16} />
                    {uploading ? "导入中…" : "附件"}
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
                  <button type="button" className="attach-button" aria-expanded={runtimeOptions} onClick={() => setRuntimeOptions(!runtimeOptions)}>运行选项</button>
                  {runtimeOptions && <><span className="tb-divider" />
                  <label
                    className="tb-item"
                    title="访问权限：逐次确认=每轮发送前勾选外发；会话自动=本会话内外发免勾选"
                  >
                    权限
                    <select
                      value={accessMode}
                      onChange={(e) => onAccessModeChange(e.target.value)}
                      disabled={starting}
                    >
                      <option value="each">逐次确认</option>
                      <option value="auto">会话自动</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="tb-item"
                    title={`当前模型：${config?.model || "未配置"}；点击切换或配置模型`}
                    onClick={onModelSettings}
                  >
                    模型 <b>{config?.model || "未配置"}</b>
                  </button>
                  {config?.modelConfigured && (
                    <label
                      className="tb-item"
                      title="深入：请求模型启用思考/推理通道（取决于供应商支持；标准=关闭）"
                    >
                      思考
                      <select
                        value={thinking}
                        onChange={(e) => onThinkingChange(e.target.value)}
                        disabled={starting}
                      >
                        <option value="disabled">标准</option>
                        <option value="enabled">深入</option>
                      </select>
                    </label>
                  )}</>}
                </>
              )}
              {taskType === "medical" && !isFollowup && attached && (
                <span className="hub-attach-count">
                  已附 {attachedCount} 份材料
                </span>
              )}
              <span className="composer-spacer" />
              {consentRequired && taskType === "medical" && !isFollowup && (
                <label className="tb-check">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => onConsentChange(e.target.checked)}
                    disabled={starting}
                  />
                  本轮允许外发
                </label>
              )}
              {isFollowup || taskType === "project" ? (
                <button
                  className="hub-start"
                  disabled={
                    !config ||
                    starting ||
                    (taskType === "project" ? false : !selectedPatient)
                  }
                >
                  {starting ? (
                    <Loader2 size={16} className="spin" />
                  ) : taskType === "project" ? (
                    "发送并打开工作区"
                  ) : (
                    "进入随访"
                  )}
                  <ArrowRight size={16} />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  aria-label="发送任务"
                  disabled={
                    !config ||
                    starting ||
                    !prompt.trim() ||
                    (consentRequired && !consent)
                  }
                >
                  {starting ? (
                    <Loader2 size={16} className="spin" />
                  ) : (
                    <ArrowUp size={19} />
                  )}
                </button>
              )}
            </div>
          </form>
          <p className="hub-composer-hint">
            {taskType === "project"
              ? "通用任务可处理文件、表格、代码与浏览器工作。进入工作区后选择目录与工具权限。"
              : attached
                ? `已附加 ${attachedCount} 份材料，将随本次任务一起发送。Enter 发送 · Shift + Enter 换行`
                : selectedPatient
                  ? `将沿用「${selectedPatient.name}」的病例材料直接发起任务，发送后仍可在右侧核对范围。Enter 发送 · Shift + Enter 换行`
                  : "临床任务围绕患者与诊疗材料，AI 产出均为待你复核的草稿。Enter 发送 · Shift + Enter 换行"}
          </p>
          <section className={`hub-scenarios ${showAllFlows || category !== "clinical" ? "" : "hub-scenarios-compact"}`} aria-label="医疗工作场景">
            <div className="hub-section-head">
              <h2>常用场景</h2>
              <div className="hub-category" aria-label="场景分类">
                <button
                  aria-pressed={category === "clinical"}
                  className={category === "clinical" ? "active" : ""}
                  onClick={() => { setCategory("clinical"); setShowAllFlows(false); }}
                >
                  临床与患者
                </button>
                <button
                  aria-pressed={category === "research"}
                  className={category === "research" ? "active" : ""}
                  onClick={() => { setCategory("research"); setShowAllFlows(false); }}
                >
                  循证准备
                </button>
              </div>
            </div>
            <div className="hub-scene-grid">
              {MEDICAL_WORKFLOWS.filter(
                (flow) => flow.category === category && (showAllFlows || category !== "clinical" || ["timeline", "record-draft", "med-safety", "lab-read", "patient-edu", "followup"].includes(flow.id)),
              ).map((flow) => (
                <button
                  key={flow.id}
                  className={`hub-scene ${flow.id === flowId ? "selected" : ""}`}
                  title={flow.desc}
                  aria-pressed={flow.id === flowId}
                  onClick={() => chooseFlow(flow)}
                >
                  <span className="hub-scene-icon">
                    <flow.icon size={20} />
                  </span>
                  <b>{flow.title}</b>
                  <p>{flow.desc}</p>
                  <small>
                    {flow.output}
                    <ArrowUpRight size={14} />
                  </small>
                </button>
              ))}
            </div>
            {category === "clinical" && <button className="text-button hub-more-flows" onClick={() => setShowAllFlows(!showAllFlows)}>{showAllFlows ? "收起更多场景" : "更多场景"}</button>}
          </section>
          </>}
        </>
      ) : (
        <section className="hub-history">
          <span className="hub-kicker">
            {view === "review"
              ? "每一份成果，都经过你的判断"
              : "材料、过程与成果，一起保留"}
          </span>
          <h1>{view === "review" ? "待复核" : "任务记录"}</h1>
          <p>
            {view === "review"
              ? `${reviewCount} 份草稿待复核。进入工作区，对照来源、修订内容并记录复核结果。`
              : "继续处理已有任务，患者相关任务始终沿用各自的病例工作区。"}
          </p>
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
        本机保存 <span>·</span> AI 成果待复核 <span>·</span> 外部模型按次授权
      </footer>
    </main>
  );
}
