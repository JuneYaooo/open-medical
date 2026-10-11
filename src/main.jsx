import { DoctorAgenda } from "./doctor-agenda";
import { CareInbox } from "./care-inbox";
import { PendingTray, PENDING_REFRESH_EVENT } from "./pending-tray";
import { AppSettingsView } from "./app-settings";
import { readLocation, writeLocation, VIEW_LABELS } from "./navigation";
import { conversationRunIds } from "../shared/patient-conversations.mjs";
import { PatientConversationNav } from "./patient-conversation-nav";
import { TaskResult, hasTaskResult } from "./task-result";
import { SimilarCases } from "./similar-cases";
import { ProjectDirectory, ToolDirectory, TaskDirectory } from "./work-directory";
import { IntakeBackground } from "./intake-background";
import { MaterialDetails } from "./material-details";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowUp,
  Bot,
  BookOpen,
  ChevronRight,
  ClipboardList,
  Download,
  Copy,
  FileText,
  FolderOpen,
  History,
  Loader2,
  Menu,
  MessageSquare,
  Paperclip,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Stethoscope,
  Trash2,
  X,
  AlertCircle,
  ExternalLink,
  PencilLine,
  CalendarClock,
  AtSign,
  Inbox,
} from "lucide-react";
import {
  api,
  bootstrap,
  streamTurn,
  downloadSession,
  medicalEnabled,
} from "./agent-runtime";
import { artifactLines, artifactTitle, INTENTS } from "../shared/medical.mjs";
import "./style.css";
import "./business-layout.css";
import "./v6-layout.css";
import "./agent-experience.css";
import { importMaterial, uploadScannedPages } from "./import-material";
import { TaskCenter } from "./task-center";
import { PatientsView } from "./patients";
import { WorkspacesView } from "./workspaces";
import { WorkbenchHome } from "./workbench-home";
import { RichMessage } from "./workbench/message";
import { RunStatusNotice, OutcomeCard } from "./workbench/run-status-view";
import { consultationLookupIssue } from "./workbench/run-status";
import { blockedText, runDerivedStatus } from "./workbench/run-status";
import { DoctorProfilePanel } from "./doctor-profile";
import { LiteratureView } from "./literature";
import { KnowledgeLibraries } from "./knowledge-libraries";
import { FollowupsView } from "./followups";
import { CasesView } from "./cases";
import { ResearchView } from "./research";
import { TrialScreeningView } from "./trial-screening";
import { DrgView } from "./drg";
import { ClinicalRefView } from "./clinical-ref";
import { IconButton, Badge, Modal, STATUS } from "./components";
import { ModelSettings } from "./model-settings";
import {
  AcceptanceView,
  MemoryNote,
  PatientSummaryCard,
  StepsFlow,
  modeToRequest,
} from "./ui";
const WORKFLOWS = [
  {
    id: "observations",
    title: "检验数值摘录",
    icon: Activity,
    desc: "保留检验单位和原始出处",
    prompt: "请摘录本次材料的检验数值，保留单位和原始出处，不进行异常判断。",
  },
  {
    id: "timeline",
    title: "病历时间线",
    icon: History,
    desc: "按原文日期整理就诊事件",
    prompt: "请将本次材料整理为病历时间线，保留原文来源和待确认信息。",
  },
  {
    id: "medication",
    title: "用药信息复核",
    icon: ClipboardList,
    desc: "核对缺失字段与复核事项",
    prompt: "请整理这份用药材料，列出需要专业人员核对的信息和缺失字段。",
  },
  {
    id: "evidence",
    title: "循证任务",
    icon: BookOpen,
    desc: "构建 PICO 与检索计划",
    prompt: "请根据材料建立循证检索任务，整理 PICO、检索式与证据核查步骤。",
  },
];
// 顶栏三条用量指示器（上下文占用/累计 token/检索命中）的数据源：
// 字符数与会话持久化 token 从会话对象汇总，检索命中由 SSE 事件实时累计。
const RETRIEVAL_TOOL = /search|retrieve|literature|similar_case|knowledge/i;
const metersFromSession = (s) => {
  const chars = (s?.messages || []).reduce(
    (n, m) => n + (m.content || "").length,
    0,
  );
  let tokens = 0;
  let rounds = 0;
  for (const run of s?.runs || []) {
    tokens += run.usage?.total_tokens || 0;
    rounds += run.usage?.rounds || 0;
  }
  return { chars, tokens, rounds };
};
// Codex 式相对时间标签:分钟/小时/天/周,给侧栏最近对话列表用。
const agoLabel = (value) => {
  if (!value) return "";
  const s = (Date.now() - new Date(value)) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "分钟";
  if (s < 86400) return Math.round(s / 3600) + "小时";
  if (s < 604800) return Math.round(s / 86400) + "天";
  return Math.round(s / 604800) + "周";
};
const eventLabel = (event) =>
  ({
    "policy.evaluated": `识别任务：${INTENTS[event.payload?.intent] || "资料整理"}`,
    "tool.start": `调用 ${event.payload?.tool}`,
    "tool.complete": `工具完成：${event.payload?.tool}`,
    "tool.failed": event.payload?.error,
    "message.start": "开始执行",
    "message.delta": "正在生成草稿",
    "message.complete": "草稿已保存",
    error: event.payload?.error,
    "run.cancelled": "已停止并保留部分内容",
    "sandbox.started": "开始隔离计算",
    "sandbox.completed": "隔离计算完成",
    "sandbox.failed": event.payload?.error,
    "context.compacting": "正在整理长输入或压缩历史，原文会保留",
    "context.compaction_skipped": "完整上下文仍在预算内，继续处理",
    "context.compacted": `${event.payload?.inputChunks ? `长输入已分 ${event.payload.inputChunks} 片整理` : "历史已压缩"}${
      event.payload?.beforeChars
        ? `（${event.payload.beforeChars} → ${event.payload.afterChars} 字符，原文可按 archiveId 读回）`
        : ""
    }`,
    "subagent.queued": `${event.payload?.child?.name}等待执行`,
    "subagent.started": `${event.payload?.child?.name}开始执行`,
    "subagent.tool": `${event.payload?.child?.name}调用 ${event.payload?.tool}`,
    "subagent.completed": `${event.payload?.child?.name}已完成`,
    "subagent.failed": `${event.payload?.child?.name}失败：${event.payload?.child?.error}`,
    "subagent.cancelled": `${event.payload?.child?.name}已取消`,
    "status.update":
      {
        model_running: "模型处理中",
        retrying: "服务暂忙，正在重试",
      }[event.payload?.status] || event.payload?.status,
  })[event.type] || event.type;
function ArtifactView({ artifact, onReview, onEdit, onSource, onOpen }) {
  const [review, setReview] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setReview(false);
    setEditing(false);
    setError("");
  }, [artifact?.id]);
  if (!artifact)
    return (
      <div className="panel-empty">
        <ClipboardList />
        <h3>产物会留在这里</h3>
        <p>上传材料并发起任务后，查看结构化草稿、原文来源和复核状态。</p>
      </div>
    );
  const save = async (e, action) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await action(new FormData(e.currentTarget));
      setReview(false);
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="artifact-detail">
      <div className="artifact-heading">
        <Badge status={artifact.status} />
        <span>版本 {artifact.version}</span>
        <IconButton
          title="编辑产物"
          onClick={() => {
            setEditing(!editing);
            setReview(false);
          }}
        >
          <PencilLine size={14} />
        </IconButton>
      </div>
      <h3>{artifactTitle(artifact) || "未命名结果"}</h3>
      <p className="muted">
        {artifact.provenance === "local_rule" ? "本地规则整理" : "待核查草稿"} ·{" "}
        {artifact.createdAt
          ? new Date(artifact.createdAt).toLocaleString("zh-CN")
          : "时间未记录"}
      </p>
      {artifact.events?.length > 0 && (
        <ol className="timeline">
          {artifact.events.map((event, i) => (
            <li key={i}>
              <time>{event.date}</time>
              <p>{event.event}</p>
              {event.correctionNote && (
                <p className="correction-note">
                  修订依据：{event.correctionNote}
                </p>
              )}
              <button
                className="source-link"
                onClick={() => onSource(event.source)}
              >
                {event.source.sourceName}
                {event.source.page ? ` · P${event.source.page}` : ""} · L
                {event.source.line}
                <ChevronRight size={12} />
              </button>
              {event.ambiguousDates && (
                <small className="error-text">
                  同一行包含多个日期，当前按首个日期索引，请核对事件归属。
                </small>
              )}
              {!event.dateValid && (
                <span className="error-text">日期需要修正</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {artifact.pico && (
        <>
          <dl className="pico">
            {Object.entries(artifact.pico).map(([key, value]) => (
              <div key={key}>
                <dt>
                  {
                    {
                      population: "P · 人群",
                      intervention: "I · 干预",
                      comparison: "C · 对照",
                      outcome: "O · 结局",
                    }[key]
                  }
                </dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="field-label">检索式草稿</p>
          <code className="query">{artifact.query || "请先补全 PICO"}</code>
          {artifact.searchUrl && (
            <a
              className="external-link"
              href={artifact.searchUrl}
              target="_blank"
              rel="noreferrer"
            >
              在 PubMed 中检索
              <ExternalLink size={13} />
            </a>
          )}
          <p className="muted">尚未检索或评估外部文献。</p>
        </>
      )}
      {artifact.type !== "similar_cases" && artifact.matches?.map((match, i) => (
        <blockquote key={i}>
          <p>{match.quote}</p>
          {/^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/$/.test(match.url || "") ?
            <a className="source-link" href={match.url} target="_blank" rel="noreferrer">{match.sourceName} · PubMed</a> :
            artifact.type === "similar_cases" ? <span>{match.sourceName} · 本地记录</span> :
            <button className="source-link" onClick={() => onSource(match)}>{match.sourceName}{match.line ? ` · L${match.line}` : ""}</button>}
          {match.scope && <small>{match.scope}</small>}
          {match.evidence?.text && <details><summary>查看检索时保存的{match.evidence.type === "abstract" ? "摘要" : "记录"}</summary><p>{match.evidence.text}</p></details>}

        </blockquote>
      ))}
      {artifact.observations?.map((observation, i) => (
        <div className="observation" key={i}>
          <b>{observation.name}</b>
          <strong>
            {observation.value} <small>{observation.unit}</small>
          </strong>
          <button
            className="source-link"
            onClick={() => onSource(observation.source)}
          >
            {observation.source.sourceName}
            {observation.source.page ? ` · P${observation.source.page}` : ""} ·
            L{observation.source.line}
          </button>
          <span>未进行临床解释</span>
        </div>
      ))}
      {artifact.type === "similar_cases" && <SimilarCases key={artifact.id} artifact={artifact} variant="teaser" onOpen={onOpen} />}
      {(artifact.concerns || (!artifact.events &&
        !artifact.pico &&
        !artifact.matches &&
        !artifact.observations)) && (
          <ul className="checklist">
            {artifactLines(artifact).map((line, i) => (
              <li key={i}>
                <span>□</span>
                {line}
              </li>
            ))}
          </ul>
        )}
      {artifact.missing?.length > 0 && (
        <div className="missing">
          <b>待补充信息</b>
          <ul>
            {artifact.missing.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {artifact.matches && artifact.checks?.length > 0 && (
        <ul className="checklist">
          {artifact.checks.map((x) => (
            <li key={x}>□ {x}</li>
          ))}
        </ul>
      )}
      {artifact.type !== "similar_cases" && artifact.limitations?.map((x) => (
        <p className="boundary" key={x}>
          {x}
        </p>
      ))}
      {artifact.type !== "similar_cases" && artifact.review && (
        <div className="review-note">
          <b>复核记录 · {artifact.review.reviewer}</b>
          <p>{artifact.review.note}</p>
          <small>{artifact.review.at}（本地使用者声明）</small>
        </div>
      )}
      {artifact.history?.length > 0 && (
        <details className="artifact-history">
          <summary>查看 {artifact.history.length} 次修订记录</summary>
          {artifact.history.map((h) => (
            <div key={h.version}>
              <b>
                版本 {h.version} · {STATUS[h.status]}
              </b>
              <p>{h.title}</p>
              {h.events?.map((e, i) => (
                <p key={i}>
                  {e.date} · {e.event}
                </p>
              ))}
              {h.review && (
                <small>
                  复核：{h.review.reviewer} · {h.review.note}
                </small>
              )}
            </div>
          ))}
        </details>
      )}
      {editing && (
        <form
          className="inline-form"
          onSubmit={(e) =>
            save(e, (f) =>
              onEdit({
                title: f.get("title"),
                events: artifact.events?.map((event, i) => ({
                  date: f.get(`date-${i}`),
                  event: f.get(`event-${i}`),
                  correctionNote: f.get(`note-${i}`),
                })),
                items: artifact.items
                  ? f
                      .get("items")
                      .split("\n")
                      .map((v) => v.trim())
                      .filter(Boolean)
                  : undefined,
                pico: artifact.pico
                  ? Object.fromEntries(
                      [
                        "population",
                        "intervention",
                        "comparison",
                        "outcome",
                      ].map((k) => [k, f.get(k)]),
                    )
                  : undefined,
                version: artifact.version,
              }),
            )
          }
        >
          <label>
            产物标题
            <input name="title" required defaultValue={artifact.title} />
          </label>
          {artifact.events?.map((event, i) => (
            <fieldset className="event-editor" key={i}>
              <legend>
                事件 {i + 1} · {event.source.sourceName} L{event.source.line}
              </legend>
              <label>
                日期
                <input name={`date-${i}`} defaultValue={event.date} required />
              </label>
              <label>
                事件摘要
                <textarea
                  name={`event-${i}`}
                  defaultValue={event.event}
                  required
                />
              </label>
              <label>
                修改依据
                <textarea
                  name={`note-${i}`}
                  defaultValue={event.correctionNote || ""}
                  placeholder="如果修改了日期或摘要，说明核对依据"
                />
              </label>
            </fieldset>
          ))}
          {artifact.items && (
            <label>
              流程条目（每行一项）
              <textarea
                name="items"
                defaultValue={artifact.items.join("\n")}
                required
                rows={5}
              />
            </label>
          )}
          {artifact.pico &&
            Object.entries(artifact.pico).map(([k, v]) => (
              <label key={k}>
                {
                  {
                    population: "人群",
                    intervention: "干预",
                    comparison: "对照",
                    outcome: "结局",
                  }[k]
                }
                <input name={k} required defaultValue={v} />
              </label>
            ))}
          <p className="muted">
            保存后将重新进入待复核状态。原文证据不在此处修改。
          </p>
          <button className="primary" disabled={saving}>
            保存修改
          </button>
        </form>
      )}
      {!review && !editing && (
        <button className="primary wide" onClick={() => setReview(true)}>
          <ShieldCheck size={15} />
          人工复核
        </button>
      )}
      {review && (
        <form
          className="inline-form"
          onSubmit={(e) =>
            save(e, (f) =>
              onReview({
                reviewer: f.get("reviewer"),
                note: f.get("note"),
                decision: f.get("decision"),
                attested: f.get("attested") === "on",
                version: artifact.version,
              }),
            )
          }
        >
          <label>
            复核者代号
            <input
              name="reviewer"
              placeholder="例如：研究员 A"
              required
              maxLength={80}
            />
          </label>
          <label>
            复核说明
            <textarea
              name="note"
              placeholder="核查过哪些来源？还有哪些局限？"
              required
            />
          </label>
          <label>
            决定
            <select name="decision">
              <option value="approved">确认此工作草稿</option>
              <option value="rejected">退回修订</option>
            </select>
          </label>
          <label className="checkbox">
            <input type="checkbox" name="attested" required />
            我已检查原文、缺失信息和适用范围
          </label>
          <p className="muted">此记录不代表医生身份认证或临床签名。</p>
          <button className="primary" disabled={saving}>
            {saving ? "保存中…" : "记录复核结果"}
          </button>
        </form>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
function App() {
  const initialLocation = useRef(readLocation()).current;
  const [config, setConfig] = useState(null),
    [sessions, setSessions] = useState([]),
    [session, setSession] = useState(null),
    [activeId, setActiveId] = useState(initialLocation.view === "workbench" ? initialLocation.id : ""),
    [draft, setDraft] = useState(""),
    [consent, setConsent] = useState(false);
  const [questionSelection, setQuestionSelection] = useState({});
  const questionDrafts = useRef(new Map());
  // 患者页一键入口带到下一次发送的显式工作流（如治疗方案评估），
  // 草稿模式下医生核对后手动发送时一并提交。
  const pendingWorkflowRef = useRef("");
  const [accessMode, setAccessMode] = useState("auto");
  const [thinking, setThinking] = useState("disabled");
  const [pickedSkills, setPickedSkills] = useState([]),
    [mention, setMention] = useState(null),
    [mentionIndex, setMentionIndex] = useState(0);
  const [view, setViewState] = useState(initialLocation.view);
  const setView = (next, location = {}) => {
    writeLocation(next, location);
    setViewState(next);
  };
  const [displayMode, setDisplayMode] = useState("work");
  const [workspaceDisplay, setWorkspaceDisplay] = useState("work");
  const [largeText, setLargeText] = useState(() => localStorage.getItem("om.largeText") === "true");
  const [workspaceTarget, setWorkspaceTarget] = useState(initialLocation.view === "workspaces" ? { id: initialLocation.id, panel: initialLocation.tab } : null);
  const [projectTool, setProjectTool] = useState("");
  const [, setActiveWsId] = useState("");
  const [wsList, setWsList] = useState([]);
  const [patientRoute, setPatientRoute] = useState(initialLocation.view === "patients" ? { id: initialLocation.id, tab: initialLocation.tab } : {});
  const [homeKey, setHomeKey] = useState(0);
  const [homeDraft, setHomeDraft] = useState({});
  const [patientsList, setPatientsList] = useState([]);
  const [listError, setListError] = useState("");
  const [assistantId, setAssistantId] = useState("");
  const [currentPatientId, setCurrentPatientId] = useState(
    () => localStorage.getItem("om.currentPatient") || "",
  );
  const [patientDetail, setPatientDetail] = useState(null);
  const [acceptId, setAcceptId] = useState("");
  const [doctorMemCount, setDoctorMemCount] = useState(0);
  const [referencedPatients, setReferencedPatients] = useState([]);
  const [kQuery, setKQuery] = useState("");
  const [kHits, setKHits] = useState(null);
  const [kBusy, setKBusy] = useState(false);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [runs, setRuns] = useState({}),
    [tab, setTab] = useState(initialLocation.view === "workbench" ? initialLocation.tab || "materials" : "materials"),
    [artifactId, setArtifactId] = useState(""),
    [audit, setAudit] = useState([]);
  const [meters, setMeters] = useState({
    chars: 0,
    tokens: 0,
    rounds: 0,
    retrievals: 0,
    compacted: false,
  });
  const [fileSelection, setFileSelection] = useState({}),
    [materialQuery, setMaterialQuery] = useState(""),
    [materialMatches, setMaterialMatches] = useState(null);
  const [modal, setModal] = useState(null),
    [sidebar, setSidebar] = useState(false),
    [inspector, setInspector] = useState(initialLocation.view === "workbench" && Boolean(initialLocation.tab)),
    [uploading, setUploading] = useState(false),
    [homeFileCount, setHomeFileCount] = useState(0),
    [citation, setCitation] = useState(null);
  const inputRef = useRef(),
    fileRef = useRef(),
    endRef = useRef(),
    followOutput = useRef(true),
    lastScrollTop = useRef(0),
    activeRef = useRef(initialLocation.view === "workbench" ? initialLocation.id : ""),
    generation = useRef(0),
    sendingRef = useRef(new Set()),
    homePending = useRef(null);
  const activeRun = runs[activeId];
  const persistedRunning = session?.runs.findLast(
    (r) => r.status === "running",
  );
  const busy = Boolean(activeRun?.busy || persistedRunning);
  const skillOptions = config?.skills || [];
  const mentionMatches = mention
    ? skillOptions
        .filter(
          (skill) =>
            !pickedSkills.includes(skill.id) &&
            `${skill.title || skill.name} ${skill.name} ${skill.id} ${skill.description || ""}`
              .toLowerCase()
              .includes(mention.query.toLowerCase()),
        )
        .slice(0, 3)
    : [];
  const pickSkill = (skill) => {
    setDraft((d) => d.replace(/@[^\s@]{0,20}$/, ""));
    setPickedSkills((prev) =>
      prev.includes(skill.id) || prev.length >= 3 ? prev : [...prev, skill.id],
    );
    setMention(null);
    inputRef.current?.focus();
  };
  const patientMentions =
    mention && !session?.patientId
      ? patientsList
          .filter((p) => p.name.toLowerCase().includes(mention.query.toLowerCase()))
          .slice(0, 4)
      : [];
  const pickPatientMention = async (p) => {
    const fullPatient = await api(`/api/patients/${p.id}`);
    setDraft((d) => d.replace(/@[^\s@]{0,20}$/, ""));
    setMention(null);
    setReferencedPatients((prev) =>
      prev.some((x) => x.id === p.id) ? prev : [...prev, fullPatient],
    );
    inputRef.current?.focus();
  };
  const selectedArtifact =
    session?.artifacts.find((a) => a.id === artifactId) ||
    session?.artifacts.at(-1);
  // 统一内核会话执行中可通过 steer 追加要求（与项目工作区入口一致）。
  const canSteer =
    busy && session?.kind === "session" && Boolean(persistedRunning?.id);
  const runOf = (runId) => session?.runs?.find((r) => r.id === runId);
  const questionRunId = session?.patientId
    ? (questionSelection.sessionId === session.id ? questionSelection.runId : session.runs.at(-1)?.id) : undefined;
  const questionRun = session?.runs.find(r => r.id === questionRunId);
  const questionIds = conversationRunIds(session?.runs, questionRunId);
  const canFollowQuestion = questionRun?.status === "completed" && questionRun?.mode !== "local";
  const chooseQuestion = (runId) => {
    questionDrafts.current.set(session.id + ":" + (questionRunId || "new"), draft);
    setQuestionSelection({ sessionId: session.id, runId });
    setAcceptId("");
    setDraft(questionDrafts.current.get(session.id + ":" + (runId || "new")) || "");
    setError("");
    setNotice("");
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  const completedCaseRun = (r) => r?.status === "completed" && (!r.outcome || r.outcome === "delivered") && r.artifacts?.some(a => a.type === "similar_cases");
  const messageMeta = (m) => {
    if (m.role === "user") return "本轮输入";
    const outcome = m.outcome || runOf(m.runId)?.outcome;
    if (completedCaseRun(runOf(m.runId))) return "检索结果";
    if (outcome === "answered") return "";
    if (outcome === "delivered") return "";
    // N3:执行类未完成/未验证不冒充交付,也不降格为文字回答。
    if (outcome === "delivery_failed") return consultationLookupIssue(runOf(m.runId)) ? "回答依据不完整" : "交付未完成";
    if (outcome === "unverified") return "结果未验证";
    return m.intent === "consultation" ||
      (m.intent === undefined && !runOf(m.runId)?.artifacts?.length)
      ? "咨询回复"
      : "工作草稿";
  };
  const acceptArtifact = session?.artifacts.find((a) => a.id === acceptId);
  const selectedFileIds = (
    fileSelection[activeId] ||
    session?.files.map((f) => f.id) ||
    []
  ).filter((id) => session?.files.some((f) => f.id === id));
  // 能力驱动刷新:通用模式(无医疗能力)只拉工作区列表,不请求 /api/sessions
  // 医疗列表分别读取，失败时保留已加载数据并提供重试。
  // init 的闭包可能捕获旧 config,因此允许显式传入 bootstrap 结果。
  const refreshList = async (cfg = config) => {
    const medical = medicalEnabled(cfg);
    const results = await Promise.allSettled([
      medical ? api("/api/sessions") : Promise.resolve({ sessions: [] }),
      api("/api/workspaces"),
      medical ? api("/api/patients?summary=1") : Promise.resolve({ patients: [] }),
    ]);
    const [tasks, projects, people] = results;
    if (tasks.status === "fulfilled") setSessions(tasks.value.sessions);
    if (projects.status === "fulfilled") setWsList((projects.value.workspaces || []).filter((item) => item.kind !== "session"));
    if (people.status === "fulfilled") setPatientsList(people.value.patients || []);
    const missing = results.flatMap((result, index) => result.status === "rejected" ? [["任务", "项目", "患者"][index]] : []);
    setListError(missing.length ? `${missing.join("、")}列表暂时无法更新，已保留此前读取的数据。` : "");
    return tasks.status === "fulfilled" ? tasks.value.sessions : sessions;
  };

  const load = async (id) => {
    const version = ++generation.current;
    setLoading(true);
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
      if (version === generation.current) {
        setSession(data);
        setMeters((m) => ({ ...m, ...metersFromSession(data) }));
        setArtifactId("");
        setCitation(null);
        return data;
      }
    } catch (err) {
      if (version === generation.current) setError(err.message);
    } finally {
      if (version === generation.current) setLoading(false);
    }
  };
  // Keep pending attachments while navigating; explicit new task or send consumes them.
  const resetHomePending = () => {
    homePending.current = null;
    setHomeFileCount(0);
  };
  const select = async (id) => {
    setError("");
    setNotice("");
    setMaterialQuery("");
    setMaterialMatches(null);
    setSession(null);
    setQuestionSelection({});
    setMeters({ chars: 0, tokens: 0, rounds: 0, retrievals: 0, compacted: false });
    activeRef.current = id;
    setActiveId(id);
    setDraft("");
    setConsent(false);
    setSidebar(false);
    setReferencedPatients([]);
    setAcceptId("");
    return load(id);
  };
  const init = async () => {
    setError("");
    setLoading(true);
    try {
      const value = await bootstrap(true);
      setConfig(value);
      setThinking(value.thinking === "enabled" ? "enabled" : "disabled");
      // 通用模式没有医疗首页:默认进入领域无关的项目工作区视图。
      if (!medicalEnabled(value) && !["workspaces", "projects", "tools", "tasks", "settings"].includes(readLocation().view)) setView("workspaces", { replace: true });
      const list = await refreshList(value);
      if (medicalEnabled(value))
        api("/api/doctor/profile")
          .then(
            (p) => setDoctorMemCount(p.counts?.active ?? p.counts?.confirmed ?? 0),
          )
          .catch(() => {});
      if (
        activeRef.current &&
        list.some((item) => item.id === activeRef.current)
      )
        await load(activeRef.current);
      else {
        if (activeRef.current) setError("这项任务不存在或已删除，可以返回任务记录继续查找。");
        setSession(null);
        setLoading(false);
      }
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };
  useEffect(() => {
    init();
  }, []);
  useEffect(() => {
    const restore = () => {
      const route = readLocation();
      setViewState(route.view);
      setSidebar(false);
      setError("");
      if (route.view === "patients") setPatientRoute({ id: route.id, tab: route.tab, navigationKey: Date.now() });
      if (route.view === "workspaces") setWorkspaceTarget({ id: route.id, panel: route.tab });
      if (route.view === "workbench" && route.id) {
        setTab(route.tab || "materials");
        setInspector(Boolean(route.tab));
        select(route.id);
      }
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  // 当前患者上下文：打开患者会话时跟随；详情供速览卡使用。
  // 无医疗能力时即便 localStorage 残留患者 ID 也不请求患者接口。
  useEffect(() => {
    const pid = session?.patientId || currentPatientId;
    if (!pid || !medicalEnabled(config)) {
      setPatientDetail(null);
      return;
    }
    let stale = false;
    api(`/api/patients/${pid}`)
      .then((d) => {
        if (!stale) setPatientDetail(d);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [session?.patientId, currentPatientId, config]);
  const switchCurrentPatient = (id) => {
    setCurrentPatientId(id);
    localStorage.setItem("om.currentPatient", id || "");
  };
  useLayoutEffect(() => { followOutput.current = true; lastScrollTop.current = 0; }, [activeId]);
  useLayoutEffect(() => {
    const pane = endRef.current?.parentElement;
    if (pane && followOutput.current) {
      pane.scrollTop = pane.scrollHeight;
      lastScrollTop.current = pane.scrollTop;
    }
  }, [activeId, session?.messages.length, activeRun?.partial, activeRun?.busy]);
  useEffect(() => {
    if (!activeId) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      api(`/api/sessions/${activeId}`)
        .then((s) => {
          if (activeRef.current === s.id)
            setSession((prev) =>
              prev?.id === s.id && prev.revision > s.revision ? prev : s,
            );
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [activeId, persistedRunning?.id, activeRun?.busy]);
  const create = async (title) => {
    generation.current++;
    setError("");
    try {
      const data = await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify(title ? { title } : {}),
      });
      await refreshList();
      activeRef.current = data.id;
      setActiveId(data.id);
      setSession(data);
      setMeters({ chars: 0, tokens: 0, rounds: 0, retrievals: 0, compacted: false });
      setLoading(false);
      setDraft("");
      setConsent(false);
      setSidebar(false);
      setArtifactId("");
      setAcceptId("");
      setCitation(null);
      setMaterialQuery("");
      setMaterialMatches(null);
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    }
  };
  const updateSession = async () => {
    if (!activeRef.current) return;
    const id = activeRef.current;
    const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
    if (activeRef.current === id) {
      setSession(data);
      setMeters((m) => ({ ...m, ...metersFromSession(data) }));
    }
    await refreshList();
    return data;
  };
  const renderIncompleteRun = (r, inHistory = false) => (
                        <details className="incomplete-run" key={r.id} open={!inHistory}>
                          <summary><Badge status={r.status} /> {inHistory ? "历史任务" : "本次任务未完成"}：{session.messages.find(m => m.role === "user" && m.runId === r.id)?.content?.slice(0, 60) || "之前的执行"}</summary>
                          {r.derivedStatus === "blocked" && (
                            <span className="error-text">
                              受阻：{blockedText(r.waitingReason)}
                            </span>
                          )}
                          <p>{r.error}</p>
                          <button
                            className="secondary"
                            disabled={busy || loading}
                            onClick={() => {
                              const original = session.messages.find(
                                (m) => m.runId === r.id && m.role === "user",
                              );
                              if (original) {
                                setDraft(original.content);
                                setConsent(false);
                                setFileSelection((prev) => ({
                                  ...prev,
                                  [activeId]: r.fileIds.filter((id) =>
                                    session.files.some((f) => f.id === id),
                                  ),
                                }));
                                inputRef.current?.focus();
                              }
                            }}
                          >
                            载入原任务重试
                          </button>
                          {r.artifacts?.some(a => a.status === "draft") && (
                            <button className="secondary" disabled={busy || loading} onClick={async () => {
                              try {
                                await api(`/api/sessions/${activeId}/runs/${r.id}/archive-drafts`, {method:"POST",body:JSON.stringify({archived:!r.draftsArchived})});
                                await updateSession();
                              } catch (err) { setError(err.message); }
                            }}>
                              {r.draftsArchived ? "恢复这次执行的草稿" : "收起这次未完成执行的草稿"}
                            </button>
                          )}
                          {r.partial && (
                            <details>
                              <summary>查看保留的部分内容</summary>
                              <RichMessage text={r.partial} />
                            </details>
                          )}
                        </details>
  );
  async function send(e, override = {}, refreshedSession, retryOnConflict = false) {
    e?.preventDefault();
    const text = override.message || draft.trim();
    if (!text || loading) return;
    // 执行中追加要求：统一内核会话（kind:"session"）走 steer 指令队列，与
    // 项目工作区一致；旧引擎会话没有该通道，提交会被服务端以「正在执行」
    // 拒绝并提示，保持原有行为。
    const executing = activeRun?.busy || Boolean(persistedRunning);
    if (executing && e && session?.kind === "session" && persistedRunning?.id) {
      setDraft("");
      setPickedSkills([]);
      setMention(null);
      try {
        await api(`/api/workspaces/${session.id}/steer`, "POST", {
          runId: persistedRunning.id,
          message: text,
          externalConsent: accessMode === "auto" ? true : consent,
          requestId: crypto.randomUUID(),
        });
        setNotice("补充要求已加入队列，助手会在下一步接收。");
      } catch (err) {
        setError(err.message);
        setDraft(text);
      }
      return;
    }
    let current = refreshedSession || session;
    if (!current) current = await create();
    if (!current || sendingRef.current.has(current.id)) return;
    const id = current.id;
    questionDrafts.current.delete(id + ":" + (questionRunId || "new"));
    sendingRef.current.add(id);
    followOutput.current = true;
    lastScrollTop.current = 0;
    setError("");
    setNotice("");
    setDraft("");
    setPickedSkills([]);
    setMention(null);
    setRuns((prev) => ({
      ...prev,
      [id]: { busy: true, partial: "", events: [] },
    }));
    let started = false;
    const modelEnabled =
      Boolean(config?.modelConfigured) && accessMode !== "local";
    const pendingWorkflow = pendingWorkflowRef.current;
    pendingWorkflowRef.current = "";
    const req = modeToRequest(modelEnabled, {
      message: text,
    });
    try {
      await streamTurn(
        id,
        {
          message: req.message,
          mode: req.mode,
          externalConsent: accessMode === "auto" ? true : consent,
          ...(thinking === "enabled" && modelEnabled
            ? { thinking: "enabled" }
            : {}),
          skills: pickedSkills,
          delegations: [],
          ...(pendingWorkflow ? { workflow: pendingWorkflow } : {}),
          ...(current.patientId ? { conversationParentRunId: current.id === session?.id && canFollowQuestion ? questionRunId : null } : {}),
          ...override,
          sessionRevision: current.revision,
          fileIds: (
            fileSelection[current.id] ||
            current.files.map((f) => f.id)
          ).filter((id) => current.files.some((f) => f.id === id)),
          requestId: crypto.randomUUID(),
        },
        (event) => {
          started = true;
          if (event.type === "tool.complete" && /^care_/.test(event.payload?.tool || ""))
            window.dispatchEvent(new Event(PENDING_REFRESH_EVENT));
          if (
            event.type === "tool.complete" &&
            RETRIEVAL_TOOL.test(event.payload?.tool || "")
          )
            setMeters((m) => ({ ...m, retrievals: m.retrievals + 1 }));
          if (event.type === "context.compacting")
            setMeters((m) => ({ ...m, compacted: true }));
          if (event.type === "message.complete" && event.payload?.usage) {
            const usage = event.payload.usage;
            setMeters((m) => ({
              ...m,
              tokens: m.tokens + (usage.total_tokens || 0),
              rounds: m.rounds + (usage.rounds || 0),
            }));
          }
          setRuns((prev) => {
            const value = prev[id] || { busy: true, partial: "", events: [] };
            return {
              ...prev,
              [id]: {
                ...value,
                partial:
                  event.type === "message.delta"
                    ? value.partial + (event.payload.text || "")
                    : value.partial,
                events: [...value.events, event].slice(-100),
                busy: !["message.complete", "error", "run.cancelled"].includes(
                  event.type,
                ),
              },
            };
          });
          if (event.type === "message.start" && activeRef.current === id)
            api(`/api/sessions/${id}`)
              .then((s) => {
                if (activeRef.current === id) {
                  setQuestionSelection({ sessionId: id, runId: s.runs.at(-1)?.id });
                  setSession((prev) => prev?.id === s.id && prev.revision > s.revision ? prev : s);
                }
              })
              .catch((err) => {
                if (activeRef.current === id) setError(err.message);
              });
          if (event.type === "message.complete" && activeRef.current === id) {
            setTab("results");
            // 逐次确认档：每轮结束后收回外发授权，下一轮需重新勾选。
            if (accessMode === "each") setConsent(false);
          }
        },
      );
    } catch (err) {
      // 首次发送被 revision 冲突拒绝（并发上传/重命名晚到时）：重取快照
      // 自动重发一次，用户无需手动「刷新核对后再发送」。
      if (
        !started &&
        !retryOnConflict &&
        /会话资料已更新|工作区已变化/.test(err.message || "")
      ) {
        const fresh = await api(`/api/sessions/${id}`).catch(() => null);
        if (fresh) {
          setDraft((current) => current || text);
          sendingRef.current.delete(id);
          return await send(null, override, fresh, true);
        }
      }
      if (activeRef.current === id) {
        setError(err.message);
        if (!started) setDraft((current) => current || text);
      }
      setRuns((prev) => ({
        ...prev,
        [id]: { ...prev[id], error: err.message },
      }));
    } finally {
      sendingRef.current.delete(id);
      setRuns((prev) => ({ ...prev, [id]: { ...prev[id], busy: false } }));
      try {
        const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
        if (activeRef.current === id) {
          setSession(data);
          if (data.patientId && data.runs.at(-1)?.id !== current.runs.at(-1)?.id)
            setQuestionSelection({ sessionId: id, runId: data.runs.at(-1)?.id });
          setMeters((m) => ({ ...m, ...metersFromSession(data) }));
        }
        await refreshList();
      } catch (err) {
        if (activeRef.current === id) setError(err.message);
      }
    }
  }
  const stop = async () => {
    try {
      await api(`/api/chat/${activeId}/cancel`, { method: "POST", body: "{}" });
      setNotice("停止请求已发送，正在保存已完成的部分。");
    } catch (err) {
      setError(err.message);
    }
  };
  const selectWorkflow = async (flow) => {
    if (!session) await create();
    setDraft(flow.prompt);
    setConsent(false);
    inputRef.current?.focus();
  };
  const upload = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    setUploading(true);
    setError("");
    try {
      let current = readLocation().view === "home" ? homePending.current : session;
      if (!current) current = await create();
      if (!current) return;
      for (const file of files) {
        const input = await importMaterial(file);
        const material = await uploadScannedPages(current.id, input);
        await api(`/api/sessions/${current.id}/files`, {
          method: "POST",
          body: JSON.stringify(material),
        });
      }
      setConsent(false);
      await updateSession();
      setTab("materials");
      setNotice("材料已保存。图片保留原图，可用本地 OCR 或视觉模型读取；PDF、Word、Excel 保存抽取文本，请核对来源和缺失信息。");
      if (homePending.current?.id === current.id) {
        const fresh = await api(`/api/sessions/${current.id}`);
        setHomeFileCount(fresh.files.length);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };
  // 首页点附件：先确保有待发会话（患者任务挂患者会话），再弹文件选择
  const homeAttach = async (patientSessionId) => {
    if (!homePending.current) {
      homePending.current = patientSessionId
        ? await select(patientSessionId)
        : await create();
      if (!homePending.current) return;
    }
    fileRef.current?.click();
  };
  const openSource = (source) => {
    setCitation(source);
    setTab("materials");
    setInspector(true);
  };
  const openAudit = async () => {
    setTab("events");
    try {
      const value = await api(`/api/sessions/${activeId}/audit`);
      setAudit(value.events);
    } catch (err) {
      setError(err.message);
    }
  };
  const deleteSession = async () => {
    try {
      await api(`/api/sessions/${activeId}`, { method: "DELETE" });
      setModal(null);
      const list = await refreshList();
      if (list.length) select(list[0].id);
      else {
        setSession(null);
        setActiveId("");
        activeRef.current = "";
      }
    } catch (err) {
      setError(err.message);
    }
  };
  const navigate = (next) => {
    setView(next);
    setSidebar(false);
    setNotice("");
    refreshList().catch((err) => setError(err.message));
  };
  const startNewTask = () => {
    if (medicalEnabled(config)) {
      navigate("home");
      setHomeKey(value => value + 1);
    } else openWorkspaces({ create: true });
  };
  const startProjectTask = async ({ id, prompt }) => {
    const task = await api(`/api/workspaces/${id}/tasks`, "POST", {});
    setHomeDraft({});
    setWorkspaceDisplay("chat");
    openWorkspaces({ id: task.id, prompt });
  };
  const openWorkspaces = (target = {}) => {
    if (projectTool) setWorkspaceDisplay("work");
    setWorkspaceTarget({...target, panel: target.panel || (["browser", "terminal", "extensions"].includes(projectTool) ? projectTool : "files")});
    setProjectTool("");
    setActiveWsId(target.id || "");
    setSidebar(false);
    setView("workspaces", { id: target.id, tab: target.panel });
  };
  const openPatient = (route = {}) => {
    setPatientRoute(route);
    navigate("patients");
    writeLocation("patients", { id: route.id, tab: route.tab, replace: true });
  };
  // 全局助手：服务端单例会话，入口幂等复用同一段对话。
  const openGlobalAssistant = async () => {
    try {
      const data = await api("/api/assistant/session", "POST", {});
      setAssistantId(data.id);
      setSidebar(false);
      await refreshList().catch(() => {});
      await openTask(data.id);
    } catch (e) {
      setListError(`全局助手打开失败：${e.message}`);
    }
  };
  const openTask = async (id, options = {}) => {
    pendingWorkflowRef.current = options.workflow || "";
    setView("workbench", { id, tab: options.tab });
    const data = await select(id);
    if (data) {
      if (data.patientId && (options.draft || options.newQuestion)) setQuestionSelection({ sessionId: data.id, runId: null });
      setTab(options.tab || "materials");
      setArtifactId(
        options.artifactId ||
          (options.tab === "results"
            ? data.artifacts.find((artifact) => artifact.status === "draft")?.id
            : "") ||
          "",
      );
      setInspector(options.tab === "results");
      if (options.artifactId) setAcceptId(options.artifactId);
      if (options.draft) {
        setNotice("已准备好任务要求。核对材料与问题后，点击发送开始；当前尚未执行。");
        setDraft(options.draft);
        setConsent(false);
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    }
  };
  const prepareTask = async ({ prompt, patient, title, skills = [] }) => {
    const pending = homePending.current;
    homePending.current = null;
    setHomeFileCount(0);
    let data;
    if (pending) {
      if (title)
        await api(`/api/sessions/${pending.id}`, {
          method: "PATCH",
          body: JSON.stringify({ title }),
        }).catch(() => {});
      // PATCH 标题与上传材料都会递增 revision；必须在它们全部完成后再取
      // 快照，否则发送会带旧 revision 被服务端 409 拒绝（任务静默不执行）。
      data = await api(`/api/sessions/${pending.id}`).catch(() => pending);
      await refreshList().catch(() => {});
    } else if (patient) data = await select(patient.sessionId);
    else data = await create(title);
    if (!data) throw new Error("任务准备失败，请刷新连接后重试。");
    setConsent(false);
    setTab("materials");
    setInspector(false);
    setHomeDraft({});
    setView("workbench", { id: data.id });
    if (patient) {
      switchCurrentPatient(patient.id);
      setNotice(
        `任务已在 ${patient.name} 的病例工作区发起，材料范围可在右侧核对。`,
      );
    }
    setQuestionSelection({ sessionId: data.id, runId: null });
    send(null, { message: prompt, skills, conversationParentRunId: null }, data);
  };
  const modelEnabled =
    Boolean(config?.modelConfigured) && accessMode !== "local";
  // 领域能力:医疗模式渲染完整医疗工作台,通用模式只渲染领域无关 App Shell。
  const medical = medicalEnabled(config);
  useEffect(() => {
    if (config)
      document.title = medical
        ? `${VIEW_LABELS[view] || "医疗工作台"} · Open Medical`
        : `${VIEW_LABELS[view] || "通用工作台"} · Open Agent`;
  }, [config, medical, view]);
  useEffect(() => { if(inspector) setDisplayMode(mode => mode === "chat" ? "work" : mode); }, [inspector]);
  useEffect(() => {
    if (!inspector) return;
    const close = (event) => { if (event.key === "Escape") setInspector(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [inspector]);
  const effectiveConsentRequired = modelEnabled && accessMode === "each";
  const fileContent = citation
    ? session?.files.find((f) => f.id === citation.sourceId)?.text ||
      session?.messages.find((m) => m.id === citation.sourceId)?.content
    : null;
  return (
    <div className={`agent-app v6-shell mode-${view === "workspaces" ? workspaceDisplay : displayMode} ${medical ? "medical-shell" : ""} ${largeText ? "large-text" : ""}`}>
      {medicalEnabled(config) && <PendingTray />}
      {medicalEnabled(config) && <IntakeBackground onOpen={() => openPatient({create: true, intakeOpen: Date.now()})} />}
      <a href="#main-content" className="skip-link">
        跳到工作区
      </a>
      <header className="topbar">
        <div className="top-brand">
          <button
            className="mobile-nav-toggle icon-button"
            aria-label="打开工作台导航"
            aria-expanded={sidebar}
            onClick={() => setSidebar(!sidebar)}
          >
            <Menu size={18} />
          </button>
          <span className="brand-mark">
            {medical ? <Stethoscope size={21} /> : <Bot size={21} />}
          </span>
          <b>{medical ? "Open Medical" : "Open Agent"}</b>
          {!sidebar && <button className="mobile-agent-entry" aria-label="新建任务" onClick={startNewTask}><Plus size={16}/>新任务</button>}
          <span className="brand-divider" />
          <span className="brand-caption">
            {medical ? "医疗工作台" : "通用工作台"}
          </span>
        </div>
        <div className="top-actions">
          {["workbench", "workspaces"].includes(view) && <div className="display-modes" role="group" aria-label="工作区显示方式">
            {[["work", "工作区"], ["split", "AI 半屏"], ["chat", "AI 全屏"]].map(([id,label]) => <button key={id} disabled={!["workbench","workspaces"].includes(view)} title={["workbench","workspaces"].includes(view)?label:"打开任务或项目后切换显示方式"} aria-pressed={(view==="workspaces"?workspaceDisplay:displayMode)===id} onClick={()=>{if(view==="workspaces")setWorkspaceDisplay(id);else {setDisplayMode(id);setInspector(id!=="chat");}}}>{label}</button>)}
          </div>
          }<button className="text-size-control" aria-label={largeText ? "Aa · 恢复标准字号" : "Aa · 大字模式"} aria-pressed={largeText} onClick={()=>{setLargeText(!largeText);localStorage.setItem("om.largeText",String(!largeText));}}>Aa <span>{largeText?"标准字号":"大字模式"}</span></button>
          {session && (
            <div className="top-meters" role="status" aria-label="会话用量指标">
              <span
                className={`meter ${
                  meters.chars / (config?.contextBudget || 80000) >= 0.6
                    ? "warn"
                    : ""
                }`}
                title={`当前会话约 ${meters.chars} 字符 / 上下文预算 ${
                  config?.contextBudget || 80000
                } 字符${meters.compacted ? "；接近预算时历史已自动压缩，原文可按归档读回" : ""}`}
              >
                上下文{" "}
                {Math.min(
                  100,
                  Math.round((meters.chars / (config?.contextBudget || 80000)) * 100),
                )}
                %
              </span>
              <span
                className="meter"
                title={`本会话累计消耗 ${meters.tokens} tokens · ${meters.rounds} 轮模型调用`}
              >
                {meters.tokens >= 1000
                  ? `${(meters.tokens / 1000).toFixed(1)}k tok`
                  : `${meters.tokens} tok`}
              </span>
              <span
                className="meter"
                title="本次打开会话以来的知识库/文献/病例检索次数"
              >
                检索 {meters.retrievals}
              </span>
            </div>
          )}
          <span className={`connection ${config ? "" : "offline"}`}>
            <i />
            {config ? "本机工作空间" : "连接未就绪"}
          </span>
          <button
            className="meter model-badge"
            title={`当前模型：${config?.model || "未配置"}（${config?.provider || "-"}）；点击切换或配置模型`}
            onClick={() => setModal("model")}
          >
            {config?.modelConfigured ? config.model : "配置模型"}
          </button>
          {medical && view === "workbench" && (
            <IconButton
              title="计划任务与沙箱"
              disabled={view !== "workbench" || !session || busy}
              onClick={() => setModal("tasks")}
            >
              <CalendarClock size={18} />
            </IconButton>
          )}
        </div>
      </header>
      <div className="product-body">
        {sidebar && (
          <button
            className="nav-scrim"
            aria-label="关闭工作台导航"
            onClick={() => setSidebar(false)}
          />
        )}
        <aside className={`app-navigation ${sidebar ? "open" : ""}`}>
          <button className="new-session agent-new-task" aria-label="新建任务" aria-current={view === "home" ? "page" : undefined} onClick={startNewTask}>
            <Plus size={20}/><span>新建任务</span>
          </button>
          {medical && <div className="medical-quick-wrap">
            <nav className="medical-quick" aria-label="主要业务">
              <button aria-current={view === "workbench" && session?.id === assistantId ? "page" : undefined} className={view === "workbench" && session?.id === assistantId ? "active" : ""} onClick={openGlobalAssistant}><Bot size={17}/><span>全局助手</span></button>
              {[["care", "患者消息", Inbox], ["agenda", "今日待办", CalendarClock], ["patients", "患者", Stethoscope], ["followups", "随访", MessageSquare], ["research", "临床试验", BookOpen]].map(([id,label,Icon]) => <button key={id} aria-current={view === id ? "page" : undefined} className={view === id ? "active" : ""} onClick={() => id === "patients" ? openPatient({ navigationKey: Date.now() }) : navigate(id)}><Icon size={17}/><span>{label}</span></button>)}
            </nav>
            <nav className="medical-quick" aria-label="资料与工具">
              <button aria-current={["tools","knowledge","literature","cases","clinical-ref","data-analysis","drg"].includes(view) ? "page" : undefined} className={["tools","knowledge","literature","cases","clinical-ref","data-analysis","drg"].includes(view) ? "active" : ""} onClick={() => navigate("tools")}><Search size={17}/><span>资料与工具</span></button>
            </nav>
          </div>}
          {medical && <div className="agent-recents">
            <p className="business-nav-label">最近对话</p>
            <nav aria-label="最近对话" className="agent-recents-list">
              {(() => {
                // Codex 式形态映射:会话没有项目字段但有患者——患者即"项目分组",
                // 无患者关联的进「历史」。每组最多 3 条,分组最多 5 个,历史最多 6 条。
                const groups = new Map(); const loose = [];
                for (const item of sessions) {
                  if (item.patientId) {
                    if (!groups.has(item.patientId)) groups.set(item.patientId, []);
                    if (groups.get(item.patientId).length < 3) groups.get(item.patientId).push(item);
                  } else if (loose.length < 6) loose.push(item);
                  if (groups.size >= 5 && loose.length >= 6) break;
                }
                const taskButton = item => <button key={item.id} aria-label={`继续对话：${item.title}`} title={`继续对话：${item.title}`} className={view === "workbench" && activeId === item.id ? "active" : ""} onClick={() => openTask(item.id)}><span>{item.title}</span><small>{item.running ? "进行中" : item.reviewCount ? "待复核" : agoLabel(item.updatedAt)}</small></button>;
                return <>
                  {[...groups.entries()].map(([pid, items]) => items.length ? <div key={pid} className="agent-recents-group">
                    <p className="agent-recents-group-label">{patientsList.find(p => p.id === pid)?.name || "患者"}</p>
                    {items.map(taskButton)}
                  </div> : null)}
                  {loose.length > 0 && <div className={groups.size ? "agent-recents-group" : undefined}>
                    {groups.size > 0 && <p className="agent-recents-group-label">历史</p>}
                    {loose.map(taskButton)}
                  </div>}
                  {!sessions.length && <p className="sidebar-empty">发送第一条消息后，对话会保存在这里。</p>}
                  <div className="agent-recents-tail">
                    <button onClick={() => navigate("tasks")}>查看全部任务记录</button>
                    <button onClick={() => navigate("projects")}>查看全部项目文件</button>
                  </div>
                </>;
              })()}
            </nav>
          </div>}
          {!medical && <nav className="business-nav" aria-label="通用工作">
            {[["tasks", "任务记录", MessageSquare], ["projects", "项目文件", FolderOpen]].map(([id,label,Icon]) => <button key={id} aria-current={(id === "tasks" ? ["tasks","workbench","review","history"].includes(view) : ["projects","workspaces"].includes(view)) ? "page" : undefined} className={(id === "tasks" ? ["tasks","workbench","review","history"].includes(view) : ["projects","workspaces"].includes(view)) ? "active" : ""} onClick={() => navigate(id)}><Icon size={18}/>{label}</button>)}
          </nav>}
          {!medical && <nav className="business-nav resource-nav" aria-label="资料与工具">
            <button aria-current={["tools","knowledge","literature","cases","clinical-ref","data-analysis","drg"].includes(view) ? "page" : undefined} className={["tools","knowledge","literature","cases","clinical-ref","data-analysis","drg"].includes(view) ? "active" : ""} onClick={() => navigate("tools")}><Search size={18}/>资料与工具</button>
          </nav>}
          {wsList.some(w=>w.pinned&&!w.archived)&&<nav className="pinned-projects" aria-label="固定项目"><p className="business-nav-label">固定项目</p>{wsList.filter(w=>w.pinned&&!w.archived).slice(0,3).map(w=><button key={w.id} onClick={()=>openWorkspaces({id:w.id})}><FolderOpen size={16}/><span>{w.title}</span></button>)}</nav>}
          <div className="business-preferences"><button onClick={() => navigate("settings")}><Settings2 size={16}/>设置与连接</button></div>
        </aside>
        <div className="product-content" id="main-content" tabIndex={-1}>
          {["knowledge","literature","clinical-ref","cases","data-analysis","drg"].includes(view) && <nav className="page-trail" aria-label="当前位置"><button onClick={() => navigate("tools")}>资料与工具</button><ChevronRight size={14}/><span>{VIEW_LABELS[view]}</span></nav>}
          {view === "workbench" && session?.patientId && <nav className="page-trail" aria-label="当前患者"><button onClick={() => openPatient({id:session.patientId})}><Stethoscope size={15}/>{patientsList.find(p => p.id === session.patientId)?.name || "患者档案"}</button><ChevronRight size={14}/><span>当前对话与成果保存在此患者下</span></nav>}
          {listError && <div className="navigation-notice" role="alert"><span>{listError}</span><button className="secondary" onClick={() => refreshList()}>重新加载列表</button></div>}
          {!config ? (<main id="main" className="workbench-hub">
                {error ? <div className="connection-recovery" role="alert">
                  <AlertCircle size={28} />
                  <h1>暂时无法连接工作台</h1>
                  <p>{error}</p>
                  <p>确认本地服务已启动后重试，你的本机数据不会因此删除。</p>
                  <button className="primary" onClick={init} disabled={loading}>{loading ? "正在重试…" : "重新连接"}</button>
                </div> : <div className="loading-state" role="status">
                  <Loader2 className="spin" />正在连接本地运行时…
                </div>}
              </main>) : view === "settings" && config ? <AppSettingsView config={config} onModel={()=>setModal("model")} onDoctor={()=>setModal("doctor")} onProjects={()=>navigate("projects")} onAsk={(prompt)=>{setHomeDraft({prompt});setHomeKey((k)=>k+1);navigate("home");}} /> : view === "projects" && config ? <ProjectDirectory purpose={projectTool} items={wsList} onOpen={openWorkspaces} onChanged={refreshList}/> : view === "tools" && config ? <ToolDirectory config={config} onModelSettings={()=>setModal("model")} onNavigate={navigate} onProjects={tool=>{setProjectTool(tool);navigate("projects");}} onNewTask={startNewTask}/> : view === "tasks" ? <TaskDirectory sessions={sessions} workspaces={wsList} patients={patientsList} onTask={openTask} onProject={openWorkspaces}/> : view === "workspaces" ? (
            <WorkspacesView
              key={`ws-${homeKey}-${workspaceTarget?.id || ""}-${workspaceTarget?.create || ""}`}
              config={config}
              initialPanel={workspaceTarget?.panel || "files"}
              displayMode={workspaceDisplay}
              onDisplayModeChange={setWorkspaceDisplay}
              initialWorkspaceId={workspaceTarget?.id || ""}
              initialCreate={Boolean(workspaceTarget?.create)}
              initialPrompt={workspaceTarget?.prompt || ""}
              onOpenSettings={() => navigate("settings")}
              onMenu={() => setSidebar(!sidebar)}
              onChanged={(id) => {
                if (id) {
                  setActiveWsId(id);
                  if (readLocation().view === "workspaces") writeLocation("workspaces", { id, tab: readLocation().tab, replace: !readLocation().id });
                }
                refreshList().catch(() => {});
              }}
            />
          ) : view === "care" && medical ? (<CareInbox onOpenPatient={(id) => openPatient({ id, tab: "messages" })} />) : view === "agenda" && medical ? (<main id="main" className="work-directory"><header className="directory-heading"><div><h1>今日待办</h1><p>今天需要联系、复诊、核对结果的患者，以及高危风险提醒。</p></div></header><DoctorAgenda onPatient={openPatient} onOpenTask={openTask} onView={navigate}/></main>) : view === "patients" && medical ? (
            <PatientsView
              key={`${patientRoute.id || "list"}-${patientRoute.tab || "overview"}-${patientRoute.create || false}-${patientRoute.import || false}-${patientRoute.intakeOpen || ""}-${patientRoute.navigationKey || ""}`}
              config={config}
              onLocationChange={(id, tab) => writeLocation("patients", { id, tab })}
              initialPatientId={patientRoute.id}
              initialTab={patientRoute.tab}
              initialCreate={patientRoute.create}
              initialImport={patientRoute.import}
              onOpenWorkspace={(id, options = {}) => openTask(id, { newQuestion: !options.tab, ...options })}
              onSwitchCurrent={switchCurrentPatient}
              onChanged={refreshList}
            />
          ) : view === "literature" ? (
            <LiteratureView onOpenTask={openTask} />
          ) : view === "knowledge" ? (
            <KnowledgeLibraries onOpenTask={openTask} />
          ) : view === "clinical-ref" ? (
            <ClinicalRefView />
          ) : view === "followups" && medical ? (
            <FollowupsView onSettings={()=>{navigate("settings");window.history.replaceState({},"", "?view=settings&settingsTab=followup");}} onOpenTask={openTask} onOpenPatient={(id) => openPatient({ id, tab: "followups" })} />
          ) : view === "cases" ? (
            <CasesView />
          ) : view === "research" && medical ? (
            <TrialScreeningView onOpenTask={openTask} onOpenPatient={id=>openPatient({id})} />
          ) : view === "data-analysis" ? (
            <ResearchView />
          ) : view === "drg" ? (
            <DrgView />
          ) : view !== "workbench" ? (
            <WorkbenchHome
              key={homeKey}
              draftState={homeDraft}
              onDraftChange={setHomeDraft}
              view={view}
              config={config}
              sessions={sessions}
              onStart={prepareTask}
              onOpenTask={openTask}
              onPatient={openPatient}
              onView={navigate}
              onRefresh={refreshList}
              onReconnect={init}
              projects={wsList}
              onOpenProjects={startProjectTask}
              onClearDraft={() => { resetHomePending(); setHomeDraft({}); setHomeKey(value => value + 1); }}
              accessMode={accessMode}
              onAccessModeChange={(value) => {
                setAccessMode(value);
                setConsent(value === "auto");
              }}
              thinking={thinking}
              onThinkingChange={setThinking}
              consent={consent}
              onConsentChange={setConsent}
              onModelSettings={() => setModal("model")}
              onAttach={homeAttach}
              attachmentError={error}
              uploading={uploading}
              attachedCount={homeFileCount}
              fileInputRef={fileRef}
              onFilesPicked={upload}
            />
          ) : (
            <div className={`shell ${inspector ? "with-inspector" : ""}`}>
              <main id="main" className="conversation">
                <div className="conversation-head">
                  <IconButton
                    title="显示会话列表"
                    onClick={() => setSidebar(!sidebar)}
                  >
                    <Menu size={18} />
                  </IconButton>
                  <div className="heading-copy">
                    <small>
                      {session?.patientId ? "患者关联任务" : "Agent 对话"}
                    </small>
                    <h1>{session?.title || "今天，需要处理什么材料？"}</h1>
                  </div>
                  {session && (
                    <div className="head-actions">
                      <IconButton
                        title="重命名会话"
                        onClick={() => setModal("rename")}
                      >
                        <PencilLine size={16} />
                      </IconButton>
                      <IconButton
                        title="复制选中材料到新会话"
                        disabled={busy || loading || !selectedFileIds.length}
                        onClick={async () => {
                          try {
                            const copy = await api(
                              `/api/sessions/${activeId}/copy-materials`,
                              {
                                method: "POST",
                                body: JSON.stringify({
                                  sessionRevision: session.revision,
                                  fileIds: selectedFileIds,
                                }),
                              },
                            );
                            await refreshList();
                            select(copy.id);
                            setNotice(
                              "已复制所选材料，新会话从空白任务开始，未继承模型历史或复核结果。",
                            );
                          } catch (err) {
                            setError(err.message);
                          }
                        }}
                      >
                        <Copy size={16} />
                      </IconButton>
                      <IconButton
                        title="导出会话"
                        onClick={() => setModal("export")}
                      >
                        <Download size={16} />
                      </IconButton>
                      <IconButton
                        title="删除会话"
                        disabled={busy || loading || Boolean(session.patientId)}
                        onClick={() => setModal("delete")}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </div>
                  )}
                  <button
                    className="secondary inspector-toggle"
                    aria-expanded={inspector}
                    aria-controls="task-reference-panel"
                    onClick={() => setInspector(!inspector)}
                  >
                    <FolderOpen size={16} />
                    {inspector ? "收起资料" : "查看资料"}
                  </button>
                </div>
                {session && (
                  <div className="task-context-bar">
                    {!session.patientId && (session.files.length > 0 ||
                      session.artifacts.length > 0) && (
                      <div className="task-steps" aria-label="任务阶段">
                        <span
                          className={!session.files.length ? "current" : "done"}
                        >
                          1 准备材料
                        </span>
                        <ChevronRight size={12} />
                        <span
                          className={
                            busy ||
                            (session.files.length && !session.artifacts.length)
                              ? "current"
                              : session.artifacts.length
                                ? "done"
                                : ""
                          }
                        >
                          2 整理生成
                        </span>
                        <ChevronRight size={12} />
                        <span
                          className={
                            session.artifacts.length && !busy ? "current" : ""
                          }
                        >
                          3 复核成果
                        </span>
                      </div>
                    )}
                    {session.patientId && (
                      <button
                        className="text-button"
                        onClick={() => openPatient({ id: session.patientId })}
                      >
                        患者档案 <ChevronRight size={12} />
                      </button>
                    )}
                  </div>
                )}
                {error && (
                  <div role="alert" className="error-banner">
                    <AlertCircle size={16} />
                    <span>{error}</span>
                    {!config && <button onClick={init}>重新连接</button>}
                    {!session && config && <button onClick={() => navigate("tasks")}>返回任务记录</button>}
                    <IconButton
                      title="关闭错误提示"
                      onClick={() => setError("")}
                    >
                      <X size={14} />
                    </IconButton>
                  </div>
                )}
                {session?.patientId && !loading && !acceptArtifact && <PatientConversationNav session={session} runId={questionRunId} busy={busy} onSelect={chooseQuestion} />}
                {loading ? (
                  <div className="loading-state">
                    <Loader2 className="spin" />
                    正在载入工作会话…
                  </div>
                ) : acceptArtifact ? (
                  <AcceptanceView
                    artifact={acceptArtifact}
                    previous={acceptArtifact.history?.at(-1)}
                    onSource={openSource}
                    onClose={() => {
                      setAcceptId("");
                      updateSession();
                    }}
                    onReview={async (body) => {
                      await api(
                        `/api/sessions/${activeId}/artifacts/${acceptArtifact.id}/review`,
                        { method: "POST", body: JSON.stringify(body) },
                      );
                      const reviewedSession = await updateSession();
                      if (body.decision === "rejected") {
                        const title = acceptArtifact.title;
                        const note = body.note;
                        setAcceptId("");
                        setNotice(`已退回「${title}」，正在按复核意见生成修订…`);
                        try {
                          await send(null, {
                            message: `请根据复核意见修订「${title}」：${note}。请保留原文来源与行号，修订后更新版本。`,
                          }, reviewedSession);
                        } catch {
                          setNotice("修订任务已写入会话，可手动发送继续。");
                        }
                      }
                    }}
                  />
                ) : (
                  <div className="message-list"
                    onWheel={(e) => { if (e.deltaY < 0) followOutput.current = false; }}
                    onTouchMove={() => { followOutput.current = false; }}
                    onKeyDown={(e) => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) followOutput.current = false; }}
                    onScroll={(e) => {
                      const pane = e.currentTarget;
                      const movement = pane.scrollTop - lastScrollTop.current;
                      const bottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 24;
                      if (movement < -1) followOutput.current = false;
                      else if (movement > 1 && bottom) followOutput.current = true;
                      lastScrollTop.current = pane.scrollTop;
                    }}>
                    {session?.patientId && patientDetail && (
                      <PatientSummaryCard
                        detail={patientDetail}
                        session={session}
                        compact
                        onOpenDetail={() =>
                          openPatient({ id: session.patientId })
                        }
                      />
                    )}
                    {(!session?.messages.length || (session?.patientId && !questionRunId && !busy)) && (
                      <div className="welcome task-preparation">
                        <div className="welcome-symbol">
                          {session?.files.length ? (
                            <FolderOpen size={24} />
                          ) : (
                            <Stethoscope size={24} />
                          )}
                        </div>
                        <p className="eyebrow">直接提问，或描述任务</p>
                        <h2>
                          {session?.patientId ? "这次想了解患者的哪方面？" : session?.files.length
                            ? "材料已就绪，可以直接开始。"
                            : "有什么可以帮你？"}
                        </h2>
                        <p>
                          {session?.patientId
                            ? "可以直接问这位患者的新问题。病历资料会共享，以前的聊天不会自动带入。"
                            : "咨询、指标解读这类问题会直接回答；整理病历、写文书时助手会自动选择合适的技能模板，需要时再添加材料。"}
                        </p>
                        <button
                          className="secondary prepare-materials"
                          disabled={!config || uploading}
                          onClick={() => {
                            if (session?.files.length) {
                              setTab("materials");
                              setInspector(true);
                            } else fileRef.current?.click();
                          }}
                        >
                          <Paperclip size={15} />
                          {session?.files.length
                            ? `核对本次选中的 ${selectedFileIds.length} 份材料`
                            : "添加任务材料"}
                        </button>
                        {!draft.trim() && (
                          <div className="workflow-grid">
                            {WORKFLOWS.map((flow) => (
                              <button
                                onClick={() => selectWorkflow(flow)}
                                key={flow.id}
                              >
                                <flow.icon size={19} />
                                <b>{flow.title}</b>
                                <span>{flow.desc}</span>
                                <ChevronRight size={15} />
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="welcome-note">
                          <ShieldCheck size={14} />
                          未配置模型时自动本地整理；智能模式下，输入与材料外发前需勾选同意。
                        </div>
                      </div>
                    )}
                    {session?.messages.filter((m) => !session.patientId || questionIds.has(m.runId)).map((m) => (
                      <article
                        key={m.id}
                        className={`message ${m.role === "user" ? "user-message" : ""}`}
                      >
                        <div className="message-avatar">
                          {m.role === "user" ? "我" : <Stethoscope size={17} />}
                        </div>
                        <div className="message-body">
                          <div className="message-meta">
                            <b>{m.role === "user" ? "你" : "医疗工作助理"}</b>
                            <span>{messageMeta(m)}</span>
                          </div>
                          <div className="message-content">
                            {m.role === "user" ? (
                              m.content
                            ) : (
                              runOf(m.runId)?.artifacts?.some(a => a.type === "similar_cases") ? <><SimilarCases key={m.runId} variant="teaser" onOpen={() => setAcceptId(runOf(m.runId).artifacts.find(a => a.type === "similar_cases").id)} artifact={runOf(m.runId).artifacts.find(a => a.type === "similar_cases")} onRefresh={busy ? undefined : () => send(null, {message:"请重新检索这个患者的相似病例，并逐项对照疾病、阶段、治疗、用药和年龄性别，保存有原文依据的相似度结果。"})} />{m.content ? <details className="task-result"><summary>查看文字说明</summary><RichMessage text={m.content}/></details> : null}</> : hasTaskResult(runOf(m.runId)) ? <><TaskResult key={m.runId} run={runOf(m.runId)}/><details className="task-result"><summary>查看文字说明</summary><RichMessage text={m.content}/></details></> : <RichMessage text={m.content} />
                            )}
                          </div>
                          {m.role !== "user" && ["delivery_failed","unverified"].includes(m.outcome || runOf(m.runId)?.outcome) &&
                            (m.outcome || runOf(m.runId)?.outcome) && (
                              <OutcomeCard
                                outcome={m.outcome || runOf(m.runId)?.outcome}
                                delivery={runOf(m.runId)?.delivery}
                                consultationRun={runOf(m.runId)}
                              />
                            )}
                          {m.role !== "user" && (
                            <MemoryNote count={doctorMemCount} />
                          )}
                          {m.risk === "high" && (
                            <p className="boundary">
                              此内容需要专业人员核查，不能用于自动诊疗决策。
                            </p>
                          )}
                        </div>
                      </article>
                    ))}
                    {busy && (
                      <article className="message">
                        <div className="message-avatar">
                          <Loader2 className="spin" size={17} />
                        </div>
                        <div className="message-body">
                          <RunStatusNotice
                            run={persistedRunning}
                            pendingCount={0}
                          />
                          <StepsFlow
                            events={activeRun?.busy ? activeRun.events || [] : persistedRunning?.events || []}
                            running={busy}
                            fallbackText={
                              persistedRunning &&
                              runDerivedStatus(persistedRunning) !== "running"
                                ? "任务在等待处理，见上方说明"
                                : "正在思考并调用工具…"
                            }
                          />
                          {(activeRun?.partial || persistedRunning?.partial) && (
                            ["patient-assessment", "similar-case-search"].includes(persistedRunning?.policy?.workflow) ? (
                              <details className="message-content streaming execution-notes">
                                <summary>查看执行过程（非最终结论）</summary>
                                <RichMessage text={activeRun?.partial || persistedRunning?.partial} />
                              </details>
                            ) : <div className="message-content streaming"><RichMessage text={activeRun?.partial || persistedRunning?.partial} /></div>
                          )}
                        </div>
                      </article>
                    )}
                    {!busy && (!session?.patientId || questionRunId) &&
                      (session?.artifacts.length || 0) > 0 &&
                      session.artifacts
                        .filter(a => !(a.type === "treatment_review" && session.messages.some(m=>m.role==="assistant" && m.runId===(session.patientId ? questionRun : session.runs.at(-1))?.id)) && (session.patientId ? questionRun : session.runs.at(-1))?.artifacts?.some(current => current.id === a.id) && !(a.type === "similar_cases" && session.messages.some(m => m.role === "assistant" && m.runId === (session.patientId ? questionRun : session.runs.at(-1))?.id)))
                        .slice(-3)
                        .reverse()
                        .map((a) => (
                          <div className="artifact-inline" key={a.id}>
                            <div className="ai-head">
                              <FileText size={14} />
                              <b>{a.title}</b>
                              <span className={`acc-badge ${a.status}`}>
                                {STATUS[a.status]}
                              </span>
                              <span className="muted">v{a.version}</span>
                            </div>
                            <div className="ai-acts">
                              <button
                                className="mini-btn"
                                onClick={() => {
                                  setArtifactId(a.id);
                                  setAcceptId(a.id);
                                }}
                              >
                                {a.type === "similar_cases" ? "查看病例详情" : "查看结果"}
                              </button>
                            </div>
                          </div>
                        ))}
                    {!busy && (session?.patientId ? (questionRun ? [questionRun] : []) : (session?.runs.slice(-1) || []))
                      .filter(r => ["failed", "cancelled", "interrupted"].includes(r.status))
                      .map(r => renderIncompleteRun(r))}
                    <div ref={endRef} />
                  </div>
                )}
                {!acceptArtifact && (
                <div className="composer-wrap">
                  {mention && (
                    <div className="mention-menu" role="listbox" aria-label="提及">
                      {patientMentions.length > 0 && (
                        <>
                          <p className="mention-title">@ 引用患者（引用 ≠ 切换当前患者）</p>
                          {patientMentions.map((p) => (
                            <button
                              type="button"
                              role="option"
                              aria-selected={false}
                              key={p.id}
                              className="patient-mention"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                pickPatientMention(p).catch((err) => setError(err.message));
                              }}
                            >
                              <Stethoscope size={12} />
                              <span>
                                <b>{p.name}</b>
                                <small>{(p.tags || []).join("、") || "患者档案"}</small>
                              </span>
                            </button>
                          ))}
                        </>
                      )}
                      <p className="mention-title">
                        @ 固定技能（最多 3 个）；不选择直接发送则由模型自动路由
                      </p>
                      {mentionMatches.length ? (
                        mentionMatches.map((skill, index) => (
                          <button
                            type="button"
                            role="option"
                            aria-selected={index === mentionIndex}
                            className={index === mentionIndex ? "active" : ""}
                            key={skill.id}
                            onMouseEnter={() => setMentionIndex(index)}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              pickSkill(skill);
                            }}
                          >
                            <AtSign size={12} />
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
                  {referencedPatients.length > 0 && (
                    <>
                      <div className="skill-chips">
                        {referencedPatients.map((p) => (
                          <span className="skill-chip patient" key={p.id}>
                            <Stethoscope size={11} /> @患者：{p.name}
                            <button
                              type="button"
                              aria-label={`移除引用患者 ${p.name}`}
                              onClick={() =>
                                setReferencedPatients((prev) =>
                                  prev.filter((x) => x.id !== p.id),
                                )
                              }
                            >
                              <X size={11} />
                            </button>
                          </span>
                        ))}
                        <small>引用的患者上下文；@引用不切换当前患者</small>
                      </div>
                      <div className="ref-patient-cards">
                        {referencedPatients.map((p) => (
                          <PatientSummaryCard
                            key={p.id}
                            patient={p}
                            compact
                            onOpenDetail={() => openPatient({ id: p.id })}
                          />
                        ))}
                      </div>
                    </>
                  )}
                  {Boolean(pickedSkills.length) && (
                    <div className="skill-chips">
                      {pickedSkills.map((id) => {
                        const skill = skillOptions.find((s) => s.id === id);
                        return (
                          <span className="skill-chip" key={id}>
                            <AtSign size={11} />
                            {skill?.title || skill?.name || id}
                            <button
                              type="button"
                              aria-label={`移除技能 ${skill?.title || skill?.name || id}`}
                              onClick={() =>
                                setPickedSkills((prev) =>
                                  prev.filter((x) => x !== id),
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
                  {session?.patientId && <div className="patient-question-context" role="status">
                    {busy ? "正在处理当前问题，可补充要求。" : canFollowQuestion ? <>继续追问 · {session.messages.find(m => m.role === "user" && m.runId === [...questionIds].at(-1))?.content}</> : "新问题 · 使用患者档案与所选资料"}
                    {!busy && questionRunId && !canFollowQuestion && <span>这次问答未形成可追问的模型回答。再次发送会独立开始。</span>}
                  </div>}
                  <form className="composer" onSubmit={send}>
                    <textarea
                      ref={inputRef}
                      aria-label="医疗工作需求"
                      rows={3}
                      placeholder={
                        canSteer
                          ? "任务执行中…输入补充要求可直接追加（Enter 发送）"
                          : session?.patientId ? (canFollowQuestion ? "继续追问这段回答，如：请解释第二点…" : "问这位患者的新问题，如：总结过往用药情况…")
                          : "输入问题或任务，如「血糖有点高，27 岁男生，怎么办」；输入 @ 可固定技能…"
                      }
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        const matched = e.target.value.match(/@([^\s@]{0,20})$/);
                        if (matched) {
                          setMention({ query: matched[1] });
                          setMentionIndex(0);
                        } else setMention(null);
                      }}
                      onKeyDown={(e) => {
                        if (mention && mentionMatches.length) {
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setMentionIndex(
                              (i) => (i + 1) % mentionMatches.length,
                            );
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
                            setMention(null);
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
                          send(e);
                        }
                      }}
                      disabled={loading || (busy && !canSteer)}
                    />
                    <div className="composer-bottom">
                      <button
                        type="button"
                        className="attach-button"
                        title="添加材料：图片 / PDF / Word / Excel / TXT / Markdown / CSV / JSON"
                        onClick={() => fileRef.current?.click()}
                        disabled={busy || uploading || !config}
                      >
                        <Paperclip size={16} />
                        {uploading ? "导入中…" : "附件"}
                      </button>
                      <button
                        type="button"
                        className="attach-button"
                        title="输入 @ 或点此固定技能（如出院小结、用药复核）；不固定则自动路由"
                        onClick={() => {
                          setDraft((d) => d + (d && !d.endsWith(" ") ? " @" : "@"));
                          setMention({ query: "" });
                          setMentionIndex(0);
                          inputRef.current?.focus();
                        }}
                        disabled={busy || loading || !config}
                      >
                        <AtSign size={15} />
                        技能
                      </button>
                      <input
                        ref={fileRef}
                        type="file"
                        multiple
                        hidden
                        accept=".png,.jpg,.jpeg,.webp,.txt,.md,.markdown,.csv,.tsv,.json,.pdf,.xlsx,.docx"
                        onChange={upload}
                      />
                      <span className="tb-divider" />
                      <label
                        className="tb-item"
                        title="访问权限：逐次确认=每轮发送前勾选外发；会话自动=本会话内外发免勾选"
                      >
                        权限
                        <select
                          value={accessMode}
                          onChange={(e) => {
                            const v = e.target.value;
                            setAccessMode(v);
                            setConsent(v === "auto");
                          }}
                          disabled={busy || loading}
                        >
                          <option value="each">逐次确认</option>
                          <option value="auto">会话自动</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        className="tb-item"
                        title={`当前模型：${config?.model || "未配置"}；点击切换或配置模型`}
                        onClick={() => setModal("model")}
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
                            onChange={(e) => setThinking(e.target.value)}
                            disabled={busy || loading}
                          >
                            <option value="disabled">标准</option>
                            <option value="enabled">深入</option>
                          </select>
                        </label>
                      )}
                      <span className="composer-spacer" />
                      {accessMode === "each" && config?.modelConfigured && !busy && (
                        <label className="tb-check">
                          <input
                            type="checkbox"
                            checked={consent}
                            onChange={(e) => setConsent(e.target.checked)}
                          />
                          本轮允许外发
                        </label>
                      )}
                      {busy && (
                        <button
                          type="button"
                          className="send-button stop"
                          onClick={stop}
                          aria-label="停止执行"
                        >
                          <Square size={15} />
                        </button>
                      )}
                      {(!busy || canSteer) && (
                        <button
                          className="send-button"
                          type="submit"
                          aria-label={canSteer ? "追加要求" : "发送任务"}
                          disabled={
                            !draft.trim() ||
                            loading ||
                            !config ||
                            uploading ||
                            effectiveConsentRequired && !consent
                          }
                        >
                          <ArrowUp size={19} />
                        </button>
                      )}
                    </div>
                  </form>
                  <div className="composer-note">
                    <span>
                      AI 自动判断直接回答还是整理成草稿；整理产出均为待复核草稿
                      {!config?.modelConfigured && (
                        <>
                          {" · "}
                          <button
                            className="text-button"
                            onClick={() => setModal("model")}
                          >
                            未配置模型，点击配置后使用 AI Agent
                          </button>
                        </>
                      )}
                    </span>
                    <span>Enter 发送 · Shift + Enter 换行</span>
                  </div>
                </div>
                )}
              </main>
              <aside id="task-reference-panel" aria-label="资料与文件" className={`inspector ${inspector ? "open" : ""}`}>
                <div className="inspector-head">
                  <b>资料与文件</b>
                  <IconButton
                    title="关闭材料面板"
                    onClick={() => setInspector(false)}
                  >
                    <X size={16} />
                  </IconButton>
                </div>
                <div className="panel-tabs" role="tablist">
                  {[
                    ["materials", "患者资料"],
                    ["results", "已保存结果"],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      role="tab"
                      aria-selected={tab === key}
                      className={tab === key ? "active" : ""}
                      onClick={() =>
                        key === "events" ? session && openAudit() : setTab(key)
                      }
                    >
                      {key === "materials" && !session?.patientId ? "任务资料" : label}
                    </button>
                  ))}
                </div>
                <div className="panel-scroll">
                  {tab === "results" &&
                    session?.patientId &&
                    session.artifacts.some(
                      (artifact) => artifact.status === "approved",
                    ) && (
                      <div className="next-workflow">
                        <b>继续这位患者的工作</b>
                        <p>已复核的成果保留在病例工作区，可继续安排随访。</p>
                        <button
                          className="secondary"
                          onClick={() =>
                            openPatient({
                              id: session.patientId,
                              tab: "followups",
                            })
                          }
                        >
                          <CalendarClock size={14} />
                          安排随访
                        </button>
                      </div>
                    )}
                  {tab === "materials" && (
                    <>
                      {citation && (
                        <div className="source-preview">
                          <button
                            className="text-button"
                            onClick={() => setCitation(null)}
                          >
                            ← 返回材料
                          </button>
                          <h3>
                            {citation.sourceName}
                            {citation.page ? ` · P${citation.page}` : ""} · L
                            {citation.line}
                          </h3>
                          <pre>
                            {(fileContent || citation.quote || "")
                              .split("\n")
                              .map((line, i) => (
                                <span
                                  key={i}
                                  className={
                                    i + 1 === citation.line ? "highlight" : ""
                                  }
                                >
                                  {i + 1} {line}
                                  {"\n"}
                                </span>
                              ))}
                          </pre>
                        </div>
                      )}
                      {!citation && (
                        <>
                          <div className="panel-section-head">
                            <h3>
                              本会话材料 · 本轮选中 {selectedFileIds.length} 份
                            </h3>
                            <IconButton
                              title="添加会话材料"
                              disabled={busy || !config}
                              onClick={() => fileRef.current?.click()}
                            >
                              <Plus size={15} />
                            </IconButton>
                          </div>
                          {session?.files.length > 0 && (
                            <form
                              className="material-search"
                              onSubmit={async (e) => {
                                e.preventDefault();
                                try {
                                  const value = await api(
                                    `/api/sessions/${activeId}/search?q=${encodeURIComponent(materialQuery)}`,
                                  );
                                  setMaterialMatches(value.matches);
                                } catch (err) {
                                  setError(err.message);
                                }
                              }}
                            >
                              <input
                                aria-label="检索本会话材料"
                                placeholder="在本会话材料中检索"
                                value={materialQuery}
                                onChange={(e) => {
                                  setMaterialQuery(e.target.value);
                                  if (!e.target.value) setMaterialMatches(null);
                                }}
                              />
                              <button
                                className="icon-button"
                                aria-label="检索材料"
                                disabled={!materialQuery.trim()}
                              >
                                <Search size={15} />
                              </button>
                            </form>
                          )}
                          {materialMatches && (
                            <div className="material-matches">
                              <p>
                                找到 {materialMatches.length}{" "}
                                条原文匹配（仅本会话）
                              </p>
                              {materialMatches.map((match, i) => (
                                <button
                                  key={i}
                                  onClick={() => setCitation(match)}
                                >
                                  <b>
                                    {match.sourceName}
                                    {match.page ? ` · P${match.page}` : ""} · L
                                    {match.line}
                                  </b>
                                  <span>{match.quote}</span>
                                </button>
                              ))}
                            </div>
                          )}
                          {!session?.files.length ? (
                            <div className="panel-empty">
                              <FolderOpen size={29} />
                              <h3>原文是每次整理的起点</h3>
                              <p>
                                支持
                                图片（PNG/JPG/WebP，≤4MB）、PDF（≤20MB，文字层最多300页、扫描页最多30页）、Word、Excel（≤20MB）及 TXT、Markdown、CSV、JSON（≤2MB）。扫描资料可使用本地 OCR 读取。
                              </p>
                              <button
                                className="secondary"
                                disabled={!config}
                                onClick={() => fileRef.current?.click()}
                              >
                                导入材料
                              </button>
                            </div>
                          ) : (
                            session.files.map((file) => (
                              <div className="file-card" key={file.id}>
                                <div>
                                  <input
                                    className="file-selection"
                                    type="checkbox"
                                    aria-label={`本轮使用 ${file.name}`}
                                    checked={selectedFileIds.includes(file.id)}
                                    disabled={busy || loading}
                                    onChange={() => {
                                      if (
                                        !selectedFileIds.includes(file.id) &&
                                        selectedFileIds.length >= 10
                                      ) {
                                        setError(
                                          "每轮最多选择 10 份材料，请先取消一项。",
                                        );
                                        return;
                                      }
                                      setConsent(false);
                                      setFileSelection((prev) => ({
                                        ...prev,
                                        [activeId]: selectedFileIds.includes(
                                          file.id,
                                        )
                                          ? selectedFileIds.filter(
                                              (id) => id !== file.id,
                                            )
                                          : [...selectedFileIds, file.id],
                                      }));
                                    }}
                                  />
                                  <FileText size={17} />
                                  <button
                                    onClick={() =>
                                      setCitation({
                                        sourceId: file.id,
                                        sourceName: file.name,
                                        line: 1,
                                      })
                                    }
                                  >
                                    {file.name}
                                  </button>
                                  <IconButton
                                    title={`删除材料 ${file.name}`}
                                    disabled={busy || loading}
                                    onClick={async () => {
                                      try {
                                        await api(
                                          `/api/sessions/${activeId}/files/${file.id}`,
                                          { method: "DELETE" },
                                        );
                                        setConsent(false);
                                        await updateSession();
                                      } catch (err) {
                                        setError(err.message);
                                      }
                                    }}
                                  >
                                    <X size={14} />
                                  </IconButton>
                                </div>
                                <small>
                                  {(file.size / 1024).toFixed(1)} KB ·{" "}
                                  {file.text.split("\n").length} 行
                                </small>
                                <MaterialDetails file={file} sessionId={activeId} />
                                <p className="file-preview">
                                  {file.extraction?.type === "image" ? "原图已保存。提问时可识别病历文字；模糊内容和数值请对照原图核对。" : file.text.replace(/\n\[PDF 第 \d+ 页扫描图\] artifactId:.*$/gm, "").slice(0, 110)}
                                </p>
                              </div>
                            ))
                          )}
                          <div className="panel-boundary">
                            <ShieldCheck size={16} />
                            <p>
                              <b>发送前请确认材料范围</b>
                              材料以原文保存和处理；开启模型辅助时将原文外发，请自行确认不包含不应离开本机的信息。
                            </p>
                          </div>
                        </>
                      )}
                    </>
                  )}
                  {tab === "knowledge" && (
                    <div className="panel-knowledge">
                      <form
                        className="material-search"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (!kQuery.trim()) return;
                          setKBusy(true);
                          try {
                            const value = await api(
                              `/api/knowledge/search?q=${encodeURIComponent(kQuery)}&limit=8`,
                            );
                            setKHits(value.hits);
                          } catch (err) {
                            setError(err.message);
                          } finally {
                            setKBusy(false);
                          }
                        }}
                      >
                        <input
                          aria-label="检索知识库"
                          placeholder="在知识库中检索，引用会带出处进入对话"
                          value={kQuery}
                          onChange={(e) => setKQuery(e.target.value)}
                        />
                        <button className="icon-button" aria-label="检索知识库" disabled={!kQuery.trim() || kBusy}>
                          <Search size={15} />
                        </button>
                      </form>
                      {(kHits || []).map((hit, i) => (
                        <div className="kb-hit" key={`${hit.docId}-${hit.ord}-${i}`}>
                          <div className="kb-hit-t">
                            <b>{hit.docTitle}</b>
                            <small>
                              {hit.kind || "知识"} · L{hit.startLine}–{hit.endLine}
                            </small>
                          </div>
                          {(hit.matches || []).slice(0, 2).map((m) => (
                            <p className="kb-hit-m" key={m.lineNo}>
                              <span>L{m.lineNo}</span>
                              {m.text}
                            </p>
                          ))}
                          <button
                            className="mini-btn"
                            onClick={() => {
                              const cite = `\n【参考：${hit.docTitle} L${hit.startLine}–${hit.endLine}】${(hit.matches || [])[0]?.text || ""}`;
                              setDraft((d) => (d ? d + cite : cite.trim()));
                              inputRef.current?.focus();
                            }}
                          >
                            引用进对话
                          </button>
                        </div>
                      ))}
                      {kHits && !kHits.length && (
                        <p className="muted">没有匹配的知识条目。可在「工具箱 → 知识库」上传指南。</p>
                      )}
                      {!kHits && (
                        <p className="muted">输入关键词检索本地知识库；命中可一键引用进对话，出处随答案保留。</p>
                      )}
                    </div>
                  )}
                  {tab === "results" && (
                    <>
                      <p className="muted">{session?.patientId ? "这位患者历次任务保存的结果。本次回答已在左侧展示。" : "这个任务保存的结果文件。"}</p>
                      {session?.artifacts.length > 1 && (
                        <select
                          className="artifact-select"
                          aria-label="选择已保存结果"
                          value={selectedArtifact?.id}
                          onChange={(e) => setArtifactId(e.target.value)}
                        >
                          {session.artifacts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {artifactTitle(a) || "未命名结果"} · {STATUS[a.status]}
                            </option>
                          ))}
                        </select>
                      )}
                      <ArtifactView
                        artifact={selectedArtifact}
                        onSource={openSource}
                        onOpen={() => {
                          setArtifactId(selectedArtifact.id);
                          setAcceptId(selectedArtifact.id);
                        }}
                        onReview={async (body) => {
                          await api(
                            `/api/sessions/${activeId}/artifacts/${selectedArtifact.id}/review`,
                            { method: "POST", body: JSON.stringify(body) },
                          );
                          await updateSession();
                        }}
                        onEdit={async (body) => {
                          await api(
                            `/api/sessions/${activeId}/artifacts/${selectedArtifact.id}`,
                            { method: "PATCH", body: JSON.stringify(body) },
                          );
                          await updateSession();
                        }}
                      />
                    </>
                  )}
                  {tab === "events" && (
                    <>
                      <h3 className="panel-title">执行过程</h3>
                      {session?.runs
                        .slice()
                        .reverse()
                        .map((run) => (
                          <div className="run-card" key={run.id}>
                            <div>
                              <Badge status={run.status} />
                              <small>
                                {new Date(run.startedAt).toLocaleTimeString(
                                  "zh-CN",
                                )}
                              </small>
                            </div>
                            <p>
                              {INTENTS[run.policy?.intent] || "医疗任务"} ·{" "}
                              {run.mode === "local" ? "本地整理" : "Agent 执行"}
                            </p>
                            <p>{session.messages.find(m => m.role === "user" && m.runId === run.id)?.content}</p>
                            <details className="run-conversation">
                              <summary>查看这次任务的对话</summary>
                              {session.messages.filter(m => m.runId === run.id).map((m, index) => (
                                <article key={m.id || index} className="history-message">
                                  <b>{m.role === "user" ? "你的提问" : "医疗工作助理"}</b>
                                  <RichMessage text={m.content} />
                                </article>
                              ))}
                            </details>
                            {["failed", "cancelled", "interrupted"].includes(run.status) && renderIncompleteRun(run, true)}
                            {(run.children || []).map((child) => (
                              <div className="child-run" key={child.id}>
                                <span>{child.name}</span>
                                <Badge status={child.status} />
                                {child.error && <p>{child.error}</p>}
                              </div>
                            ))}
                            <details>
                              <summary>查看过程与来源版本</summary>
                              {(run.events || []).map((event) => (
                                <p className="event-line" key={event.seq}>
                                  <span>{event.seq}</span>
                                  {eventLabel(event)}
                                </p>
                              ))}
                              {(run.sourceHashes || []).map((s) => (
                                <code className="hash" key={s.id}>
                                  SHA256 {s.hash.slice(0, 16)}…
                                </code>
                              ))}
                            </details>
                          </div>
                        ))}
                      <h3 className="panel-title">本地审计记录</h3>
                      {audit.slice(0, 25).map((a) => (
                        <div className="audit-row" key={a.id}>
                          <span>{a.action}</span>
                          <small>
                            {new Date(a.time).toLocaleTimeString("zh-CN")}
                          </small>
                        </div>
                      ))}
                    </>
                  )}
                </div>
                <details className="inspector-more">
                  <summary>更多工具</summary>
                  <button className="text-button" aria-pressed={tab === "knowledge"} onClick={() => setTab("knowledge")}>查询知识库</button>
                  <button className="text-button" aria-pressed={tab === "events"} onClick={() => session && openAudit()}>运行记录与历史任务</button>
                </details>
              </aside>
            </div>
          )}
        </div>
      </div>
      {notice && (
        <div className="notice" role="status">
          {notice}
          <IconButton title="关闭提示" onClick={() => setNotice("")}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      {modal === "model" && (
        <Modal title="切换模型" onClose={() => setModal(null)}>
          <ModelSettings
            onClose={() => setModal(null)}
            onSaved={async () => {
              await init();
            }}
          />
        </Modal>
      )}
      {modal === "doctor" && (
        <Modal
          title="医生档案与记忆"
          onClose={() => {
            setModal(null);
            api("/api/doctor/profile")
              .then((p) => setDoctorMemCount(p.counts?.active ?? p.counts?.confirmed ?? 0))
              .catch(() => {});
          }}
          wide
        >
          <DoctorProfilePanel config={config} />
        </Modal>
      )}
      {modal === "tasks" && session && (
        <Modal title="计划任务与沙箱" onClose={() => setModal(null)}>
          <TaskCenter
            session={session}
            fileIds={selectedFileIds}
            config={config}
            onChanged={updateSession}
            onSandbox={(code) => {
              setModal(null);
              send(null, {
                message: "对选中医疗资料进行沙箱计算，结果待复核。",
                mode: "local",
                delegations: [],
                sandboxCode: code,
              });
            }}
          />
        </Modal>
      )}
      {modal === "delete" && (
        <Modal title="删除这个工作会话？" onClose={() => setModal(null)}>
          <p>
            会话、导入材料、产物与本会话审计记录将一并删除。此操作无法撤销。
          </p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setModal(null)}>
              保留会话
            </button>
            <button className="danger" onClick={deleteSession}>
              确认删除
            </button>
          </div>
        </Modal>
      )}
      {modal === "rename" && (
        <Modal title="重命名会话" onClose={() => setModal(null)}>
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(`/api/sessions/${activeId}`, {
                  method: "PATCH",
                  body: JSON.stringify({
                    title: new FormData(e.currentTarget).get("title"),
                  }),
                });
                await updateSession();
                setModal(null);
              } catch (err) {
                setError(err.message);
              }
            }}
          >
            <label>
              会话名称
              <input
                name="title"
                defaultValue={session.title}
                required
                maxLength={100}
                autoFocus
              />
            </label>
            <button className="primary">保存</button>
          </form>
        </Modal>
      )}
      {modal === "export" && (
        <Modal title="导出工作记录" onClose={() => setModal(null)}>
          <p>导出包含草稿状态、复核记录和来源。未复核的产物会标为待复核。</p>
          <div className="modal-actions">
            {["md", "json"].map((format) => (
              <button
                key={format}
                className="secondary"
                onClick={async () => {
                  try {
                    await downloadSession(session, format);
                    setModal(null);
                  } catch (err) {
                    setError(err.message);
                  }
                }}
              >
                <Download size={15} />
                {format === "md" ? "Markdown" : "JSON"}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
