import { useEffect, useRef, useState } from "react";
import { api } from "./agent-runtime";
import { localCalendarDate } from "../shared/calendar-date.mjs";
import { Download, Plus, X, Loader2, Search } from "lucide-react";

const fmtDate = (value) => (value ? String(value).slice(0, 10) : "");

// Structured clinical data panel for one patient: diagnoses (with ICD-10
// helper), medications, allergies, labs and visits. Edits are local until
// saved; export produces a de-identified JSON for research.
export function ClinicalPanel({ detail, onChanged, onError, section }) {
  const [draft, setDraft] = useState(() => normalize(detail));
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const searchVersion = useRef(0);
  useEffect(() => {
    setDraft(normalize(detail));
  }, [detail.id, detail.revision]);
  const [icdQuery, setIcdQuery] = useState("");
  const [icdResults, setIcdResults] = useState([]);
  const [newDiagnosis, setNewDiagnosis] = useState("");
  const [newMed, setNewMed] = useState({ name: "", dose: "", frequency: "", status: "unknown" });
  const [newAllergy, setNewAllergy] = useState("");
  const [newLab, setNewLab] = useState({
    item: "",
    value: "",
    unit: "",
    date: "",
  });
  const [newVisit, setNewVisit] = useState({ date: "", reason: "" });

  const patch = async (fields) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setSaving(true);
    try {
      const saved = await api(`/api/patients/${detail.id}`, "PATCH", {
        expectedRevision: detail.revision,
        ...fields,
      });
      setDraft(normalize(saved));
      await onChanged();
      return true;
    } catch (err) {
      onError?.(err.message);
      return false;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const saveDiagnoses = (diagnoses) => patch({ diagnoses });
  const saveMedications = (medications) => patch({ medications });
  const saveAllergies = (allergies) => patch({ allergies });
  const saveLabs = (labs) => patch({ labs });
  const saveVisits = (visits) => patch({ visits });

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
        { code, name, date: localCalendarDate() },
      ]))
    )
      return;
    searchVersion.current++;
    setNewDiagnosis("");
    setIcdQuery("");
    setIcdResults([]);
  };
  const addMedication = async () => {
    if (!newMed.name.trim()) return;
    if (!(await saveMedications([...draft.medications, { ...newMed }]))) return;
    setNewMed({ name: "", dose: "", frequency: "", status: "unknown" });
  };
  const addAllergy = async () => {
    const text = newAllergy.trim();
    if (!text || draft.allergies.includes(text)) return;
    if (!(await saveAllergies([...draft.allergies, text]))) return;
    setNewAllergy("");
  };
  const addLab = async () => {
    const value = Number(newLab.value);
    if (
      !newLab.item.trim() ||
      !newLab.date ||
      !newLab.value.trim() ||
      !Number.isFinite(value)
    )
      return;
    if (
      !(await saveLabs([
        ...draft.labs,
        {
          item: newLab.item.trim(),
          value,
          ...(newLab.unit ? { unit: newLab.unit } : {}),
          date: newLab.date,
        },
      ]))
    )
      return;
    setNewLab({ item: "", value: "", unit: "", date: "" });
  };
  const addVisit = async () => {
    if (!newVisit.date || !newVisit.reason.trim()) return;
    if (!(await saveVisits([...draft.visits, { ...newVisit }]))) return;
    setNewVisit({ date: "", reason: "" });
  };
  const exportDeidentified = async () => {
    const data = await api(`/api/patients/${detail.id}/export`);
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${data.pseudoId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <fieldset
      disabled={saving || detail.archived}
      className="detail-panel clinical-panel"
      aria-busy={saving}
    >
      {(!section || section === 'diagnoses') && <section>
        <h3>诊断 {saving && <Loader2 className="spin" size={13} />}</h3>
        <ul className="clinical-rows">
          {draft.diagnoses.map((d, index) => (
            <li key={`${d.code}-${d.name}-${index}`}>
              <span>
                <b>{d.name}</b>
                {d.code ? ` · ${d.code}` : ""}
                {d.date ? ` · ${fmtDate(d.date)}` : ""}
              </span>
              <button
                className="icon-button"
                title="移除"
                onClick={() =>
                  saveDiagnoses(draft.diagnoses.filter((_, i) => i !== index))
                }
              >
                <X size={13} />
              </button>
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
            placeholder="或直接填写诊断名称"
            onChange={(e) => setNewDiagnosis(e.target.value)}
          />
          <button
            className="secondary"
            onClick={() => addDiagnosis("", newDiagnosis)}
            disabled={!newDiagnosis.trim()}
          >
            <Plus size={13} /> 添加
          </button>
          {icdResults.length > 0 && (
            <div className="icd-results">
              {icdResults.map((item) => (
                <button
                  key={item.code}
                  onClick={() => addDiagnosis(item.code, item.name)}
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
        {!draft.allergies.length && <label className="clinical-status-field">核对状态<select aria-label="过敏史核对状态" value={draft.allergyStatus} onChange={(e) => patch({ allergyStatus: e.target.value })}>
          <option value="unknown">尚未核对</option><option value="none_known">已核对：无已知过敏</option>
        </select></label>}
        <div className="allergy-chips">
          {draft.allergies.map((item) => (
            <span className="hint-tag allergy" key={item}>
              {item}
              <button
                onClick={() =>
                  saveAllergies(draft.allergies.filter((a) => a !== item))
                }
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {!draft.allergies.length && <span className="muted">未记录。</span>}
        </div>
        <div className="clinical-add">
          <input
            value={newAllergy}
            placeholder="添加过敏原"
            onChange={(e) => setNewAllergy(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addAllergy()}
          />
          <button
            className="secondary"
            onClick={addAllergy}
            disabled={!newAllergy.trim()}
          >
            <Plus size={13} /> 添加
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
              </span>
              <select aria-label={`${m.name}用药状态`} value={m.status || "unknown"} onChange={(e) => saveMedications(draft.medications.map((item, i) => i === index ? { ...item, status: e.target.value } : item))}>
                <option value="unknown">状态待核对</option><option value="active">目前在用</option><option value="stopped">已停用</option>
              </select>
              <button
                className="icon-button"
                title="移除"
                onClick={() =>
                  saveMedications(
                    draft.medications.filter((_, i) => i !== index),
                  )
                }
              >
                <X size={13} />
              </button>
            </li>
          ))}
          {!draft.medications.length && <li className="muted">未记录用药。</li>}
        </ul>
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
          <select aria-label="新增用药状态" value={newMed.status} onChange={(e) => setNewMed({ ...newMed, status: e.target.value })}><option value="unknown">状态待核对</option><option value="active">目前在用</option><option value="stopped">已停用</option></select>
          <button
            className="secondary"
            onClick={addMedication}
            disabled={!newMed.name.trim()}
          >
            <Plus size={13} /> 添加
          </button>
        </div>
      </section>}

      {(!section || section === 'labs') && <section>
        <h3>检验记录</h3>
        <ul className="clinical-rows">
          {draft.labs.slice(-12).map((l, index, visible) => {
            const realIndex = draft.labs.length - visible.length + index;
            return (
              <li key={`${l.item}-${l.date}-${index}`}>
                <span>
                  <b>{l.item}</b> {l.value}
                  {l.unit || ""} · {fmtDate(l.date)}
                </span>
                <button
                  className="icon-button"
                  title="移除"
                  onClick={() =>
                    saveLabs(draft.labs.filter((_, i) => i !== realIndex))
                  }
                >
                  <X size={13} />
                </button>
              </li>
            );
          })}
          {!draft.labs.length && <li className="muted">未记录检验。</li>}
        </ul>
        <div className="clinical-add clinical-add-med">
          <input
            value={newLab.item}
            placeholder="项目"
            onChange={(e) => setNewLab({ ...newLab, item: e.target.value })}
          />
          <input
            value={newLab.value}
            placeholder="数值"
            inputMode="decimal"
            onChange={(e) => setNewLab({ ...newLab, value: e.target.value })}
          />
          <input
            value={newLab.unit}
            placeholder="单位"
            onChange={(e) => setNewLab({ ...newLab, unit: e.target.value })}
          />
          <input
            type="date"
            value={newLab.date}
            onChange={(e) => setNewLab({ ...newLab, date: e.target.value })}
          />
          <button
            className="secondary"
            onClick={addLab}
            disabled={
              !newLab.item.trim() || !newLab.date || newLab.value === ""
            }
          >
            <Plus size={13} /> 添加
          </button>
        </div>
      </section>}

      {(!section || section === 'visits') && <section>
        <h3>就诊记录</h3>
        <ul className="clinical-rows">
          {draft.visits.slice(-8).map((v, index, visible) => {
            const realIndex = draft.visits.length - visible.length + index;
            return (
              <li key={`${v.date}-${index}`}>
                <span>
                  {fmtDate(v.date)} · {v.reason}
                  {v.note ? ` · ${v.note}` : ""}
                </span>
                <button
                  className="icon-button"
                  title="移除"
                  onClick={() =>
                    saveVisits(draft.visits.filter((_, i) => i !== realIndex))
                  }
                >
                  <X size={13} />
                </button>
              </li>
            );
          })}
          {!draft.visits.length && <li className="muted">未记录就诊。</li>}
        </ul>
        <div className="clinical-add clinical-add-med">
          <input
            type="date"
            value={newVisit.date}
            onChange={(e) => setNewVisit({ ...newVisit, date: e.target.value })}
          />
          <input
            value={newVisit.reason}
            placeholder="就诊事由"
            onChange={(e) =>
              setNewVisit({ ...newVisit, reason: e.target.value })
            }
          />
          <button
            className="secondary"
            onClick={addVisit}
            disabled={!newVisit.date || !newVisit.reason.trim()}
          >
            <Plus size={13} /> 添加
          </button>
        </div>
      </section>}

      <div className="clinical-actions">
        <button
          className="secondary"
          onClick={() =>
            exportDeidentified().catch((err) => onError?.(err.message))
          }
        >
          <Download size={14} /> 脱敏导出（科研用 JSON）
        </button>
        <span className="muted">
          每处修改立即保存；导出文件不含姓名、电话与确切年龄。
        </span>
      </div>
    </fieldset>
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
