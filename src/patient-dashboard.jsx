import { HabitSuggestion, SimilarCaseCard } from "./learning-loop";
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { dashboardLabGroups } from '../shared/patient-dashboard.mjs';
import { PatientLabs } from './patient-labs';
import { PatientOverview } from './patient-overview';
import { PatientMaterialLibrary } from './patient-material-library';
import { api } from './agent-runtime';
import './patient-dashboard.css';
import { labAxis } from '../shared/lab-axis.mjs';
import { ClinicalPanel } from './patient-clinical';
import { hasClinicalDraft } from './clinical-drafts';
import { TreatmentPanel } from './patient-treatment';
import { PatientHistory } from './patient-history';
import { diagnosisSources } from '../shared/diagnoses.mjs';
import { CLINICAL_SUMMARY_INSTRUCTION } from '../shared/clinical-summary.mjs';
import { usePluginEnabled } from "./plugin-slots";

// 从病程/诊断备注里提取引用的原文文件名（与「查看原文」跳转共用）。
export function citedFileName(text) {
  const m = String(text || '').match(/([^\s,，、;；:：()（）[\]【】「」《》"'']+\.(?:jpe?g|png|webp|pdf|txt|md|docx|xlsx))/i);
  return m ? m[1] : '';
}
function LabPlot({ group, compact = false }) {
  const points = group.points, values = points.map(p=>p.value);
  const dates = [...new Set(points.map(p=>p.date))].sort();
  const axis = labAxis(values);
  let start=Date.parse(dates[0]), end=Date.parse(dates.at(-1));
  if (start===end) { start-=43200000; end+=43200000; } // 单日记录左右各留半天，散点才落得进坐标系
  const width = compact ? 420 : 700, right = width - 40, left = Math.max(60, Math.min(200, Math.max(...axis.ticks.map(t=>t.label.length))*7+16));
  const x = p => left + (Date.parse(p.date)-start)/(end-start)*(right-left);
  const y = p => 150-axis.position(p.value)*115;
  const unique = [...new Map(points.map(p=>[`${p.date}|${p.value}`,p])).values()];
  // 同日多值时不连线：并列数值之间没有先后，连了就是假趋势。
  const line = dates.length > 1 && !group.conflict;
  return <div className="lab-plot-scroll" tabIndex={0} aria-label="检验图，可横向滚动"><svg viewBox={`0 0 ${width} 194`} role="img" aria-label={`${group.item} ${group.unit || '单位未记录'} 检验趋势，${points.length} 次记录${line ? '' : '，散点展示'}`}>
    {axis.ticks.map(({value,label},i)=><g key={i}><line x1={left} x2={right} y1={y({value})} y2={y({value})} stroke="var(--border)"/><text x={left-11} y={y({value})+4} textAnchor="end">{label}</text></g>)}
    {line && <polyline fill="none" stroke="var(--accent)" strokeWidth="2.5" points={unique.map(p=>`${x(p)},${y(p)}`).join(' ')} />}
    {unique.map((p,i)=><circle key={i} cx={x(p)} cy={y(p)} r="4" fill="var(--accent)"><title>{p.date}：{p.value} {group.unit || '单位未记录'}；{diagnosisSources(p).join('；') || '来源未记录'}{p.note ? `；备注：${p.note}` : ''}</title></circle>)}
    {dates.length > 1 ? <><text x={left} y="182">{dates[0]}</text><text x={right} y="182" textAnchor="end">{dates.at(-1)}</text></> : <text x={width/2} y="182" textAnchor="middle">{dates[0]}</text>}
  </svg></div>;
}
export function PatientDashboard({ patient, session, onClinical, onOpenWorkspace, onView, modelConfigured = true, view = "overview", followups = [], focusFile = null, focusLab = null, editRequest, onEditRequestHandled, onChanged, onError, riskPanel }) {
  const similarCasesEnabled = usePluginEnabled("similar-cases");
  const [editing, setEditing] = useState(() => focusLab?.patientId === patient.id ? false : hasClinicalDraft(patient.id, view));
  useEffect(() => {
    if (editRequest?.patientId !== patient.id || editRequest?.tab !== view) return;
    setEditing(true);
    onEditRequestHandled?.();
  }, [editRequest, patient.id, view, onEditRequestHandled]);
  const titles = {overview:'患者概览',diagnoses:'诊断与病史',medications:'治疗方案与预后',labs:'检验结果',visits:'就诊经过',library:'资料库'};
  const [visionSupported, setVisionSupported] = useState(false);
  const [ocrNotice, setOcrNotice] = useState('');
  const groups = useMemo(()=>dashboardLabGroups(patient.labs || []),[patient.labs]);
  const visits=patient.visits || [];
  const files=session.files || [];
  const visitsSorted=[...visits].sort((a,b)=>String(b.date || '').localeCompare(String(a.date || '')));
  useEffect(() => { api('/api/ocr-settings').then(s => setVisionSupported(s.imageCapable === true)).catch(() => {}); }, []);
  const handleMaterialsChanged = (message) => { setOcrNotice(typeof message === 'string' ? message : ''); return onChanged?.(); };
  return <section className="patient-dashboard" aria-label="患者资料面板">
    {view === 'overview' && !editing && <h2 className="sr-only">患者概览</h2>}
    {((view !== 'labs' && view !== 'overview') || editing) && <header className="chart-heading"><div><h2>{titles[view]}</h2>{view === 'visits' ? <p>共 {visits.length} 次就诊 · 最近在前</p> : !['diagnoses','library'].includes(view) && <p>档案更新于 {patient.updatedAt ? new Date(patient.updatedAt).toLocaleDateString('zh-CN') : '日期未记录'}</p>}</div>{view === 'labs' && <div className="toolbar-actions">{!editing && <button className="secondary" disabled={patient.archived} onClick={()=>setEditing(true)}>添加检验</button>}<button className="secondary" disabled={patient.archived} onClick={()=>onOpenWorkspace(session.id, {tab:'materials'})}>添加报告资料</button></div>}{(!['overview','library','diagnoses'].includes(view) || editing) && <button className="secondary" onClick={()=>setEditing(!editing)}>{editing ? '返回记录' : view === 'medications' ? '编辑用药与过敏' : view === 'visits' ? '添加就诊' : view === 'labs' ? '更正检验记录' : '编辑记录'} <ArrowUpRight size={15}/></button>}</header>}
    {editing ? <ClinicalPanel detail={patient} section={view} onChanged={onChanged} onError={onError}/> : <>
    {view === 'overview' && <><PatientOverview patient={patient} session={session} groups={groups} onNavigate={onClinical} onOpenWorkspace={onOpenWorkspace} onView={onView} riskPanel={riskPanel}/><HabitSuggestion key={patient.id} patientId={patient.id}/>{similarCasesEnabled && <details className="workspace-optional"><summary>相似病例参考</summary><SimilarCaseCard key={`similar-${patient.id}`} patientId={patient.id}/></details>}</>}
    {view === 'diagnoses' && <PatientHistory patient={patient} files={files} onEdit={()=>setEditing(true)} onNavigate={onClinical} onChanged={onChanged} citedFileName={citedFileName} summarizeBlocked={modelConfigured ? '' : '需先连接模型才能整理摘要草稿'} onSummarize={()=>onOpenWorkspace(session.id, {draft: `请根据当前患者（ID：${patient.id}）已有档案及原始资料，重新整理并保存精简病史摘要，保留其他临床记录。${CLINICAL_SUMMARY_INSTRUCTION}`})}/>}
    <div>
      {view === 'medications' && <TreatmentPanel patient={patient} followups={followups} files={files} citedFileName={citedFileName} groups={groups} Plot={LabPlot} onEditMedications={()=>setEditing(true)} onNavigate={onClinical} onChanged={onChanged}/>}
    </div>
    {view === 'labs' && <PatientLabs patient={patient} session={session} focusLab={focusLab} onChanged={onChanged} onError={onError} onClinical={onClinical} onOpenWorkspace={onOpenWorkspace} onEdit={()=>setEditing(true)} Plot={LabPlot} citedFileName={citedFileName}/>}
    <div>
      {view === 'visits' && <section id="chart-visits" className="chart-section visit-timeline" aria-label="就诊时间轴">{visits.length ? <ol className="visit-list">{visitsSorted.map((v,i)=>{
        const cited = citedFileName(v.source) || citedFileName(v.note) || citedFileName(v.reason) || v.source;
        const matches = cited ? files.filter(f => f.name.toLowerCase() === cited.toLowerCase()) : [];
        const target = matches.length === 1 ? matches[0] : null;
        return <li key={i}><time>{v.date || '日期未记录'}</time><div><h4>{v.reason || '就诊原因未记录'}</h4>{v.note && <p style={{ whiteSpace: 'pre-line' }}>{v.note}</p>}{v.source && <p className="om-source">来源：{v.source}</p>}{target && <button className="om-link" onClick={()=>onClinical('library', { focusFile: target.id })}>查看原文 {target.name}</button>}{matches.length > 1 && <button className="om-link" onClick={()=>onClinical('library')}>同名资料有多份，到资料库核对</button>}</div></li>;
      })}</ol> : <p className="chart-empty">暂无就诊记录。</p>}</section>}
      {view === 'library' && <>{ocrNotice && <p role="status">{ocrNotice}</p>}{!!session.intakeIssues?.length && <div role="status"><b>以下资料未能导入</b>{session.intakeIssues.map((issue, i) => <p key={i}>{issue.name}：{issue.error || '读取失败'}</p>)}</div>}<PatientMaterialLibrary files={files} sessionId={session.id} focusFile={focusFile} visionSupported={visionSupported} onChanged={handleMaterialsChanged} onError={onError} onOpenWorkspace={onOpenWorkspace}/></>}
    </div>
    </>}
  </section>;
}
