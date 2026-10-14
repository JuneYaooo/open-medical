import { HabitSuggestion, SimilarCaseCard } from "./learning-loop";
import { useEffect, useMemo, useState } from 'react';
import { Activity, FileText, CalendarDays, Pill, ArrowUpRight } from 'lucide-react';
import { dashboardLabGroups, dashboardLabLayout, dashboardHistory } from '../shared/patient-dashboard.mjs';
import { groupDiagnoses, sortDiagnoses } from '../shared/diagnoses.mjs';
import { MATERIAL_CATEGORIES } from '../shared/material-classify.mjs';
import { groupMaterials } from '../shared/material-folder.mjs';
import { MaterialDetails, materialQualityLevel } from './material-details';
import { api } from './agent-runtime';
import './patient-dashboard.css';
import { ClinicalPanel } from './patient-clinical';
import { TreatmentPanel } from './patient-treatment';

function Source({ value }) {
  return value ? <details className="chart-source"><summary>资料来源</summary><p>{value}</p></details> : <small className="muted">来源未记录</small>;
}
// 从病程/诊断备注里提取引用的原文文件名（与「查看原文」跳转共用）。
export function citedFileName(text) {
  const m = String(text || '').match(/([^\s,，、;；:：()（）[\]【】「」《》"'']+\.(?:jpe?g|png|webp|pdf|txt|md|docx|xlsx))/i);
  return m ? m[1] : '';
}
function LabPlot({ group, compact = false }) {
  const points = group.points, values = points.map(p=>p.value);
  const dates = [...new Set(points.map(p=>p.date))].sort();
  const min = Math.min(...values), max = Math.max(...values), pad = (max-min || Math.abs(max) || 1)*.15;
  let low = min-pad, high = max+pad;
  if (min >= 0 && low < 0) low = 0; // 检验值不会为负，别让轴标签跑出负数
  let start=Date.parse(dates[0]), end=Date.parse(dates.at(-1));
  if (start===end) { start-=43200000; end+=43200000; } // 单日记录左右各留半天，散点才落得进坐标系
  const width = compact ? 420 : 700, right = width - 40;
  const x = p => 60 + (Date.parse(p.date)-start)/(end-start)*(right-60);
  const y = p => 150-(p.value-low)/(high-low)*115;
  const short = n => Number(n.toPrecision(compact ? 3 : 5)).toString();
  const unique = [...new Map(points.map(p=>[`${p.date}|${p.value}`,p])).values()];
  // 同日多值时不连线：并列数值之间没有先后，连了就是假趋势。
  const line = dates.length > 1 && !group.conflict;
  return <svg viewBox={`0 0 ${width} 194`} role="img" aria-label={`${group.item} ${group.unit || '单位未记录'} 检验趋势，${points.length} 次记录${line ? '' : '，散点展示'}`}>
    {[low,(low+high)/2,high].map((n,i)=><g key={i}><line x1="60" x2={right} y1={150-i*57.5} y2={150-i*57.5} stroke="var(--border)"/><text x="49" y={154-i*57.5} textAnchor="end">{short(n)}</text></g>)}
    {line && <polyline fill="none" stroke="var(--accent)" strokeWidth="2.5" points={unique.map(p=>`${x(p)},${y(p)}`).join(' ')} />}
    {unique.map((p,i)=><circle key={i} cx={x(p)} cy={y(p)} r="4" fill="var(--accent)"><title>{p.date}：{p.value} {group.unit || '单位未记录'}；{p.source || '来源未记录'}</title></circle>)}
    {dates.length > 1 ? <><text x="60" y="182">{dates[0]}</text><text x={right} y="182" textAnchor="end">{dates.at(-1)}</text></> : <text x={width/2} y="182" textAnchor="middle">{dates[0]}</text>}
  </svg>;
}
// 病史摘要常是一整段长文，按句切成约 2 句一段便于扫读；只加换行，不改文字本身。
function summaryParagraphs(text) {
  const out = [];
  for (const block of String(text || '').split(/\n+/)) {
    const sentences = block.match(/[^。！？]+[。！？]?/g) || [];
    let cur = '';
    for (const s of sentences) {
      if (cur && cur.length + s.length > 160) { out.push(cur); cur = s; } else cur += s;
    }
    if (cur) out.push(cur);
  }
  return out;
}
export function PatientDashboard({ patient, session, onClinical, onOpenWorkspace, view = "overview", focusFile = null, onChanged, onError }) {
  const [editing, setEditing] = useState(false);
  const titles = {overview:'患者概览',diagnoses:'诊断与病史',medications:'治疗方案与预后',labs:'检验趋势',visits:'就诊经过',library:'资料库'};
  const [display, setDisplay] = useState(patient.labDisplay || { revision: 0 });
  const [displayBusy, setDisplayBusy] = useState(false);
  const [materialQuery, setMaterialQuery] = useState('');
  const [visionSupported, setVisionSupported] = useState(false);
  const [ocrBulk, setOcrBulk] = useState('');
  const [ocrNotice, setOcrNotice] = useState('');
  const [monitors, setMonitors] = useState([]);
  const [monitorAlerts, setMonitorAlerts] = useState({});
  const [monitorForm, setMonitorForm] = useState(null);
  const [monitorBusy, setMonitorBusy] = useState(false);
  const groups = useMemo(()=>dashboardLabGroups(patient.labs || []),[patient.labs]);
  const [libraryFilter, setLibraryFilter] = useState('');
  const layout = dashboardLabLayout(patient.labs || [], display, monitors);
  const comparisonDates = [...new Set(layout.comparison.flatMap(g => g.records.map(r => r.date || '日期未记录')))].sort().reverse();
  const diagnoses=patient.diagnoses || [], meds=patient.medications || [], visits=patient.visits || [], allergies=patient.allergies || [];
  const history=dashboardHistory(patient);
  const files=session.files || [];
  const libraryGroups = useMemo(()=>groupMaterials(files),[files]);
  // 资料库视图 = 全部资料视图（0.9.109 起合并）：文件名搜索 + 按类型筛选一起作用。
  const shownGroups = (()=>{ const q=materialQuery.trim().toLowerCase(); return libraryGroups
    .map(g=>({...g,files:g.files.filter(f=>f.name.toLowerCase().includes(q))}))
    .filter(g=>g.files.length && (!libraryFilter || g.category === libraryFilter)); })();
  const visitsSorted=[...visits].sort((a,b)=>String(b.date || '').localeCompare(String(a.date || '')));
  useEffect(() => { api('/api/ocr-settings').then(s => setVisionSupported(s.imageCapable === true)).catch(() => {}); }, []);
  const loadMonitors = () => {
    api(`/api/patients/${patient.id}/lab-monitors`).then(s => setMonitors(s.monitors || [])).catch(() => {});
    api(`/api/risk-alerts?patientId=${patient.id}`).then(s => {
      const map = {};
      for (const alert of s.alerts || []) if (typeof alert.ruleKey === 'string' && alert.ruleKey.startsWith('lab_monitor_')) map[alert.ruleKey.slice('lab_monitor_'.length)] = alert;
      setMonitorAlerts(map);
    }).catch(() => {});
  };
  useEffect(() => { loadMonitors(); }, [patient.id]);
  useEffect(() => { setDisplay(patient.labDisplay || { revision: 0 }); }, [patient.id, patient.labDisplay]);
  const saveDisplay = async patch => {
    setDisplayBusy(true);
    try {
      const result = await api(`/api/patients/${patient.id}/lab-display`, 'PATCH', { expectedRevision: display.revision, ...patch });
      setDisplay(result.preferences);
      onChanged?.();
    } catch (error) {
      onError?.(error.message);
      try { const result = await api(`/api/patients/${patient.id}/lab-display`); setDisplay(result.preferences); } catch {}
    } finally { setDisplayBusy(false); }
  };
  const toggleDisplay = (field, key) => {
    const current = display[field] || (field === 'compare' ? groups.map(g => g.key) : []);
    saveDisplay({ [field]: current.includes(key) ? current.filter(k => k !== key) : [...current, key] });
  };
  const startMonitor = group => setMonitorForm({item: group.item, unit: group.unit || '', op: 'gt', threshold: '', recheckDays: '', severity: 'warning', note: ''});
  const submitMonitor = async (event) => {
    event.preventDefault();
    const threshold = Number(monitorForm.threshold);
    if (!Number.isFinite(threshold)) { onError?.('监测阈值须为数值'); return; }
    const recheck = monitorForm.recheckDays === '' || monitorForm.recheckDays === null ? null : Number(monitorForm.recheckDays);
    setMonitorBusy(true);
    try {
      await api(`/api/patients/${patient.id}/lab-monitors`, 'POST', { item: monitorForm.item, unit: monitorForm.unit, op: monitorForm.op, threshold, recheckDays: recheck, severity: monitorForm.severity, note: monitorForm.note });
      setMonitorForm(null);
      loadMonitors();
    } catch (error) { onError?.(error.message); } finally { setMonitorBusy(false); }
  };
  const toggleMonitor = async (monitor) => {
    try {
      await api(`/api/patients/${patient.id}/lab-monitors/${monitor.id}`, 'PATCH', { revision: monitor.revision, status: monitor.status === 'paused' ? 'active' : 'paused' });
      loadMonitors();
    } catch (error) { onError?.(error.message); }
  };
  const removeMonitor = async (monitor) => {
    try {
      await api(`/api/patients/${patient.id}/lab-monitors/${monitor.id}`, 'DELETE', { revision: monitor.revision });
      loadMonitors();
    } catch (error) { onError?.(error.message); }
  };
  const setFileMeta = async (file, patch) => {
    try {
      await api(`/api/sessions/${session.id}/files/${file.id}/meta`, 'PATCH', patch);
      onChanged?.();
    } catch (error) { onError?.(error.message); }
  };
  const reviewFiles = files.map(file => ({ file, level: materialQualityLevel(file) })).filter(x => x.level && x.level !== 'good');
  const poorCount = reviewFiles.filter(x => x.level === 'poor').length;
  const fairCount = reviewFiles.length - poorCount;
  // 统计评分对"页眉完整+正文乱码"的页面会误判良好，所以整批重识别覆盖全部
  // 图片材料，而不只是评分不佳的子集——乱码页恰恰藏在那批"良好"里。
  const imageFiles = files.filter(f => f.extraction && (f.extraction.type === 'image' ? f.extraction.artifactId : f.extraction.pageImages?.length));
  const handleMaterialsChanged = (message) => { setOcrNotice(typeof message === 'string' ? message : ''); onChanged?.(); };
  const reprepareFiles = async (targets, reason) => {
    for (const file of targets) {
      setOcrBulk(`正在用识别模型重新识别「${file.name}」…`);
      try { await api(`/api/sessions/${session.id}/files/${file.id}/prepare`, 'POST', { force: true, preferVision: true }); }
      catch (error) { setOcrBulk(''); onError?.(error.message); return; }
    }
    setOcrBulk('');
    try {
      await api(`/api/sessions/${session.id}/record-refresh`, 'POST', { fileIds: targets.map(file => file.id), reason });
      setOcrNotice(`已重新识别 ${targets.length} 份资料，正在按新文本重新整理病历，完成后可在资料工作区查看更新提案。`);
      onChanged?.();
    } catch (error) { onError?.(`重新识别完成，但发起病历重新整理失败：${error.message}`); }
  };
  const reprepareAll = () => reprepareFiles(imageFiles, '识别模型整批重新识别');
  return <section className="patient-dashboard" aria-label="患者资料面板">
    <header className="chart-heading"><div><span className="eyebrow">患者档案</span><h2>{titles[view]}</h2><p>已保存的档案记录 · 更新于 {patient.updatedAt ? new Date(patient.updatedAt).toLocaleDateString('zh-CN') : '日期未记录'}</p></div>{!['overview','library'].includes(view) && <button className="secondary" onClick={()=>setEditing(!editing)}>{editing ? '返回记录' : view === 'medications' ? '核对用药与过敏' : '核对与编辑'} <ArrowUpRight size={15}/></button>}</header>
    {editing ? <ClinicalPanel detail={patient} section={view} onChanged={onChanged} onError={onError}/> : <>
    {view === 'overview' && <><HabitSuggestion key={patient.id} patientId={patient.id} /><SimilarCaseCard key={`similar-${patient.id}`} patientId={patient.id} /></>}
    {view === 'overview' && <nav className="chart-metrics" aria-label="档案内容导航">
      {[[Activity,'诊断与问题',diagnoses.length,'problems'],[Pill,'用药记录',meds.length,'medications'],[CalendarDays,'就诊记录',visits.length,'visits'],[FileText,'资料文件',files.length,'library']].map(([Icon,label,count,id])=><a key={id} href={`#patient-${id}`} onClick={e=>{e.preventDefault();onClinical(id==='problems'?'diagnoses':id);}}><Icon size={18}/><span>{label}<b>{count}<small> 条</small></b></span></a>)}
    </nav>}
    {view === 'overview' && <div className="overview-brief" aria-label="患者近期概览">
      <section><h3>主要诊断</h3><p>{sortDiagnoses(diagnoses).slice(0,3).map(d=>typeof d==='string'?d:d.name).join(' · ') || '尚未登记诊断'}</p><button className="text-button" onClick={()=>onClinical('diagnoses')}>查看完整诊断与病史</button></section>
      <section><h3>最近一次就诊</h3>{visitsSorted[0] ? <p>{visitsSorted[0].date || '日期未记录'} · {visitsSorted[0].reason}</p> : <p>尚无就诊记录</p>}<button className="text-button" onClick={()=>onClinical('visits')}>查看就诊经过</button></section>
      <section><h3>最近检验</h3>{groups.slice().sort((a,b)=>String(b.records.at(-1)?.date||'').localeCompare(String(a.records.at(-1)?.date||''))).slice(0,3).map(g=><p key={g.key}>{g.item} · {g.conflict ? '同日数值待核对' : `${g.records.at(-1)?.value} ${g.unit || '单位未记录'}`}<small> · {g.records.at(-1)?.date || '日期未记录'}</small></p>)}{!groups.length && <p>尚无检验记录</p>}<button className="text-button" onClick={()=>onClinical('labs')}>查看全部检验与趋势</button></section>
      <section><h3>用药与过敏核对</h3><p>{allergies.length ? '已有过敏记录，请留意。' : patient.allergyStatus==='none_known' ? '已核对：无已知过敏。' : '过敏史尚待核对。'}{meds.some(m=>!m.status||m.status==='unknown') ? '部分用药的当前使用状态待核对。' : !meds.length ? '尚无用药记录。' : '已登记用药，接诊时核对是否变化。'}</p><button className="text-button" onClick={()=>onClinical('medications')}>查看治疗方案与预后</button></section>
    </div>}
    {view === 'diagnoses' && <article className="chart-history" aria-label="病程概览"><h3>{patient.clinicalSummary ? '病史摘要' : '病程概览'}</h3>
      {patient.clinicalSummary ? <>{summaryParagraphs(patient.clinicalSummary.text).map((p,i)=><p key={i} className="clinical-summary-text">{p}</p>)}<Source value={patient.clinicalSummary.source}/></> : <><small className="muted">按已保存的就诊记录排列；保留原有描述，不推断当前病情。</small>{history.length ? <ol className="history-overview">{history.map((v,i)=><li key={i}><time>{v.date || '日期未记录'}</time><p>{v.reason}</p><a href="#patient-visits" onClick={e=>{e.preventDefault();onClinical("visits");}}>查看就诊记录与补充说明</a></li>)}</ol> : <p>尚无可整理的就诊病程。请补充资料，诊断与用药记录仍可在下方查看。</p>}</>}
      {patient.note && <details className="chart-record-notes"><summary>资料备注与待核对信息</summary><p>{patient.note}</p></details>}
      {!!patient.tags?.length && <div className="chart-tags" aria-label="患者标签">{patient.tags.map(tag=><span key={tag}>{tag}</span>)}</div>}
    </article>}
    <div>
      {view === 'diagnoses' && <section id="chart-problems" className="chart-section" aria-label="诊断与问题"><header><h3>诊断与问题</h3><small>{diagnoses.length} 条记录</small></header>
        {diagnoses.length ? groupDiagnoses(diagnoses).map(group=><div key={group.status} className="chart-problem-group">
          <h4>{group.label}<small>{group.items.length} 条</small></h4>
          <ul className="chart-problems">{group.items.map((d,i)=><li key={i}>
            <div><b>{typeof d==='string'?d:d.name}</b>{typeof d!=='string' && (!!d.date || !!d.code) && <small>{[d.date || '日期未记录', d.code].filter(Boolean).join(' · ')}</small>}</div>
            {typeof d!=='string' && d.note && <p className="chart-problem-note">{d.note}</p>}
            {typeof d!=='string' && <Source value={(d.sources?.length ? d.sources : [d.source].filter(Boolean)).join('；')}/>}
          </li>)}</ul>
        </div>) : <p className="chart-empty">资料未明确提供诊断，待补充。</p>}
      </section>}
      {view === 'medications' && <TreatmentPanel patient={patient} groups={groups} Plot={LabPlot} onEditMedications={()=>setEditing(true)} onNavigate={onClinical} onChanged={onChanged}/>}
    </div>
    {view === 'labs' && <section className="chart-section chart-labs" aria-label="检验资料与趋势"><header><div><h3>检验资料与趋势</h3><p>同项目、同单位分别展示；趋势仅呈现记录，不自动判断正常或异常。</p></div><small>{patient.labs?.length || 0} 条检验</small></header>
      <div className="chart-display-toolbar">
        <p>默认展示全部指标，监测项目、同日数值冲突和多次检验优先。可以对 AI 说“把血红蛋白放前面，折叠其余指标”。</p>
        <button className="secondary" onClick={()=>onOpenWorkspace(session.id, {draft: `请帮我调整当前患者的检验趋势展示习惯（患者 ID：${patient.id}）。先读取当前展示偏好和指标，我想调整：`})}>和 AI 调整展示</button>
        <button className="text-button" disabled={displayBusy} onClick={()=>saveDisplay({reset:true})}>恢复默认展示</button>
      </div>
      {!!layout.comparison.length && <div className="chart-table-wrap chart-lab-comparison"><table>
        <caption>检验结果对照 · {layout.comparison.length} 项</caption>
        <thead><tr><th>检验项目 / 单位</th>{comparisonDates.map(date=><th key={date}>{date}</th>)}</tr></thead>
        <tbody>{layout.comparison.map(g=><tr key={g.key}><th>{g.item}<small>{g.unit || '单位未记录'}</small></th>{comparisonDates.map(date=>{
          const records = g.records.filter(r=>(r.date || '日期未记录') === date);
          return <td key={date} title={records.map(r=>r.source || '来源未记录').join('；')}>{records.length ? records.map(r=>r.value).join(' / ') : '—'}</td>;
        })}</tr>)}</tbody>
      </table></div>}
      <div className="chart-lab-grid">{layout.visible.map(group=>{
        const collapsed = layout.collapsed.has(group.key);
        const latest = group.records.at(-1);
        return <article className="chart-lab-card" key={group.key} aria-label={`${group.item} ${group.unit || '单位未记录'}`}>
          <header><div><h4>{group.item}</h4><small>{group.unit || '单位未记录'} · {group.records.length} 次记录</small></div>
            <div className="chart-lab-latest"><b>{group.conflict ? '数值待核对' : latest?.value}</b><small>{latest?.date || '日期未记录'}</small></div>
          </header>
          <div className="chart-lab-actions">
            <button className="text-button" disabled={displayBusy} onClick={()=>saveDisplay({order:[group.key, ...layout.groups.map(g=>g.key).filter(k=>k!==group.key)]})}>排在最前</button>
            <button className="text-button" disabled={displayBusy} aria-pressed={layout.comparison.some(g=>g.key===group.key)} onClick={()=>toggleDisplay('compare',group.key)}>{layout.comparison.some(g=>g.key===group.key) ? '移出对照' : '加入对照'}</button>
            <button className="text-button" disabled={displayBusy} aria-expanded={!collapsed} onClick={()=>toggleDisplay('collapsed',group.key)}>{collapsed ? '展开趋势' : '折叠趋势'}</button>
            <button className="text-button" disabled={displayBusy} onClick={()=>toggleDisplay('hidden',group.key)}>隐藏</button>
            <button className="text-button" onClick={()=>startMonitor(group)}>设监测</button>
          </div>
          {!collapsed && <>
            {group.canPlot ? <LabPlot group={group}/> : <p className="chart-empty">缺少有效日期或数值，请核对明细。</p>}
            {group.conflict && <p className="chart-lab-hint">同一天存在不同数值，散点并列、暂不连线，请核对记录及来源。</p>}
            {group.distinctDates === 1 && <p className="chart-lab-hint">目前只有一天的记录，还连不成趋势线。</p>}
            {!group.unit && <p className="chart-lab-hint">单位未记录，纵轴只表示数值相对高低。</p>}
            <details className="chart-lab-records"><summary>全部记录与来源 · {group.records.length} 条</summary><div className="chart-table-wrap"><table><caption>{group.item} · 全部记录</caption><thead><tr><th>日期</th><th>结果</th><th>单位</th><th>来源</th></tr></thead><tbody>{group.records.toReversed().map((r,i)=><tr key={i}><td>{r.date || '日期未记录'}</td><td><b>{r.value}</b></td><td>{r.unit || '未记录'}</td><td>{r.source || '来源未记录'}</td></tr>)}</tbody></table></div></details>
          </>}
        </article>;
      })}</div>
      {!!layout.hidden.length && <details className="chart-hidden-labs"><summary>已隐藏 {layout.hidden.length} 项检验 · 展开后可恢复</summary>{layout.hidden.map(g=><div key={g.key}><span>{g.item} · {g.unit || '单位未记录'}</span><button className="text-button" disabled={displayBusy} onClick={()=>toggleDisplay('hidden',g.key)}>恢复展示</button></div>)}</details>}
      {!groups.length && <p className="chart-empty">资料中尚无结构化检验记录。</p>}
      {(!!groups.length || !!monitors.length) && <div className="chart-monitors" aria-label="个性化检验监测">
        <header><div><h4>个性化监测</h4><p>在指标上点“设监测”可设阈值或复查间隔；越界或到期进入今日待办的风险提示。隐藏指标不影响监测。</p></div></header>
        {monitorForm && <form className="chart-monitor-form" onSubmit={submitMonitor}>
          <div className="chart-monitor-row"><b>{monitorForm.item}</b><label>条件<select value={monitorForm.op} onChange={e=>setMonitorForm({...monitorForm, op: e.target.value})}><option value="gt">高于</option><option value="lt">低于</option></select></label>
          <label>阈值<input type="number" step="any" required value={monitorForm.threshold} onChange={e=>setMonitorForm({...monitorForm, threshold: e.target.value})}/><span>{monitorForm.unit || '单位未记录'}</span></label>
          <label>复查间隔（天，可选）<input type="number" min="1" max="3650" value={monitorForm.recheckDays} onChange={e=>setMonitorForm({...monitorForm, recheckDays: e.target.value})}/></label>
          <label>严重度<select value={monitorForm.severity} onChange={e=>setMonitorForm({...monitorForm, severity: e.target.value})}><option value="warning">提醒</option><option value="critical">重要</option></select></label>
          <label>备注<input value={monitorForm.note} maxLength={200} onChange={e=>setMonitorForm({...monitorForm, note: e.target.value})}/></label></div>
          <div className="chart-monitor-actions"><button className="primary" type="submit" disabled={monitorBusy}>保存并开始监测</button><button className="text-button" type="button" onClick={()=>setMonitorForm(null)}>取消</button></div>
        </form>}
        {!!monitors.length && <ul className="chart-monitor-list">{monitors.map(m => {
          const alert = monitorAlerts[m.id];
          return <li key={m.id}>
            <b>{m.item}</b><span>{m.op === 'gt' ? '高于' : '低于'} {m.threshold}{m.unitHint || ''}</span>
            {!!m.recheckDays && <span>每 {m.recheckDays} 天复查</span>}
            <span className={`chart-monitor-sev ${m.severity}`}>{m.severity === 'critical' ? '重要' : '提醒'}</span>
            {m.status === 'paused' ? <span className="chart-monitor-state paused">已暂停</span> : alert && alert.status !== 'resolved' ? <span className="chart-monitor-state fired">已触发 · 见今日待办</span> : <span className="chart-monitor-state">监测中</span>}
            {m.note && <small className="muted">{m.note}</small>}
            <span className="chart-monitor-actions"><button className="text-button" onClick={()=>toggleMonitor(m)}>{m.status === 'paused' ? '恢复' : '暂停'}</button><button className="text-button danger" onClick={()=>removeMonitor(m)}>删除</button></span>
          </li>;
        })}</ul>}
        {!monitors.length && !monitorForm && <p className="muted">尚未设置个性化监测。内置的通用风险规则不受影响，始终生效。</p>}
      </div>}
    </section>}
    <div>
      {view === 'visits' && <section id="chart-visits" className="chart-section" aria-label="就诊时间轴"><header><h3>就诊时间轴</h3><small>按资料中的日期排列</small></header>{visits.length ? <ol className="chart-timeline">{visitsSorted.map((v,i)=>{
        const cited = citedFileName(v.note) || citedFileName(v.reason);
        const target = cited && files.find(f => f.name.toLowerCase() === cited.toLowerCase());
        return <li key={i}><time>{v.date || '日期未记录'}</time><h4>{v.reason}</h4>{v.note && <p>{v.note}</p>}{target && <button className="text-button" onClick={()=>onClinical('library', { focusFile: target.id })}>查看原文 {target.name}</button>}</li>;
      })}</ol> : <p className="chart-empty">暂无就诊记录。</p>}</section>}
      {view === 'library' && <section id="chart-library" className="chart-section chart-library" aria-label="资料库">
        <header><div><h3>资料库</h3><p>提取资料时自动按类型归类；点开资料可以修改类型与日期。</p></div><button className="text-button" onClick={()=>onOpenWorkspace(session.id,{tab:'materials'})}>打开资料工作区</button><small>{files.length} 份资料</small></header>
        {!!reviewFiles.length && <div className={`ocr-review-banner ${poorCount ? 'poor' : ''}`} role="status">
          <p><b>{poorCount && fairCount ? `${poorCount} 份资料识别质量较低、${fairCount} 份待核对` : poorCount ? `${poorCount} 份资料识别质量较低` : `${fairCount} 份资料识别待核对`}</b>：识别文字可能有缺字、错字或漏掉数值，会影响病历整理的准确性。建议对照原图核对，或用视觉模型重新识别。</p>
          <p className="muted">涉及：{reviewFiles.map(x => x.file.name).join('、')}</p>
          {visionSupported && !!imageFiles.length && <button className="secondary" disabled={!!ocrBulk} onClick={reprepareAll}>用识别模型重新识别全部 {imageFiles.length} 份并整理病历</button>}
          {!visionSupported && <small className="muted">暂无可用的图片识别模型；可在模型设置中勾选「此模型支持图片」，或在「文字识别（OCR）」中配置专用识别模型。</small>}
        </div>}
        {ocrBulk && <p role="status">{ocrBulk}</p>}
        {ocrNotice && <p role="status">{ocrNotice}</p>}
        <label className="chart-source-search">查找文件<input value={materialQuery} onChange={e=>setMaterialQuery(e.target.value)} placeholder="输入文件名"/></label>
        {libraryGroups.length > 1 && <nav className="library-filter" aria-label="按类型筛选">
          <button className={!libraryFilter ? 'active' : ''} onClick={()=>setLibraryFilter('')}>全部 {files.length}</button>
          {libraryGroups.map(g=><button key={g.category} className={libraryFilter === g.category ? 'active' : ''} onClick={()=>setLibraryFilter(libraryFilter === g.category ? '' : g.category)}>{g.category} {g.count}</button>)}
        </nav>}
        {shownGroups.map(g=><div className="library-group" key={g.category}>
          <header><h4>{g.category}<small>{g.files.length} 份{g.dateRange ? ` · ${g.dateRange}` : ''}</small></h4>
          {g.category === '检验报告' && !!groups.length && <div className="library-lab-strip">
            {groups.slice().sort((a,b)=>String(b.records.at(-1)?.date||'').localeCompare(String(a.records.at(-1)?.date||''))).slice(0,4).map(lab=><span key={lab.key}>{lab.item} · {lab.conflict ? '待核对' : `${lab.records.at(-1)?.value} ${lab.unit || ''}`}<small> {lab.records.at(-1)?.date || ''}</small></span>)}
            <button className="text-button" onClick={()=>onClinical('labs')}>查看全部检验与趋势</button>
          </div>}
          </header>
          <div className="chart-files">{g.files.map(file=><details key={file.id} open={focusFile ? focusFile === file.id : undefined} ref={el => { if (focusFile === file.id) el?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>
            <summary>
              <FileText size={15}/><span>{file.name}</span>
              <span className={`lib-cat ${file.categorySource === 'auto' ? 'guess' : 'confirmed'}`}>{file.category || '未分类'}{file.categorySource === 'auto' ? '（自动）' : ''}</span>
              {!!file.documentDate && <small>{file.documentDate}</small>}
              {(() => { const level = materialQualityLevel(file); return level ? <span className={`ocr-badge ${level}`}>{level === 'good' ? '识别良好' : level === 'fair' ? '识别待核对' : '识别质量低'}</span> : null; })()}
            </summary>
            <div className="library-meta-editor">
              <label>类型
                <select value={file.category || ''} onChange={e=>setFileMeta(file, { category: e.target.value })}>
                  <option value="">未分类</option>
                  {MATERIAL_CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              {!!file.categorySuggestion && file.categorySuggestion.category !== file.category && <button className="text-button" onClick={()=>setFileMeta(file, { category: file.categorySuggestion.category })}>采纳推测「{file.categorySuggestion.category}」{file.categorySuggestion.reason ? `（${file.categorySuggestion.reason}）` : ''}</button>}
              <label>资料日期
                <input type="date" value={file.documentDate || ''} onChange={e=>setFileMeta(file, { documentDate: e.target.value })}/>
              </label>
              {!!file.dateSuggestion && file.dateSuggestion !== file.documentDate && <button className="text-button" onClick={()=>setFileMeta(file, { documentDate: file.dateSuggestion })}>采纳推测 {file.dateSuggestion}</button>}
            </div>
            <MaterialDetails file={file} sessionId={session.id} visionSupported={visionSupported} onChanged={handleMaterialsChanged} onError={onError}/>
          </details>)}</div>
        </div>)}
        {!files.length && <p className="chart-empty">尚未关联资料文件。先在资料工作区或聊天上传资料，识别完成后会自动归类。</p>}
        {!!files.length && !shownGroups.length && <p className="chart-empty">{materialQuery.trim() ? '没有匹配的文件。' : '该类型下暂无资料。'}</p>}
      </section>}
    </div>
    </>}
  </section>;
}
