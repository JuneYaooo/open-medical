import { useEffect, useMemo, useState } from 'react';
import { Activity, FileText, CalendarDays, Pill, ArrowUpRight } from 'lucide-react';
import { dashboardLabGroups, dashboardHistory } from '../shared/patient-dashboard.mjs';
import { MaterialDetails, materialQualityLevel } from './material-details';
import { api } from './agent-runtime';
import './patient-dashboard.css';
import { ClinicalPanel } from './patient-clinical';

function Source({ value }) {
  return value ? <details className="chart-source"><summary>资料来源</summary><p>{value}</p></details> : <small className="muted">来源未记录</small>;
}
function LabPlot({ group }) {
  const points = group.points, values = points.map(p=>p.value);
  const min = Math.min(...values), max = Math.max(...values), pad = (max-min || Math.abs(max) || 1)*.15;
  const low=min-pad, high=max+pad, start=Date.parse(points[0].date), end=Date.parse(points.at(-1).date);
  const x = p => 60 + (Date.parse(p.date)-start)/(end-start)*600;
  const y = p => 150-(p.value-low)/(high-low)*115;
  const short = n => Number(n.toPrecision(5)).toString();
  return <svg viewBox="0 0 700 194" role="img" aria-label={`${group.item} ${group.unit} 检验趋势，${points.length} 次记录`}>
    {[low,(low+high)/2,high].map((n,i)=><g key={i}><line x1="60" x2="660" y1={150-i*57.5} y2={150-i*57.5} stroke="var(--border)"/><text x="49" y={154-i*57.5} textAnchor="end">{short(n)}</text></g>)}
    <polyline fill="none" stroke="var(--accent)" strokeWidth="2.5" points={points.map(p=>`${x(p)},${y(p)}`).join(' ')} />
    {points.map(p=><circle key={p.date} cx={x(p)} cy={y(p)} r="4" fill="var(--accent)"><title>{p.date}：{p.value} {group.unit}；{p.source || '来源未记录'}</title></circle>)}
    <text x="60" y="182">{points[0].date}</text><text x="660" y="182" textAnchor="end">{points.at(-1).date}</text>
  </svg>;
}
export function PatientDashboard({ patient, session, onClinical, onOpenWorkspace, view = "overview", onChanged, onError }) {
  const [editing, setEditing] = useState(false);
  const titles = {overview:'患者概览',diagnoses:'诊断与病史',medications:'用药与过敏',labs:'检验趋势',visits:'就诊经过',sources:'原始资料'};
  const [selected, setSelected] = useState('');
  const [materialQuery, setMaterialQuery] = useState('');
  const [visionSupported, setVisionSupported] = useState(false);
  const [ocrBulk, setOcrBulk] = useState('');
  const [ocrNotice, setOcrNotice] = useState('');
  const groups = useMemo(()=>dashboardLabGroups(patient.labs || []),[patient.labs]);
  const group = groups.find(g=>g.key===selected) || groups.find(g=>g.canPlot) || groups[0];
  const diagnoses=patient.diagnoses || [], meds=patient.medications || [], visits=patient.visits || [], allergies=patient.allergies || [];
  const history=dashboardHistory(patient);
  const files=session.files || [];
  const visitsSorted=[...visits].sort((a,b)=>String(b.date || '').localeCompare(String(a.date || '')));
  const status={active:'正在使用',stopped:'已停用',unknown:'状态待核对'};
  useEffect(() => { api('/api/model-settings').then(s => setVisionSupported(s.vision === true)).catch(() => {}); }, []);
  const reviewFiles = files.map(file => ({ file, level: materialQualityLevel(file) })).filter(x => x.level && x.level !== 'good');
  const poorFiles = reviewFiles.filter(x => x.level === 'poor').map(x => x.file);
  const handleMaterialsChanged = (message) => { setOcrNotice(typeof message === 'string' ? message : ''); onChanged?.(); };
  const repreparePoor = async () => {
    for (const file of poorFiles) {
      setOcrBulk(`正在用视觉模型重新识别「${file.name}」…`);
      try { await api(`/api/sessions/${session.id}/files/${file.id}/prepare`, 'POST', { force: true, preferVision: true }); }
      catch (error) { setOcrBulk(''); onError?.(error.message); return; }
    }
    setOcrBulk('');
    try {
      await api(`/api/sessions/${session.id}/record-refresh`, 'POST', { fileIds: poorFiles.map(file => file.id), reason: '视觉模型重新识别' });
      setOcrNotice(`已重新识别 ${poorFiles.length} 份资料，正在按新文本重新整理病历，完成后可在资料工作区查看更新提案。`);
      onChanged?.();
    } catch (error) { onError?.(`重新识别完成，但发起病历重新整理失败：${error.message}`); }
  };
  return <section className="patient-dashboard" aria-label="患者资料面板">
    <header className="chart-heading"><div><span className="eyebrow">患者档案</span><h2>{titles[view]}</h2><p>已保存的档案记录 · 更新于 {patient.updatedAt ? new Date(patient.updatedAt).toLocaleDateString('zh-CN') : '日期未记录'}</p></div>{!['overview','sources'].includes(view) && <button className="secondary" onClick={()=>setEditing(!editing)}>{editing ? '返回记录' : '核对与编辑'} <ArrowUpRight size={15}/></button>}</header>
    {editing ? <ClinicalPanel detail={patient} section={view} onChanged={onChanged} onError={onError}/> : <>
    {view === 'overview' && <nav className="chart-metrics" aria-label="档案内容导航">
      {[[Activity,'诊断与问题',diagnoses.length,'problems'],[Pill,'用药记录',meds.length,'medications'],[CalendarDays,'就诊记录',visits.length,'visits'],[FileText,'资料文件',files.length,'sources']].map(([Icon,label,count,id])=><a key={id} href={`#patient-${id}`} onClick={e=>{e.preventDefault();onClinical(id==='problems'?'diagnoses':id);}}><Icon size={18}/><span>{label}<b>{count}<small> 条</small></b></span></a>)}
    </nav>}
    {view === 'overview' && <div className="overview-brief" aria-label="患者近期概览">
      <section><h3>主要诊断</h3><p>{diagnoses.slice(0,3).map(d=>typeof d==='string'?d:d.name).join(' · ') || '尚未登记诊断'}</p><button className="text-button" onClick={()=>onClinical('diagnoses')}>查看完整诊断与病史</button></section>
      <section><h3>最近一次就诊</h3>{visitsSorted[0] ? <p>{visitsSorted[0].date || '日期未记录'} · {visitsSorted[0].reason}</p> : <p>尚无就诊记录</p>}<button className="text-button" onClick={()=>onClinical('visits')}>查看就诊经过</button></section>
      <section><h3>最近检验</h3>{groups.slice().sort((a,b)=>String(b.records.at(-1)?.date||'').localeCompare(String(a.records.at(-1)?.date||''))).slice(0,3).map(g=><p key={g.key}>{g.item} · {g.conflict ? '同日数值待核对' : `${g.records.at(-1)?.value} ${g.unit || '单位未记录'}`}<small> · {g.records.at(-1)?.date || '日期未记录'}</small></p>)}{!groups.length && <p>尚无检验记录</p>}<button className="text-button" onClick={()=>onClinical('labs')}>查看全部检验与趋势</button></section>
      <section><h3>用药与过敏核对</h3><p>{allergies.length ? '已有过敏记录，请留意。' : patient.allergyStatus==='none_known' ? '已核对：无已知过敏。' : '过敏史尚待核对。'}{meds.some(m=>!m.status||m.status==='unknown') ? '部分用药的当前使用状态待核对。' : !meds.length ? '尚无用药记录。' : '已登记用药，接诊时核对是否变化。'}</p><button className="text-button" onClick={()=>onClinical('medications')}>查看用药与过敏</button></section>
    </div>}
    {view === 'diagnoses' && <article className="chart-history" aria-label="病程概览"><h3>{patient.clinicalSummary ? '病史摘要' : '病程概览'}</h3>
      {patient.clinicalSummary ? <><p className="clinical-summary-text">{patient.clinicalSummary.text}</p><Source value={patient.clinicalSummary.source}/></> : <><small className="muted">按已保存的就诊记录排列；保留原有描述，不推断当前病情。</small>{history.length ? <ol className="history-overview">{history.map((v,i)=><li key={i}><time>{v.date || '日期未记录'}</time><p>{v.reason}</p><a href="#patient-visits" onClick={e=>{e.preventDefault();onClinical("visits");}}>查看就诊记录与补充说明</a></li>)}</ol> : <p>尚无可整理的就诊病程。请补充资料，诊断与用药记录仍可在下方查看。</p>}</>}
      {patient.note && <details className="chart-record-notes"><summary>资料备注与待核对信息</summary><p>{patient.note}</p></details>}
      {!!patient.tags?.length && <div className="chart-tags" aria-label="患者标签">{patient.tags.map(tag=><span key={tag}>{tag}</span>)}</div>}
    </article>}
    <div>
      {view === 'diagnoses' && <section id="chart-problems" className="chart-section" aria-label="诊断与问题"><header><h3>诊断与问题</h3><small>{diagnoses.length} 条记录</small></header>{diagnoses.length ? <ul className="chart-problems">{diagnoses.map((d,i)=><li key={i}><div><b>{typeof d==='string'?d:d.name}</b><small>{d.date || '日期未记录'}{d.code ? ` · ${d.code}` : ''}</small></div><Source value={d.source}/></li>)}</ul> : <p className="chart-empty">资料未明确提供诊断，待补充。</p>}</section>}
      {view === 'medications' && <section id="chart-medications" className="chart-section" aria-label="用药与过敏记录"><header><h3>用药与过敏</h3><small>{meds.length} 条用药</small></header><div className={`chart-allergies ${allergies.length ? 'recorded' : ''}`}><b>过敏史</b><p>{allergies.length ? allergies.map(a=>typeof a==='string'?a:[a.substance,a.reaction].filter(Boolean).join('：')).join('；') : patient.allergyStatus==='none_known' ? '已核对：无已知过敏' : '尚未核对'}</p></div>{meds.length ? <ul className="chart-meds">{meds.map((m,i)=><li key={i}><div className="chart-med-title"><b>{m.name}</b><span className={`chart-med-status ${m.status || 'unknown'}`}>{status[m.status] || status.unknown}</span></div><p>{[m.dose,m.frequency].filter(Boolean).join(' · ') || '剂量与频次未记录'}</p>{m.note && <p className="muted">{m.note}</p>}<Source value={m.source}/></li>)}</ul> : <p className="chart-empty">暂无用药记录，不代表未使用药物。</p>}</section>}
    </div>
    {view === 'labs' && <section className="chart-section chart-labs" aria-label="检验资料与趋势"><header><div><h3>检验资料与趋势</h3><p>同项目、同单位分别展示；趋势仅呈现记录，不自动判断正常或异常。</p></div><small>{patient.labs?.length || 0} 条检验</small></header>
      {group ? <><label className="chart-lab-picker">查看检验项目<select value={group.key} onChange={e=>setSelected(e.target.value)}>{groups.map(g=><option key={g.key} value={g.key}>{g.item} · {g.unit || '单位未记录'} · {g.records.length} 次</option>)}</select></label>
      <div className="chart-lab-summary"><b>{group.item}</b><span>{group.records.length} 次记录 · {group.unit || '单位未记录'}</span></div>
      {group.canPlot ? <LabPlot group={group}/> : <p className="chart-empty">{group.conflict ? '同日存在不同数值，暂不连线，请核对下方记录及来源。' : !group.unit ? '单位未记录，暂不绘制趋势。' : '有效日期不足两次，先展示已有记录。'}</p>}
      <div className="chart-table-wrap"><table><caption>{group.item} · 全部记录</caption><thead><tr><th>日期</th><th>结果</th><th>单位</th><th>来源</th></tr></thead><tbody>{group.records.toReversed().map((r,i)=><tr key={i}><td>{r.date || '日期未记录'}</td><td><b>{r.value}</b></td><td>{r.unit || '未记录'}</td><td>{r.source || '来源未记录'}</td></tr>)}</tbody></table></div></> : <p className="chart-empty">资料中尚无结构化检验记录。</p>}
    </section>}
    <div>
      {view === 'visits' && <section id="chart-visits" className="chart-section" aria-label="就诊时间轴"><header><h3>就诊时间轴</h3><small>按资料中的日期排列</small></header>{visits.length ? <ol className="chart-timeline">{visitsSorted.map((v,i)=><li key={i}><time>{v.date || '日期未记录'}</time><h4>{v.reason}</h4>{v.note && <p>{v.note}</p>}</li>)}</ol> : <p className="chart-empty">暂无就诊记录。</p>}</section>}
      {view === 'sources' && <section id="chart-sources" className="chart-section" aria-label="档案来源资料"><header><h3>来源资料</h3><button className="text-button" onClick={()=>onOpenWorkspace(session.id,{tab:'materials'})}>打开资料工作区</button></header>
      {!!reviewFiles.length && <div className={`ocr-review-banner ${poorFiles.length ? 'poor' : ''}`} role="status">
        <p><b>{poorFiles.length ? `${poorFiles.length} 份资料识别质量较低` : `${reviewFiles.length} 份资料识别待核对`}</b>：识别文字可能有缺字、错字或漏掉数值，会影响病历整理的准确性。建议对照原图核对，或用视觉模型重新识别。</p>
        <p className="muted">涉及：{reviewFiles.map(x => x.file.name).join('、')}</p>
        {visionSupported && !!poorFiles.length && <button className="secondary" disabled={!!ocrBulk} onClick={repreparePoor}>重新识别这 {poorFiles.length} 份并整理病历</button>}
        {!visionSupported && <small className="muted">当前模型不支持图片识别；在模型设置中更换为多模态（视觉）模型后可重新识别。</small>}
      </div>}
      {ocrBulk && <p role="status">{ocrBulk}</p>}
      {ocrNotice && <p role="status">{ocrNotice}</p>}
      <label className="chart-source-search">查找文件<input value={materialQuery} onChange={e=>setMaterialQuery(e.target.value)} placeholder="输入文件名"/></label><div className="chart-files">{files.filter(f=>f.name.toLowerCase().includes(materialQuery.toLowerCase())).map(file=><details key={file.id}><summary><FileText size={15}/><span>{file.name}</span></summary><MaterialDetails file={file} sessionId={session.id} visionSupported={visionSupported} onChanged={handleMaterialsChanged} onError={onError}/></details>)}</div>{!files.length && <p className="chart-empty">尚未关联资料文件。</p>}{!!files.length && !files.some(f=>f.name.toLowerCase().includes(materialQuery.toLowerCase())) && <p className="chart-empty">没有匹配的文件。</p>}</section>}
    </div>
    </>}
  </section>;
}
