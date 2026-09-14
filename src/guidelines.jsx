import { useEffect, useRef, useState } from "react";
import { api } from "./agent-runtime";
import { importMaterial } from "./import-material";
import {
  Search,
  Loader2,
  Upload,
  Trash2,
  BookOpen,
  ChevronLeft,
} from "lucide-react";

// Local guideline library: import PDFs/Markdown (text extracted in the
// browser), full-text search with line provenance, and an inline reader.
export function GuidelinesView() {
  const [docs, setDocs] = useState([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(null); // {name, text} awaiting metadata
  const [meta, setMeta] = useState({ title: "", org: "", year: "" });
  const [reader, setReader] = useState(null); // {doc, highlight}
  const fileRef = useRef();

  const refresh = async () => {
    const value = await api("/api/guidelines");
    setDocs(value.documents);
    return value.documents;
  };
  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, []);

  const onPickFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const material = await importMaterial(file);
      const text = material.text;
      if (!text) throw new Error("无法从该文件提取文本");
      setPending({ name: material.name || file.name, text });
      setMeta({
        title: (file.name.replace(/\.[^.]+$/, "")).slice(0, 120),
        org: "",
        year: String(new Date().getFullYear()),
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const confirmImport = async () => {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/guidelines", "POST", {
        title: meta.title || pending.name,
        org: meta.org || undefined,
        year: meta.year ? Number(meta.year) : undefined,
        text: pending.text,
        fileName: pending.name,
      });
      setPending(null);
      setNotice("指南已导入本地库并建立索引。");
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const runSearch = async (event) => {
    event?.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError("");
    try {
      const value = await api(
        `/api/guidelines/search?q=${encodeURIComponent(query)}&limit=12`,
      );
      setHits(value.hits);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const removeDoc = async (id) => {
    setError("");
    try {
      await api(`/api/guidelines/${id}`, "DELETE");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };
  const openReader = async (docId, highlight) => {
    setError("");
    try {
      const doc = await api(`/api/guidelines/${docId}`);
      setReader({ doc, highlight: highlight || null });
    } catch (err) {
      setError(err.message);
    }
  };

  if (reader) {
    const lines = reader.doc.text.split("\n");
    const { highlight } = reader;
    return (
      <div className="module-view">
        <section className="module-card guidelines-view">
          <div className="guidelines-reader-head">
            <button
              className="secondary"
              onClick={() => setReader(null)}
            >
              <ChevronLeft size={15} /> 返回列表
            </button>
            <h1>{reader.doc.title}</h1>
            <span className="muted">
              {reader.doc.org || "未标注机构"}
              {reader.doc.year ? ` · ${reader.doc.year}` : ""} · 共 {reader.doc.lineCount} 行
            </span>
          </div>
          <div className="guidelines-text">
            {lines.map((line, index) => {
              const lineNo = index + 1;
              const isMatch =
                highlight &&
                lineNo >= highlight.startLine &&
                lineNo <= highlight.endLine;
              return (
                <p
                  key={lineNo}
                  className={`guideline-line ${isMatch ? "matched" : ""}`}
                >
                  <span className="line-no">{lineNo}</span>
                  {line || " "}
                </p>
              );
            })}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="module-view">
      <section className="module-card guidelines-view">
        <div className="module-head">
          <div>
            <h1>指南库</h1>
            <p className="module-phase">本地导入 · 全文检索 · 行号出处</p>
          </div>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="form-notice">{notice}</p>}

        {pending ? (
          <div className="guideline-import">
            <h3>确认导入：{pending.name}</h3>
            <p className="muted">
              已提取 {pending.text.length} 字符文本。
            </p>
            <div className="guideline-meta-row">
              <input
                value={meta.title}
                placeholder="指南标题"
                onChange={(e) => setMeta({ ...meta, title: e.target.value })}
              />
              <input
                value={meta.org}
                placeholder="机构（如 中华医学会）"
                onChange={(e) => setMeta({ ...meta, org: e.target.value })}
              />
              <input
                value={meta.year}
                placeholder="年份"
                inputMode="numeric"
                onChange={(e) =>
                  setMeta({ ...meta, year: e.target.value.replace(/\D/g, "") })
                }
              />
            </div>
            <div className="guideline-import-actions">
              <button onClick={confirmImport} disabled={busy}>
                {busy ? <Loader2 className="spin" size={14} /> : <Upload size={14} />}
                导入并建索引
              </button>
              <button className="secondary" onClick={() => setPending(null)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <button className="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload size={14} /> 导入指南（PDF / Markdown / TXT）
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.md,.txt,.markdown"
          hidden
          onChange={onPickFile}
        />

        <form className="literature-form" onSubmit={runSearch}>
          <input
            className="literature-query"
            value={query}
            placeholder="在指南库中检索，如：血压达标 随访"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" disabled={busy || !query.trim()}>
            {busy ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
            检索
          </button>
        </form>

        {hits && (
          <ul className="literature-results">
            {hits.map((hit) => (
              <li className="literature-item" key={`${hit.docId}-${hit.ord}`}>
                <div className="literature-title-row">
                  <button
                    className="literature-title"
                    onClick={() => openReader(hit.docId, hit)}
                  >
                    <BookOpen size={14} /> {hit.docTitle}
                  </button>
                  <span className="literature-journal">
                    {hit.org || "未标注机构"}
                    {hit.year ? ` · ${hit.year}` : ""} · L{hit.startLine}–{hit.endLine}
                  </span>
                </div>
                {hit.matches.map((match) => (
                  <p className="guideline-match" key={match.lineNo}>
                    <span className="line-no">L{match.lineNo}</span>
                    {match.text}
                  </p>
                ))}
                <div className="literature-actions">
                  <button
                    className="secondary"
                    onClick={() => openReader(hit.docId, hit)}
                  >
                    查看原文
                  </button>
                </div>
              </li>
            ))}
            {!hits.length && <li className="memory-empty">指南库中没有匹配的条文。</li>}
          </ul>
        )}

        <h3 className="guidelines-list-title">
          已收录指南 <span className="muted">{docs.length} 份</span>
        </h3>
        <ul className="guideline-docs">
          {docs.map((doc) => (
            <li key={doc.id}>
              <button className="guideline-doc" onClick={() => openReader(doc.id)}>
                <b>{doc.title}</b>
                <small>
                  {doc.org || "未标注机构"}
                  {doc.year ? ` · ${doc.year}` : ""} · {doc.chunkCount} 个索引块
                </small>
              </button>
              <button
                className="icon-button danger"
                title="删除该指南"
                onClick={() => removeDoc(doc.id)}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
          {!docs.length && (
            <li className="memory-empty">
              还没有指南。导入本地指南 PDF 后，检索结果可带行号出处进入循证草稿。
            </li>
          )}
        </ul>
        <p className="module-note">
          指南内容仅作为参考资料，检索引用时请核对原文行号；不构成处方或剂量建议。
        </p>
      </section>
    </div>
  );
}
