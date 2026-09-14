import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Image,
  Globe,
  Plus,
  MessageSquare,
  FolderOpen,
  Settings2,
  History,
  FileCheck2,
  ArrowUp,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  TriangleAlert,
  RotateCcw,
  FileText,
  X,
} from "lucide-react";
import { WorkspaceExtensionsPanel } from "./workspace-extensions";
import { WorkspaceDevelopment } from "./workspace-development";
import { api } from "./agent-runtime";
import { sseFrames } from "../shared/sse.mjs";
import "./workspaces.css";
import { MediaPanel } from "./workbench/media";
const InteractiveTerminal = lazy(() =>
  import("./workbench/interactive-terminal").then((m) => ({
    default: m.InteractiveTerminal,
  })),
);
import { TeamModels } from "./workbench/team-models";
import { RemoteJobs } from "./workbench/remote-jobs";
import { DesktopPanel } from "./workbench/desktop-control";
import { BrowserPanel } from "./workbench/browser";
import { FileEditor } from "./workbench/editor";
import { TaskSidebar } from "./workbench/sidebar";
import { RichMessage } from "./workbench/message";
import { DiffView } from "./workbench/diff";
import { Activity } from "./workbench/activity";
import { ComposerTools } from "./workbench/composer-tools";
import { TerminalPanel } from "./workbench/terminal";
import { Artifacts } from "./workbench/artifacts";
import "./workbench/workbench.css";

const stateLabel = (value) =>
  ({
    pending: "待批准",
    applying: "正在写入",
    applied: "已写入",
    rejected: "已拒绝",
    revoked: "授权已撤销",
    completed: "已完成",
    failed: "失败",
    cancelled: "已停止",
    interrupted: "已中断",
    active: "已启用",
    paused: "已暂停",
    running: "执行中",
    recovering: "等待恢复",
  })[value] || value;

export function WorkspacesView({ config, onOpenSettings }) {
  const [fileLine, setFileLine] = useState(1);
  const [view, setView] = useState("chat");
  const [showCreate, setShowCreate] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true),
    [panelWidth, setPanelWidth] = useState(48);
  const [attachments, setAttachments] = useState([]),
    [attachmentError, setAttachmentError] = useState("");
  const selectedId = useRef(null),
    drafts = useRef(new Map()),
    messagesEnd = useRef(null),
    followOutput = useRef(true);
  async function organize(w, changes) {
    try {
      await api(`/api/workspaces/${w.id}/organization`, "PATCH", changes);
      await refresh();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  }
  async function newTask(w) {
    try {
      const task = await api(`/api/workspaces/${w.id}/tasks`, "POST", {});
      await select(task.id);
    } catch (e) {
      setError(e.message);
    }
  }
  // Open a workspace file in the results panel, tracked as a tab so several
  // files can be viewed and switched between.
  async function openInTab(path, line = 1) {
    const id = selectedId.current;
    try {
      let result = { path };
      if (!/\.(png|jpe?g|webp|gif|pdf)$/i.test(path)) {
        result = await api(`/api/workspaces/${id}/tools`, "POST", {
          tool: "read_file",
          arguments: { path },
        });
      }
      if (id === selectedId.current) {
        setFile(result);
        setContent(result.text || "");
        setFileLine(line);
        setView("files");
        setOpenTabs((tabs) =>
          tabs.some((t) => t.path === path)
            ? tabs
            : [...tabs, { path }],
        );
      }
    } catch (e) {
      if (id === selectedId.current) setError(e.message);
    }
  }
  async function openFile(href) {
    const location = href.match(/(?:#L?|:)(\d+)(?::\d+)?$/);
    let path = decodeURIComponent(href)
      .replace(/#L?\d+.*$/, "")
      .replace(/:\d+(?::\d+)?$/, "");
    const prefix = current.root.replace(/\/$/, "") + "/";
    if (path.startsWith(prefix)) path = path.slice(prefix.length);
    await openInTab(path, Number(location?.[1] || 1));
  }
  function closeTab(path) {
    setOpenTabs((tabs) => {
      const next = tabs.filter((t) => t.path !== path);
      if (file?.path === path) {
        if (next.length) void openInTab(next.at(-1).path);
        else {
          setFile(null);
          setContent("");
        }
      }
      return next;
    });
  }
  const promptRef = useRef(null);
  const dialogRef = useRef(null);
  useEffect(() => {
    if (showCreate) dialogRef.current?.showModal();
  }, [showCreate]);
  const suggestions = [
    "阅读项目，说明它的结构和启动方法",
    "定位失败测试，提出修复并运行验证",
    "整理目录中的资料，生成一份 Markdown 摘要",
  ];
  function chooseSuggestion(text) {
    setPrompt(text);
    setView("chat");
    requestAnimationFrame(() => promptRef.current?.focus());
  }
  async function downloadArtifact(item) {
    try {
      const response = await api(
        `${base}/artifacts/${encodeURIComponent(item.id)}`,
        { raw: true },
      );
      const blob = await response.blob();
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = item.name || "artifact";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e.message);
    }
  }
  const [items, setItems] = useState([]),
    [current, setCurrent] = useState(null);
  const [title, setTitle] = useState(""),
    [root, setRoot] = useState(""),
    [directoryConsent, setDirectoryConsent] = useState(false);
  const [error, setError] = useState(""),
    [trajectory, setTrajectory] = useState(null),
    [history, setHistory] = useState(null),
    [replay, setReplay] = useState(null),
    [replayIndex, setReplayIndex] = useState(0),
    [busy, setBusy] = useState(false),
    [streaming, setRunning] = useState(false);
  const running =
    streaming || Boolean(current?.runs.some((r) => r.status === "running"));
  const [background, setBackground] = useState(true),
    [resumeOnRestart, setResumeOnRestart] = useState(false),
    [rounds, setRounds] = useState(32),
    [minutes, setMinutes] = useState(30),
    [resumeRunId, setResumeRunId] = useState("");
  const [profile, setProfile] = useState("standard"),
    [write, setWrite] = useState(false),
    [gitWrite, setGitWrite] = useState(false),
    [writeScopeText, setWriteScopeText] = useState(""),
    [openTabs, setOpenTabs] = useState([]),
    [browserOpen, setBrowserOpen] = useState(false);
  const [files, setFiles] = useState([]),
    [directory, setDirectory] = useState("."),
    [file, setFile] = useState(null),
    [content, setContent] = useState(""),
    [preview, setPreview] = useState(null),
    [officeText, setOfficeText] = useState(""),
    [officeBusy, setOfficeBusy] = useState(false);
  // Binary previews (image/PDF) are fetched as blobs with the session token
  // and rendered from object URLs; nothing untrusted is fetched cross-origin.
  useEffect(() => {
    setPreview(null);
    setOfficeText("");
    const extension = (file?.path || "").split(".").at(-1)?.toLowerCase();
    if (!file || !/^(png|jpe?g|webp|gif|pdf)$/.test(extension || ""))
      return undefined;
    let url,
      alive = true;
    api(
      `/api/workspaces/${file.workspaceId || current?.id}/file?path=${encodeURIComponent(file.path)}`,
      { raw: true },
    )
      .then((response) => response.blob())
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setPreview({
          kind: extension === "pdf" ? "pdf" : "image",
          url,
        });
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file?.path, current?.id]);
  const [prompt, setPrompt] = useState(""),
    [consent, setConsent] = useState(false),
    [partial, setPartial] = useState(""),
    [events, setEvents] = useState([]);
  const [scheduleAt, setScheduleAt] = useState(""),
    [cron, setCron] = useState(""),
    [timezone, setTimezone] = useState(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    ),
    [scheduleMessage, setScheduleMessage] = useState(""),
    [intervalMinutes, setIntervalMinutes] = useState(0),
    [scheduleConsent, setScheduleConsent] = useState(false);
  const [scheduleRecovery, setScheduleRecovery] = useState(false);
  const abort = useRef(null),
    generation = useRef(0);
  const base = current ? `/api/workspaces/${current.id}` : "";
  useEffect(() => {
    setHistory(null);
    setReplay(null);
  }, [current?.id]);
  useEffect(() => {
    if (!current?.runs.some((r) => r.status === "running") || streaming) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const w = await api(`/api/workspaces/${current.id}`);
        if (alive && selectedId.current === current.id) {
          setCurrent(w);
          setPartial(w.runs.find((r) => r.status === "running")?.partial || "");
          const log = await api(`/api/workspaces/${current.id}/events`);
          if (alive && selectedId.current === current.id) setEvents(log.events);
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
    }, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [current?.id, running, streaming]);
  useEffect(() => {
    let alive = true;
    api("/api/workspaces")
      .then((r) => {
        if (alive) {
          setItems(r.workspaces);
          try {
            const last = localStorage.getItem("workbench.selectedTask");
            if (last && r.workspaces.some((w) => w.id === last && !w.archived))
              select(last);
          } catch {}
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      generation.current++;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const list = await api("/api/workspaces");
        if (alive) setItems(list.workspaces);
      } catch {}
    }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (followOutput.current)
      messagesEnd.current?.scrollIntoView({ block: "end" });
  }, [partial, current?.messages.length]);
  async function refresh(id = current?.id) {
    const list = await api("/api/workspaces");
    setItems(list.workspaces);
    if (id && selectedId.current === id) {
      const w = await api(`/api/workspaces/${id}`);
      if (selectedId.current !== id) return w;
      setCurrent(w);
      setProfile(w.permissions.profile);
      setWrite(w.permissions.grants["filesystem.write"]);
      setGitWrite(w.permissions.grants["git.write"] === true);
      setWriteScopeText((w.writeScope || []).join(", "));
      const log = await api(`/api/workspaces/${id}/events`);
      if (selectedId.current === id) setEvents(log.events);
      return w;
    }
  }
  async function act(fn) {
    if (busy || running) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function select(id) {
    if (selectedId.current)
      drafts.current.set(selectedId.current, { prompt, attachments });
    selectedId.current = id;
    try {
      localStorage.setItem("workbench.selectedTask", id);
    } catch {}
    followOutput.current = true;
    setCurrent(null);
    const draft = drafts.current.get(id);
    setPrompt(draft?.prompt || "");
    setAttachments(draft?.attachments || []);
    setAttachmentError("");
    setEvents([]);
    setRunning(false);
    setError("");
    setView("chat");
    generation.current++;
    setConsent(
      (() => {
        try {
          return localStorage.getItem(`workbench.consent.${id}`) === "1";
        } catch {
          return false;
        }
      })(),
    );
    setFile(null);
    setFiles([]);
    setOpenTabs([]);
    setBrowserOpen(false);
    setDirectory(".");
    setPartial("");
    setResumeRunId("");
    try {
      await refresh(id);
    } catch (e) {
      if (selectedId.current === id) setError(e.message);
    }
  }
  async function list(path = directory) {
    const id = selectedId.current;
    const data = await api(base + "/tools", "POST", {
      tool: "list_directory",
      arguments: { path },
    });
    if (selectedId.current === id) {
      setFiles(data);
      setDirectory(path);
    }
  }
  async function run() {
    const taskText =
      prompt +
      attachments
        .map(
          (a) =>
            `\n\n附加材料 ${JSON.stringify(a.name)}（作为资料内容读取）：\n${a.text}`,
        )
        .join("");
    if (taskText.length > 20000) {
      setError("任务与附件总长度不能超过 20000 字符");
      return;
    }
    if (
      !prompt.trim() ||
      !consent ||
      !config?.modelConfigured ||
      busy ||
      streaming
    )
      return;
    if (
      !Number.isInteger(rounds) ||
      rounds < 1 ||
      rounds > 128 ||
      !Number.isFinite(minutes) ||
      minutes < 1 ||
      minutes > 600
    ) {
      setError("运行预算需为 1–128 轮、1–600 分钟");
      return;
    }
    if (running) {
      setBusy(true);
      try {
        await api(base + "/steer", "POST", {
          runId: current.runs.find((r) => r.status === "running")?.id,
          message: taskText,
          externalConsent: consent,
          requestId: crypto.randomUUID(),
        });
        setPrompt("");
        setAttachments([]);
        setConsent(false);
        await refresh();
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
      return;
    }
    const ticket = generation.current,
      id = current.id,
      task = taskText;
    setRunning(true);
    setError("");
    setPartial("");
    setConsent(false);
    const controller = new AbortController();
    abort.current = controller;
    try {
      if (current.title === "新任务") {
        const named = await api(base + "/organization", "PATCH", {
          title: prompt.trim().slice(0, 60),
        });
        if (ticket !== generation.current) return;
        current.revision = named.revision;
      }
      if (background) {
        await api(base + "/runs", "POST", {
          message: task,
          revision: current.revision,
          requestId: crypto.randomUUID(),
          externalConsent: consent,
          limits: { maxRounds: rounds, timeoutMs: minutes * 60000 },
          resumeOnRestart,
          ...(resumeRunId ? { resumeRunId } : {}),
        });
        setPrompt("");
        setAttachments([]);
        setResumeRunId("");
        if (ticket === generation.current) await refresh(id);
        return;
      }
      const response = await api(base + "/run", {
        method: "POST",
        raw: true,
        signal: controller.signal,
        body: JSON.stringify({
          message: task,
          revision: current.revision,
          requestId: crypto.randomUUID(),
          externalConsent: consent,
          limits: { maxRounds: rounds, timeoutMs: minutes * 60000 },
          resumeOnRestart,
          ...(resumeRunId ? { resumeRunId } : {}),
        }),
      });
      setPrompt("");
      setAttachments([]);
      let terminal = false;
      for await (const frame of sseFrames(response.body)) {
        if (ticket !== generation.current) break;
        const event = JSON.parse(frame.data);
        setEvents((old) => [...old.slice(-199), event]);
        if (event.type === "message.delta")
          setPartial((old) => old + event.payload.text);
        if (event.type === "plan.updated")
          setCurrent((w) => ({ ...w, plan: { steps: event.payload.steps } }));
        if (["message.complete", "error", "run.cancelled"].includes(event.type))
          terminal = true;
        if (event.type === "error") setError(event.payload.error);
      }
      if (!terminal && !controller.signal.aborted)
        throw new Error("连接已中断，请刷新查看任务状态");
    } catch (e) {
      if (!controller.signal.aborted && ticket === generation.current)
        setError(e.message);
    } finally {
      if (ticket === generation.current) {
        setRunning(false);
        setPartial("");
        await refresh(id).catch((e) => setError(e.message));
      }
      if (abort.current === controller) abort.current = null;
    }
  }
  return (
    <main className="generic-workspaces" id="main">
      <header>
        <div>
          <span className="workspace-kicker">本地工作区</span>
          <h1>通用 Agent 工作区</h1>
          <p>选择一个文件夹开始。读取限定在授权目录内，修改先查看、再批准。</p>
        </div>
        <button
          className="secondary"
          disabled={busy || running}
          onClick={() => act(() => refresh())}
        >
          刷新
        </button>
      </header>
      {error && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}
      <div
        className={`workspace-layout ${sidebarOpen ? "" : "wb-sidebar-hidden"}`}
      >
        <aside className="workspace-picker">
          <TaskSidebar
            items={items}
            current={current}
            disabled={busy || streaming}
            onSelect={select}
            onCreate={() => setShowCreate(true)}
            onNewTask={newTask}
            onSettings={onOpenSettings}
            onWorkspaceSettings={() => current && setView("settings")}
            model={config?.modelConfigured ? config.model : ""}
            onOrganize={organize}
          />
          {showCreate && (
            <dialog
              ref={dialogRef}
              className="desk-dialog"
              onClose={() => setShowCreate(false)}
              aria-label="连接工作区"
            >
              <button
                className="desk-dialog-close"
                onClick={() => setShowCreate(false)}
              >
                关闭
              </button>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  act(async () => {
                    const w = await api("/api/workspaces", "POST", {
                      title,
                      root,
                      directoryConsent,
                    });
                    setDirectoryConsent(false);
                    setShowCreate(false);
                    await select(w.id);
                  });
                }}
              >
                <h3>连接一个工作区</h3>
                <p>选择 Agent 可以读取的本地文件夹。文件修改会单独请求授权。</p>
                <label>
                  名称
                  <input
                    autoFocus
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="例如：研究资料"
                  />
                </label>
                <label>
                  文件夹绝对路径
                  <input
                    value={root}
                    onChange={(e) => {
                      setRoot(e.target.value);
                      setDirectoryConsent(false);
                    }}
                    placeholder="/Users/…/Documents/project"
                    required
                  />
                </label>
                {(config?.directoryPicker || window.omwDesktop) && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || running}
                    onClick={() =>
                      act(async () => {
                        // Prefer the packaged desktop's native picker; the
                        // HTTP endpoint only exists in the embedded runtime.
                        const root =
                          typeof window.omwDesktop?.chooseDirectory ===
                          "function"
                            ? await window.omwDesktop.chooseDirectory()
                            : (
                                await api(
                                  "/api/workspaces/pick-directory",
                                  "POST",
                                  {},
                                )
                              ).root;
                        if (root) {
                          setRoot(root);
                          setDirectoryConsent(false);
                        }
                      })
                    }
                  >
                    选择文件夹…
                  </button>
                )}
                <label className="workspace-checkbox">
                  <input
                    type="checkbox"
                    checked={directoryConsent}
                    onChange={(e) => setDirectoryConsent(e.target.checked)}
                  />
                  授权此工作区读取该目录
                </label>
                <button
                  className="primary"
                  disabled={busy || running || !directoryConsent || !root}
                >
                  创建工作区
                </button>
              </form>
            </dialog>
          )}
        </aside>
        {current ? (
          <section
            className={`workspace-detail ${view !== "chat" ? "wb-panel-open" : ""}`}
            style={{ "--wb-panel-width": `${panelWidth}%` }}
          >
            <header className="wb-topbar">
              <div className="wb-topbar-left">
                <button
                  className="wb-sidebar-toggle"
                  aria-label="切换侧栏"
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                >
                  {sidebarOpen ? (
                    <PanelLeftClose size={17} />
                  ) : (
                    <PanelLeftOpen size={17} />
                  )}
                </button>
                <h2 title={current.root}>{current.title}</h2>
                <button
                  className={`wb-status-chip ${running ? "running" : ""}`}
                  onClick={onOpenSettings}
                  title={
                    config.modelConfigured
                      ? `${config.provider} · ${config.model} · ${
                          current.permissions.grants["filesystem.write"]
                            ? "允许修改"
                            : "读取模式"
                        }`
                      : "打开模型设置"
                  }
                >
                  {running
                    ? "● 执行中"
                    : config.modelConfigured
                      ? `${config.model} · ${
                          current.permissions.grants["filesystem.write"]
                            ? "可修改"
                            : "只读"
                        }`
                      : "连接模型"}
                </button>
              </div>
              <nav className="wb-panel-switch" aria-label="工作区视图">
                {[
                  ["files", FolderOpen, "文件与终端"],
                  ["review", FileCheck2, "变更审批"],
                  ["browser", Globe, "浏览器"],
                  ["media", Image, "媒体"],
                  ["history", History, "运行记录"],
                ].map(([key, Icon, label]) => (
                  <button
                    key={key}
                    aria-current={view === key ? "page" : undefined}
                    title={label}
                    onClick={() => {
                      if (view === key) setView("chat");
                      else setView(key);
                    }}
                  >
                    <Icon size={16} />
                    {key === "review" &&
                      current.approvals.some((a) => a.status === "pending") && (
                        <span className="desk-count">
                          {
                            current.approvals.filter(
                              (a) => a.status === "pending",
                            ).length
                          }
                        </span>
                      )}
                  </button>
                ))}
              </nav>
            </header>
            <div className="wb-work-area">
              <section className="workspace-conversation">
                <div
                  className="wb-conversation-scroll"
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    followOutput.current =
                      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
                  }}
                >
                  {current.messages.length === 0 && !partial && (
                    <div className="desk-chat-welcome">
                      <h2>今天想完成什么？</h2>
                      <p>
                        描述目标，Agent
                        会在这个工作区内读取文件、执行工具并汇报结果。
                      </p>
                    </div>
                  )}
                  <div className="desk-messages">
                    {current.messages.map((m, i) => (
                      <article
                        className={`desk-message desk-message-${m.role}`}
                        key={i}
                      >
                        <small>{m.role === "user" ? "你" : "助理"}</small>
                        <RichMessage text={m.content} onOpenFile={openFile} />
                      </article>
                    ))}
                    {partial && (
                      <article aria-live="polite">
                        <small>正在处理</small>
                        <RichMessage text={partial} onOpenFile={openFile} />
                      </article>
                    )}
                  </div>
                  <Activity
                    events={events}
                    current={current}
                    running={running}
                    onReview={() => setView("review")}
                    onHistory={() => setView("history")}
                  />
                  <Artifacts
                    key={current.id}
                    current={current}
                    refresh={refresh}
                    onDownload={downloadArtifact}
                    onOpenFile={openFile}
                  />
                  <div ref={messagesEnd} />
                </div>
                <div className="desk-composer">
                  <details className="desk-run-options wb-run-compact">
                    <summary>
                      运行选项 · {minutes} 分钟 · 最多 {rounds} 轮
                      {resumeRunId ? " · 续接检查点" : ""}
                    </summary>
                    <div className="workspace-authority">
                      <label>
                        最多模型轮数
                        <input
                          type="number"
                          min="1"
                          max="128"
                          value={rounds}
                          disabled={running}
                          onChange={(e) => setRounds(Number(e.target.value))}
                        />
                      </label>
                      <label>
                        执行时限（分钟）
                        <input
                          type="number"
                          min="1"
                          max="600"
                          value={minutes}
                          disabled={running}
                          onChange={(e) => setMinutes(Number(e.target.value))}
                        />
                      </label>
                      <label className="workspace-checkbox">
                        <input
                          type="checkbox"
                          checked={background}
                          disabled={running}
                          onChange={(e) => setBackground(e.target.checked)}
                        />
                        后台执行，关闭页面后继续（应用须运行）
                      </label>
                      <label className="workspace-checkbox">
                        <input
                          type="checkbox"
                          checked={resumeOnRestart}
                          disabled={running}
                          onChange={(e) => setResumeOnRestart(e.target.checked)}
                        />
                        服务重启后自动续接本任务（沿用当前授权和预算，最多恢复 3
                        次）
                      </label>
                      {current.runs.at(-1)?.canResume && !running && (
                        <label className="workspace-checkbox">
                          <input
                            type="checkbox"
                            checked={Boolean(resumeRunId)}
                            onChange={(e) =>
                              setResumeRunId(
                                e.target.checked ? current.runs.at(-1).id : "",
                              )
                            }
                          />
                          使用上次持久化检查点继续；未知工具结果先核查，已完成工具不会重放
                        </label>
                      )}
                    </div>
                    {current.archivedRuns > 0 && (
                      <details>
                        <summary>
                          较早的任务（{current.archivedRuns} 条归档）
                        </summary>
                        {history?.entries.map(({ run, messages }) => (
                          <article key={run.id}>
                            <small>
                              {new Date(run.startedAt).toLocaleString()} ·{" "}
                              {stateLabel(run.status)}
                            </small>
                            {messages.map((m, i) => (
                              <pre key={i}>
                                {m.role === "user" ? "你：" : "助理："}
                                {m.content}
                              </pre>
                            ))}
                          </article>
                        ))}
                        {(!history || history.nextCursor) && (
                          <button
                            onClick={async () => {
                              const ticket = generation.current;
                              try {
                                const page = await api(
                                  base +
                                    "/history" +
                                    (history?.nextCursor
                                      ? `?before=${history.nextCursor}`
                                      : ""),
                                );
                                if (ticket === generation.current)
                                  setHistory((old) => ({
                                    ...page,
                                    entries: [
                                      ...(old?.entries || []),
                                      ...page.entries,
                                    ],
                                  }));
                              } catch (e) {
                                setError(e.message);
                              }
                            }}
                          >
                            加载较早的任务
                          </button>
                        )}
                      </details>
                    )}
                  </details>
                  <ComposerTools
                    key={current.id}
                    current={current}
                    onSkill={(id) => {
                      setPrompt(
                        (p) => p + `\n请使用技能 ${id}，先读取该技能说明。\n`,
                      );
                      promptRef.current?.focus();
                    }}
                    attachments={attachments}
                    setAttachments={setAttachments}
                    disabled={busy}
                    error={attachmentError}
                    setError={setAttachmentError}
                    onMention={() => {
                      setView("files");
                      list().catch((e) => setError(e.message));
                    }}
                  />
                  <textarea
                    ref={promptRef}
                    aria-label="通用任务"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={
                      running
                        ? "补充要求，Agent 会在下一步接收…"
                        : "描述你想完成的任务…（⌘/Ctrl + Enter 发送）"
                    }
                    disabled={busy}
                    onKeyDown={(e) => {
                      if (
                        (e.metaKey || e.ctrlKey) &&
                        e.key === "Enter" &&
                        !e.nativeEvent.isComposing &&
                        !busy &&
                        prompt.trim() &&
                        consent &&
                        config?.modelConfigured
                      ) {
                        e.preventDefault();
                        run();
                      }
                    }}
                  />
                  <div className="wb-composer-footer">
                    <label
                      className="workspace-checkbox wb-consent"
                      title="允许本次任务、同授权下的历史及工具读取的文件内容发送给当前模型"
                    >
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => {
                          setConsent(e.target.checked);
                          try {
                            localStorage.setItem(
                              `workbench.consent.${current.id}`,
                              e.target.checked ? "1" : "0",
                            );
                          } catch {}
                        }}
                        disabled={busy}
                      />
                      允许发送任务与所读文件给模型
                    </label>
                    <div className="wb-composer-actions">
                      <button
                        className="wb-model-shortcut"
                        onClick={onOpenSettings}
                        title="模型连接设置"
                      >
                        {config.modelConfigured
                          ? config.model
                          : "连接模型"}
                      </button>
                      <button
                        className="secondary"
                        hidden={
                          !running &&
                          !current.runs.some((r) => r.status === "running")
                        }
                        onClick={async () => {
                          try {
                            await api(base + "/cancel", "POST", {});
                            abort.current?.abort();
                            if (!running) await refresh();
                          } catch (e) {
                            setError(e.message);
                          }
                        }}
                      >
                        停止
                      </button>
                      <button
                        className="wb-send"
                        aria-label="发送任务"
                        disabled={
                          busy ||
                          !prompt.trim() ||
                          !consent ||
                          !config?.modelConfigured
                        }
                        title={
                          !consent
                            ? "先勾选发送授权"
                            : !config?.modelConfigured
                              ? "先连接模型"
                              : "发送任务"
                        }
                        onClick={run}
                      >
                        <ArrowUp size={17} />
                      </button>
                    </div>
                  </div>
                  {!config?.modelConfigured && (
                    <span className="wb-model-missing">
                      尚未连接模型，请在左下角「设置」里连接。
                    </span>
                  )}
                  <div className="wb-auth-bar">
                    <ShieldCheck size={14} />
                    <select
                      aria-label="授权模式"
                      value={
                        current.permissions.grants["filesystem.write"]
                          ? current.approvalPolicy || "review"
                          : "review"
                      }
                      disabled={busy || running}
                      onChange={(e) => {
                        const mode = e.target.value;
                        act(async () => {
                          const scopeEntries = writeScopeText
                            .split(/[,，\n]/)
                            .map((entry) => entry.trim())
                            .filter(Boolean);
                          await api(base, "PATCH", {
                            revision: current.revision,
                            profile: profile === "minimal" ? "code" : profile,
                            allowWrite: true,
                            approvalPolicy: mode,
                            ...(mode !== "review"
                              ? { autoApplyConsent: true }
                              : {}),
                            allowGit: mode === "full",
                            gitConsent: mode === "full",
                            writeScope: scopeEntries.length
                              ? scopeEntries
                              : null,
                          });
                          await refresh();
                        });
                      }}
                    >
                      <option value="review">每次批准</option>
                      <option value="workspace-write">自动批准 · 工作区内</option>
                      <option value="full">完全批准 · 含 Git 提交</option>
                    </select>
                    {(current.permissions.grants["filesystem.write"]
                      ? current.approvalPolicy
                      : "review") === "full" && (
                      <TriangleAlert
                        size={14}
                        className="wb-warn-icon"
                        title="完全批准已开启：Agent 将自动应用文件修改并自动提交本地 Git，请仅在可信任务中使用"
                      />
                    )}
                    {writeScopeText.trim() && (
                      <span
                        className="wb-auth-scope"
                        title="可写子目录（在工作区设置中修改）"
                      >
                        可写 {writeScopeText.trim()}
                      </span>
                    )}
                  </div>
                </div>
                {current.messages.length === 0 && !partial && (
                  <div className="desk-suggestions">
                    {suggestions.map((text) => (
                      <button key={text} onClick={() => chooseSuggestion(text)}>
                        {text}
                        <ArrowUp size={15} />
                      </button>
                    ))}
                  </div>
                )}
              </section>
              <aside
                className="wb-inspector"
                hidden={view === "chat"}
                aria-label="工作面板"
              >
                <header className="wb-inspector-header">
                  <span>
                    {
                      {
                        media: "图片与音视频",
                        browser: "浏览器预览",
                        files: "文件与终端",
                        review: "变更审批",
                        history: "运行记录",
                        settings: "工作区设置",
                      }[view]
                    }
                  </span>
                  <label>
                    宽度
                    <input
                      aria-label="工作面板宽度"
                      type="range"
                      min="32"
                      max="65"
                      value={panelWidth}
                      onChange={(e) => setPanelWidth(Number(e.target.value))}
                    />
                  </label>
                  <button
                    aria-label="关闭工作面板"
                    onClick={() => setView("chat")}
                  >
                    <X size={16} />
                  </button>
                </header>
                {view === "media" && (
                  <MediaPanel
                    key={current.id}
                    current={current}
                    refresh={refresh}
                    running={running}
                    onSettings={() => setView("settings")}
                  />
                )}
                {view === "browser" && <DesktopPanel key={`desktop-${current.id}`} current={current} />}
                {view === "browser" && (
                  <BrowserPanel
                    key={current.id}
                    current={current}
                    running={running}
                    onSettings={() => setView("settings")}
                  />
                )}
                <div
                  hidden={view !== "settings"}
                  className="desk-settings-panel"
                >
                  <div className="desk-settings-header">
                    <Settings2 size={19} />
                    <div>
                      <h3>工作区设置</h3>
                      <p>模型、文件权限和扩展能力都在这里管理。</p>
                    </div>
                  </div>
                  <section className="desk-model-settings">
                    <div>
                      <span className="desk-settings-label">执行模型</span>
                      <h3>
                        {config.modelConfigured
                          ? `${config.provider} · ${config.model}`
                          : "尚未配置模型"}
                      </h3>
                      <p>
                        {config.modelConfigured
                          ? "当前工作区会使用这个模型执行任务。"
                          : "配置后才能发送任务，文件浏览和审批仍可离线使用。"}
                      </p>
                    </div>
                    {onOpenSettings && (
                      <button className="secondary" onClick={onOpenSettings}>
                        管理模型连接
                      </button>
                    )}
                  </section>
                  <p className="desk-settings-help">
                    模型连接是本机全局设置；下面的文件权限与扩展配置只作用于当前工作区。
                  </p>
                </div>
                <div hidden={view !== "settings"}>
                  {current.forkedFrom && (
                    <p className="workspace-note">
                      此分支继承对话，仍使用同一文件夹；文件未复制，写入需重新授权。
                    </p>
                  )}
                  <button
                    className="secondary wb-fork-button"
                    disabled={
                      busy ||
                      running ||
                      current.runs.some((r) => r.status === "running")
                    }
                    onClick={() =>
                      act(async () => {
                        const w = await api(base + "/fork", "POST", {
                          revision: current.revision,
                        });
                        await select(w.id);
                      })
                    }
                  >
                    从当前历史分支
                  </button>
                  <details className="wb-advanced-auth">
                    <summary>高级授权（工具模式、可写子目录、独立 Git）</summary>
                    <div className="workspace-authority">
                      <label>
                        工具模式
                        <select
                          value={profile}
                          disabled={busy || running}
                          onChange={(e) => setProfile(e.target.value)}
                        >
                          <option value="standard">标准 · 文件与工具</option>
                          <option value="minimal">极简 · 仅对话（只读）</option>
                          <option value="creator">创作 · 文件草稿</option>
                          <option value="code">代码 · 修改、测试与子任务</option>
                        </select>
                      </label>
                      <label className="wb-write-scope">
                        可写子目录
                        <input
                          value={writeScopeText}
                          disabled={busy || running}
                          placeholder="留空 = 整个工作区；示例：docs, src/lib"
                          onChange={(e) => setWriteScopeText(e.target.value)}
                        />
                        <small>
                          安全收窄：填写后 Agent
                          只能修改这些子目录内的文件，其余路径一律只读（密钥文件仍然全局禁止）。
                        </small>
                      </label>
                      <label className="workspace-checkbox">
                        <input
                          type="checkbox"
                          disabled={profile === "minimal" || busy || running}
                          checked={gitWrite}
                          onChange={(e) => setGitWrite(e.target.checked)}
                        />
                        独立授权 Git 提交（不依赖“完全批准”档位）
                      </label>
                      <button
                        className="secondary"
                        disabled={busy || running}
                        onClick={() =>
                          act(async () => {
                            const mode = current.permissions.grants[
                              "filesystem.write"
                            ]
                              ? current.approvalPolicy || "review"
                              : "review";
                            const scopeEntries = writeScopeText
                              .split(/[,，\n]/)
                              .map((entry) => entry.trim())
                              .filter(Boolean);
                            await api(base, "PATCH", {
                              revision: current.revision,
                              profile,
                              allowWrite: write,
                              approvalPolicy: mode,
                              ...(mode !== "review"
                                ? { autoApplyConsent: true }
                                : {}),
                              allowGit:
                                mode === "full" ||
                                (gitWrite && profile !== "minimal"),
                              gitConsent:
                                mode === "full" ||
                                (gitWrite && profile !== "minimal"),
                              writeScope: scopeEntries.length
                                ? scopeEntries
                                : null,
                            });
                            await refresh();
                          })
                        }
                      >
                        保存高级授权
                      </button>
                    </div>
                  </details>
                  <RemoteJobs key={`remote-${current.id}`} current={current} refresh={refresh} />
                  <TeamModels
                    key={`team-${current.id}`}
                    current={current}
                    refresh={refresh}
                    disabled={busy || running}
                  />
                  <WorkspaceExtensionsPanel
                    key={`extensions-${current.id}`}
                    workspace={current}
                    refresh={refresh}
                    disabled={busy || running}
                  />
                </div>
                <div hidden={view !== "files"}>
                  {!browserOpen && !file && (
                    <div className="wb-files-empty">
                      <FileText size={30} strokeWidth={1.4} />
                      <h3>没有打开的文件</h3>
                      <p>在对话中点击文件名可直接打开，或浏览工作区文件夹。</p>
                      <button
                        className="secondary"
                        disabled={busy || running}
                        onClick={() => {
                          setBrowserOpen(true);
                          act(() => list(directory));
                        }}
                      >
                        <FolderOpen size={14} /> 浏览工作区文件
                      </button>
                    </div>
                  )}
                  {browserOpen && (
                    <>
                  <nav className="wb-file-breadcrumb" aria-label="当前目录">
                    <button onClick={() => act(() => list("."))}>
                      {current.root.split(/[\\/]/).filter(Boolean).at(-1) ||
                        current.root}
                    </button>
                    {directory !== "." &&
                      directory
                        .split("/")
                        .filter(Boolean)
                        .map((part, index, all) => (
                          <button
                            key={index}
                            onClick={() =>
                              act(() =>
                                list(all.slice(0, index + 1).join("/")),
                              )
                            }
                          >
                            {part}
                          </button>
                        ))}
                    <button
                      className="wb-file-refresh"
                      aria-label="刷新目录"
                      title="刷新目录"
                      onClick={() => act(() => list(directory))}
                    >
                      <RotateCcw size={13} />
                    </button>
                  </nav>
                  <div className="wb-file-grid">
                    {files.map((entry) => (
                      <button
                        key={entry.name}
                        className={`wb-file-row ${entry.directory ? "dir" : ""} ${
                          file?.path ===
                          (directory === "."
                            ? entry.name
                            : directory.replace(/\/$/, "") + "/" + entry.name)
                            ? "active"
                            : ""
                        }`}
                        disabled={busy || running}
                        onClick={() => {
                          const path =
                            directory === "."
                              ? entry.name
                              : directory.replace(/\/$/, "") + "/" + entry.name;
                          if (entry.directory) act(() => list(path));
                          else {
                            // Picker semantics: choose a file, then show it.
                            act(() => openInTab(path));
                            setBrowserOpen(false);
                          }
                        }}
                      >
                        {entry.directory ? (
                          <FolderOpen size={15} />
                        ) : (
                          <FileText size={15} />
                        )}
                        <span>{entry.name}</span>
                      </button>
                    ))}
                    {!files.length && (
                      <p className="wb-muted">此目录为空，或点击 ↻ 刷新。</p>
                    )}
                  </div>
                    <div className="wb-files-toolbar">
                      <button
                        className="wb-browse-toggle"
                        onClick={() => setBrowserOpen(false)}
                      >
                        收起浏览
                      </button>
                    </div>
                    </>
                  )}
                  {openTabs.length > 0 && (
                    <div className="wb-file-tabs" role="tablist">
                      {openTabs.map((tab) => (
                        <button
                          key={tab.path}
                          role="tab"
                          aria-selected={file?.path === tab.path}
                          className={file?.path === tab.path ? "active" : ""}
                          onClick={() => act(() => openInTab(tab.path))}
                        >
                          <span>{tab.path.split("/").at(-1)}</span>
                          <span
                            role="button"
                            aria-label={`关闭 ${tab.path}`}
                            className="wb-tab-close"
                            onClick={(e) => {
                              e.stopPropagation();
                              closeTab(tab.path);
                            }}
                          >
                            <X size={12} />
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {file && (
                      <div>
                        <div className="wb-editor-heading">
                          <h3>{file.path}</h3>
                          <button
                            onClick={() => {
                              setPrompt(
                                (p) => p + `\n请查看文件：${file.path}\n`,
                              );
                              promptRef.current?.focus();
                            }}
                          >
                            引用到对话
                          </button>
                        </div>
                        {preview ? (
                          preview.kind === "image" ? (
                            <img
                              className="wb-file-preview"
                              src={preview.url}
                              alt={file.path}
                            />
                          ) : (
                            <iframe
                              className="wb-file-preview"
                              title={file.path}
                              src={preview.url}
                            />
                          )
                        ) : /\.(docx|xlsx|pptx)$/i.test(file.path) ? (
                          <div className="wb-office-preview">
                            <div className="workspace-toolbar">
                              <button
                                className="secondary"
                                disabled={officeBusy || busy || running}
                                onClick={() =>
                                  act(async () => {
                                    setOfficeBusy(true);
                                    try {
                                      const result = await api(
                                        base + "/tools",
                                        "POST",
                                        {
                                          tool: "document_read",
                                          arguments: { path: file.path },
                                        },
                                      );
                                      setOfficeText(
                                        result.text ||
                                          result.markdown ||
                                          JSON.stringify(result, null, 2),
                                      );
                                    } finally {
                                      setOfficeBusy(false);
                                    }
                                  })
                                }
                              >
                                {officeBusy ? "转换中…" : "转换为文本预览"}
                              </button>
                              <small>
                                Word / Excel / PPT 通过办公文档运行时（Docker）读取
                              </small>
                            </div>
                            {officeText && (
                              <pre className="wb-office-text">{officeText}</pre>
                            )}
                          </div>
                        ) : (
                          <>
                            <FileEditor
                          key={`${current.id}-${file.path}`}
                          content={content}
                          onChange={setContent}
                          line={fileLine}
                          onQuote={(selected) => {
                            if (!selected) {
                              setError("请先在文件编辑器中选中需要讨论的内容");
                              return;
                            }
                            setPrompt(
                              (p) =>
                                p +
                                `\n关于 ${file.path} 中这段代码：\n\`\`\`\n${selected}\n\`\`\`\n`,
                            );
                            promptRef.current?.focus();
                          }}
                        />
                        <button
                          className="secondary"
                          disabled={
                            busy ||
                            running ||
                            !current.permissions.grants["filesystem.write"]
                          }
                          onClick={() =>
                            act(async () => {
                              await api(base + "/tools", "POST", {
                                tool: "propose_file_write",
                                arguments: {
                                  path: file.path,
                                  content,
                                  ...(file.hash
                                    ? { expectedHash: file.hash }
                                    : {}),
                                },
                              });
                              await refresh();
                            })
                          }
                        >
                          提交修改供批准
                        </button>
                          </>
                        )}
                      </div>
                    )}
                </div>
                <div hidden={view !== "review"}>
                  {current.approvals.length === 0 && (
                    <div className="desk-panel-empty">
                      <FileCheck2 size={28} />
                      <h3>暂时没有文件变更</h3>
                      <p>
                        Agent 提出的修改会出现在这里，你可以查看内容并批准。
                      </p>
                      <button onClick={() => setView("chat")}>返回对话</button>
                    </div>
                  )}
                  {current.approvals.length > 0 && (
                    <section className="workspace-approvals">
                      <h3>文件修改审批</h3>
                      {current.approvals.slice(-20).map((a) => (
                        <article key={a.id}>
                          <div className="workspace-toolbar">
                            <b>{a.path}</b>
                            <span>{stateLabel(a.status)}</span>
                          </div>
                          <details open={a.status === "pending"}>
                            <summary>查看修改前后</summary>
                            <DiffView
                              path={a.path}
                              before={a.before}
                              after={a.kind === "file.delete" ? "" : a.content}
                            />
                          </details>
                          {a.error && <p role="alert">{a.error}</p>}
                          {a.status === "applied" && a.before !== null && (
                            <button
                              className="secondary"
                              disabled={
                                busy ||
                                running ||
                                !current.permissions.grants["filesystem.write"]
                              }
                              onClick={() =>
                                act(async () => {
                                  await api(
                                    base + "/approvals/" + a.id + "/revert",
                                    "POST",
                                    { revision: current.revision },
                                  );
                                  await refresh();
                                })
                              }
                            >
                              生成回退提案
                            </button>
                          )}
                          {a.status === "pending" && (
                            <div className="workspace-toolbar">
                              {[
                                ["approve", "批准并写入"],
                                ["reject", "拒绝"],
                              ].map(([decision, label]) => (
                                <button
                                  key={decision}
                                  className="secondary"
                                  disabled={busy || running}
                                  onClick={() =>
                                    act(async () => {
                                      await api(
                                        base + "/approvals/" + a.id,
                                        "POST",
                                        {
                                          revision: current.revision,
                                          decision,
                                        },
                                      );
                                      await refresh();
                                      setFile(null);
                                    })
                                  }
                                >
                                  {decision === "approve" &&
                                  a.kind === "file.delete"
                                    ? "批准并删除"
                                    : label}
                                </button>
                              ))}
                            </div>
                          )}
                        </article>
                      ))}
                    </section>
                  )}
                </div>
                <div hidden={view !== "files"}>
                  {view === "files" && (
                    <Suspense fallback={<p>正在载入交互终端…</p>}>
                      {" "}
                      <InteractiveTerminal
                        key={`pty-${current.id}`}
                        current={current}
                        disabled={busy || running}
                      />{" "}
                    </Suspense>
                  )}
                  <TerminalPanel
                    key={`terminal-${current.id}`}
                    current={current}
                    running={running}
                    onSettings={() => setView("settings")}
                  />
                  <WorkspaceDevelopment
                    key={`development-${current.id}`}
                    current={current}
                    busy={busy || running}
                    act={act}
                    refresh={refresh}
                    select={select}
                  />
                </div>

                <div hidden={view !== "settings"}>
                  <details className="workspace-schedules">
                    <summary>计划任务</summary>
                    <p>
                      支持单次、固定间隔和带时区的
                      Cron。应用需保持运行；计划不会自动批准文件修改。
                    </p>
                    <label>
                      任务内容
                      <textarea
                        value={scheduleMessage}
                        onChange={(e) => {
                          setScheduleMessage(e.target.value);
                          setScheduleConsent(false);
                        }}
                      />
                    </label>
                    <div className="workspace-toolbar">
                      <label>
                        执行时间
                        <input
                          type="datetime-local"
                          disabled={Boolean(cron)}
                          value={scheduleAt}
                          onChange={(e) => setScheduleAt(e.target.value)}
                        />
                      </label>
                      <label>
                        间隔分钟（0 为单次）
                        <input
                          type="number"
                          min="0"
                          max="525600"
                          disabled={Boolean(cron)}
                          value={intervalMinutes}
                          onChange={(e) =>
                            setIntervalMinutes(Number(e.target.value))
                          }
                        />
                      </label>
                    </div>
                    <label className="workspace-checkbox">
                      <input
                        type="checkbox"
                        checked={scheduleConsent}
                        onChange={(e) => setScheduleConsent(e.target.checked)}
                      />
                      授权按此计划将任务和读取文件发送给当前模型
                    </label>
                    <label className="workspace-checkbox">
                      <input
                        type="checkbox"
                        checked={scheduleRecovery}
                        onChange={(e) => {
                          setScheduleRecovery(e.target.checked);
                          setScheduleConsent(false);
                        }}
                      />
                      计划执行被服务重启中断时，自动续接原任务
                    </label>
                    <label>
                      Cron（可选）
                      <input
                        value={cron}
                        onChange={(e) => {
                          setCron(e.target.value);
                          setScheduleConsent(false);
                        }}
                        placeholder="0 9 * * 1-5"
                      />
                    </label>
                    <label>
                      时区
                      <input
                        value={timezone}
                        onChange={(e) => {
                          setTimezone(e.target.value);
                          setScheduleConsent(false);
                        }}
                      />
                    </label>
                    <button
                      className="secondary"
                      disabled={
                        busy ||
                        running ||
                        !scheduleConsent ||
                        (!scheduleAt && !cron) ||
                        !scheduleMessage.trim() ||
                        !config?.modelConfigured
                      }
                      onClick={() =>
                        act(async () => {
                          await api(base + "/schedules", "POST", {
                            revision: current.revision,
                            message: scheduleMessage,
                            runAt: new Date(scheduleAt).getTime(),
                            intervalMinutes: cron ? 0 : intervalMinutes,
                            ...(cron ? { cron, timezone } : {}),
                            externalConsent: scheduleConsent,
                            resumeOnRestart: scheduleRecovery,
                          });
                          setScheduleConsent(false);
                          await refresh();
                        })
                      }
                    >
                      创建计划
                    </button>
                    {(current.schedules || []).map((job) => (
                      <article className="workspace-run" key={job.id}>
                        <b>{job.message}</b>
                        <p>
                          {stateLabel(job.status)} ·{" "}
                          {new Date(job.nextRunAt).toLocaleString()} ·{" "}
                          {job.cron
                            ? `${job.cron} · ${job.timezone}`
                            : job.intervalMinutes
                              ? `每 ${job.intervalMinutes} 分钟`
                              : "单次"}
                        </p>
                        {job.error && <p>{job.error}</p>}
                        <button
                          className="secondary"
                          disabled={
                            busy ||
                            running ||
                            job.status === "running" ||
                            (job.status !== "active" && !scheduleConsent)
                          }
                          onClick={() =>
                            act(async () => {
                              await api(base + "/schedules/" + job.id, "POST", {
                                revision: current.revision,
                                status:
                                  job.status === "active" ? "paused" : "active",
                                externalConsent: scheduleConsent,
                              });
                              setScheduleConsent(false);
                              await refresh();
                            })
                          }
                        >
                          {job.status === "active"
                            ? "暂停计划"
                            : job.cron
                              ? "重新授权，按 Cron 恢复"
                              : "重新授权，1 分钟后恢复"}
                        </button>
                      </article>
                    ))}
                  </details>
                </div>
                <div hidden={view !== "history"}>
                  {(current.artifacts || []).length > 0 && (
                    <section className="desk-artifacts" aria-label="任务成果">
                      <div className="desk-section-title">
                        <div>
                          <h3>任务成果</h3>
                          <p>
                            已生成的文件可以直接下载或交给下一个任务继续处理。
                          </p>
                        </div>
                        <span>{current.artifacts.length} 个文件</span>
                      </div>
                      <div className="desk-artifact-list">
                        {current.artifacts.map((item) => (
                          <article key={item.id}>
                            <div>
                              <b>{item.name}</b>
                              <small>
                                {item.mime} · {Math.ceil(item.size / 1024)} KB ·{" "}
                                {new Date(item.createdAt).toLocaleString()}
                              </small>
                            </div>
                            <button
                              className="secondary"
                              onClick={() => downloadArtifact(item)}
                            >
                              下载
                            </button>
                          </article>
                        ))}
                      </div>
                    </section>
                  )}
                  <details open>
                    <summary>执行记录与历史分支</summary>
                    {(current.notifications || [])
                      .filter((n) => !n.read)
                      .map((n) => (
                        <p key={n.id}>
                          {new Date(n.createdAt).toLocaleString()} ·{" "}
                          {stateLabel(n.status)}
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={async () => {
                              try {
                                await api(
                                  base + "/notifications/" + n.id,
                                  "POST",
                                  {},
                                );
                                await refresh();
                              } catch (e) {
                                setError(e.message);
                              }
                            }}
                          >
                            标记已读
                          </button>
                        </p>
                      ))}
                    {(current.runs || []).some(
                      (r) =>
                        r.status === "running" || r.status === "recovering",
                    ) && (
                      <div className="desk-background-status" role="status">
                        <span>后台任务仍在运行</span>
                        <span>可以切换工作区，任务会继续记录在这里</span>
                        <button
                          className="secondary"
                          onClick={() => setView("chat")}
                        >
                          查看对话
                        </button>
                      </div>
                    )}
                    {current.runs.map((r) => (
                      <div className="workspace-run" key={r.id}>
                        <span>
                          {stateLabel(r.status)} ·{" "}
                          {new Date(r.startedAt).toLocaleString()}
                        </span>
                        {r.error && <p>{r.error}</p>}
                        <p>
                          用量：{r.usage?.total_tokens || 0} tokens ·{" "}
                          {r.endedAt
                            ? ((r.endedAt - r.startedAt) / 1000).toFixed(1) +
                              " 秒"
                            : "执行中"}
                        </p>
                        <button
                          className="secondary"
                          onClick={async () => {
                            try {
                              setTrajectory({
                                runId: r.id,
                                ...(await api(base + "/trajectory/" + r.id)),
                              });
                            } catch (e) {
                              setError(e.message);
                            }
                          }}
                        >
                          查看模型与工具轨迹
                        </button>
                        <button
                          className="secondary"
                          onClick={async () => {
                            try {
                              setReplay(await api(base + "/replay/" + r.id));
                              setReplayIndex(0);
                            } catch (e) {
                              setError(e.message);
                            }
                          }}
                        >
                          逐步重放（不执行工具）
                        </button>
                        {(r.children || []).map((child) => (
                          <details key={child.id}>
                            <summary>
                              子任务 · {stateLabel(child.status)} · {child.task}
                            </summary>
                            <pre>{child.text || child.error}</pre>
                          </details>
                        ))}
                        {r.status !== "completed" && r.partial && (
                          <pre>{r.partial}</pre>
                        )}
                        <button
                          className="secondary"
                          disabled={busy || running || r.status === "running"}
                          onClick={() =>
                            act(async () => {
                              const w = await api(base + "/fork", "POST", {
                                runId: r.id,
                                revision: current.revision,
                              });
                              await select(w.id);
                            })
                          }
                        >
                          从此轮分支
                        </button>
                      </div>
                    ))}
                    <pre className="workspace-events">
                      {events.map((e) => `${e.id} · ${e.type}`).join("\n")}
                    </pre>
                    {trajectory && (
                      <details open>
                        <summary>轨迹 · {trajectory.runId}</summary>
                        <pre className="workspace-events">
                          {JSON.stringify(trajectory.entries, null, 2)}
                        </pre>
                        {trajectory.entries.length >= 100 && (
                          <button
                            onClick={async () => {
                              try {
                                const next = await api(
                                  base +
                                    "/trajectory/" +
                                    trajectory.runId +
                                    "?after=" +
                                    trajectory.cursor,
                                );
                                setTrajectory({
                                  runId: trajectory.runId,
                                  ...next,
                                });
                              } catch (e) {
                                setError(e.message);
                              }
                            }}
                          >
                            下一页
                          </button>
                        )}
                      </details>
                    )}
                    {replay && (
                      <details open>
                        <summary>只读重放 · {replay.runId}</summary>
                        <p>
                          {replay.summary.steps} 个步骤 ·{" "}
                          {replay.summary.actors} 个执行代理 ·
                          {replay.summary.protocolComplete
                            ? "调用记录完整"
                            : "存在中断或缺失记录"}
                        </p>
                        {replay.steps.length > 0 && (
                          <>
                            <label>
                              步骤 {replayIndex + 1} / {replay.steps.length}
                              <input
                                aria-label="重放步骤"
                                type="range"
                                min="0"
                                max={replay.steps.length - 1}
                                value={replayIndex}
                                onChange={(e) =>
                                  setReplayIndex(Number(e.target.value))
                                }
                              />
                            </label>
                            <pre className="workspace-events">
                              {JSON.stringify(
                                replay.steps[replayIndex],
                                null,
                                2,
                              )}
                            </pre>
                          </>
                        )}
                        {!replay.summary.protocolComplete && (
                          <pre className="workspace-events">
                            {JSON.stringify(replay.summary, null, 2)}
                          </pre>
                        )}
                      </details>
                    )}
                  </details>
                </div>
              </aside>
            </div>
          </section>
        ) : (
          <section className="workspace-empty">
            <MessageSquare size={32} strokeWidth={1.5} />
            <h2>从一项具体的工作开始</h2>
            <p>连接项目或资料文件夹，然后直接告诉 Agent 你想完成什么。</p>
            <button
              className="primary desk-start"
              onClick={() => setShowCreate(true)}
            >
              <Plus size={17} />
              连接文件夹，开始使用
            </button>
            <div className="desk-start-steps">
              <span>
                <b>1</b> 连接工作区
              </span>
              <span>
                <b>2</b> 描述任务
              </span>
              <span>
                <b>3</b> 查看并确认结果
              </span>
            </div>
            <p className="workspace-empty-note">
              可以从“解释这个项目”或“整理一份资料摘要”开始。
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
