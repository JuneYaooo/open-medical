import { useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  Plus,
  PencilLine,
  Pin,
  Archive,
  FileCheck2,
  ArrowUp,
  Square,
  ShieldCheck,
  TriangleAlert,
  RotateCcw,
  FileText,
  X,
  Loader2,
  Menu,
  ChevronRight,
} from "lucide-react";
import { WorkspaceExtensionsPanel } from "./workspace-extensions";
import { WorkspaceDevelopment } from "./workspace-development";
import { api, medicalEnabled } from "./agent-runtime";
import { sseFrames } from "../shared/sse.mjs";
import "./workspaces.css";
import { MediaPanel } from "./workbench/media";
import { TeamModels } from "./workbench/team-models";
import { RemoteJobs } from "./workbench/remote-jobs";
import { DesktopPanel } from "./workbench/desktop-control";
import { BrowserPanel } from "./workbench/browser";
import { RichMessage } from "./workbench/message";
import { DiffView } from "./workbench/diff";
import { Activity } from "./workbench/activity";
import { RunStatusNotice, OutcomeCard } from "./workbench/run-status-view";
import { blockedText, runChipLabel } from "./workbench/run-status";
import { ComposerTools } from "./workbench/composer-tools";
import { Artifacts } from "./workbench/artifacts";
import { IconButton, Modal } from "./components";
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

// 融合后的项目工作区视图：与医疗任务共用同一套外壳
// （侧栏/顶栏在 main.jsx，这里是 conversation + composer + inspector）。
// 不再渲染独立的 Open Agent 侧栏与顶栏。
export function WorkspacesView({
  config,
  onOpenSettings,
  onMenu,
  initialWorkspaceId = "",
  initialCreate = false,
  initialPrompt = "",
  initialPanel = "files",
  onChanged,
  displayMode = "work",
  onDisplayModeChange,
}) {
  const [panel, setPanel] = useState("files");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  useEffect(() => { setInspectorOpen(displayMode !== "chat"); }, [displayMode]);
  const [showCreate, setShowCreate] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [attachments, setAttachments] = useState([]),
    [attachmentError, setAttachmentError] = useState("");
  useEffect(() => {
    if (initialCreate) setShowCreate(true);
    else if (initialWorkspaceId) select(initialWorkspaceId);
    if (initialPrompt) setPrompt(initialPrompt);
  }, []);  
  const selectedId = useRef(null),
    drafts = useRef(new Map()),
    messagesEnd = useRef(null),
    followOutput = useRef(true),
    // 首次预填的提示词：select() 会重置输入框，用它穿透第一次选中
    pendingPrompt = useRef(initialPrompt);
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
  async function openInTab(path) {
    const id = selectedId.current;
    try {
      let result = { path };
      // Image/PDF stream as blobs; office docs go through the document
      // runtime; everything readable as text (html/md/code) uses read_file.
      if (
        !/\.(png|jpe?g|webp|gif|pdf|docx|xlsx|pptx)$/i.test(path)
      ) {
        result = await api(`/api/workspaces/${id}/tools`, "POST", {
          tool: "read_file",
          arguments: { path },
        });
      }
      if (id === selectedId.current) {
        setFile(result);
        setContent(result.text || "");
        setPanel("files");
        setInspectorOpen(true);
        onDisplayModeChange?.("work");
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
    let path = decodeURIComponent(href)
      .replace(/#L?\d+.*$/, "")
      .replace(/:\d+(?::\d+)?$/, "");
    const prefix = current.root.replace(/\/$/, "") + "/";
    if (path.startsWith(prefix)) path = path.slice(prefix.length);
    await openInTab(path);
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
  const suggestions = [
    "阅读项目，说明它的结构和启动方法",
    "定位失败测试，提出修复并运行验证",
    "整理目录中的资料，生成一份 Markdown 摘要",
  ];
  function chooseSuggestion(text) {
    setPrompt(text);
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
    // Kept for the run-history panel's pagination loader.
    [history, setHistory] = useState(null), // eslint-disable-line no-unused-vars
    [replay, setReplay] = useState(null),
    [replayIndex, setReplayIndex] = useState(0),
    [busy, setBusy] = useState(false),
    [streaming, setRunning] = useState(false);
  const running =
    streaming || Boolean(current?.runs.some((r) => r.status === "running"));
  // Fixed run defaults: effectively unlimited rounds/time with automatic
  // context compaction; background execution on. Setters kept for a future
  // advanced-options UI.
  const [background] = useState(true),
    [resumeOnRestart] = useState(false),
    [rounds] = useState(512),
    [minutes] = useState(720),
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
    [officeError, setOfficeError] = useState(""),
    [officeBusy, setOfficeBusy] = useState(false),
    [htmlUrl, setHtmlUrl] = useState("");
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
  const previewKind = (() => {
    if (!file) return null;
    if (preview) return preview.kind;
    const extension = (file.path || "").split(".").at(-1)?.toLowerCase();
    if (extension === "html" || extension === "htm") return "html";
    if (extension === "md" || extension === "markdown") return "markdown";
    if (["docx", "xlsx", "pptx"].includes(extension)) return "office";
    return "text";
  })();
  // HTML preview renders from an opaque-origin blob: scripts may run for
  // interactive pages, but they cannot touch the app origin or credentials.
  useEffect(() => {
    if (previewKind !== "html" || !content) {
      setHtmlUrl("");
      return undefined;
    }
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/html" }),
    );
    setHtmlUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [previewKind, content]);
  // Office documents convert automatically through the document runtime.
  useEffect(() => {
    if (previewKind !== "office" || !file || officeBusy || officeText) {
      if (previewKind !== "office") setOfficeError("");
      return undefined;
    }
    let alive = true;
    setOfficeBusy(true);
    setOfficeError("");
    api(base + "/tools", "POST", {
      tool: "document_read",
      arguments: { path: file.path },
    })
      .then((result) => {
        if (!alive) return;
        setOfficeText(
          result.text || result.markdown || JSON.stringify(result, null, 2),
        );
      })
      .catch((e) => alive && setOfficeError(e.message))
      .finally(() => alive && setOfficeBusy(false));
    return () => {
      alive = false;
    };
  }, [previewKind, file?.path, current?.id]);
  const [prompt, setPrompt] = useState(""),
    [partial, setPartial] = useState(""),
    [events, setEvents] = useState([]);
  // 首页带来的首个任务：工作区就绪后自动运行一次，避免用户落地后还要再点
  // 一次发送。只在首个稳定状态触发；条件不满足（忙碌/运行中/无模型）时保
  // 留预填，交回手动发送。
  const autoRun = useRef(initialPrompt ? "pending" : "off");
  useEffect(() => {
    if (autoRun.current !== "pending" || !current?.id) return;
    autoRun.current = "off";
    if (running || busy || !prompt.trim() || !config?.modelConfigured) return;
    run();
  }, [current?.id, prompt, busy, running]);
  // Auto-refresh open previews when the agent applies file changes: the
  // viewer re-reads the file and rebuilds its blob, so the panel never shows
  // a stale version of an open tab.
  const lastAppliedEvent = useRef(0);
  const pendingPreviewRefresh = useRef(new Set());
  useEffect(() => {
    lastAppliedEvent.current = 0;
  }, [current?.id]);
  useEffect(() => {
    if (!events.length) return;
    const maxId = Math.max(...events.map((e) => e.id));
    if (!lastAppliedEvent.current) {
      lastAppliedEvent.current = maxId; // baseline: ignore history on load
      return;
    }
    const fresh = events.filter(
      (e) => e.id > lastAppliedEvent.current && e.type === "approval.applied",
    );
    lastAppliedEvent.current = maxId;
    if (!fresh.length) return;
    const changed = new Set(
      fresh.map((e) => e.payload?.path).filter(Boolean),
    );
    // approval.applied lands while the run is still executing, and read_file
    // is refused mid-run — defer those refreshes until the run finishes.
    if (file && changed.has(file.path)) {
      if (running) pendingPreviewRefresh.current.add(file.path);
      else void openInTab(file.path);
    }
    if (browserOpen) {
      if (running) pendingPreviewRefresh.current.add("__list__");
      else void list(directory);
    }
  }, [events, current?.id]);
  useEffect(() => {
    if (running || !pendingPreviewRefresh.current.size) return;
    const timer = setTimeout(() => {
      const pending = pendingPreviewRefresh.current;
      pendingPreviewRefresh.current = new Set();
      for (const path of pending)
        path === "__list__" ? void list(directory) : void openInTab(path);
    }, 600);
    return () => clearTimeout(timer);
  }, [running, current?.id]);
  // Auto-grow within a cap: starts at one line, follows content, stops at a
  // readable maximum and scrolls beyond that.
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 260) + "px";
  }, [prompt, current?.id]);
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
    let sawRunning = false;
    const timer = setInterval(async () => {
      try {
        const w = await api(`/api/workspaces/${current.id}`);
        if (!alive || selectedId.current !== current.id) return;
        setCurrent(w);
        setPartial(w.runs.find((r) => r.status === "running")?.partial || "");
        const stillRunning = w.runs.some((r) => r.status === "running");
        if (sawRunning && !stillRunning) {
          // The run just finished: trailing events (approval.applied, final
          // message) land right after the status flip — fetch once more
          // after a beat so open previews refresh to the final content.
          sawRunning = false;
          setTimeout(async () => {
            if (!alive || selectedId.current !== current.id) return;
            try {
              const [finalWorkspace, finalLog] = await Promise.all([
                api(`/api/workspaces/${current.id}`),
                api(`/api/workspaces/${current.id}/events?latest=1`),
              ]);
              if (alive && selectedId.current === current.id) {
                setCurrent(finalWorkspace);
                setEvents(finalLog.events);
              }
            } catch {}
          }, 900);
          return;
        }
        sawRunning = stillRunning;
        const log = await api(`/api/workspaces/${current.id}/events?latest=1`);
        if (alive && selectedId.current === current.id) setEvents(log.events);
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
          setItems(r.workspaces.filter((item) => item.kind !== "session"));
          try {
            // 上次选中的优先；全新环境没有记录时自动进入第一个项目
            const last = localStorage.getItem("workbench.selectedTask");
            const target =
              last && r.workspaces.some((w) => w.id === last && !w.archived)
                ? last
                : r.workspaces.find((w) => !w.archived)?.id;
            if (!initialWorkspaceId && !initialCreate && target) select(target);
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
  // 工作区列表变化时通知外壳刷新侧栏（项目区），避免列表签名比对频率过高。
  const listSignature = useRef("");
  useEffect(() => {
    const signature = JSON.stringify(
      items.map((w) => [
        w.id,
        w.title,
        w.pinned,
        w.archived,
        w.running,
        w.pending,
      ]),
    );
    if (signature !== listSignature.current) {
      listSignature.current = signature;
      if (selectedId.current) onChanged?.(selectedId.current);
    }
  }, [items]);  
  useEffect(() => {
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const list = await api("/api/workspaces");
        if (!alive) return;
        setItems(list.workspaces.filter((item) => item.kind !== "session"));
        // Pick up activity started outside this tab (background runs,
        // applied edits) so the selected workspace and its events stay live.
        const meta = list.workspaces.find((w) => w.id === selectedId.current);
        if (
          meta &&
          !streaming &&
          (meta.running ||
            meta.revision !== current?.revision ||
            meta.updatedAt !== current?.updatedAt)
        )
          refresh(meta.id).catch(() => {});
      } catch {}
    }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [current?.revision, streaming]);
  useEffect(() => {
    if (followOutput.current)
      messagesEnd.current?.scrollIntoView({ block: "end" });
  }, [partial, current?.messages.length]);
  async function refresh(id = current?.id) {
    const list = await api("/api/workspaces");
    setItems(list.workspaces.filter((item) => item.kind !== "session"));
    if (id && selectedId.current === id) {
      const w = await api(`/api/workspaces/${id}`);
      if (selectedId.current !== id) return w;
      setCurrent(w);
      setProfile(w.permissions.profile);
      setWrite(w.permissions.grants["filesystem.write"]);
      setGitWrite(w.permissions.grants["git.write"] === true);
      setWriteScopeText((w.writeScope || []).join(", "));
      const log = await api(`/api/workspaces/${id}/events?latest=1`);
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
    setPrompt(pendingPrompt.current || draft?.prompt || "");
    pendingPrompt.current = "";
    setAttachments(draft?.attachments || []);
    setAttachmentError("");
    setEvents([]);
    setRunning(false);
    setError("");
    setPanel(initialPanel);
    setBrowserOpen(false);
    setDirectory(".");
    setPartial("");
    setResumeRunId("");
    generation.current++;
    setFile(null);
    setFiles([]);
    setOpenTabs([]);
    try {
      await refresh(id);
      onChanged?.(id);
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
      !config?.modelConfigured ||
      busy ||
      streaming
    )
      return;
    if (
      !Number.isInteger(rounds) ||
      rounds < 1 ||
      rounds > 1024 ||
      !Number.isFinite(minutes) ||
      minutes < 1 ||
      minutes > 1440
    ) {
      setError("运行预算需为 1–1024 轮、1–1440 分钟");
      return;
    }
    if (running) {
      setBusy(true);
      try {
        await api(base + "/steer", "POST", {
          runId: current.runs.find((r) => r.status === "running")?.id,
          message: taskText,
          externalConsent: true,
          requestId: crypto.randomUUID(),
        });
        setPrompt("");
        setAttachments([]);
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
          externalConsent: true,
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
          externalConsent: true,
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
  const pendingApprovals =
    current?.approvals.filter((a) => a.status === "pending") || [];
  // W7 状态呈现：活跃运行 + 待审批数 → 统一等待状态（优先服务端
  // derivedStatus，通用接口未下发时按同一事实在展示层归一）。
  const activeRun =
    current?.runs.findLast((r) => ["running", "queued"].includes(r.status)) ||
    null;
  const lastRun = current?.runs.at(-1) || null;
  // 文案按能力渲染:纯通用模式不宣称医疗工具可用。
  const medical = medicalEnabled(config);
  return (
    <div className={`shell workspace-shell ${inspectorOpen ? "with-inspector" : ""}`}>
      {showCreate && (
        <Modal
          title="连接项目工作区"
          onClose={() => setShowCreate(false)}
          wide
        >
          <form
            className="inline-form"
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
            <p className="muted">
              选择助手可以读取的本地文件夹。文件修改会单独请求授权
              {medical ? "，医疗工具在项目任务中同样可用。" : "。"}
            </p>
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
                      typeof window.omwDesktop?.chooseDirectory === "function"
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
            <label className="checkbox">
              <input
                type="checkbox"
                checked={directoryConsent}
                onChange={(e) => setDirectoryConsent(e.target.checked)}
              />
              授权此工作区读取该目录
            </label>
            <button className="primary" disabled={busy || running || !directoryConsent || !root}>
              创建工作区
            </button>
          </form>
        </Modal>
      )}
      {renaming && current && (
        <Modal title="重命名工作区" onClose={() => setRenaming(false)}>
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await organize(current, { title: renameValue }))
                setRenaming(false);
            }}
          >
            <label>
              名称
              <input
                autoFocus
                value={renameValue}
                maxLength={100}
                onChange={(e) => setRenameValue(e.target.value)}
                required
              />
            </label>
            <button className="primary" disabled={!renameValue.trim()}>
              保存
            </button>
          </form>
        </Modal>
      )}
      {!current ? (
        <div className="workspace-hub-empty">
          <div className="panel-empty">
            <FolderOpen size={29} />
            <h3>项目工作区</h3>
            <p>
              连接一个本地文件夹开始：读取限定在授权目录内，文件修改先查看、再批准。
              {medical ? "医疗工具（文献、知识库、用药核查）在项目任务中同样可用。" : ""}
            </p>
            <button
              className="secondary"
              disabled={busy || running}
              onClick={() => setShowCreate(true)}
            >
              <Plus size={15} />
              连接文件夹，开始使用
            </button>
          </div>
        </div>
      ) : (
        <>
          <main id="main" className="conversation">
            <div className="conversation-head">
              {onMenu && (
                <IconButton title="显示会话列表" onClick={onMenu}>
                  <Menu size={18} />
                </IconButton>
              )}
              <div className="heading-copy">
                <small>
                  项目工作区 ·{" "}
                  {current.root.split(/[\\/]/).filter(Boolean).at(-1) ||
                    current.root}
                </small>
                <h1>{current.title}</h1>
              </div>
              <div className="head-actions">
                <IconButton
                  title="在此文件夹新建任务"
                  disabled={busy || running}
                  onClick={() => newTask(current)}
                >
                  <Plus size={16} />
                </IconButton>
                <IconButton
                  title="重命名工作区"
                  disabled={busy || running}
                  onClick={() => {
                    setRenameValue(current.title);
                    setRenaming(true);
                  }}
                >
                  <PencilLine size={16} />
                </IconButton>
                <IconButton
                  title={current.pinned ? "取消置顶" : "在侧栏置顶"}
                  disabled={busy || running}
                  onClick={() => organize(current, { pinned: !current.pinned })}
                >
                  <Pin size={16} />
                </IconButton>
                <IconButton
                  title={
                    current.archived ? "恢复此工作区" : "归档此工作区（可恢复）"
                  }
                  disabled={busy || running || current.running}
                  onClick={() =>
                    organize(current, { archived: !current.archived })
                  }
                >
                  {current.archived ? <RotateCcw size={16} /> : <Archive size={16} />}
                </IconButton>
              </div>
              <IconButton
                title="显示工作面板"
                onClick={() => {setInspectorOpen(!inspectorOpen);onDisplayModeChange?.(inspectorOpen?"chat":"work");}}
              >
                <FolderOpen size={18} />
              </IconButton>
            </div>
            {current && (
              <div className="task-context-bar">
                <button
                  className={`meter wb-status-chip ${running ? "running" : ""}`}
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
                    ? `● ${runChipLabel(activeRun, pendingApprovals.length) || "执行中"}`
                    : config.modelConfigured
                      ? `${config.model} · ${
                          current.permissions.grants["filesystem.write"]
                            ? "可修改"
                            : "只读"
                        }`
                      : "连接模型"}
                </button>
                <span className="meter" title={current.root}>
                  {current.root}
                </span>
                {current.archived && (
                  <span className="meter">已归档 · 侧栏不再显示</span>
                )}
              </div>
            )}
            {error && (
              <p className="workspace-error" role="alert">
                {error}
                <IconButton title="关闭错误提示" onClick={() => setError("")}>
                  <X size={14} />
                </IconButton>
              </p>
            )}
            <div
              className="message-list"
              onScroll={(e) => {
                const el = e.currentTarget;
                followOutput.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 120;
              }}
            >
              {current.messages.length === 0 && !partial && (
                <div className="welcome task-preparation">
                  <div className="welcome-symbol">
                    <FolderOpen size={24} />
                  </div>
                  <p className="eyebrow">项目工作区已连接</p>
                  <h2>想在这个文件夹里完成什么？</h2>
                  <p>
                    描述目标，助手会在授权目录内读取文件、执行工具并汇报结果；文件修改先审批后写入。
                  </p>
                  {!prompt.trim() && (
                    <div className="ws-suggest-grid">
                      {suggestions.map((text) => (
                        <button onClick={() => chooseSuggestion(text)} key={text}>
                          <span>{text}</span>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="welcome-note">
                    <ShieldCheck size={14} />
                    {medical
                      ? "读取限定在授权目录内；文献、知识库、用药核查等医疗工具在项目任务中同样可用。"
                      : "读取限定在授权目录内；文件修改按授权档位审批后写入。"}
                  </div>
                </div>
              )}
              <div className="desk-messages">
                {current.messages.map((m, i) => (
                  <article
                    className={`message ${m.role === "user" ? "user-message" : ""}`}
                    key={i}
                  >
                    <div className="message-avatar">
                      {m.role === "user" ? "我" : <FolderOpen size={17} />}
                    </div>
                    <div className="message-body">
                      <div className="message-meta">
                        <b>{m.role === "user" ? "你" : "项目助理"}</b>
                        <span>{m.role === "user" ? "本轮输入" : "工作汇报"}</span>
                      </div>
                      <div className="message-content">
                        <RichMessage text={m.content} onOpenFile={openFile} />
                      </div>
                    </div>
                  </article>
                ))}
                {(running || partial) && (
                  <article className="message">
                    <div className="message-avatar">
                      <Loader2 className="spin" size={17} />
                    </div>
                    <div className="message-body">
                      <Activity
                        events={events}
                        current={current}
                        running={running}
                        onReview={() => {
                          setPanel("review");
                          setInspectorOpen(true);
                          onDisplayModeChange?.("work");
                        }}
                        onHistory={() => {
                          setPanel("history");
                          setInspectorOpen(true);
                          onDisplayModeChange?.("work");
                        }}
                      />
                      {partial && (
                        <div className="message-content streaming">
                          <RichMessage text={partial} onOpenFile={openFile} />
                        </div>
                      )}
                    </div>
                  </article>
                )}
              </div>
              <RunStatusNotice
                run={activeRun}
                pendingCount={pendingApprovals.length}
                onApprove={() => {
                  setPanel("review");
                  setInspectorOpen(true);
                  onDisplayModeChange?.("work");
                }}
              />
              {!running && lastRun && (lastRun.outcome || lastRun.delivery) && (
                <OutcomeCard
                  outcome={lastRun.outcome}
                  delivery={lastRun.delivery}
                />
              )}
              <Artifacts
                key={current.id}
                current={current}
                refresh={refresh}
                onDownload={downloadArtifact}
                onOpenFile={openFile}
              />
              <div ref={messagesEnd} />
            </div>
            <div className="composer-wrap">
              {current.runs.at(-1)?.canResume && !running && (
                <label className="workspace-checkbox wb-resume-row">
                  <input
                    type="checkbox"
                    checked={Boolean(resumeRunId)}
                    onChange={(e) =>
                      setResumeRunId(
                        e.target.checked ? current.runs.at(-1).id : "",
                      )
                    }
                  />
                  上次任务被中断，勾选后从检查点继续
                </label>
              )}
              <form className="composer" onSubmit={(e) => { e.preventDefault(); run(); }}>
                <textarea
                  ref={promptRef}
                  aria-label="项目任务"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={
                    running
                      ? "补充要求，助手会在下一步接收…（Enter 发送）"
                      : "描述你想在这个文件夹里完成的任务…（Enter 发送，Shift+Enter 换行）"
                  }
                  disabled={busy}
                  onKeyDown={(e) => {
                    // Enter sends, Shift+Enter newlines; never send while an
                    // IME composition (Chinese input) is confirming a candidate.
                    const composing =
                      e.nativeEvent.isComposing || e.keyCode === 229;
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !composing &&
                      !busy &&
                      prompt.trim() &&
                      config?.modelConfigured
                    ) {
                      e.preventDefault();
                      run();
                    }
                  }}
                />
                <div className="composer-bottom">
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
                      setPanel("files");
                      setInspectorOpen(true);
                      onDisplayModeChange?.("work");
                      list().catch((e) => setError(e.message));
                    }}
                  />
                  <span className="tb-divider" />
                  <label
                    className="tb-item"
                    title="文件写入授权：每次批准=修改先审查再写入；自动批准=工作区内直接写入；完全批准=含本地 Git 提交"
                  >
                    授权
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
                      <option value="workspace-write">自动 · 工作区内</option>
                      <option value="full">完全 · 含 Git</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="tb-item"
                    title={`当前模型：${config?.model || "未配置"}；点击打开运行设置更换模型`}
                    onClick={onOpenSettings}
                  >
                    模型 <b>{config?.model || "未配置"}</b>
                  </button>
                  <span className="composer-spacer" />
                  {(current.permissions.grants["filesystem.write"]
                    ? current.approvalPolicy
                    : "review") === "full" && (
                    <TriangleAlert
                      size={14}
                      className="tb-warn-icon"
                      title="完全批准已开启：助手将自动应用文件修改并自动提交本地 Git，请仅在可信任务中使用"
                    />
                  )}
                  {writeScopeText.trim() && (
                    <span
                      className="tb-scope-chip"
                      title="可写子目录（在设置标签页修改）"
                    >
                      可写 {writeScopeText.trim()}
                    </span>
                  )}
                  {running || streaming ? (
                    <button
                      type="button"
                      className="send-button stop"
                      aria-label="停止执行"
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
                      <Square size={15} />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      type="submit"
                      aria-label="发送任务"
                      disabled={busy || !prompt.trim() || !config?.modelConfigured}
                      title={!config?.modelConfigured ? "先连接模型" : "发送任务"}
                    >
                      <ArrowUp size={19} />
                    </button>
                  )}
                </div>
              </form>
              <div className="composer-note">
                <span>
                  项目任务在授权文件夹内读写，文件修改按「授权」档位审批后写入
                  {!config?.modelConfigured && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        className="text-button"
                        onClick={onOpenSettings}
                      >
                        未配置模型；点击配置后才能执行任务
                      </button>
                    </>
                  )}
                </span>
                <span>Enter 发送 · Shift + Enter 换行</span>
              </div>
            </div>
          </main>
          <aside
            className={`inspector ${inspectorOpen ? "open" : ""}`}
            aria-label="工作面板"
          >
            <div className="inspector-head">
              <b>工作面板</b>
              <span>{current.artifacts?.length || 0} 个成果文件</span>
              <IconButton
                title="关闭工作面板"
                onClick={() => setInspectorOpen(false)}
              >
                <X size={16} />
              </IconButton>
            </div>
            <div className="panel-tabs" role="tablist">
              {[
                ["files", "文件"],
                ["review", "审批"],
                ["media", "媒体"],
                ["browser", "浏览"],
                ["history", "记录"],
                ["settings", "设置"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={panel === key}
                  className={panel === key ? "active" : ""}
                  onClick={() => {
                    setPanel(key);
                    setInspectorOpen(true);
                    onDisplayModeChange?.("work");
                    // 进入文件标签时，没有打开的文件就直接展开目录浏览
                    if (
                      key === "files" &&
                      !browserOpen &&
                      !file &&
                      !busy &&
                      !running
                    ) {
                      setBrowserOpen(true);
                      list().catch((e) => setError(e.message));
                    }
                  }}
                >
                  {label}
                  {key === "review" && pendingApprovals.length > 0 && (
                    <span>{pendingApprovals.length}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="panel-scroll">
              <div hidden={panel !== "files"} className="wb-files-panel">
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
                <div className="wb-files-toolbar">
                  <button
                    className="wb-browse-toggle"
                    onClick={() => {
                      setBrowserOpen(!browserOpen);
                      if (!browserOpen) act(() => list(directory));
                    }}
                  >
                    {browserOpen ? "收起浏览" : "浏览文件"}
                  </button>
                </div>
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
                  <div className="wb-viewer">
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
                    ) : previewKind === "html" ? (
                      <iframe
                        className="wb-file-preview"
                        title={file.path}
                        src={htmlUrl}
                        sandbox="allow-scripts allow-modals allow-popups"
                      />
                    ) : previewKind === "markdown" ? (
                      <div className="wb-md-preview">
                        <RichMessage text={content} onOpenFile={openFile} />
                      </div>
                    ) : previewKind === "office" ? (
                      <div className="wb-office-preview">
                        {officeBusy && (
                          <p className="wb-muted">正在通过办公运行时转换…</p>
                        )}
                        {!officeBusy && !officeText && !officeError && (
                          <p className="wb-muted">正在读取文档…</p>
                        )}
                        {officeError && <p className="wb-muted">{officeError}</p>}
                        {officeText && <RichMessage text={officeText} />}
                      </div>
                    ) : (
                      <pre className="wb-viewer-text">{content}</pre>
                    )}
                  </div>
                )}
              </div>
              <div hidden={panel !== "review"}>
                {current.approvals.length === 0 && (
                  <div className="panel-empty">
                    <FileCheck2 size={28} />
                    <h3>暂时没有文件变更</h3>
                    <p>
                      助手提出的修改会出现在这里，你可以查看内容并批准。
                    </p>
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
              {panel === "media" && (
                <MediaPanel
                  key={current.id}
                  current={current}
                  refresh={refresh}
                  running={running}
                  onSettings={() => setPanel("settings")}
                />
              )}
              {panel === "browser" && (
                <>
                  <DesktopPanel key={`desktop-${current.id}`} current={current} />
                  <BrowserPanel
                    key={current.id}
                    current={current}
                    running={running}
                    onSettings={() => setPanel("settings")}
                  />
                </>
              )}
              <div hidden={panel !== "settings"} className="desk-settings-panel">
                <div className="desk-settings-header">
                  <div>
                    <h3>项目设置</h3>
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
                  模型连接是本机全局设置；
                  {medical ? "医疗能力、" : ""}文件权限与扩展配置只作用于当前工作区。
                </p>
              </div>
              <div hidden={panel !== "settings"}>
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
                        安全收窄：填写后助手只能修改这些子目录内的文件，其余路径一律只读（密钥文件仍然全局禁止）。
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
              <div hidden={panel !== "settings"}>
                <WorkspaceDevelopment
                  key={`development-${current.id}`}
                  current={current}
                  busy={busy || running}
                  act={act}
                  refresh={refresh}
                  select={select}
                />
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
              <div hidden={panel !== "history"}>
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
                    </div>
                  )}
                  {current.runs.map((r) => (
                    <div className="workspace-run" key={r.id}>
                      <span>
                        {stateLabel(r.status)} ·{" "}
                        {new Date(r.startedAt).toLocaleString()}
                      </span>
                      {r.derivedStatus === "blocked" && (
                        <p className="wb-run-blocked">
                          受阻：{blockedText(r.waitingReason)}
                        </p>
                      )}
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
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
