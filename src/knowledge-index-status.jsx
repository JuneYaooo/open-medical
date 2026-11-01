import { useEffect, useRef, useState } from "react";
import { api } from "./agent-runtime";

// Retrieval index health for the knowledge base. Without a working embedding
// service every document falls back to keyword search; this is where the
// doctor sees that, tests the connection, and rebuilds the index.
export function KnowledgeIndexStatus({ onChanged }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  const load = async () => {
    try {
      const value = await api("/api/knowledge/index-status");
      if (alive.current) setStatus(value);
    } catch (err) {
      if (alive.current) setError(err.message);
    }
  };
  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, []);
  const act = async (kind, work) => {
    if (busy) return;
    setBusy(kind); setError(""); setNotice("");
    try { setNotice(await work()); await load(); await onChanged?.(); }
    catch (err) { setError(err.message); }
    finally { if (alive.current) setBusy(""); }
  };
  if (!status) return error ? <p className="form-error" role="alert">检索索引状态读取失败：{error}</p> : null;
  const docs = status.indexing || [];
  const keywordOnly = docs.filter((d) => d.status && !["ready", "running", "queued"].includes(d.status)).length;
  const health = status.embedder?.health?.state;
  const healthy = health === "ready";
  const problem = keywordOnly > 0 || status.stale || health === "failed";
  if (!docs.length) return null;
  return <details className="kw-index-status" open={problem}>
    <summary>
      <b>检索索引</b>
      <span className={`om-chip ${problem ? "is-caution" : "is-ok"}`}>
        {status.stale ? "嵌入模型已更换，需重建索引" : keywordOnly ? `${keywordOnly} 份资料仅关键词检索` : healthy ? "语义检索可用" : "嵌入连接未检查"}
      </span>
    </summary>
    <p className="muted">
      嵌入模型 {status.currentModel || "未配置"}（{status.embedder?.mode === "cloud" ? "云端，仅发送公开知识文本" : "本机 Ollama"}）· 已索引 {status.embeddedChunks} 个片段
      {health === "failed" && "。最近一次连接测试失败"}
    </p>
    {status.embedder?.mode !== "cloud" && !healthy && <p className="muted">本机模式需要已运行的 Ollama 并安装 bge-m3 模型（ollama pull bge-m3）；也可设置环境变量 MEDICAL_EMBEDDING_KEY 改用云端嵌入。未就绪时关键词检索照常可用。</p>}
    <div className="toolbar-actions">
      <button className="secondary" disabled={Boolean(busy)} onClick={() => act("probe", async () => {
        const result = await api("/api/knowledge/embedding-health", "POST", {});
        return result.health?.state === "ready" ? "嵌入连接正常。" : "嵌入连接失败，请检查服务后重试。";
      })}>{busy === "probe" ? "正在检查…" : "检查嵌入连接"}</button>
      <button className="secondary" disabled={Boolean(busy)} onClick={() => {
        if (!window.confirm("重建全部资料的检索索引？资料较多时需要几分钟，期间检索照常可用。")) return;
        act("reindex", async () => {
          const result = await api("/api/knowledge/reindex", "POST", {});
          return result.failures?.length ? `已处理 ${result.docs} 份资料，其中 ${result.failures.length} 份仍未建立语义索引。` : `已重建 ${result.docs} 份资料的索引。`;
        });
      }}>{busy === "reindex" ? "正在重建…" : "重建全部索引"}</button>
    </div>
    {notice && <p role="status" className="muted">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </details>;
}
