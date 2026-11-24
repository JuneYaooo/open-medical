import { useRef, useState } from 'react';
import { Activity, CalendarDays, ClipboardList, Pill, Sparkles } from 'lucide-react';
import { useClinicalDraft } from './clinical-drafts';
import { PatientQuestionStarters } from './patient-question-starters';
import { abnormalLabs, FLAG_ARROW } from '../shared/lab-flags.mjs';
import { allergyState } from '../shared/patient-list-brief.mjs';
import { clinicalDiagnoses } from '../shared/diagnoses.mjs';
import './clinical-assistance.css';

const medText = m => [m.name || m.drug, m.dose, m.frequency].filter(Boolean).join(' ');

// Questions built from this chart's own data, so the doctor starts from what
// is actually open in the record rather than a generic menu.
export function patientSuggestions(patient) {
  const out = [];
  const abnormal = abnormalLabs(patient.labs || [], { gender: patient.gender || '' });
  if (abnormal.length) {
    const list = abnormal.slice(0, 3).map(r => `${r.item} ${r.value}${r.unit ? ` ${r.unit}` : ''}${FLAG_ARROW[r.flag]}`).join('、');
    out.push({ icon: Activity, label: `解读异常检验：${list}`, prompt: `请解读这位患者最新的异常检验（${list}），结合病史、诊断与当前用药分析可能原因和临床意义，并列出建议的复查或进一步检查。注明判断依据与来源。` });
  }
  const meds = (patient.medications || []).filter(m => m.status === 'active');
  const allergy = allergyState(patient);
  if (meds.length) {
    const names = meds.map(medText).join('；');
    const allergyNote = allergy.status === 'recorded' ? `过敏史：${allergy.allergies.join('、')}` : allergy.status === 'unknown' ? '过敏史未记录，请提示需核对' : '无已知过敏';
    out.push({ icon: Pill, label: meds.length > 1 ? `核查 ${meds.length} 种在用药物的相互作用与禁忌` : `核查在用药物 ${meds[0].name || ''} 的剂量与禁忌`, prompt: `请核查这位患者当前在用药物（${names}）的剂量、相互作用，以及与已登记诊断和过敏情况（${allergyNote}）相关的禁忌，列出需要医生确认的问题。` });
  }
  const visit = [...(patient.visits || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
  if (visit?.note) {
    out.push({ icon: CalendarDays, label: `跟进最近就诊（${visit.date || '日期未记录'} ${visit.reason || ''}）记录的问题`, prompt: `请根据最近一次就诊（${visit.date || '日期未记录'}，${visit.reason || '原因未记录'}）的记录：“${visit.note}”，梳理需要跟进核对的问题，并给出下次就诊前应准备的检查与问诊要点。` });
  }
  const diagnoses = clinicalDiagnoses(patient.diagnoses || []);
  if (diagnoses.length) {
    const names = diagnoses.slice(0, 3).map(d => d.name).join('、');
    out.push({ icon: ClipboardList, label: `评估当前病情与治疗目标（${names}）`, prompt: `请结合这位患者的检验趋势、用药与就诊记录，评估其当前诊断（${names}）的病情控制是否达到治疗目标，指出证据不足之处，并给出可供医生参考的调整方向。` });
  }
  return out.slice(0, 4);
}

export function PatientSuggestionList({ patient, onChoose, disabled = false, hint = '' }) {
  const suggestions = patient ? patientSuggestions(patient) : [];
  if (!suggestions.length) return null;
  return <div className="assistance-suggestions">
    <h2><Sparkles size={16} aria-hidden="true"/>根据档案建议{hint && <small>{hint}</small>}</h2>
    <ul>{suggestions.map(({ icon: Icon, label, prompt }) => <li key={label}><button type="button" disabled={disabled} onClick={() => onChoose(prompt)}><Icon size={17} aria-hidden="true"/><span>{label}</span></button></li>)}</ul>
  </div>;
}

// 对话只由模型执行：未连接模型时说明原因并锁定提问入口。
const LOCKED = { border: 0, padding: 0, margin: 0, minWidth: 0 };
export function ClinicalAssistance({ patient, onOpenTask, modelConfigured = true, onModelSettings }) {
  const [question, setQuestion] = useClinicalDraft(patient.id, 'assistanceQuestion', '');
  const [workflow, setWorkflow] = useClinicalDraft(patient.id, 'assistanceWorkflow', '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const ask = async (text, flow) => {
    if (sending.current || !text.trim() || !modelConfigured) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await onOpenTask(patient.sessionId, { draft: text.trim(), workflow: flow, submit: true, newQuestion: true });
      setQuestion('');
      setWorkflow('');
    } catch (err) {
      // Keep the question so a failed one-click suggestion can be edited and resent.
      setQuestion(text);
      setWorkflow(flow);
      setError(err.message);
    }
    finally { sending.current = false; setBusy(false); }
  };
  const submit = event => { event.preventDefault(); return ask(question, workflow); };
  return <section className="clinical-assistance" aria-label="患者诊疗辅助面板">
    <h1>本次想了解什么？</h1>
    <p className="assistance-lead">助手会读取 {patient.name} 的诊断、用药、检验与资料作答，结论供您复核。</p>
    {!modelConfigured && <p className="notice" role="status">需先连接模型：未连接时不能向助手提问。{onModelSettings && <button type="button" className="text-button" onClick={onModelSettings}>连接模型</button>}</p>}
    <form onSubmit={submit}>
      <textarea aria-label="本次诊疗问题" value={question} onChange={e => setQuestion(e.target.value)} placeholder="输入诊疗问题，例如：近 3 个月血压控制如何？是否需要调整用药？" disabled={busy || !modelConfigured} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e); }}/>
      <div className="assistance-submit"><span>Enter 发送 · Shift + Enter 换行</span><button type="submit" className="primary" disabled={busy || !question.trim() || !modelConfigured} title={modelConfigured ? undefined : '需先连接模型'}>{busy ? '正在开始…' : '发送问题'}</button></div>
    </form>
    {error && <p role="alert" className="error-text">{error}</p>}
    <fieldset disabled={!modelConfigured} style={LOCKED} aria-label="提问建议">
      <PatientSuggestionList patient={patient} disabled={!modelConfigured || busy} hint="点击直接开始，结果供你复核" onChoose={prompt => ask(prompt, '')}/>
      <PatientQuestionStarters label="常用方向 · 点击直接开始" onChoose={({ prompt, workflow = "" }) => ask(prompt, workflow)}/>
    </fieldset>
  </section>;
}
