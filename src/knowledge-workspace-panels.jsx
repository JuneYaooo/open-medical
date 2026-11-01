import { useState } from "react";
import { coverageLabel } from "../shared/knowledge-profiles.mjs";
import { graphState } from "./knowledge-workspace-model.mjs";

function closeMenu(event) {
  const menu = event.currentTarget.closest("details");
  if (menu) menu.open = false;
}

export function KnowledgeDocuments({
  docs,
  jobs,
  onRead,
  onReview,
  onIndex,
  onOrganize,
  onDelete,
  busy,
  onImport,
}) {
  const [query, setQuery] = useState("");
  const keywordOnly = docs.filter((doc) => ["failed", "interrupted", "keyword_only"].includes(doc.indexing?.status)).length;
  const filtered = docs.filter((doc) =>
    `${doc.title} ${doc.org || ""} ${doc.edition || doc.year || ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <section>
      <div className="kw-section-heading">
        <label className="kw-document-filter">
          <span className="sr-only">查找资料</span>
          <input
            aria-label="查找资料"
            placeholder="按名称、机构或版本查找资料"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="toolbar-actions">
          <span className="kw-document-count">
            {query.trim() ? `${filtered.length} / ${docs.length}` : docs.length}{" "}
            份资料
          </span>
          <button className="primary" onClick={onImport}>
            添加资料
          </button>
        </div>
      </div>
      {keywordOnly > 0 && (
        <p className="kl-banner" role="note">
          {keywordOnly} 份资料的语义检索暂不可用，目前按关键词检索。可在「设置 → 模型与运行」配置向量服务后，在资料的“更多”里重建语义索引。
        </p>
      )}
      {!!filtered.length && (
        <div className="kw-table-scroll">
          <table className="kw-table kw-documents-table">
            <thead>
              <tr>
                <th>资料</th>
                <th>版本</th>
                <th>状态</th>
                <th><span className="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((doc) => {
                const graph = graphState(doc.id, jobs);
                const partial = ["excerpt", "needs_review"].includes(doc.coverage?.status);
                return (
                <tr key={doc.id} className={doc.reviewStatus === "retired" ? "is-retired" : ""}>
                  <td>
                    <button
                      className="text-button kw-doc-title"
                      onClick={() => onRead(doc.id)}
                    >
                      {doc.title}
                    </button>
                    {doc.org && <small>{doc.org}</small>}
                    {(doc.edition || doc.year) && (
                      <small className="kw-mobile-version">
                        {doc.edition || doc.year}
                      </small>
                    )}
                  </td>
                  <td>{doc.edition || doc.year || <span className="om-meta">未注明</span>}</td>
                  <td>
                    <span className="kl-status">
                      {doc.reviewStatus === "retired" && <span className="om-chip kw-badge">已停用</span>}
                      {partial && <span className="om-chip is-caution">{coverageLabel(doc.coverage)}</span>}
                      {["failed", "interrupted", "keyword_only"].includes(doc.indexing?.status) && <span className="om-chip is-caution" title="语义检索暂不可用，仍可按关键词检索；可在上方「检索索引」重建">仅关键词检索</span>}
                      {["running", "queued"].includes(doc.indexing?.status) && <span className="om-chip">索引处理中</span>}
                      {graph === "生成中" && <span className="om-chip is-info">图谱生成中…</span>}
                      {graph === "已生成" && <span className="om-chip is-ok">已生成图谱</span>}
                      {doc.reviewStatus !== "retired" && !partial && doc.indexing?.status === "ready" && graph !== "生成中" && graph !== "已生成" && <span className="om-meta">可检索</span>}
                    </span>
                  </td>
                  <td>
                    <div className="kw-document-actions">
                      <button className="text-button kl-read" onClick={() => onRead(doc.id)}>
                        阅读
                      </button>
                      <details className="kw-document-more kl-menu">
                        <summary aria-label={`更多操作：${doc.title}`}>
                          更多
                        </summary>
                        <div className="kw-row-actions">
                          {doc.indexing?.error?.message && (
                            <small>{doc.indexing.error.message}</small>
                          )}
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={(e) => { closeMenu(e); onReview(doc); }}
                          >
                            来源与版本
                          </button>
                          {doc.indexing?.status !== "ready" && (
                            <button
                              className="text-button"
                              disabled={
                                busy || doc.indexing?.status === "running"
                              }
                              onClick={(e) => { closeMenu(e); onIndex(doc); }}
                            >
                              {doc.indexing?.status === "running"
                                ? "索引处理中"
                                : "重建语义索引"}
                            </button>
                          )}
                          {doc.reviewStatus !== "retired" &&
                            ["尚未生成", "未完成"].includes(graph) && (
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={(e) => { closeMenu(e); onOrganize(doc); }}
                              >
                                {graph === "未完成"
                                  ? "继续生成图谱"
                                  : "生成图谱"}
                              </button>
                            )}
                          <button
                            className="text-button danger"
                            disabled={busy}
                            onClick={(e) => { closeMenu(e); onDelete(doc); }}
                          >
                            删除资料
                          </button>
                        </div>
                      </details>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!filtered.length && (
        <div className="kw-empty">
          {docs.length
            ? "没有找到匹配的资料，试试其他名称或版本。"
            : "还没有资料。添加文件后，即可在这里阅读、检索或向 AI 提问。"}
        </div>
      )}
    </section>
  );
}
