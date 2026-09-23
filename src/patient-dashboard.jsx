import { useMemo, useState } from 'react';
import { Activity, FileText, CalendarDays, Pill, ArrowUpRight } from 'lucide-react';
import { dashboardLabGroups, dashboardHistory } from '../shared/patient-dashboard.mjs';
import { MaterialDetails } from './material-details';
import './patient-dashboard.css';

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
export function PatientDashboard({ patient, session, onClinical, onOpenWorkspace }) {
  const [selected, setSelected] = useState('');
  const [materialQuery, setMaterialQuery] = useState('');
  const groups = useMemo(()=>dashboardLabGroups(patient.labs || []),[patient.labs]);
  const group = groups.find(g=>g.key===selected) || groups.find(g=>g.canPlot) || groups[0];
  const diagnoses=patient.diagnoses || [], meds=patient.medications || [], visits=patient.visits || [], allergies=patient.allergies || [];
  const history=dashboardHistory(patient);
  const files=session.files || [];
  const visitsSorted=[...visits].sort((a,b)=>String(b.date || '').localeCompare(String(a.date || '')));
  const status={active:'正在使用',stopped:'已停用',unknown:'状态待核对'};
  return <section className="patient-dashboard" aria-label="患者资料面板">
    <header className="chart-heading"><div><span className="eyebrow">患者档案</span><h2>患者资料总览</h2><p>已确认的病史与检查资料 · 更新于 {patient.updatedAt ? new Date(patient.updatedAt).toLocaleDateString('zh-CN') : '日期未记录'}</p></div><button className="secondary" onClick={onClinical}>核对与编辑资料 <ArrowUpRight size={15}/></button></header>
    <nav className="chart-metrics" aria-label="档案内容导航">
      {[[Activity,'诊断与问题',diagnoses.length,'problems'],[Pill,'用药记录',meds.length,'medications'],[CalendarDays,'就诊记录',visits.length,'visits'],[FileText,'资料文件',files.length,'sources']].map(([Icon,label,count,id])=><a key={id} href={`#chart-${id}`}><Icon size={18}/><span>{label}<b>{count}<small> 条</small></b></span></a>)}
    </nav>
    <article className="chart-history" aria-label="病程概览"><h3>{patient.clinicalSummary ? '病史摘要' : '病程概览'}</h3>
      {patient.clinicalSummary ? <><p className="clinical-summary-text">{patient.clinicalSummary.text}</p><Source value={patient.clinicalSummary.source}/></> : <><small className="muted">按已保存的就诊记录排列；保留原有描述，不推断当前病情。</small>{history.length ? <ol className="history-overview">{history.map((v,i)=><li key={i}><time>{v.date || '日期未记录'}</time><p>{v.reason}</p><a href="#chart-visits">查看就诊记录与补充说明</a></li>)}</ol> : <p>尚无可整理的就诊病程。请补充资料，诊断与用药记录仍可在下方查看。</p>}</>}
      {patient.note && <details className="chart-record-notes"><summary>资料备注与待核对信息</summary><p>{patient.note}</p></details>}
      {!!patient.tags?.length && <div className="chart-tags" aria-label="患者标签">{patient.tags.map(tag=><span key={tag}>{tag}</span>)}</div>}
    </article>
    <div className="chart-columns">
      <section id="chart-problems" className="chart-section" aria-label="诊断与问题"><header><h3>诊断与问题</h3><small>{diagnoses.length} 条记录</small></header>{diagnoses.length ? <ul className="chart-problems">{diagnoses.map((d,i)=><li key={i}><div><b>{typeof d==='string'?d:d.name}</b><small>{d.date || '日期未记录'}{d.code ? ` · ${d.code}` : ''}</small></div><Source value={d.source}/></li>)}</ul> : <p className="chart-empty">资料未明确提供诊断，待补充。</p>}</section>
      <section id="chart-medications" className="chart-section" aria-label="用药与过敏记录"><header><h3>用药与过敏</h3><small>{meds.length} 条用药</small></header><div className={`chart-allergies ${allergies.length ? 'recorded' : ''}`}><b>过敏史</b><p>{allergies.length ? allergies.map(a=>typeof a==='string'?a:[a.substance,a.reaction].filter(Boolean).join('：')).join('；') : patient.allergyStatus==='none_known' ? '已核对：无已知过敏' : '尚未核对'}</p></div>{meds.length ? <ul className="chart-meds">{meds.map((m,i)=><li key={i}><div className="chart-med-title"><b>{m.name}</b><span className={`chart-med-status ${m.status || 'unknown'}`}>{status[m.status] || status.unknown}</span></div><p>{[m.dose,m.frequency].filter(Boolean).join(' · ') || '剂量与频次未记录'}</p>{m.note && <p className="muted">{m.note}</p>}<Source value={m.source}/></li>)}</ul> : <p className="chart-empty">暂无用药记录，不代表未使用药物。</p>}</section>
    </div>
    <section className="chart-section chart-labs" aria-label="检验资料与趋势"><header><div><h3>检验资料与趋势</h3><p>同项目、同单位分别展示；趋势仅呈现记录，不自动判断正常或异常。</p></div><small>{patient.labs?.length || 0} 条检验</small></header>
      {group ? <><label className="chart-lab-picker">查看检验项目<select value={group.key} onChange={e=>setSelected(e.target.value)}>{groups.map(g=><option key={g.key} value={g.key}>{g.item} · {g.unit || '单位未记录'} · {g.records.length} 次</option>)}</select></label>
      <div className="chart-lab-summary"><b>{group.item}</b><span>{group.records.length} 次记录 · {group.unit || '单位未记录'}</span></div>
      {group.canPlot ? <LabPlot group={group}/> : <p className="chart-empty">{group.conflict ? '同日存在不同数值，暂不连线，请核对下方记录及来源。' : !group.unit ? '单位未记录，暂不绘制趋势。' : '有效日期不足两次，先展示已有记录。'}</p>}
      <div className="chart-table-wrap"><table><caption>{group.item} · 全部记录</caption><thead><tr><th>日期</th><th>结果</th><th>单位</th><th>来源</th></tr></thead><tbody>{group.records.toReversed().map((r,i)=><tr key={i}><td>{r.date || '日期未记录'}</td><td><b>{r.value}</b></td><td>{r.unit || '未记录'}</td><td>{r.source || '来源未记录'}</td></tr>)}</tbody></table></div></> : <p className="chart-empty">资料中尚无结构化检验记录。</p>}
    </section>
    <div className="chart-columns chart-bottom">
      <section id="chart-visits" className="chart-section" aria-label="就诊时间轴"><header><h3>就诊时间轴</h3><small>按资料中的日期排列</small></header>{visits.length ? <ol className="chart-timeline">{visitsSorted.map((v,i)=><li key={i}><time>{v.date || '日期未记录'}</time><h4>{v.reason}</h4>{v.note && <p>{v.note}</p>}</li>)}</ol> : <p className="chart-empty">暂无就诊记录。</p>}</section>
      <section id="chart-sources" className="chart-section" aria-label="档案来源资料"><header><h3>来源资料</h3><button className="text-button" onClick={()=>onOpenWorkspace(session.id,{tab:'materials'})}>打开资料工作区</button></header><label className="chart-source-search">查找文件<input value={materialQuery} onChange={e=>setMaterialQuery(e.target.value)} placeholder="输入文件名"/></label><div className="chart-files">{files.filter(f=>f.name.toLowerCase().includes(materialQuery.toLowerCase())).map(file=><details key={file.id}><summary><FileText size={15}/><span>{file.name}</span></summary><MaterialDetails file={file} sessionId={session.id}/><details><summary>查看文字内容</summary><pre>{file.text || '暂无可读取文字'}</pre></details></details>)}</div>{!files.length && <p className="chart-empty">尚未关联资料文件。</p>}{!!files.length && !files.some(f=>f.name.toLowerCase().includes(materialQuery.toLowerCase())) && <p className="chart-empty">没有匹配的文件。</p>}</section>
    </div>
  </section>;
}
