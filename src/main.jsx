import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowUp,
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
} from "lucide-react";
import { api, bootstrap, streamTurn, downloadSession } from "./agent-runtime";
import { artifactLines, artifactTitle, INTENTS } from "../shared/medical.mjs";
import "./style.css";
import { importMaterial } from "./import-material";
import { TaskCenter } from "./task-center";
import { PatientsView } from "./patients";
import { WorkspacesView } from "./workspaces";
import { WorkbenchHome } from "./workbench-home";
import { RichMessage } from "./workbench/message";
import { DoctorProfilePanel } from "./doctor-profile";
import { LiteratureView } from "./literature";
import { KnowledgeView } from "./knowledge";
import { FollowupsView } from "./followups";
import { CasesView } from "./cases";
import { ResearchView } from "./research";
import { DrgView } from "./drg";
import { ClinicalRefView } from "./clinical-ref";
import { IconButton, Badge, Modal, STATUS } from "./components";
import { ModelSettings } from "./model-settings";
import {
  AcceptanceView,
  GoalCard,
  MemoryNote,
  PatientSummaryCard,
  PatientSwitcher,
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
    "context.compacting": "上下文接近预算，正在压缩历史",
    "context.compacted": `历史已压缩${
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
function ArtifactView({ artifact, onReview, onEdit, onSource }) {
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
      <h3>{artifactTitle(artifact) || "未命名产物"}</h3>
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
      {artifact.matches?.map((match, i) => (
        <blockquote key={i}>
          <p>{match.quote}</p>
          <button className="source-link" onClick={() => onSource(match)}>
            {match.sourceName}
            {match.page ? ` · P${match.page}` : ""} · L{match.line}
          </button>
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
      {!artifact.events &&
        !artifact.pico &&
        !artifact.matches &&
        !artifact.observations && (
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
      {artifact.limitations?.map((x) => (
        <p className="boundary" key={x}>
          {x}
        </p>
      ))}
      {artifact.review && (
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
  const [config, setConfig] = useState(null),
    [sessions, setSessions] = useState([]),
    [session, setSession] = useState(null),
    [activeId, setActiveId] = useState(""),
    [draft, setDraft] = useState(""),
    [consent, setConsent] = useState(false);
  const [accessMode, setAccessMode] = useState("auto");
  const [thinking, setThinking] = useState("disabled");
  const [pickedSkills, setPickedSkills] = useState([]),
    [mention, setMention] = useState(null),
    [mentionIndex, setMentionIndex] = useState(0);
  const [view, setView] = useState("home");
  const [workspaceTarget, setWorkspaceTarget] = useState(null);
  const [activeWsId, setActiveWsId] = useState("");
  const [wsList, setWsList] = useState([]);
  const [patientRoute, setPatientRoute] = useState({});
  const [homeKey, setHomeKey] = useState(0);
  const [patientsList, setPatientsList] = useState([]);
  const [currentPatientId, setCurrentPatientId] = useState(
    () => localStorage.getItem("om.currentPatient") || "",
  );
  const [patientDetail, setPatientDetail] = useState(null);
  const [acceptId, setAcceptId] = useState("");
  const [doctorMemCount, setDoctorMemCount] = useState(0);
  const [referencedPatients, setReferencedPatients] = useState([]);
  const [toolPanel, setToolPanel] = useState(null);
  const [kQuery, setKQuery] = useState("");
  const [kHits, setKHits] = useState(null);
  const [kBusy, setKBusy] = useState(false);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [runs, setRuns] = useState({}),
    [tab, setTab] = useState("materials"),
    [artifactId, setArtifactId] = useState(""),
    [audit, setAudit] = useState([]),
    [query, setQuery] = useState("");
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
    [inspector, setInspector] = useState(false),
    [uploading, setUploading] = useState(false),
    [homeFileCount, setHomeFileCount] = useState(0),
    [citation, setCitation] = useState(null);
  const inputRef = useRef(),
    fileRef = useRef(),
    endRef = useRef(),
    activeRef = useRef(""),
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
            `${skill.name} ${skill.id} ${skill.description || ""}`
              .toLowerCase()
              .includes(mention.query.toLowerCase()),
        )
        .slice(0, 8)
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
  const pickPatientMention = (p) => {
    setDraft((d) => d.replace(/@[^\s@]{0,20}$/, ""));
    setMention(null);
    setReferencedPatients((prev) =>
      prev.some((x) => x.id === p.id) ? prev : [...prev, p],
    );
    inputRef.current?.focus();
  };
  const selectedArtifact =
    session?.artifacts.find((a) => a.id === artifactId) ||
    session?.artifacts.at(-1);
  const acceptArtifact = session?.artifacts.find((a) => a.id === acceptId);
  const selectedFileIds = (
    fileSelection[activeId] ||
    session?.files.map((f) => f.id) ||
    []
  ).filter((id) => session?.files.some((f) => f.id === id));
  const refreshList = async () => {
    const [value, ws, pt] = await Promise.all([
      api("/api/sessions"),
      api("/api/workspaces").catch(() => ({ workspaces: [] })),
      api("/api/patients").catch(() => ({ patients: [] })),
    ]);
    setSessions(value.sessions);
    setWsList(ws.workspaces || []);
    setPatientsList(pt.patients || []);
    return value.sessions;
  };
  const load = async (id) => {
    const version = ++generation.current;
    setLoading(true);
    try {
      const data = await api(`/api/sessions/${id}`);
      if (version === generation.current) {
        setSession(data);
        setMeters((m) => ({ ...m, ...metersFromSession(data) }));
        setArtifactId("");
        setCitation(null);
        return data;
      }
    } catch (err) {
      setError(err.message);
    } finally {
      if (version === generation.current) setLoading(false);
    }
  };
  // 首页附件挂在「待发任务」会话上：离开首页或正式发送后作废
  const resetHomePending = () => {
    homePending.current = null;
    setHomeFileCount(0);
  };
  const select = async (id) => {
    setError("");
    resetHomePending();
    setNotice("");
    setMaterialQuery("");
    setMaterialMatches(null);
    setSession(null);
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
      const list = await refreshList();
      api("/api/doctor/profile")
        .then((p) => setDoctorMemCount(p.counts?.active ?? p.counts?.confirmed ?? 0))
        .catch(() => {});
      if (
        activeRef.current &&
        list.some((item) => item.id === activeRef.current)
      )
        await load(activeRef.current);
      else {
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
  // 当前患者上下文：打开患者会话时跟随；详情供速览卡使用
  useEffect(() => {
    const pid = session?.patientId || currentPatientId;
    if (!pid) {
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
  }, [session?.patientId, currentPatientId]);
  const switchCurrentPatient = (id) => {
    setCurrentPatientId(id);
    localStorage.setItem("om.currentPatient", id || "");
  };
  useEffect(() => {
    if (endRef.current) {
      const pane = endRef.current.parentElement;
      if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 300)
        endRef.current.scrollIntoView({ block: "end" });
    }
  }, [session?.messages.length, activeRun?.partial]);
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
    const data = await api(`/api/sessions/${id}`);
    if (activeRef.current === id) {
      setSession(data);
      setMeters((m) => ({ ...m, ...metersFromSession(data) }));
    }
    await refreshList();
    return data;
  };
  async function send(e, override = {}, refreshedSession, retryOnConflict = false) {
    e?.preventDefault();
    const text = override.message || draft.trim();
    if (!text || loading) return;
    let current = refreshedSession || session;
    if (!current) current = await create();
    if (!current || sendingRef.current.has(current.id)) return;
    const id = current.id;
    sendingRef.current.add(id);
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
                if (activeRef.current === id)
                  setSession((prev) =>
                    prev?.id === s.id && prev.revision > s.revision ? prev : s,
                  );
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
        const data = await api(`/api/sessions/${id}`);
        if (activeRef.current === id) {
          setSession(data);
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
      let current = homePending.current || session;
      if (!current) current = await create();
      if (!current) return;
      for (const file of files) {
        const material = await importMaterial(file);
        await api(`/api/sessions/${current.id}/files`, {
          method: "POST",
          body: JSON.stringify(material),
        });
      }
      setConsent(false);
      await updateSession();
      setTab("materials");
      setNotice("材料已保存。PDF 仅保存抽取文字，表格顺序和空白页需对照原件。");
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
    resetHomePending();
    setSidebar(false);
    setNotice("");
    refreshList().catch((err) => setError(err.message));
  };
  const openWorkspaces = (target = {}) => {
    resetHomePending();
    setWorkspaceTarget(target);
    setActiveWsId(target.id || "");
    setView("workspaces");
  };
  const openPatient = (route = {}) => {
    setPatientRoute(route);
    navigate("patients");
  };
  const openTask = async (id, options = {}) => {
    setView("workbench");
    const data = await select(id);
    if (data) {
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
    setView("workbench");
    if (patient) {
      switchCurrentPatient(patient.id);
      setNotice(
        `任务已在 ${patient.name} 的病例工作区发起，材料范围可在右侧核对。`,
      );
    }
    send(null, { message: prompt, skills }, data);
  };
  const pendingReviews = sessions.reduce(
    (sum, item) => sum + item.reviewCount,
    0,
  );
  const modelEnabled =
    Boolean(config?.modelConfigured) && accessMode !== "local";
  const effectiveConsentRequired = modelEnabled && accessMode === "each";
  const fileContent = citation
    ? session?.files.find((f) => f.id === citation.sourceId)?.text ||
      session?.messages.find((m) => m.id === citation.sourceId)?.content
    : null;
  return (
    <div className="agent-app">
      <a href="#main" className="skip-link">
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
            <Stethoscope size={21} />
          </span>
          <b>Open Medical</b>
          <span className="brand-divider" />
          <span className="brand-caption">医疗工作台</span>
        </div>
        <div className="top-actions">
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
          <PatientSwitcher
            patients={patientsList}
            currentId={currentPatientId}
            onSwitch={(p) => switchCurrentPatient(p.id)}
            onManage={() => navigate("patients")}
          />
          <span className={`connection ${config ? "" : "offline"}`}>
            <i />
            {config ? "本机工作空间" : "连接未就绪"}
          </span>
          <button
            className="meter model-badge"
            title={`当前模型：${config?.model || "未配置"}（${config?.provider || "-"}）；点击切换或配置模型`}
            onClick={() => setModal("model")}
          >
            {config?.model || "未配置模型"}
          </button>
          <IconButton title="运行设置" onClick={() => setModal("settings")}>
            <Settings2 size={18} />
          </IconButton>
          <IconButton
            title="计划任务与沙箱"
            disabled={view !== "workbench" || !session || busy}
            onClick={() => setModal("tasks")}
          >
            <CalendarClock size={18} />
          </IconButton>
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
          <button
            className="new-session"
            onClick={() => {
              setHomeKey((value) => value + 1);
              navigate("home");
            }}
          >
            <Plus size={17} />
            新建任务
          </button>
          <label className="search">
            <Search size={14} />
            <input
              aria-label="搜索任务"
              placeholder="搜索任务"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <p className="nav-label">
            项目
            <button
              className="nav-label-action"
              onClick={() => openWorkspaces({ create: true })}
            >
              ＋ 新建
            </button>
          </p>
          <nav className="sessions" aria-label="项目">
            {wsList
              .filter((item) => !item.archived)
              .sort((a, b) => Number(b.pinned) - Number(a.pinned))
              .slice(0, 8)
              .map((item) => (
                <button
                  className={`session ${
                    view === "workspaces" &&
                    (activeWsId || workspaceTarget?.id) === item.id
                      ? "active"
                      : ""
                  }`}
                  key={item.id}
                  onClick={() => openWorkspaces({ id: item.id })}
                >
                  <FolderOpen size={14} />
                  <span>
                    <b>{item.title}</b>
                    <small>
                      {item.running
                        ? "执行中"
                        : item.pending
                          ? `${item.pending} 项待审批`
                          : "项目工作区"}
                    </small>
                  </span>
                  {item.pinned && <em className="nav-dot" />}
                </button>
              ))}
            {!wsList.filter((item) => !item.archived).length && (
              <p className="sidebar-empty">
                还没有项目。点「＋ 新建」把相关任务归到一起。
              </p>
            )}
          </nav>
          <p className="nav-label">
            今日任务 <span>{sessions.length}</span>
            {pendingReviews > 0 && (
              <button
                className="nav-label-action warn"
                onClick={() => navigate("review")}
              >
                待复核 {pendingReviews}
              </button>
            )}
          </p>
          <nav className="sessions" aria-label="今日任务">
            {sessions
              .filter(
                (item) =>
                  !query ||
                  item.title.toLowerCase().includes(query.toLowerCase()),
              )
              .slice(0, 12)
              .map((item) => (
                <button
                  className={`session ${view === "workbench" && item.id === activeId ? "active" : ""}`}
                  key={item.id}
                  onClick={() => openTask(item.id)}
                >
                  <MessageSquare size={14} />
                  <span>
                    <b>{item.title}</b>
                    <small>
                      {item.running
                        ? "执行中"
                        : item.reviewCount
                          ? `${item.reviewCount} 份待复核`
                          : item.patientId
                            ? "患者工作区"
                            : "独立任务"}
                    </small>
                  </span>
                </button>
              ))}
            {!sessions.length && (
              <p className="sidebar-empty">
                任务与成果会保存在这里，随时继续。
              </p>
            )}
          </nav>
          <p className="nav-label">
            患者
            <button
              className="nav-label-action"
              onClick={() => openPatient()}
            >
              管理
            </button>
          </p>
          <nav className="sessions" aria-label="患者">
            {patientsList.slice(0, 8).map((p) => (
              <button
                key={p.id}
                className={`session ${currentPatientId === p.id ? "active" : ""}`}
                onClick={() => {
                  switchCurrentPatient(p.id);
                  openPatient({ id: p.id });
                }}
              >
                <Stethoscope size={14} />
                <span>
                  <b>{p.name}</b>
                  <small>
                    {p.counts?.dueFollowups
                      ? `${p.counts.dueFollowups} 项随访到期`
                      : p.counts?.unprocessedMessages
                        ? `${p.counts.unprocessedMessages} 条新消息`
                        : "点击查看"}
                  </small>
                </span>
                {(p.counts?.dueFollowups > 0 ||
                  p.counts?.unprocessedMessages > 0) && (
                  <em className="nav-dot" />
                )}
              </button>
            ))}
            {!patientsList.length && (
              <p className="sidebar-empty">还没有患者档案。</p>
            )}
          </nav>
          <p className="nav-label">
            工具箱
            <button
              className="nav-label-action"
              onClick={() => setToolPanel("__menu")}
            >
              打开
            </button>
          </p>
          <p className="sidebar-empty">
            随访 · 病例库 · 速查 · 文献 · 科研 · DRG · 知识库
          </p>
          <button
            className="workspace-account"
            onClick={() => setModal("doctor")}
          >
            <span className="avatar">医</span>
            <span>
              <b>医生记忆</b>
              <small>档案 · 偏好 · 每晚整理</small>
            </span>
            <Settings2 size={15} />
          </button>
        </aside>
        <div className="product-content">
          {view === "workspaces" ? (
            <WorkspacesView
              key={`ws-${homeKey}-${workspaceTarget?.id || ""}-${workspaceTarget?.create || ""}`}
              config={config}
              initialWorkspaceId={workspaceTarget?.id || ""}
              initialCreate={Boolean(workspaceTarget?.create)}
              initialPrompt={workspaceTarget?.prompt || ""}
              onOpenSettings={() => setModal("settings")}
              onMenu={() => setSidebar(!sidebar)}
              onChanged={(id) => {
                if (id) setActiveWsId(id);
                refreshList().catch(() => {});
              }}
            />
          ) : view === "patients" ? (
            <PatientsView
              key={`${patientRoute.id || "list"}-${patientRoute.tab || "overview"}-${patientRoute.create || false}`}
              config={config}
              initialPatientId={patientRoute.id}
              initialTab={patientRoute.tab}
              initialCreate={patientRoute.create}
              onOpenWorkspace={openTask}
              onSwitchCurrent={switchCurrentPatient}
              onChanged={refreshList}
            />
          ) : view === "literature" ? (
            <LiteratureView onOpenTask={openTask} />
          ) : view === "knowledge" ? (
            <KnowledgeView />
          ) : view === "clinical-ref" ? (
            <ClinicalRefView />
          ) : view === "followups" ? (
            <FollowupsView onOpenPatient={(id) => openPatient({ id })} />
          ) : view === "cases" ? (
            <CasesView />
          ) : view === "research" ? (
            <ResearchView />
          ) : view === "drg" ? (
            <DrgView />
          ) : view !== "workbench" ? (
            <WorkbenchHome
              key={homeKey}
              view={view}
              config={config}
              sessions={sessions}
              onStart={prepareTask}
              onOpenTask={openTask}
              onPatient={openPatient}
              onView={navigate}
              onRefresh={refreshList}
              onReconnect={init}
              onOpenProjects={openWorkspaces}
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
              uploading={uploading}
              attachedCount={homeFileCount}
              fileInputRef={fileRef}
              onFilesPicked={upload}
            />
          ) : (
            <div className="shell">
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
                      {session?.patientId ? "患者病例工作区" : "独立医疗任务"}
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
                  <IconButton
                    title="显示材料与产物"
                    onClick={() => setInspector(!inspector)}
                  >
                    <FolderOpen size={18} />
                  </IconButton>
                </div>
                {session && (
                  <div className="task-context-bar">
                    {(session.files.length > 0 ||
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
                    <IconButton
                      title="关闭错误提示"
                      onClick={() => setError("")}
                    >
                      <X size={14} />
                    </IconButton>
                  </div>
                )}
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
                  <div className="message-list">
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
                    {!session?.messages.length && (
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
                          {session?.files.length
                            ? "材料已就绪，可以直接开始。"
                            : "有什么可以帮你？"}
                        </h2>
                        <p>
                          {session?.patientId
                            ? "这位患者的原始材料、任务与成果都保留在当前病例工作区。"
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
                    {session?.messages.map((m) => (
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
                            <span>
                              {m.role === "user"
                                ? "本轮输入"
                                : m.intent === "consultation" ||
                                    (m.intent === undefined &&
                                      !session?.runs?.find((r) => r.id === m.runId)
                                        ?.artifacts?.length)
                                  ? "咨询回复"
                                  : "工作草稿"}
                            </span>
                          </div>
                          <div className="message-content">
                            {m.role === "user" ? (
                              m.content
                            ) : (
                              <RichMessage text={m.content} />
                            )}
                          </div>
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
                    {(busy || session?.artifacts.length > 0) &&
                      (/时间线|检验|用药|病历|文书|整理|总结/.test(
                        session?.messages.findLast((m) => m.role === "user")?.content || "",
                      ) ||
                        busy ||
                        session?.artifacts.length > 0) && (
                        <GoalCard
                          message={session?.messages.findLast((m) => m.role === "user")?.content || ""}
                          running={busy}
                          artifacts={session?.artifacts || []}
                          round={session?.runs.length || 1}
                          onStop={stop}
                        />
                      )}
                    {busy && (
                      <article className="message">
                        <div className="message-avatar">
                          <Loader2 className="spin" size={17} />
                        </div>
                        <div className="message-body">
                          <StepsFlow
                            events={activeRun?.events || []}
                            running={busy}
                            fallbackText="正在思考并调用工具…"
                          />
                          {(activeRun?.partial || persistedRunning?.partial) && (
                            <div className="message-content streaming">
                              <RichMessage
                                text={
                                  activeRun?.partial ||
                                  persistedRunning?.partial
                                }
                              />
                            </div>
                          )}
                        </div>
                      </article>
                    )}
                    {!busy &&
                      (session?.artifacts.length || 0) > 0 &&
                      session.artifacts
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
                                打开验收视图
                              </button>
                            </div>
                          </div>
                        ))}
                    {session?.runs
                      .filter((r) =>
                        ["failed", "cancelled", "interrupted"].includes(
                          r.status,
                        ),
                      )
                      .map((r) => (
                        <div className="incomplete-run" key={r.id}>
                          <Badge status={r.status} />
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
                          {r.partial && (
                            <details>
                              <summary>查看保留的部分内容</summary>
                              <p>{r.partial}</p>
                            </details>
                          )}
                        </div>
                      ))}
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
                                pickPatientMention(p);
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
                            {skill?.name || id}
                            <button
                              type="button"
                              aria-label={`移除技能 ${skill?.name || id}`}
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
                  <form className="composer" onSubmit={send}>
                    <textarea
                      ref={inputRef}
                      aria-label="医疗工作需求"
                      rows={3}
                      placeholder="输入问题或任务，如「血糖有点高，27 岁男生，怎么办」；输入 @ 可固定技能…"
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
                      disabled={busy || loading}
                    />
                    <div className="composer-bottom">
                      <button
                        type="button"
                        className="attach-button"
                        title="添加材料：TXT / Markdown / CSV / JSON / PDF"
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
                        accept=".txt,.md,.csv,.json,.pdf"
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
                      {busy ? (
                        <button
                          type="button"
                          className="send-button stop"
                          onClick={stop}
                          aria-label="停止执行"
                        >
                          <Square size={15} />
                        </button>
                      ) : (
                        <button
                          className="send-button"
                          aria-label="发送任务"
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
              <aside className={`inspector ${inspector ? "open" : ""}`}>
                <div className="inspector-head">
                  <b>材料与成果</b>
                  <span>{session?.files.length || 0} 份材料</span>
                  <IconButton
                    title="关闭材料面板"
                    onClick={() => setInspector(false)}
                  >
                    <X size={16} />
                  </IconButton>
                </div>
                <div className="panel-tabs" role="tablist">
                  {[
                    ["materials", "材料"],
                    ["knowledge", "知识"],
                    ["results", "产物"],
                    ["events", "执行记录"],
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
                      {label}
                      {key === "results" && session?.artifacts.length > 0 && (
                        <span>{session.artifacts.length}</span>
                      )}
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
                                TXT、Markdown、CSV、JSON（≤2MB），以及可选文字的
                                PDF（≤20MB / 300 页）。材料自动建立本地检索索引。
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
                                {file.extraction && (
                                  <small>
                                    PDF 文本 · {file.extraction.pageCount} 页 ·
                                    未保存原件
                                    {file.extraction.emptyPages.length
                                      ? ` · 第 ${file.extraction.emptyPages.join("、")} 页无文字`
                                      : ""}
                                  </small>
                                )}
                                <p className="file-preview">
                                  {file.text.slice(0, 110)}
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
                      {session?.artifacts.length > 1 && (
                        <select
                          className="artifact-select"
                          aria-label="选择产物"
                          value={selectedArtifact?.id}
                          onChange={(e) => setArtifactId(e.target.value)}
                        >
                          {session.artifacts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {artifactTitle(a) || "未命名产物"} · {STATUS[a.status]}
                            </option>
                          ))}
                        </select>
                      )}
                      <ArtifactView
                        artifact={selectedArtifact}
                        onSource={openSource}
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
                              {INTENTS[run.policy.intent]} ·{" "}
                              {run.mode === "local" ? "本地整理" : "Agent 执行"}
                            </p>
                            {(run.children || []).map((child) => (
                              <div className="child-run" key={child.id}>
                                <span>{child.name}</span>
                                <Badge status={child.status} />
                                {child.error && <p>{child.error}</p>}
                              </div>
                            ))}
                            <details>
                              <summary>查看过程与来源版本</summary>
                              {run.events.map((event) => (
                                <p className="event-line" key={event.seq}>
                                  <span>{event.seq}</span>
                                  {eventLabel(event)}
                                </p>
                              ))}
                              {run.sourceHashes.map((s) => (
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
                <div className="inspector-footer">
                  <Activity size={13} />
                  <span>材料与复核记录保存在本机</span>
                  <span className="version">0.3</span>
                </div>
              </aside>
            </div>
          )}
        </div>
      </div>
      {toolPanel && (
        <>
          <div
            className="tool-slide-scrim"
            onClick={() => setToolPanel(null)}
            aria-hidden
          />
          <aside className="tool-slide" aria-label="工具箱面板">
            <div className="ts-head">
              <b>工具箱</b>
              {toolPanel !== "__menu" && (
                <button
                  className="text-button"
                  onClick={() => setToolPanel("__menu")}
                >
                  ‹ 工具列表
                </button>
              )}
              <IconButton title="关闭工具面板" onClick={() => setToolPanel(null)}>
                <X size={16} />
              </IconButton>
            </div>
            <div className="ts-body">
              {toolPanel === "__menu" ? (
                <div className="ts-menu">
                  {[
                    ["followups", "随访计划", "到期提醒与计划"],
                    ["cases", "病例库", "相似病例检索"],
                    ["clinical-ref", "临床速查", "量表 · 检验 · 编码 · ADR"],
                    ["knowledge", "知识库", "指南导入与检索"],
                    ["literature", "文献检索", "PubMed 检索与导入"],
                    ["research", "科研统计", "统计工具"],
                    ["drg", "DRG 测算", "入组与测算"],
                  ].map(([id, label, desc]) => (
                    <button key={id} onClick={() => setToolPanel(id)}>
                      <span>
                        <b>{label}</b>
                        <small>{desc}</small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <div className="ts-open">
                    <button
                      className="secondary"
                      onClick={() => {
                        const v = toolPanel;
                        setToolPanel(null);
                        navigate(v);
                      }}
                    >
                      整页打开 {toolPanel}
                    </button>
                  </div>
                  {toolPanel === "followups" && (
                    <FollowupsView
                      onOpenPatient={(id) => {
                        setToolPanel(null);
                        openPatient({ id });
                      }}
                    />
                  )}
                  {toolPanel === "cases" && <CasesView />}
                  {toolPanel === "clinical-ref" && <ClinicalRefView />}
                  {toolPanel === "knowledge" && <KnowledgeView />}
                  {toolPanel === "literature" && (
                    <LiteratureView
                      onOpenTask={(id) => {
                        setToolPanel(null);
                        openTask(id);
                      }}
                    />
                  )}
                  {toolPanel === "research" && <ResearchView />}
                  {toolPanel === "drg" && <DrgView />}
                </>
              )}
            </div>
          </aside>
        </>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
          <IconButton title="关闭提示" onClick={() => setNotice("")}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      {modal === "settings" && (
        <Modal title="运行设置" onClose={() => setModal(null)}>
          <div className="settings-body">
            <p>
              医疗策略、会话、资料与复核在本地运行时管理。模型只承担辅助推理。
            </p>
            <p className="boundary">
              {config?.modelConfigured
                ? `当前模型：${config.provider || "model"} · ${config.model}`
                : "尚未配置模型，点击「切换模型」配置后使用 AI Agent。"}
            </p>
            <div className="modal-actions">
              <button className="primary" onClick={() => setModal("model")}>
                切换模型
              </button>
              <button className="secondary" onClick={() => setModal("doctor")}>
                医生档案与记忆
              </button>
              <button
                className="secondary"
                onClick={async () => {
                  await init();
                  setModal(null);
                }}
              >
                刷新连接状态
              </button>
            </div>
          </div>
        </Modal>
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
