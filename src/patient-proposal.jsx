import { Modal } from "./components";

const fields = { diagnoses: "诊断", medications: "用药", allergies: "过敏原", allergyStatus: "过敏史核对状态", labs: "检验", visits: "就诊" };
const states = { active: "正在使用", stopped: "已停用", unknown: "待核对", none_known: "已核对无已知过敏", recorded: "已记录过敏原" };
const label = (value) => {
  if (typeof value === "string") return states[value] || value;
  return [value.date, value.name || value.item || value.reason, value.code, value.value !== undefined ? `${value.value} ${value.unit || "单位未填"}` : "", value.dose, value.frequency, states[value.status], value.note, value.source ? `来源：${value.source}` : ""].filter(Boolean).join(" · ");
};
const values = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];

export function PatientProposalModal({ patient, proposal, busy, error, onClose, onConfirm }) {
  const stale = patient.revision !== proposal.baseRevision;
  return <Modal title="核对档案变更" wide onClose={() => { if (!busy) onClose(); }}>
    <section className="patient-proposal-review"><p><b>{patient.name}</b> · {proposal.summary}</p><p className="muted">左侧为当前档案，右侧为采纳后的完整内容。未列出的字段保持原记录。</p>
      {Object.entries(fields).filter(([key]) => proposal.payload[key] !== undefined).map(([key, name]) => {
        const before = values(patient[key]), after = values(proposal.payload[key]);
        const beforeLabels = before.map(label), afterLabels = after.map(label);
        return <section key={key}><h4>{name} <small>{before.length} → {after.length} 项</small></h4><div className="proposal-comparison"><div><b>当前记录</b>{before.map((value, i) => <p className={!afterLabels.includes(label(value)) ? "proposal-removed" : ""} key={i}>{!afterLabels.includes(label(value)) && <small>将移除 / 改写</small>}{label(value)}</p>)}{!before.length && <p className="muted">无记录</p>}</div><div><b>采纳后</b>{after.map((value, i) => <p className={!beforeLabels.includes(label(value)) ? "proposal-added" : ""} key={i}>{!beforeLabels.includes(label(value)) && <small>新增 / 变更</small>}{label(value)}</p>)}{!after.length && <p className="proposal-removed">将清空此项记录</p>}</div></div></section>;
      })}
      {stale && <p className="error-text" role="alert">档案在提案后已变化，请关闭并重新生成提案，避免覆盖新记录。</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="modal-actions"><button className="secondary" disabled={busy} onClick={onClose}>返回核对</button><button className="primary" disabled={busy || stale} onClick={onConfirm}>{busy ? "写入中…" : "确认这些变更并写入"}</button></div>
    </section>
  </Modal>;
}
