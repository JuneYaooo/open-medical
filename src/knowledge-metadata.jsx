import { useRef, useState } from "react";
import { api } from "./agent-runtime";
import { Modal } from "./components";

export const knowledgeStateLabels = { unreviewed: "来源待核对", reviewed: "来源已核对", retired: "已停用" };
export function KnowledgeMetadataModal({ doc, onClose, onSaved }) {
  const [form, setForm] = useState({ title: doc.title, org: doc.org || "", year: doc.year || "", kind: doc.kind || "指南", collection: doc.collection || "默认知识库", sourceUrl: doc.sourceUrl || "", edition: doc.edition || "", reviewStatus: doc.reviewStatus || "unreviewed", reviewDueDate: doc.reviewDueDate || "", reviewNote: doc.reviewNote || "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const set = (key, sourceField = false) => (event) => setForm((previous) => ({ ...previous, [key]: event.target.value, ...(sourceField && previous.reviewStatus === "reviewed" ? { reviewStatus: "unreviewed" } : {}) }));
  const save = async (event) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const updated = await api(`/api/knowledge/${doc.id}`, "PATCH", { ...form, year: form.year ? Number(form.year) : null, expectedRevision: doc.revision || 0 });
      await onSaved(updated);
    } catch (err) { setError(err.message); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <Modal title="管理来源与版本" onClose={busy ? () => {} : onClose}>
    <form className="modal-form" onSubmit={save}><fieldset className="identity-fields" disabled={busy}>
      <label>文档标题<input required maxLength={150} value={form.title} onChange={set("title", true)} /></label>
      <div className="form-grid"><label>机构或作者<input maxLength={80} value={form.org} onChange={set("org", true)} /></label><label>出版年份<input type="number" min="1950" max={new Date().getFullYear()} value={form.year} onChange={set("year", true)} /></label></div>
      <div className="form-grid"><label>类别<select value={form.kind} onChange={set("kind", true)}>{["指南", "书籍", "资料", "文献", "其他"].map((v) => <option key={v}>{v}</option>)}</select></label><label>所属知识库<input required maxLength={60} value={form.collection} onChange={set("collection", true)} /></label></div>
      <label>来源链接<input type="url" maxLength={2000} value={form.sourceUrl} onChange={set("sourceUrl", true)} placeholder="https:// 官方发布页" /></label>
      <label>版本说明<input maxLength={100} value={form.edition} onChange={set("edition", true)} placeholder="如：2026 修订版、第二版" /></label>
      <div className="form-grid"><label>来源状态<select aria-label="来源状态" value={form.reviewStatus} onChange={set("reviewStatus")}>{Object.entries(knowledgeStateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>下次复核日期<input type="date" value={form.reviewDueDate} onChange={set("reviewDueDate")} /></label></div>
      <label>核对记录或停用原因<textarea aria-label="核对记录或停用原因" rows={3} required={form.reviewStatus !== "unreviewed"} maxLength={1000} value={form.reviewNote} onChange={set("reviewNote")} placeholder="核对了哪个发布页和版本？有哪些适用范围或限制？" /></label>
      <p className="muted">“来源已核对”记录你的核对过程，不代表内容适用于所有患者。停用后默认检索不再采用，原文与既有引用仍可查看。</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="toolbar-actions"><button className="secondary" type="button" onClick={onClose}>取消</button><button className="primary">{busy ? "正在保存…" : "保存来源信息"}</button></div>
    </fieldset></form>
  </Modal>;
}
