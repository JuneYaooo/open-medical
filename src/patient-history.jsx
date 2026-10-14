import { useRef, useState } from 'react';
import { ArrowUpRight, CalendarDays, FileText, Pencil, Search, Stethoscope } from 'lucide-react';
import { DIAGNOSIS_STATUS_LABELS, DIAGNOSIS_STATUS_SHORT, diagnosisSources, groupDiagnoses } from '../shared/diagnoses.mjs';
import { dashboardHistory } from '../shared/patient-dashboard.mjs';
import { api } from './agent-runtime';
import './patient-history.css';

// Only format existing text; uncertainty and original wording stay intact.
function paragraphs(text) {
  return String(text || '').split(/\n+/).filter(p => p.trim());
}
function RecordSource({ sources, onSource }) {
  if (!sources.length) return <span className="history-source-missing">来源未记录</span>;
  return <details className="history-sources"><summary>资料来源 · {sources.length}</summary><ul>{sources.map(source => <li key={source}><span>{source}</span>{onSource(source) && <button className="text-button" onClick={()=>onSource(source, true)}>查看原文 <ArrowUpRight size={13}/></button>}</li>)}</ul></details>;
}

export function PatientHistory({ patient, files, onEdit, onNavigate, onChanged, citedFileName }) {
  const groups = groupDiagnoses(patient.diagnoses || []);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [allVisits, setAllVisits] = useState(false);
  const [editor, setEditor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const history = dashboardHistory(patient).toReversed();
  const visits = allVisits ? history : history.slice(0, 4);
  const summary = patient.clinicalSummary;
  const longSummary = (summary?.text?.length || 0) > 460;
  const counts = Object.fromEntries(Object.keys(DIAGNOSIS_STATUS_LABELS).map(status => [status, groups.find(g => g.status === status)?.items.length || 0]));
  const total = groups.reduce((sum,g)=>sum+g.items.length,0);
  const matches = groups.filter(g => filter === 'all' || filter === g.status).map(g=>({...g,items:g.items.filter(d=>[d.name,d.code,d.note,...diagnosisSources(d)].filter(Boolean).join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))})).filter(g=>g.items.length);
  const sourceLink = (source, navigate = false) => {
    const name = citedFileName(source);
    const file = name && files.find(f=>f.name === name);
    if (file && navigate) onNavigate('library', { focusFile: file.id });
    return !!file;
  };
  const editSummary = () => { setEditor({ text:summary?.text || '', source:summary?.source || '' }); setError(''); };
  const saveSummary = async event => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      await api(`/api/patients/${patient.id}`, 'PATCH', { expectedRevision:patient.revision, clinicalSummary:{text:editor.text.trim(),source:editor.source.trim()} });
      await onChanged?.(); setEditor(null); setExpanded(true);
    } catch (err) { setError(err.message); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <div className="patient-history-workspace">
    <nav className="history-status-nav" aria-label="诊断分类">{[['all','全部记录',total],...Object.entries(DIAGNOSIS_STATUS_SHORT).map(([id,label])=>[id,label,counts[id]])].map(([id,label,count])=><button key={id} className={`${filter===id?'selected':''} ${id}`} aria-pressed={filter===id} onClick={()=>setFilter(id)}><span>{label}</span><strong>{count}<small>项</small></strong></button>)}</nav>
    <div className="history-layout">
      <div className="history-main">
        <section className="history-card history-summary" aria-label="病史摘要">
          <header><div><span className="history-kicker">CLINICAL HISTORY</span><h3>病史摘要</h3></div><button className="text-button" disabled={patient.archived || busy} onClick={editSummary}><Pencil size={14}/>{summary?.text ? '编辑摘要' : '补充摘要'}</button></header>
          {editor ? <form onSubmit={saveSummary} aria-label="编辑病史摘要"><fieldset disabled={busy}>
            <label>病史摘要正文<textarea autoFocus rows={8} maxLength={4000} required value={editor.text} onChange={e=>setEditor({...editor,text:e.target.value})} placeholder="记录起病、重要检查、既往治疗与近期变化，保留待确认的信息。"/></label>
            <label>病史摘要来源<textarea rows={2} maxLength={2000} required value={editor.source} onChange={e=>setEditor({...editor,source:e.target.value})} placeholder="填写原始病历、报告或本次问诊记录的出处"/></label>
            {error && <p className="error" role="alert">{error}</p>}
            <footer><button type="button" className="secondary" onClick={()=>setEditor(null)}>取消</button><button type="submit" disabled={!editor.text.trim() || !editor.source.trim()}>{busy ? '正在保存…' : '保存摘要'}</button></footer>
          </fieldset></form> : summary?.text ? <><div id="history-summary-content" className={`history-summary-copy ${longSummary && !expanded?'is-collapsed':''}`}>{paragraphs(summary.text).map((p,i)=><p key={i} className="clinical-summary-text">{p}</p>)}</div>{longSummary && <button className="text-button history-expand" aria-expanded={expanded} aria-controls="history-summary-content" onClick={()=>setExpanded(!expanded)}>{expanded ? '收起摘要' : '展开完整摘要'}</button>}<RecordSource sources={summary.source?[summary.source]:[]} onSource={sourceLink}/></> : <div className="history-empty"><FileText size={27}/><h4>把重要病史串成一条线</h4><p>补充起病经过、既往治疗与近期变化，接诊时快速回顾。</p><button className="secondary" disabled={patient.archived} onClick={editSummary}>补充病史摘要</button></div>}
        </section>
        <section className="history-card history-problems" aria-label="诊断与问题">
          <header><div><span className="history-kicker">PROBLEM LIST</span><h3>诊断与问题 <small>{total} 项记录</small></h3></div><button className="text-button" onClick={onEdit}>核对诊断 <ArrowUpRight size={14}/></button></header>
          <label className="history-search"><Search size={17}/><input type="search" aria-label="搜索诊断与病史记录" placeholder="搜索诊断、ICD 编码或备注" value={query} onChange={e=>setQuery(e.target.value)}/></label>
          <div className="history-filter-caption"><span>{filter==='all'?'全部分类':DIAGNOSIS_STATUS_LABELS[filter]} · {matches.reduce((sum,g)=>sum+g.items.length,0)} 项</span>{(filter!=='all' || query) && <button className="text-button" onClick={()=>{setFilter('all');setQuery('');}}>清除筛选</button>}</div>
          {matches.length ? matches.map(group=><div className={`history-diagnosis-group ${group.status}`} key={group.status}><h4><span/>{group.label}<small>{group.items.length}</small></h4><ul>{group.items.map((d,i)=><li key={`${d.name}-${i}`}><div className="history-diagnosis-title"><h5>{d.name}</h5><span className={`history-diagnosis-badge ${group.status}`}>{DIAGNOSIS_STATUS_SHORT[group.status]}</span></div><div className="history-diagnosis-meta">{d.code && <span>ICD · {d.code}</span>}<span>{d.date ? `记录日期 · ${d.date}` : '日期未记录'}</span></div>{d.note && <p className="history-diagnosis-note">{d.note}</p>}<RecordSource sources={diagnosisSources(d)} onSource={sourceLink}/></li>)}</ul></div>) : <div className="history-empty compact"><Stethoscope size={26}/><p>{total ? '没有符合条件的诊断记录' : '尚未登记诊断与问题'}</p>{!total && <button className="text-button" onClick={onEdit}>添加诊断记录 <ArrowUpRight size={14}/></button>}</div>}
        </section>
      </div>
      <aside className="history-aside">
        {!!counts.needs_review && <section className="history-card history-review" aria-label="待核对诊断"><span className="history-kicker">REVIEW NEEDED</span><h3>{counts.needs_review} 项诊断待核对</h3><p>核对原始资料与当前记录，确认诊断名称、日期和依据。</p><button className="text-button" onClick={()=>{setFilter('needs_review');setQuery('');}}>查看待核对项 <ArrowUpRight size={14}/></button></section>}
        <section className="history-card history-journey" aria-label="病程时间线">
          <header><div><span className="history-kicker">PATIENT JOURNEY</span><h3>病程时间线</h3></div><CalendarDays size={19}/></header>
          <p className="history-muted">按就诊记录由近到远 · {history.length} 次记录</p>
          {visits.length ? <ol>{visits.map((visit,i)=><li key={`${visit.date}-${i}`}><time>{visit.date || '日期未记录'}</time><h4>{visit.reason}</h4>{visit.note && <details className="history-visit-note"><summary>就诊补充说明</summary><p>{visit.note}</p></details>}<RecordSource sources={diagnosisSources(visit)} onSource={sourceLink}/></li>)}</ol> : <div className="history-empty compact"><CalendarDays size={26}/><p>登记就诊经过后，在这里回顾病程节点。</p></div>}
          <footer className="history-journey-actions">{history.length>4 && <button className="text-button history-expand" aria-expanded={allVisits} onClick={()=>setAllVisits(!allVisits)}>{allVisits?'收起较早记录':`展开其余 ${history.length-4} 次就诊`}</button>}
          <button className="text-button" onClick={()=>onNavigate('visits')}>查看完整就诊记录 <ArrowUpRight size={14}/></button></footer>
        </section>
        {(patient.note || patient.tags?.length>0) && <section className="history-card history-context" aria-label="档案补充信息"><span className="history-kicker">RECORD CONTEXT</span><h3>档案补充</h3>{patient.note && <details className="history-record-notes"><summary>资料备注与待核对信息</summary><p>{patient.note}</p></details>}{!!patient.tags?.length && <div className="history-tags" aria-label="患者标签">{patient.tags.map(tag=><span key={tag}>{tag}</span>)}</div>}</section>}
        <button aria-label="查看治疗方案与预后" className="history-treatment-link" onClick={()=>onNavigate('medications')}><div><span>接下来</span><b>查看治疗方案与预后</b></div><ArrowUpRight size={20}/></button>
      </aside>
    </div>
  </div>;
}
