import { useRef, useState } from 'react';
import { ArrowUpRight, CalendarDays, Pencil, Search, Stethoscope } from 'lucide-react';
import { DIAGNOSIS_STATUS_LABELS, DIAGNOSIS_STATUS_SHORT, diagnosisSources, groupDiagnoses } from '../shared/diagnoses.mjs';
import { dashboardHistory } from '../shared/patient-dashboard.mjs';
import { api } from './agent-runtime';
import { SUMMARY_FIELDS, SUMMARY_LIMIT, parseClinicalSummary, formatClinicalSummary } from '../shared/clinical-summary.mjs';
import './patient-history.css';

// Only format existing text; uncertainty and original wording stay intact.
function paragraphs(text) {
  return String(text || '').split(/\n+/).filter(p => p.trim());
}
function RecordSource({ sources, onSource }) {
  if (!sources.length) return <span className="history-source-missing">来源未记录</span>;
  return <details className="history-sources"><summary>资料来源 · {sources.length}</summary><ul>{sources.map(source => <li key={source}><span>{source}</span>{onSource(source) && <button className="text-button" onClick={()=>onSource(source, true)}>查看原文 <ArrowUpRight size={13}/></button>}</li>)}</ul></details>;
}

export function PatientHistory({ patient, files, onEdit, onNavigate, onChanged, citedFileName, onSummarize }) {
  const groups = groupDiagnoses(patient.diagnoses || []);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [allVisits, setAllVisits] = useState(false);
  const [editor, setEditor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const history = dashboardHistory(patient).toReversed();
  const visits = allVisits ? history : history.slice(0, 4);
  const summary = patient.clinicalSummary;
  const concise = parseClinicalSummary(summary?.text);
  const clinicalGroups = groups.filter(g => ['confirmed', 'suspected'].includes(g.status));
  const findings = groups.find(g => g.status === 'finding')?.items || [];
  const datedHistory = history.filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v.date || ''));
  const latest = datedHistory[0];
  const counts = Object.fromEntries(Object.keys(DIAGNOSIS_STATUS_LABELS).map(status => [status, groups.find(g => g.status === status)?.items.length || 0]));
  const total = clinicalGroups.reduce((sum,g)=>sum+g.items.length,0);
  const matches = clinicalGroups.filter(g => filter === 'all' || filter === g.status).map(g=>({...g,items:g.items.filter(d=>[d.name,d.code,d.note,...diagnosisSources(d)].filter(Boolean).join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))})).filter(g=>g.items.length);
  const sourceLink = (source, navigate = false) => {
    const name = citedFileName(source);
    const file = name && files.find(f=>f.name === name);
    if (file && navigate) onNavigate('library', { focusFile: file.id });
    return !!file;
  };
  const editSummary = () => { setEditor({ current:concise?.current || '', problems:concise?.problems || '', course:concise?.course || '', source:summary?.source || '' }); setError(''); };
  const saveSummary = async event => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      await api(`/api/patients/${patient.id}`, 'PATCH', { expectedRevision:patient.revision, clinicalSummary:{text:formatClinicalSummary(editor),source:editor.source.trim()} });
      await onChanged?.(); setEditor(null);
    } catch (err) { setError(err.message); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <div className="patient-history-workspace">

    <div className="history-layout">
      <div className="history-main">
        <section className="history-card history-summary" aria-label="病史摘要">
          <header><div><span className="history-kicker">CLINICAL HISTORY</span><h3>病史摘要</h3></div><button className="text-button" disabled={patient.archived || busy} onClick={editSummary}><Pencil size={14}/>{summary?.text ? '编辑摘要' : '补充摘要'}</button></header>
          {editor ? <form onSubmit={saveSummary} aria-label="编辑病史摘要"><fieldset disabled={busy}>
            {SUMMARY_FIELDS.map(([key,label])=><label key={key}>{label}<textarea rows={2} maxLength={SUMMARY_LIMIT} required value={editor[key]} onChange={e=>setEditor({...editor,[key]:e.target.value})} placeholder={key==='current'?'截至哪次就诊，患者目前状态如何？':key==='problems'?'当前需要处理的症状、功能影响或临床问题；保留疑似表述。':'起病 → 关键治疗 → 近期变化。'}/><small>{editor[key].length} / {SUMMARY_LIMIT}</small></label>)}
            {summary?.text && !concise && <details><summary>参考既有病史记录</summary><p className="clinical-summary-text">{summary.text}</p></details>}
            <label>病史摘要来源<textarea rows={2} maxLength={2000} required value={editor.source} onChange={e=>setEditor({...editor,source:e.target.value})} placeholder="填写原始病历、报告或本次问诊记录的出处"/></label>
            {error && <p className="error" role="alert">{error}</p>}
            <footer><button type="button" className="secondary" onClick={()=>setEditor(null)}>取消</button><button type="submit" disabled={SUMMARY_FIELDS.some(([key])=>!editor[key].trim()) || !editor.source.trim()}>{busy ? '正在保存…' : '保存摘要'}</button></footer>
          </fieldset></form> : <>
            {concise ? <dl className="history-snapshot">{SUMMARY_FIELDS.map(([key,label])=><div key={key}><dt>{label}</dt><dd className="clinical-summary-text">{concise[key]}</dd></div>)}</dl> : <>
              <dl className="history-snapshot">
                <div><dt>最近记录</dt><dd>{latest ? <>{latest.date} · {latest.reason}</> : '尚无已注明日期的就诊记录'}</dd></div>
                <div><dt>诊断概况</dt><dd>{clinicalGroups.flatMap(g=>g.items).slice(0,3).map(d=><span className="history-snapshot-item" key={d.name}>{d.name} · {DIAGNOSIS_STATUS_SHORT[groups.find(g=>g.items.includes(d)).status]}</span>)}{!total && '尚未登记诊断'}{total>3 && <small>另有 {total-3} 项，见下方诊断列表</small>}</dd></div>
                <div><dt>既往经过</dt><dd>{datedHistory.length>1 ? `${datedHistory.at(-1).date} · ${datedHistory.at(-1).reason}` : '尚无更早的就诊记录'}</dd></div>
              </dl>
              <p className="history-muted">以上为档案中的记录要点；当前状态与病程摘要尚未整理。</p>
            </>}
            {concise && <RecordSource sources={summary.source?[summary.source]:[]} onSource={sourceLink}/>}
            {summary?.text && !concise && <details className="history-original"><summary>查看既有病史记录与来源</summary><div className="history-summary-copy">{paragraphs(summary.text).map((p,i)=><p key={i}>{p}</p>)}</div><RecordSource sources={summary.source?[summary.source]:[]} onSource={sourceLink}/></details>}
            <button className="text-button history-expand" disabled={patient.archived || !onSummarize} onClick={onSummarize}>整理精简摘要 <ArrowUpRight size={14}/></button>
          </>}

        </section>
        <section className="history-card history-problems" aria-label="诊断列表">
          <header><div><span className="history-kicker">DIAGNOSES</span><h3>诊断 <small>{total} 项记录</small></h3></div><button className="text-button" onClick={onEdit}>编辑诊断 <ArrowUpRight size={14}/></button></header>
          <nav className="history-status-nav" aria-label="诊断分类">{[['all','全部诊断',total],...['confirmed','suspected'].map(id=>[id,DIAGNOSIS_STATUS_SHORT[id],counts[id]])].map(([id,label,count])=><button key={id} className={filter===id?'selected':''} aria-pressed={filter===id} onClick={()=>setFilter(id)}><span>{label}</span><strong>{count}<small>项</small></strong></button>)}</nav>
          <label className="history-search"><Search size={17}/><input type="search" aria-label="搜索诊断与病史记录" placeholder="搜索诊断、ICD 编码或备注" value={query} onChange={e=>setQuery(e.target.value)}/></label>
          <div className="history-filter-caption"><span>{filter==='all'?'全部分类':DIAGNOSIS_STATUS_LABELS[filter]} · {matches.reduce((sum,g)=>sum+g.items.length,0)} 项</span>{(filter!=='all' || query) && <button className="text-button" onClick={()=>{setFilter('all');setQuery('');}}>清除筛选</button>}</div>
          {matches.length ? matches.map(group=><div className={`history-diagnosis-group ${group.status}`} key={group.status}><h4><span/>{group.label}<small>{group.items.length}</small></h4><ul>{group.items.map((d,i)=><li key={`${d.name}-${i}`}><div className="history-diagnosis-title"><h5>{d.name}</h5><span className={`history-diagnosis-badge ${group.status}`}>{DIAGNOSIS_STATUS_SHORT[group.status]}</span></div><div className="history-diagnosis-meta">{d.code && <span>ICD · {d.code}</span>}<span>{d.date ? `记录日期 · ${d.date}` : '日期未记录'}</span></div>{d.note && <p className="history-diagnosis-note">{d.note}</p>}<RecordSource sources={diagnosisSources(d)} onSource={sourceLink}/></li>)}</ul></div>) : <div className="history-empty compact"><Stethoscope size={26}/><p>{total ? '没有符合条件的诊断记录' : '尚未登记诊断'}</p>{!total && <button className="text-button" onClick={onEdit}>添加诊断记录 <ArrowUpRight size={14}/></button>}</div>}
        </section>
      </div>
      <aside className="history-aside">
        {!!findings.length && <section className="history-card" aria-label="检查发现"><header><h3>检查发现 <small>{findings.length} 项</small></h3></header><ul className="history-findings">{findings.map((d,i)=><li key={i}><b>{d.name}</b>{d.date && <time>{d.date}</time>}{d.note && <p>{d.note}</p>}<RecordSource sources={diagnosisSources(d)} onSource={sourceLink}/></li>)}</ul></section>}
        <section className="history-card history-journey" aria-label="病程时间线">
          <header><div><span className="history-kicker">PATIENT JOURNEY</span><h3>病程时间线</h3></div><CalendarDays size={19}/></header>
          <p className="history-muted">按就诊记录由近到远 · {history.length} 次记录</p>
          {visits.length ? <ol>{visits.map((visit,i)=><li key={`${visit.date}-${i}`}><time>{visit.date || '日期未记录'}</time><h4>{visit.reason}</h4>{visit.note && <details className="history-visit-note"><summary>就诊补充说明</summary><p>{visit.note}</p></details>}<RecordSource sources={diagnosisSources(visit)} onSource={sourceLink}/></li>)}</ol> : <div className="history-empty compact"><CalendarDays size={26}/><p>登记就诊经过后，在这里回顾病程节点。</p></div>}
          <footer className="history-journey-actions">{history.length>4 && <button className="text-button history-expand" aria-expanded={allVisits} onClick={()=>setAllVisits(!allVisits)}>{allVisits?'收起较早记录':`展开其余 ${history.length-4} 次就诊`}</button>}
          <button className="text-button" onClick={()=>onNavigate('visits')}>查看完整就诊记录 <ArrowUpRight size={14}/></button></footer>
        </section>

        <button aria-label="查看治疗方案与预后" className="history-treatment-link" onClick={()=>onNavigate('medications')}><div><span>接下来</span><b>查看治疗方案与预后</b></div><ArrowUpRight size={20}/></button>
      </aside>
    </div>
  </div>;
}
