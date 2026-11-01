import { KNOWLEDGE_KINDS } from "../shared/knowledge-profiles.mjs";
import { useRef, useState } from "react";
import { api } from "./agent-runtime";
import { Modal } from "./components";


export function KnowledgeMetadataModal({ doc, onClose, onSaved }) {
  const [form, setForm] = useState({ title: doc.title, org: doc.org || "", year: doc.year || "", kind: doc.kind || "指南", collection: doc.collection || "默认知识库", sourceUrl: doc.sourceUrl || "", edition: doc.edition || "", enabled: doc.reviewStatus !== "retired", allowExternalUse: doc.allowExternalUse === true, avatarExcluded: doc.avatarExcluded === true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const set = (key, sourceField = false) => (event) => setForm((previous) => ({ ...previous, [key]: event.target.value, ...(sourceField ? { allowExternalUse: false } : {}) }));
  const save = async (event) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const { enabled, allowExternalUse, avatarExcluded, ...metadata } = form;
      const updated = await api(`/api/knowledge/${doc.id}`, "PATCH", { ...metadata, year: form.year ? Number(form.year) : null, ...(enabled !== (doc.reviewStatus !== "retired") ? { reviewStatus: enabled ? "unreviewed" : "retired" } : {}), allowExternalUse: enabled && allowExternalUse, ...(avatarExcluded !== (doc.avatarExcluded === true) ? { avatarExcluded } : {}), expectedRevision: doc.revision || 0 });
      await onSaved(updated);
    } catch (err) { setError(err.message); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <Modal title="管理来源与版本" onClose={busy ? () => {} : onClose}>
    <form className="modal-form" onSubmit={save}><fieldset className="identity-fields" disabled={busy}>
      <label>文档标题<input required maxLength={150} value={form.title} onChange={set("title", true)} /></label>
      <div className="form-grid"><label>机构或作者<input maxLength={80} value={form.org} onChange={set("org", true)} /></label><label>出版年份<input type="number" min="1950" max={new Date().getFullYear()} value={form.year} onChange={set("year", true)} /></label></div>
      <div className="form-grid"><label>类别<select value={form.kind} onChange={set("kind", true)}>{[...KNOWLEDGE_KINDS, ...(KNOWLEDGE_KINDS.includes(doc.kind || "指南") ? [] : [doc.kind])].map((v) => <option key={v}>{v}</option>)}</select></label><label>所属知识库<input required maxLength={60} value={form.collection} onChange={set("collection", true)} /></label></div>
      <label>来源链接<input type="url" maxLength={2000} value={form.sourceUrl} onChange={set("sourceUrl", true)} placeholder="https:// 官方发布页" /></label>
      <label>版本说明<input maxLength={100} value={form.edition} onChange={set("edition", true)} placeholder="如：2026 修订版、第二版" /></label>
      <label>资料状态<select aria-label="资料状态" value={form.enabled ? "active" : "retired"} onChange={e=>setForm({...form, enabled:e.target.value === "active", allowExternalUse:false})}><option value="active">使用中</option><option value="retired">已停用</option></select></label>
      <details><summary>对外引用设置</summary><label className="checkbox"><input type="checkbox" checked={form.allowExternalUse} disabled={!form.enabled} onChange={e=>setForm({...form,allowExternalUse:e.target.checked})}/>允许机器人对外回复引用此资料</label><p className="muted">仅在已授权的机器人与会话中使用。修改来源或正文后需重新开启。</p><label className="checkbox"><input type="checkbox" checked={form.avatarExcluded} onChange={e=>setForm({...form,avatarExcluded:e.target.checked})}/>不让医生分身使用这份资料</label><p className="muted">医生分身默认可使用所勾选知识库中的全部在用资料；编辑来源或正文不会改变这一设置。</p></details>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="toolbar-actions"><button className="secondary" type="button" onClick={onClose}>取消</button><button className="primary">{busy ? "正在保存…" : "保存来源信息"}</button></div>
    </fieldset></form>
  </Modal>;
}
