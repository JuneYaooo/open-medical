import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarClock,
  CheckCheck,
  ClipboardList,
  FileHeart,
  FileText,
  ShieldCheck,
  FlaskConical,
  FolderOpen,
  AlertTriangle,
  History,
  Loader2,
  MessageSquare,
  Search,
  Stethoscope,
  UserPlus,
} from "lucide-react";
import { api } from "./agent-runtime";

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
    desc: "配伍禁忌、相互作用、过敏与重复用药提示",
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
      "请把材料中的诊疗方案/用药说明改写为患者能看懂的患教材料：避免专业术语、用类比解释、列出用药时间表和需要立即就医的警示信号。结尾注明「本材料为医生生成的参考，具体遵医嘱」。",
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
      "请针对指定病种生成诊疗决策流程图：先用 guideline_search 检索诊断标准、分级与治疗决策条件并用 guideline_read 核对原文，然后按 clinical-decision-flow 技能输出 mermaid 流程图与节点出处对照表。指南库未覆盖的分支标注「需补充来源」，不得凭记忆编造路径。",
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
}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("clinical");
  const [flowId, setFlowId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [patientId, setPatientId] = useState("");
  const [starting, setStarting] = useState(false);
  const [risksOpen, setRisksOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const inputRef = useRef(null);
  const selectedFlow = MEDICAL_WORKFLOWS.find((flow) => flow.id === flowId);
  const isFollowup = flowId === "followup";
  const isHome = view === "home";
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const [people, todo, inbox, risks] = await Promise.all([
          api("/api/patients"),
          api("/api/reminders"),
          api("/api/inbox"),
          api("/api/risk-alerts"),
        ]);
        if (live) {
          setData({
            patients: people.patients,
            reminders: todo.reminders,
            inbox: inbox.messages,
            risks,
          });
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
  const followupCount = patients.reduce(
    (sum, patient) => sum + (patient.counts?.dueFollowups || 0),
    0,
  );
  const tasks = sessions.filter(
    (task) =>
      (view !== "review" || task.reviewCount > 0) &&
      task.title.toLowerCase().includes(query.toLowerCase()),
  );
  const chooseFlow = (flow) => {
    setFlowId(flow.id);
    setPrompt(flow.prompt);
    inputRef.current?.focus();
  };
  const submit = async (e) => {
    e.preventDefault();
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
    if (!prompt.trim()) return;
    setStarting(true);
    try {
      await onStart({
        prompt: prompt.trim(),
        patient: selectedPatient,
        title: selectedFlow?.title || prompt.trim().slice(0, 32),
      });
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
          <section className="hub-intro">
            <div className="hub-intro-mark">
              <Stethoscope size={25} />
            </div>
            <span className="hub-kicker">你的医疗工作伙伴</span>
            <h1>今天，想完成什么工作？</h1>
            <p>从病历到随访，让每一份材料都有去处。</p>
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
                placeholder="例如：把这位患者的就诊记录整理成时间线，标出需要补充的信息…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                maxLength={12000}
              />
            )}
            <div className="hub-composer-controls">
              <label className="hub-patient-picker">
                <Stethoscope size={15} />
                <select
                  aria-label="任务关联患者"
                  value={patientId}
                  onChange={(e) => setPatientId(e.target.value)}
                  disabled={!data || starting}
                >
                  <option value="">
                    {isFollowup ? "请选择患者" : "独立任务 · 不关联患者"}
                  </option>
                  {patients.map((patient) => (
                    <option key={patient.id} value={patient.id}>
                      {patient.name}
                      {patient.archived ? "（已归档）" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="hub-add-patient"
                onClick={() => onPatient({ create: true })}
              >
                <UserPlus size={15} />
                建档
              </button>
              <button
                className="hub-start"
                disabled={
                  !config ||
                  starting ||
                  (isFollowup ? !selectedPatient : !prompt.trim())
                }
              >
                {starting ? (
                  <Loader2 size={16} className="spin" />
                ) : isFollowup ? (
                  "进入随访"
                ) : (
                  "准备任务"
                )}
                <ArrowRight size={16} />
              </button>
            </div>
          </form>
          <p className="hub-composer-hint">
            {selectedPatient
              ? `沿用「${selectedPatient.name}」的病例材料，进入后可核对本次范围。`
              : "先准备任务，再添加材料；生成结果后由你复核。"}
          </p>
          <section className="hub-scenarios" aria-label="医疗工作场景">
            <div className="hub-section-head">
              <h2>从常用场景开始</h2>
              <div className="hub-category" aria-label="场景分类">
                <button
                  aria-pressed={category === "clinical"}
                  className={category === "clinical" ? "active" : ""}
                  onClick={() => setCategory("clinical")}
                >
                  临床与患者
                </button>
                <button
                  aria-pressed={category === "research"}
                  className={category === "research" ? "active" : ""}
                  onClick={() => setCategory("research")}
                >
                  循证准备
                </button>
              </div>
            </div>
            <div className="hub-scene-grid">
              {MEDICAL_WORKFLOWS.filter(
                (flow) => flow.category === category,
              ).map((flow) => (
                <button
                  key={flow.id}
                  className={`hub-scene ${flow.id === flowId ? "selected" : ""}`}
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
          </section>
          <section className="hub-attention" aria-label="需要关注">
            <button onClick={() => onView("review")}>
              <CheckCheck size={18} />
              <span>待复核成果</span>
              <b>{reviewCount}</b>
              <ArrowRight size={14} />
            </button>
            <button onClick={() => onPatient({})}>
              <CalendarClock size={18} />
              <span>到期随访</span>
              <b>{data ? followupCount : "—"}</b>
              <ArrowRight size={14} />
            </button>
            <button onClick={() => onPatient({})}>
              <FileText size={18} />
              <span>待办提醒</span>
              <b>{data ? data.reminders.length : "—"}</b>
              <ArrowRight size={14} />
            </button>
            <button onClick={() => setRisksOpen((value) => !value)}>
              <AlertTriangle size={18} />
              <span>风险提醒</span>
              <b className={data?.risks?.counts?.critical ? "risk-critical" : ""}>
                {data ? data.risks.counts.active : "—"}
              </b>
              <ArrowRight size={14} />
            </button>
          </section>
          {risksOpen && data?.risks?.alerts?.length > 0 && (
            <section className="hub-risk-list" aria-label="活跃风险提醒">
              {data.risks.alerts.slice(0, 6).map((alert) => (
                <div className={`hub-risk risk-${alert.severity}`} key={alert.id}>
                  <div className="hub-risk-main">
                    <b>{alert.patientName}</b> · {alert.title}
                    <small>{alert.message}</small>
                  </div>
                  <div className="hub-risk-actions">
                    {alert.patientId && (
                      <button
                        className="text-button"
                        onClick={() => onPatient({ id: alert.patientId })}
                      >
                        打开患者
                      </button>
                    )}
                    <button
                      className="text-button"
                      onClick={async () => {
                        await api(`/api/risk-alerts/${alert.id}/ack`, "POST", {});
                        onRefresh().catch(() => {});
                      }}
                    >
                      确认
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}
          <section className="hub-recent">
            <div className="hub-section-head">
              <h2>继续最近的工作</h2>
              <button className="text-button" onClick={() => onView("tasks")}>
                查看全部 <ArrowRight size={13} />
              </button>
            </div>
            {taskList(4)}
          </section>
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
