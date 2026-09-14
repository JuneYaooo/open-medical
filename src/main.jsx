import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  LayoutDashboard,
  Users,
  CheckCheck,
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
} from "lucide-react";
import { api, bootstrap, streamTurn, downloadSession } from "./agent-runtime";
import { artifactLines, INTENTS } from "../shared/medical.mjs";
import "./style.css";
import { importMaterial } from "./import-material";
import { TaskCenter } from "./task-center";
import { PatientsView } from "./patients";
import { WorkspacesView } from "./workspaces";
import { WorkbenchHome } from "./workbench-home";
import { ModuleView, MODULE_VIEW_IDS } from "./module-skeletons";
import { DoctorProfilePanel } from "./doctor-profile";
import { LiteratureView } from "./literature";
import { GuidelinesView } from "./guidelines";
import { FollowupsView } from "./followups";
import { IconButton, Badge, Modal, STATUS } from "./components";
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
      <h3>{artifact.title}</h3>
      <p className="muted">
        {artifact.provenance === "local_rule" ? "本地规则整理" : "待核查草稿"} ·{" "}
        {new Date(artifact.createdAt).toLocaleString("zh-CN")}
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
    [mode, setMode] = useState("local"),
    [consent, setConsent] = useState(false);
  const [team, setTeam] = useState(false);
  const [view, setView] = useState("workspaces");
  const [patientRoute, setPatientRoute] = useState({});
  const [homeKey, setHomeKey] = useState(0);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [runs, setRuns] = useState({}),
    [tab, setTab] = useState("materials"),
    [artifactId, setArtifactId] = useState(""),
    [audit, setAudit] = useState([]),
    [query, setQuery] = useState("");
  const [fileSelection, setFileSelection] = useState({}),
    [materialQuery, setMaterialQuery] = useState(""),
    [materialMatches, setMaterialMatches] = useState(null);
  const [modal, setModal] = useState(null),
    [sidebar, setSidebar] = useState(false),
    [inspector, setInspector] = useState(false),
    [uploading, setUploading] = useState(false),
    [citation, setCitation] = useState(null);
  const inputRef = useRef(),
    fileRef = useRef(),
    endRef = useRef(),
    activeRef = useRef(""),
    generation = useRef(0),
    sendingRef = useRef(new Set());
  const activeRun = runs[activeId];
  const persistedRunning = session?.runs.findLast(
    (r) => r.status === "running",
  );
  const busy = Boolean(activeRun?.busy || persistedRunning);
  const selectedArtifact =
    session?.artifacts.find((a) => a.id === artifactId) ||
    session?.artifacts.at(-1);
  const selectedFileIds = (
    fileSelection[activeId] ||
    session?.files.slice(0, 10).map((f) => f.id) ||
    []
  ).filter((id) => session?.files.some((f) => f.id === id));
  const refreshList = async () => {
    const value = await api("/api/sessions");
    setSessions(value.sessions);
    return value.sessions;
  };
  const load = async (id) => {
    const version = ++generation.current;
    setLoading(true);
    try {
      const data = await api(`/api/sessions/${id}`);
      if (version === generation.current) {
        setSession(data);
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
  const select = async (id) => {
    setError("");
    setNotice("");
    setMaterialQuery("");
    setMaterialMatches(null);
    setSession(null);
    activeRef.current = id;
    setActiveId(id);
    setDraft("");
    setConsent(false);
    setMode("local");
    setTeam(false);
    setSidebar(false);
    return load(id);
  };
  const init = async () => {
    setError("");
    setLoading(true);
    try {
      const value = await bootstrap(true);
      setConfig(value);
      const list = await refreshList();
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
  useEffect(() => {
    if (endRef.current) {
      const pane = endRef.current.parentElement;
      if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 300)
        endRef.current.scrollIntoView({ block: "end" });
    }
  }, [session?.messages.length, activeRun?.partial]);
  useEffect(() => {
    if (!activeId || activeRun?.busy) return;
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
      setLoading(false);
      setDraft("");
      setConsent(false);
      setSidebar(false);
      setArtifactId("");
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
    if (activeRef.current === id) setSession(data);
    await refreshList();
  };
  async function send(e, override = {}) {
    e?.preventDefault();
    const text = override.message || draft.trim();
    if (!text || loading) return;
    let current = session;
    if (!current) current = await create();
    if (!current || sendingRef.current.has(current.id)) return;
    const id = current.id;
    sendingRef.current.add(id);
    setError("");
    setNotice("");
    setDraft("");
    setConsent(false);
    setRuns((prev) => ({
      ...prev,
      [id]: { busy: true, partial: "", events: [] },
    }));
    let started = false;
    try {
      await streamTurn(
        id,
        {
          message: text,
          mode,
          externalConsent: consent,
          delegations: team ? ["timeline", "observations", "medication"] : [],
          ...override,
          sessionRevision: current.revision,
          fileIds: (
            fileSelection[current.id] ||
            current.files.slice(0, 10).map((f) => f.id)
          ).filter((id) => current.files.some((f) => f.id === id)),
          requestId: crypto.randomUUID(),
        },
        (event) => {
          started = true;
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
          if (event.type === "message.complete" && activeRef.current === id)
            setTab("results");
        },
      );
    } catch (err) {
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
        if (activeRef.current === id) setSession(data);
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
      let current = session;
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
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
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
    }
  };
  const prepareTask = async ({ prompt, patient, title }) => {
    const data = patient
      ? await select(patient.sessionId)
      : await create(title);
    if (!data) throw new Error("任务准备失败，请刷新连接后重试。");
    setDraft(prompt);
    setMode("local");
    setTeam(false);
    setConsent(false);
    setTab("materials");
    setInspector(false);
    setView("workbench");
    setNotice(
      patient
        ? `已进入 ${patient.name} 的病例工作区，请核对本次材料。`
        : "任务已准备好，添加材料后即可开始整理。",
    );
  };
  const pendingReviews = sessions.reduce(
    (sum, item) => sum + item.reviewCount,
    0,
  );
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
          <span className={`connection ${config ? "" : "offline"}`}>
            <i />
            {config ? "本机工作空间" : "连接未就绪"}
          </span>
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
              navigate(view === "workspaces" ? "workspaces" : "home");
            }}
          >
            <Plus size={17} />
            {view === "workspaces" ? "新建工作区" : "新建任务"}
          </button>
          <nav className="primary-navigation" aria-label="主导航">
            {[
              [
                "工作台",
                [
                  ["home", "医疗工作台", LayoutDashboard],
                  ["workspaces", "通用 Agent", FolderOpen],
                ],
              ],
              [
                "临床",
                [
                  ["patients", "患者档案", Users],
                  ["followups", "随访管理", CalendarClock],
                  ["cases", "病例库", FileText],
                ],
              ],
              [
                "知识",
                [
                  ["literature", "文献检索", BookOpen],
                  ["guidelines", "指南库", BookOpen],
                ],
              ],
              [
                "科研",
                [
                  ["research", "数据分析", Activity],
                  ["drg", "DRG 测算", ClipboardList],
                ],
              ],
              [
                "系统",
                [
                  ["tasks", "任务记录", FolderOpen],
                  ["review", "待复核", CheckCheck],
                ],
              ],
            ].map(([group, items]) => (
              <div className="nav-group" key={group}>
                <p className="nav-group-label">{group}</p>
                {items.map(([id, label, Icon]) => (
                  <button
                    key={id}
                    className={view === id ? "active" : ""}
                    aria-current={view === id ? "page" : undefined}
                    onClick={() =>
                      id === "patients" ? openPatient() : navigate(id)
                    }
                  >
                    <Icon size={17} />
                    <span>{label}</span>
                    {id === "review" && pendingReviews > 0 && <em>{pendingReviews}</em>}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <label className="search">
            <Search size={14} />
            <input
              aria-label="搜索工作任务"
              placeholder="搜索最近任务"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <p className="nav-label">
            最近任务 <span>{sessions.length}</span>
          </p>
          <nav className="sessions" aria-label="最近任务">
            {sessions
              .filter((item) =>
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
          <button
            className="workspace-account"
            onClick={() => setModal("settings")}
          >
            <span className="avatar">医</span>
            <span>
              <b>个人工作空间</b>
              <small>Open Medical · 本机版</small>
            </span>
            <Settings2 size={15} />
          </button>
        </aside>
        <div className="product-content">
          {view === "workspaces" ? (
            <WorkspacesView key={homeKey} config={config} />
          ) : view === "patients" ? (
            <PatientsView
              key={`${patientRoute.id || "list"}-${patientRoute.tab || "overview"}-${patientRoute.create || false}`}
              config={config}
              initialPatientId={patientRoute.id}
              initialTab={patientRoute.tab}
              initialCreate={patientRoute.create}
              onOpenWorkspace={openTask}
            />
          ) : view === "literature" ? (
            <LiteratureView onOpenTask={openTask} />
          ) : view === "guidelines" ? (
            <GuidelinesView />
          ) : view === "followups" ? (
            <FollowupsView onOpenPatient={(id) => openPatient({ id })} />
          ) : MODULE_VIEW_IDS.includes(view) ? (
            <ModuleView view={view} onView={navigate} />
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
                ) : (
                  <div className="message-list">
                    {!session?.messages.length && (
                      <div className="welcome task-preparation">
                        <div className="welcome-symbol">
                          <FolderOpen size={24} />
                        </div>
                        <p className="eyebrow">准备这次工作的材料</p>
                        <h2>
                          {session?.files.length
                            ? "材料已就绪，核对后开始。"
                            : "先添加材料，再开始整理。"}
                        </h2>
                        <p>
                          {session?.patientId
                            ? "这位患者的原始材料、任务与成果都保留在当前病例工作区。"
                            : "独立任务有自己的材料范围与执行记录。"}
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
                          默认本地整理。外部模型需逐次确认材料发送范围。
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
                              {m.role === "user" ? "本轮输入" : "工作草稿"}
                            </span>
                          </div>
                          <div className="message-content">{m.content}</div>
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
                          <div className="message-meta">
                            <b>正在执行</b>
                            <span>
                              {eventLabel(
                                activeRun?.events?.at(-1) || {
                                  type: "message.start",
                                },
                              )}
                            </span>
                          </div>
                          <div className="message-content">
                            {activeRun?.partial ||
                              persistedRunning?.partial ||
                              "准备材料和医疗工作规则…"}
                          </div>
                        </div>
                      </article>
                    )}
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
                                setMode(r.mode);
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
                <div className="composer-wrap">
                  <form className="composer" onSubmit={send}>
                    <textarea
                      ref={inputRef}
                      aria-label="医疗工作需求"
                      rows={3}
                      placeholder="描述任务，或粘贴需要整理的材料…"
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        setConsent(false);
                      }}
                      onKeyDown={(e) => {
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
                        onClick={() => fileRef.current?.click()}
                        disabled={busy || uploading || !config}
                      >
                        <Paperclip size={16} />
                        {uploading ? "导入中…" : "添加材料"}
                      </button>
                      <input
                        ref={fileRef}
                        type="file"
                        multiple
                        hidden
                        accept=".txt,.md,.csv,.json,.pdf"
                        onChange={upload}
                      />
                      <select
                        aria-label="运行方式"
                        value={mode}
                        onChange={(e) => {
                          setMode(e.target.value);
                          setConsent(false);
                        }}
                        disabled={busy || loading}
                      >
                        <option value="local">本地规则整理</option>
                        <option
                          value="model"
                          disabled={!config?.modelConfigured}
                        >
                          模型辅助{!config?.modelConfigured ? " · 未配置" : ""}
                        </option>
                      </select>
                      <span className="composer-spacer" />
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
                            (mode === "model" && !consent)
                          }
                        >
                          <ArrowUp size={19} />
                        </button>
                      )}
                    </div>
                    {mode === "model" && (
                      <label className="consent">
                        <input
                          type="checkbox"
                          checked={consent}
                          onChange={(e) => setConsent(e.target.checked)}
                        />
                        我已核对本轮输入和 {selectedFileIds.length}{" "}
                        份选中材料及此前模型会话上下文，材料将以原文外发，允许发送至所配置的模型服务。
                      </label>
                    )}
                    <label className="consent">
                      <input
                        type="checkbox"
                        checked={team}
                        disabled={busy}
                        onChange={(e) => {
                          setTeam(e.target.checked);
                          setConsent(false);
                        }}
                      />
                      三个子代理联合整理：时间线 · 检验摘录 · 用药资料
                    </label>
                  </form>
                  <div className="composer-note">
                    <span>
                      {mode === "local"
                        ? "本轮在本机整理，不调用外部模型"
                        : "模型输出为待核查草稿"}
                    </span>
                    <span>Enter 发送 · Shift + Enter 换行</span>
                  </div>
                </div>
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
                                TXT、Markdown、CSV、JSON（200KB），以及可选文字的
                                PDF（5MB / 25 页）。
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
                              {a.title} · {STATUS[a.status]}
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
                              {run.mode === "local" ? "本地规则" : "模型辅助"}
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
            <dl>
              <dt>运行内核</dt>
              <dd>AgentRuntime + 医疗领域适配器</dd>
              <dt>模型配置</dt>
              <dd>
                {config?.modelConfigured
                  ? `${config.provider || "model"} · ${config.model}`
                  : "尚未配置"}
              </dd>
              <dt>数据存储</dt>
              <dd>本机 SQLite（单用户）</dd>
              <dt>医疗技能</dt>
              <dd>
                {config?.skills?.length || 0} 个本地可发现技能（只读说明）
              </dd>
              <dt>代码沙箱</dt>
              <dd>
                {config?.sandbox?.available
                  ? `${config.sandbox.backend} · 禁止联网、文件写入和子进程`
                  : config?.sandbox?.reason}
              </dd>
              <dt>子代理</dt>
              <dd>独立上下文 · 并行 2 个 · 每任务最多 3 个 · 父任务取消联动</dd>
              <dt>调度</dt>
              <dd>SQLite 持久计划 · 单次或固定间隔 · 服务运行时执行</dd>
            </dl>
            <p className="boundary">
              要开启模型辅助，请在项目 .env 选择 AI_PROVIDER，并配置对应的
              DeepSeek、OpenAI 或 Anthropic
              密钥后重启服务。密钥不会保存在浏览器。
            </p>
            <button
              className="secondary"
              onClick={async () => {
                await init();
                setModal(null);
              }}
            >
              刷新连接状态
            </button>
            <button
              className="secondary"
              onClick={() => setModal("doctor")}
            >
              医生档案与记忆
            </button>
            <p className="muted">
              文献检索、指南库、病例库、科研分析与 DRG
              测算按模块逐步上线；本版本未接入医院信息系统、电子签名或药物数据库。
            </p>
          </div>
        </Modal>
      )}
      {modal === "doctor" && (
        <Modal
          title="医生档案与记忆"
          onClose={() => setModal(null)}
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
