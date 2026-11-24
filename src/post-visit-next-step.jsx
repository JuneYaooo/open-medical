import { useState } from "react";
import { X } from "lucide-react";
import { api } from "./agent-runtime";
import { briefContext, briefRequest } from "../shared/patient-brief.mjs";
import { usePluginActive } from "./plugin-slots";

// Shown right after a visit is marked attended: the steps that usually follow
// it, one click each, instead of a sentence telling the doctor where to go.
// Styles live in style.css (.post-visit-next) so every page can use it.
export function PostVisitNextStep({ step, onPatient, onOpenTask, modelConfigured = true, onClose }) {
  const followupActive = usePluginActive("followup");
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  if (!step) return null;
  const postVisitNotes = async () => {
    if (preparing) return;
    setPreparing(true); setError("");
    try {
      const brief = await api(`/api/patients/${step.patientId}/brief`);
      await onOpenTask(brief.sessionId, { draft: briefRequest("postvisit"), context: briefContext(brief, "postvisit"), submit: modelConfigured });
    } catch (err) { setError(err.message); }
    finally { setPreparing(false); }
  };
  return <div className="post-visit-next" role="status">
    <div><b>已登记{step.patientName}到诊</b><small>接下来通常要做：</small>{error && <span className="form-error" role="alert">{error}</span>}</div>
    <div className="toolbar-actions">
      {onOpenTask && <button className="primary" disabled={preparing} onClick={postVisitNotes}>{preparing ? "正在读取档案…" : "准备诊后文书"}</button>}
      <button className="secondary" onClick={() => onPatient({ id: step.patientId, tab: "appointments" })}>约下次复诊</button>
      {followupActive && <button className="secondary" onClick={() => onPatient({ id: step.patientId, tab: "followups" })}>安排随访</button>}
      <button className="icon-button" aria-label="关闭下一步提示" onClick={onClose}><X size={15} /></button>
    </div>
  </div>;
}
