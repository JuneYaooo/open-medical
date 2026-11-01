import { useState } from "react";
import { Modal } from "./components";

const fields = { clinicalSummary: "病史摘要", diagnoses: "诊断", medications: "用药", allergies: "过敏原", allergyStatus: "过敏史记录状态", labs: "检验", visits: "就诊" };
// 身份字段是标量覆盖（姓名等），没有列表 diff，单独渲染当前值 → 采纳值。
const identityFields = [["name", "姓名"], ["gender", "性别"], ["birthYear", "出生年"], ["patientNumber", "病历号"], ["phone", "联系电话"]];
const genderText = { male: "男", female: "女", unknown: "未知" };
const identityText = (value) =>
  value === undefined || value === null || value === ""
    ? "未填写"
    : genderText[value] || String(value);
const states = { active: "正在使用", stopped: "已停用", unknown: "待核对", none_known: "无已知过敏", recorded: "已记录过敏原" };
const label = (value) => {
  if (typeof value === "string") return states[value] || value;
  return [value.text, value.date, value.name || value.item || value.reason, value.code, value.value !== undefined ? `${value.value} ${value.unit || "单位未填"}` : "", value.dose, value.frequency, states[value.status], value.note, value.source ? `来源：${value.source}` : ""].filter(Boolean).join(" · ");
};
const values = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];

// excluded/onToggle 可选：传入时每个变更分区带勾选框，未勾选的分区不写入。
const SectionToggle = ({ name, field, excluded, onToggle }) => onToggle
  ? <input type="checkbox" aria-label={`写入「${name}」`} checked={!excluded?.has(field)} onChange={() => onToggle(field)} />
  : null;

export function PatientProposalComparison({ patient, proposal, excluded, onToggle }) {
  return <section className="patient-proposal-review"><p><b>{patient.name}</b> · {proposal.summary}</p><p className="muted">左侧为当前档案，右侧为采纳后的完整内容。未列出的字段保持原记录。</p>
      {identityFields.filter(([key]) => proposal.payload[key] !== undefined).map(([key, name]) => {
        const changed = identityText(patient[key]) !== identityText(proposal.payload[key]);
        return <section key={key}><h4><SectionToggle name={name} field={key} excluded={excluded} onToggle={onToggle} />{name}</h4><div className="proposal-comparison"><div><b>当前记录</b><p className={changed ? "proposal-removed" : ""}>{changed && <small>将移除 / 改写</small>}{identityText(patient[key])}</p></div><div><b>采纳后</b><p className={changed ? "proposal-added" : ""}>{changed && <small>新增 / 变更</small>}{identityText(proposal.payload[key])}</p></div></div></section>;
      })}
      {Object.entries(fields).filter(([key]) => proposal.payload[key] !== undefined).map(([key, name]) => {
        const before = values(patient[key]), after = values(proposal.payload[key]);
        const beforeLabels = before.map(label), afterLabels = after.map(label);
        return <section key={key}><h4><SectionToggle name={name} field={key} excluded={excluded} onToggle={onToggle} />{name} <small>{before.length} → {after.length} 项</small></h4><div className="proposal-comparison"><div><b>当前记录</b>{before.map((value, i) => <p className={!afterLabels.includes(label(value)) ? "proposal-removed" : ""} key={i}>{!afterLabels.includes(label(value)) && <small>将移除 / 改写</small>}{label(value)}</p>)}{!before.length && <p className="muted">无记录</p>}</div><div><b>采纳后</b>{after.map((value, i) => <p className={!beforeLabels.includes(label(value)) ? "proposal-added" : ""} key={i}>{!beforeLabels.includes(label(value)) && <small>新增 / 变更</small>}{label(value)}</p>)}{!after.length && <p className="proposal-removed">将清空此项记录</p>}</div></div></section>;
      })}
    </section>;
}

// 本患者待确认的档案更新（检验导入、AI 整理等），与「待确认」托盘同源。
export async function loadPatientUpdateProposals(api, patientId) {
  const page = await api(`/api/pending-actions?status=pending&type=patient-update&patientId=${encodeURIComponent(patientId)}`);
  return (page?.actions || []).filter((action) => action.type === "patient-update" && action.patientId === patientId);
}

export function PatientProposalBanner({ proposals, busy, onReview }) {
  if (!proposals?.length) return null;
  return <section className="patient-risk-list" aria-label="待确认的档案变更">
    <p className="muted">以下档案变更尚未写入，核对后确认或拒绝（也可在「待确认」中处理）：</p>
    {proposals.map((proposal) => <div className="hub-risk" key={proposal.id}>
      <div className="hub-risk-main"><b>{proposal.summary || "档案更新"}</b></div>
      <div className="hub-risk-actions"><button className="text-button" disabled={busy} onClick={() => onReview(proposal)}>核对</button></div>
    </div>)}
  </section>;
}

export function PatientProposalModal({ patient, proposal, busy, error, onClose, onConfirm, onReject }) {
  const stale = patient.revision !== proposal.baseRevision;
  // 未勾选的分区不写入；全部勾选时不传 payload，按原提案写入。
  const [excluded, setExcluded] = useState(() => new Set());
  const toggle = (key) => setExcluded((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const reviewed = Object.fromEntries(Object.entries(proposal.payload || {}).filter(([key]) => !excluded.has(key)));
  const nothing = !Object.keys(reviewed).length;
  return <Modal title="核对档案变更" wide onClose={() => { if (!busy) onClose(); }}>
      <PatientProposalComparison patient={patient} proposal={proposal} excluded={excluded} onToggle={toggle} />
      {stale && <p className="error-text" role="alert">档案在提案后已变化，无法直接写入。请拒绝此提案后重新生成，避免覆盖新记录。</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="modal-actions"><button className="secondary" disabled={busy} onClick={onClose}>返回核对</button>{onReject && <button className="secondary" disabled={busy} onClick={onReject}>拒绝此变更</button>}<button className="primary" disabled={busy || stale || nothing} onClick={() => onConfirm(excluded.size ? reviewed : undefined)}>{busy ? "写入中…" : excluded.size ? "写入已勾选的变更" : "确认这些变更并写入"}</button></div>
  </Modal>;
}
