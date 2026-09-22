import { useRef, useState } from "react";
import { api } from "./agent-runtime";
import { Modal } from "./components";

const fields = (p) => ({ name: p.name, patientNumber: p.patientNumber || "", gender: p.gender || "unknown", birthYear: p.birthYear || "", phone: p.phone || "", groups: (p.groups || []).join("，"), tags: (p.tags || []).join("，"), note: p.note || "" });
const list = (value) => value.split(/[,，]/).map((v) => v.trim()).filter(Boolean);
export function PatientIdentityModal({ patient, onClose, onSaved }) {
  const [form, setForm] = useState(() => fields(patient));
  const [revision, setRevision] = useState(patient.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const set = (key) => (event) => setForm((old) => ({ ...old, [key]: event.target.value }));
  const save = async (event) => {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try {
      await api(`/api/patients/${patient.id}`, "PATCH", { ...form, expectedRevision: revision, birthYear: form.birthYear === "" ? null : Number(form.birthYear), groups: list(form.groups), tags: list(form.tags) });
      await onSaved();
    } catch (err) { setError(err.message); }
    finally { locked.current = false; setBusy(false); }
  };
  const reload = async () => {
    setBusy(true);
    try { const current = await api(`/api/patients/${patient.id}`); setForm(fields(current)); setRevision(current.revision); setError(""); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <Modal title="编辑患者基本信息" onClose={busy ? () => {} : onClose}>
    <form className="modal-form" onSubmit={save}><fieldset disabled={busy} className="identity-fields">
      <label>姓名<input required autoFocus maxLength={80} value={form.name} onChange={set("name")} /></label>
      <label>患者编号<input maxLength={40} value={form.patientNumber} onChange={set("patientNumber")} /></label>
      <div className="form-grid"><label>性别<select value={form.gender} onChange={set("gender")}><option value="unknown">未记录</option><option value="male">男</option><option value="female">女</option></select></label>
      <label>出生年份<input type="number" min="1900" max={new Date().getFullYear()} value={form.birthYear} onChange={set("birthYear")} /></label>
      <label>联系电话<input maxLength={20} value={form.phone} onChange={set("phone")} /></label></div>
      <label>分组（逗号分隔）<input value={form.groups} onChange={set("groups")} /></label>
      <label>标签（逗号分隔）<input value={form.tags} onChange={set("tags")} /></label>
      <label>备注<textarea aria-label="备注" maxLength={2000} rows={3} value={form.note} onChange={set("note")} /></label>
      {error && <p role="alert" className="error-text">{error} <button type="button" className="text-button" onClick={reload}>放弃本次编辑并载入最新档案</button></p>}
      <div className="toolbar-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={!form.name.trim()}>{busy ? "正在保存…" : "保存基本信息"}</button></div>
    </fieldset></form>
  </Modal>;
}
