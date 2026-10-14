import { useRef, useState } from 'react';
import { diagnosisSources, groupDiagnoses } from '../shared/diagnoses.mjs';
import { ClinicalPanel } from './patient-clinical';
import { MaterialDetails } from './material-details';
import { api } from './agent-runtime';
import './patient-review.css';

export function PatientReview({ patient, session, groups, reviewFiles, visionSupported, onChanged, onError, onSource, onOpenWorkspace, materialActions }) {
  const [section, setSection] = useState('');
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const importIssues = session.intakeIssues || [];
  const materialCount = new Set([...reviewFiles.map(({file})=>file.name), ...importIssues.map(issue=>issue.name)]).size;
  const diagnoses = groupDiagnoses(patient.diagnoses).find(g => g.status === 'needs_review')?.items || [];
  const conflicts = groups.filter(g => g.conflict);
  const unknownMeds = (patient.medications || []).filter(m => !m.status || m.status === 'unknown');
  const unknownAllergies = !patient.allergies?.length && patient.allergyStatus !== 'none_known';
  const sources = item => diagnosisSources(item).map(source => <div className="review-source" key={source}><span>{source}</span>{onSource(source) && <button className="text-button" onClick={()=>onSource(source, true)}>查看原文</button>}</div>);
  const saveNote = async event => {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try {
      await api(`/api/patients/${patient.id}`, 'PATCH', { expectedRevision: patient.revision, note: note.trim() });
      await onChanged?.(); setNote(null);
    } catch (error) { onError?.(error.message); }
    finally { saving.current = false; setBusy(false); }
  };
  if (section) return <div className="patient-review"><button className="secondary" onClick={()=>setSection('')}>返回资料核对</button><ClinicalPanel detail={patient} section={section} onChanged={onChanged} onError={onError}/></div>;
  return <div className="patient-review">
    <nav className="review-index" aria-label="核对事项分类">{[['diagnoses','记录疑点',diagnoses.length],['conflicts','数值冲突',conflicts.length],['materials','导入与识别',materialCount]].map(([id,label,count])=><a href={`#review-${id}`} key={id}>{label}<b>{count}</b></a>)}</nav>
    <section className="review-section" aria-label="资料核对备注"><header><h3>资料备注</h3><button className="text-button" disabled={patient.archived || busy} onClick={()=>setNote(patient.note || '')}>编辑备注</button></header>
      {note !== null ? <form onSubmit={saveNote}><label>资料核对备注<textarea value={note} maxLength={2000} rows={4} disabled={busy} onChange={e=>setNote(e.target.value)}/></label><div className="review-actions"><button className="secondary" type="button" disabled={busy} onClick={()=>setNote(null)}>取消</button><button className="primary" disabled={busy}>保存备注</button></div></form> : <p className="review-copy">{patient.note || '暂无资料核对备注。'}</p>}
    </section>
    <section className="review-section" id="review-diagnoses" aria-label="待核对记录"><header><h3>待核对记录 <small>{diagnoses.length} 项</small></h3>{!!diagnoses.length && <button className="text-button" disabled={patient.archived} onClick={()=>setSection('diagnoses')}>修正诊断记录</button>}</header>
      {diagnoses.length ? <ul>{diagnoses.map((d,i)=><li key={i}><b>{d.name}</b>{d.date && <time>{d.date}</time>}{d.note && <p>{d.note}</p>}{sources(d)}</li>)}</ul> : <p className="muted">暂无标为待核对的记录。</p>}
    </section>
    <section className="review-section" id="review-conflicts" aria-label="检验数值冲突"><header><h3>检验数值冲突 <small>{conflicts.length} 组</small></h3>{!!conflicts.length && <button className="text-button" disabled={patient.archived} onClick={()=>setSection('labs')}>修正检验记录</button>}</header>
      {conflicts.length ? <><p className="muted">同项目、同单位、同一天出现多个数值。请结合采样时间与来源判断，暂不选择其中一个作为结论。</p>{conflicts.map(g=>{
        const dates = [...new Set(g.points.map(p=>p.date))].filter(date=>new Set(g.points.filter(p=>p.date===date).map(p=>p.value)).size>1);
        return <div className="review-conflict" key={g.key}><h4>{g.item} · {g.unit || '单位未记录'}</h4><ul>{g.records.filter(r=>dates.includes(r.date)).map((r,i)=><li key={i}><b>{r.value} {g.unit}</b><time>{r.date}</time>{sources(r)}</li>)}</ul></div>;
      })}</> : <p className="muted">暂无同日不同数值的检验记录。</p>}
    </section>
    <section className="review-section" id="review-materials" aria-label="资料导入与识别"><header><h3>资料导入与识别 <small>{materialCount} 份</small></h3><button className="text-button" onClick={()=>onOpenWorkspace(session.id,{tab:'materials'})}>打开资料工作区</button></header>
      {materialActions}
      {!!importIssues.length && <ul>{importIssues.map((issue,i)=><li key={i}><b>{issue.name}</b><p>{issue.error || '资料未能完成读取'}</p></li>)}</ul>}
      {reviewFiles.length ? reviewFiles.map(({file,level})=><details className="review-material" key={file.id}><summary>{file.name}<span>{level === 'failed' ? '读取失败' : level === 'poor' ? '识别质量低' : '识别待核对'}</span></summary><MaterialDetails file={file} sessionId={session.id} visionSupported={visionSupported} onChanged={onChanged} onError={onError}/></details>) : !importIssues.length && <p className="muted">暂无已检测到的导入或识别异常。</p>}
    </section>
    <section className="review-section" aria-label="用药与过敏信息核对"><header><h3>用药与过敏信息</h3>{(unknownMeds.length>0 || unknownAllergies) && <button className="text-button" disabled={patient.archived} onClick={()=>setSection('medications')}>补充核对结果</button>}</header>
      {unknownMeds.length>0 && <ul>{unknownMeds.map((m,i)=><li key={i}><b>{m.name}</b><p>当前是否使用尚未确认</p>{sources(m)}</li>)}</ul>}
      {unknownAllergies && <p>过敏史尚未核对。</p>}
      {!unknownMeds.length && !unknownAllergies && <p className="muted">暂无未确认的用药状态或过敏史。</p>}
    </section>
  </div>;
}
