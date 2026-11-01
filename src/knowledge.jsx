import { useCallback, useEffect, useRef, useState } from "react";
import { KnowledgeIndexStatus } from "./knowledge-index-status";
import { knowledgeSearchContext, knowledgeSourceContext, knowledgeTopicContext } from "./task-context";
import { api } from "./agent-runtime";
import { Modal } from "./components";
import { knowledgeProfile } from "../shared/knowledge-profiles.mjs";
import { KnowledgeMetadataModal } from "./knowledge-metadata";
import { KnowledgeImport } from "./knowledge-import";
import { KnowledgeMap } from "./knowledge-organization";
import { KnowledgeDocuments } from "./knowledge-workspace-panels";
import { KnowledgeSearch } from "./knowledge-search";
import { KnowledgeReader } from "./knowledge-reader";
import { workspaceTabs } from "./knowledge-workspace-model.mjs";
import "./knowledge-workspace.css";
import { openKnowledgeSource } from "./knowledge-source-events";
import { transcriptionSettingsUrl } from "./knowledge-transcription-settings";
import { KnowledgeTranscriptRecovery } from "./knowledge-transcript-recovery";

const MODEL_SETTINGS_URL = "?view=settings&settingsTab=general";

export function KnowledgeView({
  onOpenTask,
  collection = "",
  initialCitation = null,
}) {
  const [docs, setDocs] = useState([]),
    [data, setData] = useState({ jobs: [] }),
    [tab, updateTab] = useState(() => {
      const v = new URLSearchParams(window.location.search).get("knowledgeTab");
      return workspaceTabs.some(([id]) => id === v) ? v : "documents";
    }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [refreshError, setRefreshError] = useState(""),
    [notice, setNotice] = useState("");
  const [reader, setReader] = useState(initialCitation),
    [importing, setImporting] = useState(false),
    [editing, setEditing] = useState(null),
    [deleting, setDeleting] = useState(null),
    [organizing, setOrganizing] = useState(null),
    [busy, setBusy] = useState(false);
  const [transcriptJob, setTranscriptJob] = useState(null);
  const setTab = (value) => {
    updateTab(value);
    const url = new URL(window.location.href);
    url.searchParams.set("knowledgeTab", value);
    window.history.replaceState(null, "", url);
  };
  const closeReader = () => {
    setReader(null);
    const url = new URL(window.location.href);
    for (const key of ["knowledgeDoc", "line", "endLine", "sourceHash"])
      url.searchParams.delete(key);
    window.history.replaceState(null, "", url);
  };
  const alive = useRef(true),
    lock = useRef(false),
    snapshot = useRef("");
  const refresh = useCallback(async () => {
    const [value, jobs] = await Promise.all([
      api("/api/knowledge?" + new URLSearchParams({ collection })),
      api("/api/knowledge/organization?" + new URLSearchParams({ collection })),
    ]);
    if (!alive.current) return;
    // Collection filtering is also enforced here for servers returning a global document list.
    const documents = value.documents.filter(
      (d) => !collection || (d.collection || "默认知识库") === collection,
    );
    const sig = JSON.stringify([documents, jobs]);
    if (sig !== snapshot.current) {
      snapshot.current = sig;
      setDocs(documents);
      setData(jobs);
    }
    setLoading(false);
    setRefreshError("");
  }, [collection]);
  useEffect(() => {
    alive.current = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        await refresh();
      } catch (e) {
        if (alive.current) {
          setRefreshError(e.message);
          setLoading(false);
        }
      } finally {
        pending = false;
      }
    };
    load();
    const timer = setInterval(load, 3000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  const perform = async (fn) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const openReader = async (id, highlight) => {
    if (highlight) {
      openKnowledgeSource({ id, highlight, sourceHash: highlight.sourceHash || highlight.sha256 });
      return;
    }
    setError("");
    try {
      const doc = await api(`/api/knowledge/${encodeURIComponent(id)}`);
      setReader({ doc, highlight: highlight || null });
    } catch (e) {
      setError(e.message);
    }
  };
  const review = (doc) =>
    perform(async () =>
      setEditing(await api(`/api/knowledge/${encodeURIComponent(doc.id)}`)),
    );
  const reindex = (doc) =>
    perform(async () => {
      await api(`/api/knowledge/${doc.id}/reindex`, "POST", {});
      setNotice(`正在为「${doc.title}」重建语义索引。`);
    });
  // 页面入口只把医生能看懂的请求放进输入框；知识库限定、检索线索和
  // 引用要求作为任务上下文随问题发送（见 src/task-context.jsx）。
  // 知识问答由模型执行：未连接模型时不创建任务会话，直接说明并给出入口。
  const [modelGate, setModelGate] = useState(false);
  const createTask = async (title, draft, context) => {
    if (!data.modelReady) {
      // 阅读视图里没有页面级提示，错误随阅读器显示。
      if (reader) setError("需先连接模型：知识问答由模型执行，未连接时不能发送。可在 设置 → 模型与运行 中连接模型。");
      else setModelGate(true);
      return;
    }
    return perform(async () => {
      const task = await api("/api/sessions", "POST", {
        title: title.slice(0, 100),
      });
      await onOpenTask(task.id, { draft, workflow: "knowledge-answer", context });
    });
  };
  const prepareSource = (doc, range) =>
    createTask(
      `循证准备：${doc.title}`,
      `请整理《${doc.title}》${range ? `第 ${range.startLine}–${range.endLine} 行` : ""}的循证摘要。`,
      knowledgeSourceContext(collection, doc, range),
    );
  const ask = (result) =>
    createTask(`知识问答：${result.query}`, result.query, knowledgeSearchContext(collection, result));
  const pendingImports = data.jobs.filter(
    (job) =>
      !docs.some((doc) => doc.id === job.docId) &&
      ["queued", "running", "failed", "interrupted", "needs_input"].includes(
        job.status,
      ),
  );
  return (
    <div className="kw-workspace">
      {reader && (
        <KnowledgeReader
          reader={reader}
          onClose={closeReader}
          onReview={review}
          onUpdated={doc => { setReader(current => ({ doc, highlight: null, stale: Boolean(current?.highlight || current?.stale) })); refresh().catch(e => setRefreshError(e.message)); }}
          onPrepare={onOpenTask ? prepareSource : undefined}
          onLocate={openReader}
          busy={busy}
          error={error}
        />
      )}
      <div hidden={Boolean(reader)}>
        <nav className="kw-nav" aria-label="知识库工作区">
          {workspaceTabs.map(([id, label]) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="kw-content">
          <KnowledgeIndexStatus onChanged={refresh} />
          {pendingImports.map((job) => (
            <div className="kw-processing-notice" role="status" key={job.id}>
              <span>
                {job.fileName} ·{" "}
                {["queued", "running"].includes(job.status)
                  ? "正在导入…"
                  : `导入未完成：${job.error || "处理已中断"}`}
              </span>
              {!["queued", "running"].includes(job.status) && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    perform(() =>
                      api(
                        `/api/knowledge/organization/${job.id}/retry`,
                        "POST",
                        { externalConsent: true },
                      ),
                    )
                  }
                >
                  重试导入
                </button>
              )}
              {!["queued", "running"].includes(job.status) && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`移除「${job.fileName}」这条未完成的导入？已上传的原文件会一并删除。`)) return;
                    perform(() => api(`/api/knowledge/organization/${job.id}`, "DELETE"));
                  }}
                >
                  移除
                </button>
              )}
              {!["queued", "running"].includes(job.status) && /\.(mp3|m4a|wav|mp4|mov)$/i.test(job.fileName) && <>
                <a href={transcriptionSettingsUrl(collection)}>配置转写服务</a>
                {!job.suppliedTranscript && !job.docId && <button className="text-button" disabled={busy} onClick={()=>setTranscriptJob(job)}>补充文字稿</button>}
              </>}
            </div>
          ))}
          {modelGate && !data.modelReady && (
            <p className="notice" role="status">
              需先连接模型：知识问答由模型执行，未连接时不能发送；知识库检索与原文阅读不受影响。{" "}
              <a href={MODEL_SETTINGS_URL}>连接模型</a>
            </p>
          )}
          {(error || refreshError) && (
            <p className="form-error" role="alert">
              {error || refreshError}{" "}
              <button
                className="text-button"
                onClick={() => perform(async () => {})}
              >
                重新加载
              </button>
            </p>
          )}
          {notice && (
            <p role="status" className="kw-notice">
              {notice}
              <button
                className="text-button"
                aria-label="关闭提示"
                onClick={() => setNotice("")}
              >
                关闭
              </button>
            </p>
          )}
          {loading && <p role="status">正在读取知识库…</p>}
          {!loading && (
            <>
              <div hidden={tab !== "documents"}>
                <KnowledgeDocuments
                  docs={docs}
                  jobs={data.jobs}
                  onRead={openReader}
                  onReview={review}
                  onIndex={reindex}
                  onOrganize={setOrganizing}
                  onDelete={doc => { setError(""); setDeleting(doc); }}
                  busy={busy}
                  onImport={() => setImporting(true)}
                />
              </div>
              <div hidden={tab !== "search"}>
                <KnowledgeSearch
                  collection={collection}
                  onRead={openReader}
                  onAsk={onOpenTask ? ask : undefined}
                />
              </div>
              {tab === "map" && (
                <KnowledgeMap
                  key={collection}
                  collection={collection}
                  refreshKey={data.jobs}
                  onRead={openReader}
                  onAsk={
                    onOpenTask
                      ? (node) =>
                          // 问题留给医生输入；输入框为空时无法发送。
                          createTask("知识问答：" + node.label, "", knowledgeTopicContext(collection, node))
                      : undefined
                  }
                />
              )}
            </>
          )}
        </div>
      </div>
      {importing && (
        <KnowledgeImport
          collection={collection}
          capabilities={data}
          onClose={() => setImporting(false)}
          onSubmitted={async ({ count, duplicates, close }) => {
            await refresh();
            if (close) {
              setImporting(false);
              setTab("documents");
            }
            setNotice(
              `已提交 ${count} 份资料${duplicates ? `（${duplicates} 份已存在）` : ""}。上传完成的资料会在后台处理，可离开本页。`,
            );
          }}
        />
      )}
      {transcriptJob && <KnowledgeTranscriptRecovery job={transcriptJob} onClose={()=>setTranscriptJob(null)} onSaved={async()=>{setTranscriptJob(null);await refresh();}}/>}
      {editing && (
        <KnowledgeMetadataModal
          key={editing.id}
          doc={editing}
          onClose={() => setEditing(null)}
          onSaved={async (doc) => {
            setEditing(null);
            if (reader?.doc.id === doc.id) setReader({ ...reader, doc });
            await refresh();
            setNotice("来源信息已保存。");
          }}
        />
      )}
      {organizing && (
        <Modal
          title="生成知识图谱"
          onClose={() => !busy && setOrganizing(null)}
        >
          <p>
            将使用当前聊天模型整理「{organizing.title}
            」的知识点、关系与原文依据，相关文字会发送给该服务。处理进度会保存，生成结果仍需核对。
          </p>
          {!data.modelReady && (
            <p role="alert" className="form-error">
              尚未连接聊天模型。请先在设置中连接聊天模型，再生成知识图谱；资料的全文检索不受影响。
            </p>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="toolbar-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setOrganizing(null)}
            >
              取消
            </button>
            <button
              className="primary"
              disabled={busy || !data.modelReady}
              onClick={() =>
                perform(async () => {
                  await api(
                    `/api/knowledge/${organizing.id}/organization`,
                    "POST",
                    {
                      externalConsent: true,
                      sourceKind: knowledgeProfile(
                        organizing.sourceKind,
                        organizing.kind,
                      ).name,
                    },
                  );
                  setOrganizing(null);
                  setTab("map");
                })
              }
            >
              开始生成
            </button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal title="删除资料" onClose={() => !busy && setDeleting(null)}>
          <p>
            删除「{deleting.title}
            」及其检索索引和已保存的原件后，相关引用将无法打开。电脑上另外保存的源文件不受影响。
          </p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="toolbar-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              取消
            </button>
            {deleting.conflict && <button
              className="secondary"
              disabled={busy}
              onClick={() => perform(async () => {
                const doc = await api(`/api/knowledge/${deleting.id}`);
                setDeleting(null);
                setReader({ doc, highlight: null });
              })}
            >查看最新资料</button>}
            <button
              className="primary"
              disabled={busy || deleting.conflict}
              onClick={() =>
                perform(async () => {
                  try {
                    await api(`/api/knowledge/${deleting.id}`, "DELETE", { expectedRevision: deleting.revision || 0 });
                  } catch (failure) {
                    if (failure.code === "REVISION_CONFLICT") setDeleting(current => current ? { ...current, conflict: true } : current);
                    throw failure;
                  }
                  setDeleting(null);
                  setNotice("资料已删除。");
                })
              }
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
