import { useEffect, useRef, useState } from "react";
import { api } from "./agent-runtime";
import { DIAGNOSIS_STATUS_SHORT, diagnosisStatus } from "../shared/diagnoses.mjs";
import { Plus, X, Loader2, Search, Star, Share2 } from "lucide-react";
import { ShareWizard } from "./share-wizard";

import { useClinicalDraft } from "./clinical-drafts";
import { localCalendarDate } from "../shared/calendar-date.mjs";
import { evaluateMedicationSafety } from "../server/medical/med-safety.mjs";
import "./clinical-entry.css";
import { VISIT_SECTIONS, VITAL_FIELDS, batchLabs, emptyLabRow, emptyVisitSections, emptyVitals, labPanelRows, parseBloodPressure, serializeVisitSections, vitalLabs } from "./clinical-entry";

const fmtDate = (value) => (value ? String(value).slice(0, 10) : "");
const VISIT_NOTE_LIMIT = 4000;
const emptyMed = () => ({ name: "", dose: "", frequency: "", status: "active", startDate: "", source: "" });
const emptyLab = () => ({ item: "", value: "", unit: "", date: localCalendarDate(), source: "", note: "", referenceRange: "" });
const allergyName = (a) => (typeof a === "string" ? a : a?.substance || "");
const allergyLabel = (a) => (typeof a === "string" ? a : [a?.substance, a?.reaction ? `（${a.reaction}）` : ""].join(""));
const emptyVisit = () => ({ date: localCalendarDate(), reason: "", note: "", source: "", mode: "free", sections: emptyVisitSections(), vitals: emptyVitals() });
// Newest first by date; undated last; ties keep later entry first.
const byDateDesc = (list) => list.map((_, i) => i).sort((a, b) => String(list[b].date || "").localeCompare(String(list[a].date || "")) || b - a);
// Client-side allergy screen reuses the server's pure med-safety rules.
function allergyWarnings(name, allergies) {
  if (!String(name || "").trim() || !allergies.length) return [];
  try {
    const list = allergies.map(allergyName).filter(Boolean).slice(0, 20);
    return evaluateMedicationSafety({ medications: [{ name }], allergies: list }).allergyMatches;
  } catch { return []; }
}

// Structured clinical data panel for one patient: diagnoses (with ICD-10
// helper), medications, allergies, labs and visits. Edits are local until
// saved; export produces a de-identified JSON for research.
export function ClinicalPanel({ detail, onChanged, onError, section }) {
  const [draft, setDraft] = useState(() => normalize(detail));
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState(null);
  const inFlight = useRef(false);
  const searchVersion = useRef(0);
  useEffect(() => {
    setDraft(normalize(detail));
  }, [detail.id, detail.revision]);
  const [icdQuery, setIcdQuery] = useClinicalDraft(detail.id, "icd", "");
  const [icdResults, setIcdResults] = useState([]);
  const [newDiagnosis, setNewDiagnosis] = useClinicalDraft(detail.id, "diagnosis", "");
  const [icdCode, setIcdCode] = useClinicalDraft(detail.id, "diagnosisCode", "");
  const [diagnosisMeta, setDiagnosisMeta] = useClinicalDraft(detail.id, "diagnosisMeta", { status: "needs_review", date: "", source: "" });
  const [medEdit, setMedEdit] = useClinicalDraft(detail.id, "medEdit", null);
  const [labEdit, setLabEdit] = useClinicalDraft(detail.id, "labEdit", null);
  const [labNotice, setLabNotice] = useState("");
  const [expandedRecords, setExpandedRecords] = useState({});
  useEffect(() => { setExpandedRecords({}); }, [detail.id]);
  const labOrder = byDateDesc(draft.labs);
  const visitOrder = byDateDesc(draft.visits);
  const shownLabs = expandedRecords.labs ? labOrder : labOrder.slice(0, 12);
  const shownVisits = expandedRecords.visits ? visitOrder : visitOrder.slice(0, 8);
  // Removal needs a second click; the pending target is tied to the revision
  // it was chosen on so a refreshed list never deletes a different row.
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [stopEdit, setStopEdit] = useState(null);
  const removing = (kind, index) => confirmRemove?.kind === kind && confirmRemove.index === index && confirmRemove.revision === detail.revision;
  const removeControl = (kind, index, label, onConfirm) => removing(kind, index)
    ? <span className="clinical-confirm" role="group" aria-label={`确认删除${label}`}>确认删除？<button type="button" className="danger" onClick={async () => { setConfirmRemove(null); await onConfirm(); }}>删除</button><button type="button" onClick={() => setConfirmRemove(null)}>取消</button></span>
    : <button type="button" className="icon-button" title="删除" aria-label={`删除${label}`} onClick={() => setConfirmRemove({ kind, index, revision: detail.revision })}><X size={13} /></button>;
  const [pendingMutation, setPendingMutation] = useClinicalDraft(detail.id, "mutation", null);
  const [labError, setLabError] = useState("");
  const [newMed, setNewMed] = useClinicalDraft(detail.id, "medication", emptyMed());
  const [newAllergy, setNewAllergy] = useClinicalDraft(detail.id, "allergy", "");
  const [newAllergyReaction, setNewAllergyReaction] = useClinicalDraft(detail.id, "allergyReaction", "");
  const [newLab, setNewLab] = useClinicalDraft(detail.id, "lab", emptyLab());
  // 多项模式：一个日期/来源 + 多行；rows 为 null 表示尚未进入多项模式。
  const [labBatch, setLabBatch] = useClinicalDraft(detail.id, "labBatch", { date: localCalendarDate(), source: "", rows: null });
  const labBatchMode = Array.isArray(labBatch.rows);
  const setLabRow = (index, field, value) => setLabBatch({ ...labBatch, rows: labBatch.rows.map((row, i) => i === index ? { ...row, [field]: value } : row) });
  const [newVisit, setNewVisit] = useClinicalDraft(detail.id, "visit", emptyVisit());
  const [visitError, setVisitError] = useState("");
  const medWarnings = allergyWarnings(newMed.name, draft.allergies);
  const visitNote = newVisit.mode === "structured" ? serializeVisitSections(newVisit.sections) : (newVisit.note || "");
  const [visitEdit, setVisitEdit] = useClinicalDraft(detail.id, "visitEdit", null);
  const additions = {
    diagnoses: Boolean(newDiagnosis.trim() || icdCode.trim() || icdQuery.trim() || diagnosisMeta.date || diagnosisMeta.source),
    medications: Boolean(newAllergy.trim() || newAllergyReaction.trim() || newMed.name || newMed.dose || newMed.frequency || newMed.source),
    labs: labBatchMode ? labBatch.rows.some(row => String(row.value || "").trim()) : Object.entries(newLab).some(([key, value]) => key !== "date" && Boolean(value)),
    visits: Boolean(newVisit.reason || newVisit.note || newVisit.source || Object.values(newVisit.sections || {}).some(Boolean) || Object.values(newVisit.vitals || {}).some(Boolean)),
  };
  const hasAddition = section ? additions[section] : Object.values(additions).some(Boolean);
  const feedback = text => setSaveFeedback({ patientId: detail.id, text });

  const patch = async (fields, intent = fields) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setSaving(true);
    feedback("正在保存…");
    const signature = JSON.stringify(intent);
    const request = pendingMutation || { signature, body: { expectedRevision: detail.revision, ...fields, requestId: crypto.randomUUID() } };
    setPendingMutation(request);
    try {
      const saved = await api(`/api/patients/${detail.id}`, "PATCH", request.body);
      setPendingMutation(null);
      setDraft(normalize(saved));
      feedback("记录已保存");
      try { await onChanged(); } catch (error) { feedback("记录已保存，但刷新失败；请刷新查看，勿重复添加。"); onError?.(`记录已保存，但刷新失败：${error.message}。请刷新查看，勿重复添加。`); }
      if (request.signature !== signature) { feedback("先前保存已确认；当前新输入尚未保存，请核对后再次保存。"); onError?.("先前保存已确认。当前新输入仍保留，请核对最新记录后再次保存。"); return false; }
      return true;
    } catch (err) {
      // A structured rejection proves this request did not commit. A lost
      // response is uncertain, so retry its exact body before another mutation.
      if (err.code) setPendingMutation(null);
      feedback(err.code ? "本次修改尚未保存，输入已保留。" : "保存结果待确认，输入已保留；再次操作会先核对上次保存。");
      if (err.code === "REVISION_CONFLICT") {
        setConflict(true);
        onError?.("档案已被另一窗口更新。输入已保留，请载入最新记录后核对并重新添加。");
      } else onError?.(err.message);
      return false;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const saveDiagnoses = (diagnoses, intent) => patch({ diagnoses }, intent);
  const saveMedications = (medications, intent) => patch({ medications }, intent);
  const saveAllergies = (allergies, intent) => patch({ allergies }, intent);
  const saveLabs = (labs, intent) => patch({ labs }, intent);
  const saveVisits = (visits, intent) => patch({ visits }, intent);

  const searchIcd = async (text) => {
    const version = ++searchVersion.current;
    setIcdQuery(text);
    if (!text.trim()) return setIcdResults([]);
    try {
      const value = await api(`/api/icd10?q=${encodeURIComponent(text)}`);
      if (version === searchVersion.current) setIcdResults(value.codes);
    } catch (err) {
      if (version === searchVersion.current) onError?.(err.message);
    }
  };
  const addDiagnosis = async (code, name) => {
    if (!name.trim()) return;
    if (
      !(await saveDiagnoses([
        ...draft.diagnoses,
        { code, name, ...diagnosisMeta },
      ], { diagnosis: { code, name, ...diagnosisMeta } }))
    )
      return;
    searchVersion.current++;
    setNewDiagnosis("");
    setIcdCode("");
    setDiagnosisMeta({ status: "needs_review", date: "", source: "" });
    setIcdQuery("");
    setIcdResults([]);
  };
  const addMedication = async () => {
    if (!newMed.name.trim()) return;
    const { startDate, ...med } = newMed;
    const entry = { ...med, name: med.name.trim(), ...(startDate ? { startDate } : {}) };
    if (!(await saveMedications([...draft.medications, entry], { medication: newMed }))) return;
    setNewMed(emptyMed());
  };
  const addAllergy = async () => {
    const text = newAllergy.trim(), reaction = newAllergyReaction.trim();
    if (!text || draft.allergies.some(a => allergyName(a) === text)) return;
    const entry = reaction ? { substance: text, reaction } : text;
    if (!(await saveAllergies([...draft.allergies, entry], { allergy: entry }))) return;
    setNewAllergy("");
    setNewAllergyReaction("");
  };
  const addLab = async () => {
    setLabError("");
    // 「血压 148/86」拆成收缩压、舒张压两条，单位 mmHg。
    const bp = /^血压$/.test(newLab.item.trim()) ? parseBloodPressure(newLab.value) : null;
    if (bp) {
      if (!newLab.date) { setLabError("请填写检验日期；输入已保留。"); return; }
      const result = vitalLabs(bp, newLab.date, newLab.source);
      if (result.error) { setLabError(`${result.error}；输入已保留。`); return; }
      if (!(await saveLabs([...draft.labs, ...result.labs], { lab: newLab }))) return;
      setNewLab(emptyLab());
      setLabNotice("血压已拆分为收缩压、舒张压两条记录保存。");
      return;
    }
    const value = Number(newLab.value);
    if (
      !newLab.item.trim() ||
      !newLab.date ||
      !newLab.value.trim() ||
      !Number.isFinite(value)
    ) {
      setLabError("请输入数字；阴性、<0.01 等结果请上传原报告到资料库");
      return;
    }
    if (
      !(await saveLabs([
        ...draft.labs,
        {
          item: newLab.item.trim(),
          value,
          ...(newLab.unit ? { unit: newLab.unit } : {}),
          date: newLab.date,
          source: newLab.source, note: newLab.note, referenceRange: newLab.referenceRange || "",
        },
      ], { lab: newLab }))
    )
      return;
    setNewLab(emptyLab());
  };
  const addLabBatch = async () => {
    setLabError(""); setLabNotice("");
    const result = batchLabs(labBatch.rows, labBatch.date, labBatch.source.trim());
    if (result.error) { setLabError(`${result.error}；输入已保留。`); return; }
    if (!(await saveLabs([...draft.labs, ...result.labs], { labBatch }))) return;
    setLabBatch({ date: labBatch.date, source: "", rows: labPanelRows([...draft.labs, ...result.labs]) });
    setLabNotice(`已保存 ${result.labs.length} 条检验记录。`);
  };
  const addVisit = async () => {
    setVisitError("");
    if (!newVisit.date || !newVisit.reason.trim()) return;
    if (visitNote.length > VISIT_NOTE_LIMIT) { setVisitError(`就诊备注共 ${visitNote.length} 字，超过 ${VISIT_NOTE_LIMIT} 字上限，请精简；输入已保留。`); return; }
    const vitals = vitalLabs(newVisit.vitals, newVisit.date, newVisit.source.trim());
    if (vitals.error) { setVisitError(`${vitals.error}；输入已保留。`); return; }
    const visit = { date: newVisit.date, reason: newVisit.reason.trim(), ...(visitNote.trim() ? { note: visitNote.trim() } : {}), ...(newVisit.source.trim() ? { source: newVisit.source.trim() } : {}) };
    const fields = vitals.labs.length ? { visits: [...draft.visits, visit], labs: [...draft.labs, ...vitals.labs] } : { visits: [...draft.visits, visit] };
    if (!(await patch(fields, { visit: newVisit }))) return;
    setNewVisit(emptyVisit());
    if (vitals.labs.length) feedback(`就诊记录已保存，生命体征 ${vitals.labs.length} 项已同步到检验记录`);
  };
  const setVital = (key, raw) => {
    // 在收缩压栏直接输入「148/86」时自动拆分。
    const bp = key === "sbp" ? parseBloodPressure(raw) : null;
    setNewVisit({ ...newVisit, vitals: { ...newVisit.vitals, ...(bp || { [key]: raw }) } });
  };
  const setMedStatus = (index, status) => saveMedications(draft.medications.map((item, i) => {
    if (i !== index) return item;
    const { stoppedAt: _s, stopReason: _r, ...rest } = item;
    if (status === "stopped") return { ...item, status, stoppedAt: item.stoppedAt || localCalendarDate() };
    return { ...rest, status };
  }));
  const stopMedication = async (event) => {
    event.preventDefault();
    if (stopEdit.revision !== detail.revision) { onError?.("档案已变化，请取消后重新核对用药。"); return; }
    const reason = stopEdit.reason.trim();
    if (await saveMedications(draft.medications.map((item, i) => i === stopEdit.index ? { ...item, status: "stopped", stoppedAt: stopEdit.date, ...(reason ? { stopReason: reason } : {}) } : item))) setStopEdit(null);
  };
  // 收进案例库：医生主动策展动作，点击即入库（精选标记），不再套一层确认。
  const [casePanel, setCasePanel] = useState(false);
  const [caseDraft, setCaseDraft] = useState({ summary: "", lessons: "", tags: "" });
  const [caseSaving, setCaseSaving] = useState(false);
  const [caseNote, setCaseNote] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const saveToCaseLibrary = async () => {
    setCaseSaving(true);
    try {
      await api("/api/cases", "POST", {
        patientId: detail.id,
        ...(caseDraft.summary.trim() ? { summary: caseDraft.summary.trim() } : {}),
        ...(caseDraft.lessons.trim() ? { lessons: caseDraft.lessons.trim() } : {}),
        tags: caseDraft.tags.split(/[,，、\s]+/).filter(Boolean),
        starred: true,
      });
      setCasePanel(false);
      setCaseDraft({ summary: "", lessons: "", tags: "" });
      setCaseNote("已收进案例库（精选）。下次遇到相似患者，检索会优先翻出这份经验。");
    } catch (err) {
      onError?.(err.message);
    } finally {
      setCaseSaving(false);
    }
  };

  return (
    <>
    <fieldset
      disabled={saving || detail.archived}
      className="detail-panel clinical-panel"
      aria-busy={saving}
    >
      {saveFeedback?.patientId === detail.id && <p role="status">{saveFeedback.text}</p>}
      {hasAddition && <p className="muted">新增输入尚未添加，请点击对应的添加按钮完成保存。</p>}
      {visitEdit && <p className="muted">就诊更正尚未保存。</p>}
      {conflict && <section aria-label="临床记录版本核对"><p role="alert">档案版本已变化，尚未保存本次修改。新增输入已保留。</p><button type="button" onClick={async()=>{
        setSaving(true);
        try { await onChanged(); setConflict(false); onError?.(""); }
        catch (err) { onError?.(`读取最新记录失败：${err.message}。输入仍保留，可重试。`); }
        finally { setSaving(false); }
      }}>保留输入并载入最新记录</button></section>}
      {(!section || section === 'diagnoses') && <section>
        <h3>诊断 {saving && <Loader2 className="spin" size={13} />}</h3>
        <ul className="clinical-rows">
          {draft.diagnoses.map((d, index) => (
            <li key={`${d.code}-${d.name}-${index}`}>
              <span>
                <b>{d.name}</b>
                {d.code ? ` · ${d.code}` : ""}
                {d.date ? ` · ${fmtDate(d.date)}` : ""}
                {d.note ? ` · ${d.note}` : ""}
              </span>
              <details><summary>补充诊断来源与日期</summary><form onSubmit={async e=>{e.preventDefault();const data=new FormData(e.currentTarget);await saveDiagnoses(draft.diagnoses.map((item,i)=>i===index?{...item,date:data.get('date'),source:data.get('source')}:item));}}>
                <label>原诊断日期<input name="date" type="date" defaultValue={d.date || ''}/></label><label>诊断来源<input name="source" maxLength={200} defaultValue={d.source || ''}/></label><button type="submit">保存诊断补充</button>
              </form></details>
              <select
                aria-label={`${d.name}诊断状态`}
                value={diagnosisStatus(d)}
                onChange={(e) =>
                  saveDiagnoses(
                    draft.diagnoses.map((item, i) =>
                      i === index ? { ...item, status: e.target.value } : item,
                    ),
                  )
                }
              >
                {Object.entries(DIAGNOSIS_STATUS_SHORT).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <label className="clinical-primary">
                <input
                  type="checkbox"
                  aria-label={`${d.name}设为主要诊断`}
                  checked={Boolean(d.primary)}
                  onChange={(e) =>
                    saveDiagnoses(
                      draft.diagnoses.map((item, i) => {
                        if (i !== index) return item;
                        const { primary: _drop, ...rest } = item;
                        return e.target.checked ? { ...rest, primary: true } : rest;
                      }),
                    )
                  }
                />
                主要诊断
              </label>
              {removeControl("diagnosis", index, `诊断 ${d.name}`, () => saveDiagnoses(draft.diagnoses.filter((_, i) => i !== index)))}
            </li>
          ))}
          {!draft.diagnoses.length && <li className="muted">未记录诊断。</li>}
        </ul>
        <div className="clinical-add">
          <input
            value={icdQuery}
            placeholder="搜索 ICD-10（如 I10 或 高血压）"
            onChange={(e) => searchIcd(e.target.value)}
          />
          <input
            value={newDiagnosis}
            placeholder="诊断名称（可直接填写）"
            aria-label="诊断名称"
            onChange={(e) => setNewDiagnosis(e.target.value)}
          />
          <input
            value={icdCode}
            placeholder="ICD-10 编码（可选）"
            aria-label="ICD-10 编码"
            maxLength={20}
            onChange={(e) => setIcdCode(e.target.value)}
          />
          <label>诊断状态<select aria-label="新增诊断状态" value={diagnosisMeta.status} onChange={e=>setDiagnosisMeta({...diagnosisMeta,status:e.target.value})}>{Object.entries(DIAGNOSIS_STATUS_SHORT).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
          <label>原诊断日期（未知可留空）<input type="date" value={diagnosisMeta.date} onChange={e=>setDiagnosisMeta({...diagnosisMeta,date:e.target.value})}/></label>
          <label>诊断来源<input maxLength={200} value={diagnosisMeta.source} onChange={e=>setDiagnosisMeta({...diagnosisMeta,source:e.target.value})}/></label>
          <button
            className="secondary"
            onClick={() => addDiagnosis(icdCode.trim(), newDiagnosis.trim())}
            disabled={!newDiagnosis.trim()}
          >
            <Plus size={13} /> 添加诊断
          </button>
          {icdResults.length > 0 && (
            <div className="icd-results">
              {icdResults.map((item) => (
                <button
                  key={item.code}
                  type="button"
                  onClick={() => { searchVersion.current++; setIcdCode(item.code); setNewDiagnosis(item.name); setIcdQuery(""); setIcdResults([]); }}
                >
                  <Search size={11} /> {item.code} {item.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>}

      {(!section || section === 'medications') && <section>
        <h3>过敏史</h3>
        {!draft.allergies.length && <label className="clinical-status-field">记录状态<select aria-label="过敏史记录状态" value={draft.allergyStatus} onChange={(e) => patch({ allergyStatus: e.target.value })}>
          <option value="unknown">尚未记录</option><option value="none_known">无已知过敏</option>
        </select></label>}
        <div className="allergy-chips">
          {draft.allergies.map((item) => (
            <span className="hint-tag allergy" key={allergyName(item)}>
              {allergyLabel(item)}
              <button
                aria-label={`移除过敏原 ${allergyName(item)}`}
                onClick={() =>
                  saveAllergies(draft.allergies.filter((a) => a !== item))
                }
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
        <div className="clinical-add">
          <input
            value={newAllergy}
            placeholder="添加过敏原"
            onChange={(e) => setNewAllergy(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addAllergy()}
          />
          <input
            value={newAllergyReaction}
            placeholder="反应（可选，如 皮疹）"
            aria-label="过敏反应（可选）"
            maxLength={120}
            onChange={(e) => setNewAllergyReaction(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addAllergy()}
          />
          <button
            className="secondary"
            onClick={addAllergy}
            disabled={!newAllergy.trim()}
          >
            <Plus size={13} /> 添加过敏
          </button>
        </div>
      </section>}

      {(!section || section === 'medications') && <section>
        <h3>用药列表</h3>
        <ul className="clinical-rows">
          {draft.medications.map((m, index) => (
            <li key={`${m.name}-${index}`}>
              <span>
                <b>{m.name}</b>
                {m.dose ? ` · ${m.dose}` : ""}
                {m.frequency ? ` · ${m.frequency}` : ""}
                {m.startDate ? ` · ${fmtDate(m.startDate)} 开始` : ""}
                {m.status === "stopped" && (m.stoppedAt || m.stopReason) && <small> · {m.stoppedAt ? `${fmtDate(m.stoppedAt)} 停用` : "已停用"}{m.stopReason ? `（${m.stopReason}）` : ""}</small>}
              </span>
              <button className="text-button" onClick={()=>setMedEdit({index, value:{...m}, revision:detail.revision})}>更正用药</button>
              {m.status !== "stopped" && <button type="button" className="text-button" onClick={() => setStopEdit({ index, name: m.name, date: localCalendarDate(), reason: "", revision: detail.revision })}>停用</button>}
              <select aria-label={`${m.name}用药状态`} value={m.status || "unknown"} onChange={(e) => setMedStatus(index, e.target.value)}>
                <option value="unknown">状态未记录</option><option value="active">目前在用</option><option value="stopped">已停用</option>
              </select>
              {removeControl("medication", index, `用药 ${m.name}`, () => saveMedications(draft.medications.filter((_, i) => i !== index)))}
            </li>
          ))}
          {!draft.medications.length && <li className="muted">未记录用药。</li>}
        </ul>
        {stopEdit && <form aria-label="停用药物" onSubmit={stopMedication}>
          <p>停用 {stopEdit.name} · 记录停药日期与原因</p>
          <label>停药日期<input type="date" required value={stopEdit.date} onChange={e=>setStopEdit({...stopEdit,date:e.target.value})}/></label>
          <label>停药原因（可选）<input maxLength={200} placeholder="例如：血压达标减药、胃肠道不适" value={stopEdit.reason} onChange={e=>setStopEdit({...stopEdit,reason:e.target.value})}/></label>
          <button type="button" onClick={()=>setStopEdit(null)}>取消</button><button type="submit">确认停用</button>
        </form>}
        {medEdit && <form aria-label="更正用药" onSubmit={async e=>{e.preventDefault();if(medEdit.revision!==detail.revision){onError?.('档案已变化，请取消本次更正并重新核对原记录。');return;}const name=String(medEdit.value.name||'').trim();if(!name){onError?.('药名不能为空。');return;}const {startDate,...rest}=medEdit.value;if(await saveMedications(draft.medications.map((m,i)=>i===medEdit.index?{...rest,name,...(startDate?{startDate}:{})}:m)))setMedEdit(null);}}>
          <p>更正 {draft.medications[medEdit.index]?.name || medEdit.value.name} · 保留原用药状态与其他资料</p>
          <label>更正药名<input required maxLength={120} value={medEdit.value.name || ''} onChange={e=>setMedEdit({...medEdit,value:{...medEdit.value,name:e.target.value}})}/></label>
          <label>更正剂量<input maxLength={60} value={medEdit.value.dose || ''} onChange={e=>setMedEdit({...medEdit,value:{...medEdit.value,dose:e.target.value}})}/></label>
          <label>更正频次<input maxLength={60} value={medEdit.value.frequency || ''} onChange={e=>setMedEdit({...medEdit,value:{...medEdit.value,frequency:e.target.value}})}/></label>
          <label>开始用药日期（可选）<input type="date" value={medEdit.value.startDate || ''} onChange={e=>setMedEdit({...medEdit,value:{...medEdit.value,startDate:e.target.value}})}/></label>
          <label>更正处方来源<input maxLength={200} value={medEdit.value.source || ''} onChange={e=>setMedEdit({...medEdit,value:{...medEdit.value,source:e.target.value}})}/></label>
          <button type="button" onClick={()=>{setMedEdit(null);setPendingMutation(null);}}>取消更正</button><button type="submit">保存用药更正</button>
        </form>}
        <div className="clinical-add clinical-add-med">
          <input
            value={newMed.name}
            placeholder="药名"
            onChange={(e) => setNewMed({ ...newMed, name: e.target.value })}
          />
          <input
            value={newMed.dose}
            placeholder="剂量"
            onChange={(e) => setNewMed({ ...newMed, dose: e.target.value })}
          />
          <input
            value={newMed.frequency}
            placeholder="频次"
            onChange={(e) =>
              setNewMed({ ...newMed, frequency: e.target.value })
            }
          />
          <label>开始日期（可选）<input type="date" value={newMed.startDate || ""} onChange={e=>setNewMed({...newMed,startDate:e.target.value})}/></label>
          <label>处方来源<input maxLength={200} value={newMed.source} onChange={e=>setNewMed({...newMed,source:e.target.value})}/></label>
          <select aria-label="新增用药状态" value={newMed.status} onChange={(e) => setNewMed({ ...newMed, status: e.target.value })}><option value="active">目前在用</option><option value="unknown">状态未记录</option><option value="stopped">已停用</option></select>
          {medWarnings.length > 0 && <p role="alert" className="error clinical-allergy-warning">注意：{medWarnings.map(w => w.message).join(" ")} 请核对后再添加。（用药辅助提醒按药名和药物类别匹配，可能漏报。）</p>}
          <button
            className="secondary"
            onClick={addMedication}
            disabled={!newMed.name.trim()}
          >
            <Plus size={13} /> 添加用药
          </button>
        </div>
      </section>}

      {(!section || section === 'labs') && <section>
        <h3>检验记录 · 共 {draft.labs.length} 条</h3>
        {draft.labs.length > 12 && <p>
          {expandedRecords.labs ? `已显示全部 ${draft.labs.length} 条，按日期最新在前` : `显示日期最近的 12 条 / 共 ${draft.labs.length} 条`}
          <button type="button" className="text-button" disabled={Boolean(labEdit)} aria-expanded={!!expandedRecords.labs} onClick={() => setExpandedRecords({ ...expandedRecords, labs: !expandedRecords.labs })}>
            {expandedRecords.labs ? "收起较早检验记录" : `显示全部 ${draft.labs.length} 条检验记录`}
          </button>
        </p>}
        <p id="lab-value-help">仅录入精确数值；定性结果及带比较符的结果请保留原始报告。</p>
        {labError && <p role="alert" className="error">{labError}</p>}
        {labNotice && <p role="status">{labNotice}</p>}
        <ul className="clinical-rows">
          {shownLabs.map((realIndex) => {
            const l = draft.labs[realIndex];
            return (
              <li key={`${l.item}-${l.date}-${realIndex}`}>
                <span>
                  <b>{l.item}</b> {l.value}
                  {l.unit || ""} · {fmtDate(l.date)}
                  {l.source && <small> · 来源：{l.source}</small>}
                </span>
                <button type="button" className="text-button" disabled={Boolean(labEdit)} onClick={() => { setLabError(""); setLabNotice(""); setLabEdit({ index: realIndex, revision: detail.revision, value: { ...l, value: String(l.value) } }); }}>更正检验</button>
                {removeControl("lab", realIndex, `检验 ${l.item}`, () => saveLabs(draft.labs.filter((_, i) => i !== realIndex)))}
              </li>
            );
          })}
          {!draft.labs.length && <li className="muted">未记录检验。</li>}
        </ul>
        {labEdit && <form aria-label="更正检验记录" onSubmit={async e => {
          e.preventDefault(); setLabError(""); setLabNotice("");
          if (labEdit.revision !== detail.revision) { setLabError("档案已变化，本次更正尚未保存，输入已保留。请取消后重新核对原记录。"); return; }
          const value = Number(labEdit.value.value);
          if (!String(labEdit.value.value).trim() || !Number.isFinite(value)) { setLabError("请输入数字；阴性、<0.01 等结果请上传原报告到资料库"); return; }
          if (await saveLabs(draft.labs.map((lab, index) => index === labEdit.index ? { ...labEdit.value, value } : lab))) { setLabEdit(null); setLabNotice("检验记录已更正，原来源与其他记录已保留。"); }
        }}>
          <p>{labEdit.value.item} · 来源：{labEdit.value.source || "未记录"}</p>
          <label>更正检验数值<input required inputMode="decimal" value={labEdit.value.value} onChange={e => setLabEdit({ ...labEdit, value: { ...labEdit.value, value: e.target.value } })}/></label>
          <label>更正检验单位<input maxLength={40} value={labEdit.value.unit || ""} onChange={e => setLabEdit({ ...labEdit, value: { ...labEdit.value, unit: e.target.value } })}/></label>
          <label>更正采样日期<input required type="date" value={labEdit.value.date || ""} onChange={e => setLabEdit({ ...labEdit, value: { ...labEdit.value, date: e.target.value } })}/></label>
          <label>更正报告参考范围<input maxLength={200} value={labEdit.value.referenceRange || ""} onChange={e=>setLabEdit({...labEdit,value:{...labEdit.value,referenceRange:e.target.value}})}/></label>
          <label>更正检验备注<input maxLength={500} value={labEdit.value.note || ""} onChange={e => setLabEdit({ ...labEdit, value: { ...labEdit.value, note: e.target.value } })}/></label>
          <button type="button" onClick={() => { setLabEdit(null); setPendingMutation(null); setLabError(""); }}>取消更正</button><button type="submit">保存检验更正</button>
        </form>}
        <div className="clinical-lab-mode" role="radiogroup" aria-label="检验录入方式">
          <label><input type="radio" name="lab-entry-mode" checked={!labBatchMode} onChange={() => { setLabError(""); setLabBatch({ ...labBatch, rows: null }); }}/>单项</label>
          <label><input type="radio" name="lab-entry-mode" checked={labBatchMode} onChange={() => { setLabError(""); setLabBatch({ ...labBatch, rows: labPanelRows(draft.labs) }); }}/>多项（一次录多项）</label>
        </div>
        {labBatchMode ? <div className="clinical-add clinical-lab-batch">
          <label>检验日期（采样日，必填）<input type="date" required value={labBatch.date} onChange={e => setLabBatch({ ...labBatch, date: e.target.value })}/></label>
          <label>检验来源（可选）<input maxLength={200} value={labBatch.source} onChange={e => setLabBatch({ ...labBatch, source: e.target.value })}/></label>
          <table className="clinical-lab-batch-rows">
            <thead><tr><th>项目</th><th>数值</th><th>单位</th><th>参考范围（可选）</th><th><span className="sr-only">删除</span></th></tr></thead>
            <tbody>
              {labBatch.rows.map((row, index) => <tr key={index}>
                <td><input aria-label={`第 ${index + 1} 行项目`} value={row.item} onChange={e => setLabRow(index, "item", e.target.value)}/></td>
                <td><input aria-label={`${row.item || `第 ${index + 1} 行`}数值`} inputMode="decimal" placeholder={/^血压$/.test(row.item.trim()) ? "如 148/86" : ""} value={row.value} onChange={e => setLabRow(index, "value", e.target.value)}/></td>
                <td><input aria-label={`${row.item || `第 ${index + 1} 行`}单位`} maxLength={40} value={row.unit} onChange={e => setLabRow(index, "unit", e.target.value)}/></td>
                <td><input aria-label={`${row.item || `第 ${index + 1} 行`}参考范围`} maxLength={200} value={row.referenceRange} onChange={e => setLabRow(index, "referenceRange", e.target.value)}/></td>
                <td><button type="button" className="icon-button" title="删除此行" aria-label={`删除第 ${index + 1} 行`} onClick={() => setLabBatch({ ...labBatch, rows: labBatch.rows.filter((_, i) => i !== index) })}><X size={13} /></button></td>
              </tr>)}
            </tbody>
          </table>
          <small className="muted">未填数值的行不保存。</small>
          <button type="button" className="text-button" onClick={() => setLabBatch({ ...labBatch, rows: [...labBatch.rows, emptyLabRow()] })}><Plus size={13} /> 添加一行</button>
          <button
            className="secondary"
            onClick={addLabBatch}
            disabled={!labBatch.date || !labBatch.rows.some(row => String(row.value || "").trim())}
          >
            <Plus size={13} /> 保存全部检验
          </button>
        </div> : <div className="clinical-add clinical-add-med">
          <input
            autoFocus={section === "labs"}
            value={newLab.item}
            placeholder="项目"
            onChange={(e) => setNewLab({ ...newLab, item: e.target.value })}
          />
          <input
            value={newLab.value}
            placeholder={/^血压$/.test(newLab.item.trim()) ? "如 148/86" : "数值"}
            aria-describedby="lab-value-help"
            aria-invalid={!!labError}
            inputMode="decimal"
            onChange={(e) => setNewLab({ ...newLab, value: e.target.value })}
          />
          <input
            value={newLab.unit}
            placeholder="单位"
            onChange={(e) => setNewLab({ ...newLab, unit: e.target.value })}
          />
          <label>检验日期（采样日，必填）<input
            type="date"
            required
            value={newLab.date}
            onChange={(e) => setNewLab({ ...newLab, date: e.target.value })}
          /></label>
          <label>检验来源<input maxLength={200} value={newLab.source} onChange={e=>setNewLab({...newLab,source:e.target.value})}/></label>
          <label>报告参考范围（按报告原文，可选）<input maxLength={200} value={newLab.referenceRange || ""} onChange={e=>setNewLab({...newLab,referenceRange:e.target.value})}/></label>
          <label>检验备注<input maxLength={500} value={newLab.note} onChange={e=>setNewLab({...newLab,note:e.target.value})}/></label>
          <button
            className="secondary"
            onClick={addLab}
            disabled={
              !newLab.item.trim() || !newLab.date || newLab.value === ""
            }
          >
            <Plus size={13} /> 添加检验
          </button>
        </div>}
      </section>}

      {(!section || section === 'visits') && <section>
        <h3>就诊记录 · 共 {draft.visits.length} 条</h3>
        {draft.visits.length > 8 && <p>
          {expandedRecords.visits ? `已显示全部 ${draft.visits.length} 条，按日期最新在前` : `显示日期最近的 8 条 / 共 ${draft.visits.length} 条`}
          <button type="button" className="text-button" aria-expanded={!!expandedRecords.visits} onClick={() => setExpandedRecords({ ...expandedRecords, visits: !expandedRecords.visits })}>
            {expandedRecords.visits ? "收起较早就诊记录" : `显示全部 ${draft.visits.length} 条就诊记录`}
          </button>
        </p>}
        <ul className="clinical-rows">
          {shownVisits.map((realIndex) => {
            const v = draft.visits[realIndex];
            return (
              <li key={`${v.date}-${realIndex}`}>
                <span className="clinical-visit-text">
                  {fmtDate(v.date)} · {v.reason}
                  {v.note ? <><br />{v.note}</> : ""}
                  {v.source && <small> · 来源：{v.source}</small>}
                </span>
                <button type="button" className="text-button" onClick={() => setVisitEdit({ index: realIndex, value: { ...v }, revision: detail.revision })}>更正就诊记录</button>
                {removeControl("visit", realIndex, `${fmtDate(v.date)} 就诊记录`, () => saveVisits(draft.visits.filter((_, i) => i !== realIndex)))}
              </li>
            );
          })}
          {!draft.visits.length && <li className="muted">未记录就诊。</li>}
        </ul>
        {visitEdit && <form aria-label="更正就诊记录" onSubmit={async event => {
          event.preventDefault();
          if (!pendingMutation && visitEdit.revision !== detail.revision) { feedback("档案已变化，本次更正尚未保存；请取消更正后重新核对原记录。"); return; }
          if (await saveVisits(draft.visits.map((visit, index) => index === visitEdit.index ? visitEdit.value : visit))) setVisitEdit(null);
        }}>
          <label>更正就诊日期<input type="date" required value={visitEdit.value.date || ''} onChange={event => setVisitEdit({ ...visitEdit, value: { ...visitEdit.value, date: event.target.value } })}/></label>
          <label>更正就诊事由<input required maxLength={200} value={visitEdit.value.reason || ''} onChange={event => setVisitEdit({ ...visitEdit, value: { ...visitEdit.value, reason: event.target.value } })}/></label>
          <label>更正就诊备注<textarea maxLength={VISIT_NOTE_LIMIT} rows={6} value={visitEdit.value.note || ''} onChange={event => setVisitEdit({ ...visitEdit, value: { ...visitEdit.value, note: event.target.value } })}/></label>
          <label>更正就诊来源<input maxLength={200} value={visitEdit.value.source || ''} onChange={event => setVisitEdit({ ...visitEdit, value: { ...visitEdit.value, source: event.target.value } })}/></label>
          <button type="button" onClick={() => setVisitEdit(null)}>取消就诊更正</button><button type="submit">保存就诊更正</button>
        </form>}
        <div className="clinical-add clinical-add-med">
          <input
            type="date"
            aria-label="就诊日期（必填）"
            required
            value={newVisit.date}
            onChange={(e) => setNewVisit({ ...newVisit, date: e.target.value })}
          />
          <input
            autoFocus={section === "visits"}
            value={newVisit.reason}
            placeholder="就诊事由"
            aria-label="就诊事由（必填）"
            maxLength={200}
            onChange={(e) =>
              setNewVisit({ ...newVisit, reason: e.target.value })
            }
          />
          <div className="clinical-vitals" role="group" aria-label="生命体征（可选）">
            <span className="clinical-vitals-title">生命体征</span>
            {VITAL_FIELDS.map(field => <label key={field.key}>{field.label}<span className="clinical-vital-input"><input inputMode="decimal" value={newVisit.vitals?.[field.key] || ""} placeholder={field.key === "sbp" ? "可填 148/86" : ""} onChange={e => setVital(field.key, e.target.value)}/><small>{field.unit}</small></span></label>)}
            <small className="muted">选填；保存就诊时同步写入检验记录，可在检验趋势中查看。</small>
          </div>
          <div className="clinical-visit-mode" role="radiogroup" aria-label="就诊备注写法">
            <label><input type="radio" name="visit-note-mode" checked={newVisit.mode !== "structured"} onChange={() => setNewVisit({ ...newVisit, mode: "free" })}/>自由书写</label>
            <label><input type="radio" name="visit-note-mode" checked={newVisit.mode === "structured"} onChange={() => setNewVisit({ ...newVisit, mode: "structured" })}/>分项填写（主诉 / 现病史 / 查体 / 评估 / 计划）</label>
          </div>
          {newVisit.mode === "structured"
            ? VISIT_SECTIONS.map(item => <label key={item.key} className="clinical-visit-section">{item.label}（可选）<textarea rows={item.rows} maxLength={VISIT_NOTE_LIMIT} value={newVisit.sections?.[item.key] || ""} onChange={event => setNewVisit({ ...newVisit, sections: { ...newVisit.sections, [item.key]: event.target.value } })}/></label>)
            : <label>就诊备注（可选）<textarea rows={4} maxLength={VISIT_NOTE_LIMIT} placeholder="记录本次处理、观察与后续安排" value={newVisit.note || ''} onChange={event => setNewVisit({ ...newVisit, note: event.target.value })}/></label>}
          {newVisit.mode === "structured" && newVisit.note?.trim() && <small className="muted">自由书写的内容仍保留，但本次按分项保存；切回「自由书写」可查看。</small>}
          {visitNote.length > VISIT_NOTE_LIMIT * 0.9 && <small className="muted">备注 {visitNote.length} / {VISIT_NOTE_LIMIT} 字</small>}
          {visitError && <p role="alert" className="error">{visitError}</p>}
          <label>就诊来源（可选）<input maxLength={200} placeholder="例如：本次复诊记录或原始资料名称" value={newVisit.source || ''} onChange={event => setNewVisit({ ...newVisit, source: event.target.value })}/></label>
          <button
            className="secondary"
            onClick={addVisit}
            disabled={!newVisit.date || !newVisit.reason.trim()}
          >
            <Plus size={13} /> 添加就诊记录
          </button>
        </div>
      </section>}

      <div className="clinical-actions">
        <button
          className="secondary"
          onClick={() => setCasePanel((v) => !v)}
        >
          <Star size={14} /> {casePanel ? "取消收藏" : "收进案例库"}
        </button>
        <button
          className="secondary"
          onClick={() => setShareOpen(true)}
        >
          <Share2 size={14} /> 脱敏分享 / 导出
        </button>
        <span className="muted">
          状态选择、停用与确认删除后立即保存；新增记录和更正表单需点击相应的添加或保存按钮。未提交输入仅暂存于当前窗口，关闭或刷新前请完成保存。
        </span>
      </div>
      {casePanel && <div className="clinical-case-save">
        <p className="muted">
          把这位患者当前的情况快照收进案例库，并写两句你最想记住的经验。快照只保留姓名与病情要点，不含电话与证件信息；下次遇到相似患者，检索会优先翻出精选案例。
        </p>
        <textarea
          rows={2}
          aria-label="病例摘要（可选）"
          placeholder="病例摘要：病史要点、处理经过与转归（可选）"
          value={caseDraft.summary}
          onChange={(e) => setCaseDraft({ ...caseDraft, summary: e.target.value })}
        />
        <textarea
          rows={2}
          aria-label="经验教训"
          placeholder="经验教训：这次最有价值的点、下次遇到类似患者怎么用"
          value={caseDraft.lessons}
          onChange={(e) => setCaseDraft({ ...caseDraft, lessons: e.target.value })}
        />
        <input
          aria-label="案例标签"
          placeholder="标签（如：糖尿病、胰岛素方案），逗号分隔（可选）"
          value={caseDraft.tags}
          onChange={(e) => setCaseDraft({ ...caseDraft, tags: e.target.value })}
        />
        <div className="toolbar-actions">
          <button className="secondary" onClick={saveToCaseLibrary} disabled={caseSaving}>
            {caseSaving ? <Loader2 className="spin" size={13} /> : <Star size={13} />} 收入案例库
          </button>
        </div>
      </div>}
      {caseNote && <p className="form-notice" role="status">{caseNote}</p>}
    </fieldset>
    {shareOpen && <ShareWizard patientId={detail.id} patientName={detail.name} onClose={() => setShareOpen(false)} onError={onError} />}
    </>
  );
}

function normalize(detail) {
  return {
    diagnoses: detail.diagnoses || [],
    medications: detail.medications || [],
    allergies: detail.allergies || [],
    allergyStatus: detail.allergyStatus || ((detail.allergies || []).length ? "recorded" : "unknown"),
    labs: detail.labs || [],
    visits: detail.visits || [],
  };
}
