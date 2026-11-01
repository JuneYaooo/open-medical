import { useRef, useState } from 'react';
import { Activity, ArrowUpRight, CalendarDays, Check, ClipboardList, Plus, Pill, ShieldAlert } from 'lucide-react';
import { api } from './agent-runtime';
import { useClinicalDraft } from './clinical-drafts';
import { usePluginActive } from './plugin-slots';
import { localCalendarDate, isCalendarDate } from '../shared/calendar-date.mjs';
import { diagnosisSources } from '../shared/diagnoses.mjs';
import './patient-treatment.css';

const medicationStates = { active: '正在使用', unknown: '未记录状态', stopped: '已停用' };
const planStates = { active: '进行中', paused: '已暂停', completed: '已完成' };
const emptyPlan = { title: '', goal: '', interventions: '', startDate: '', reviewDate: '', status: 'active', prognosis: '', assessmentDate: '', source: '' };

export function TreatmentPanel({ patient, groups, Plot, onEditMedications, onNavigate, onChanged, files = [], followups = [], citedFileName = () => null }) {
  const followupActive = usePluginActive("followup");
  const plan = patient.treatmentPlan;
  const reviewReminder = followups.find(job => job.source?.kind === 'treatment-review' && job.source.reviewDate === plan?.reviewDate);
  const interventions = (plan?.interventions || '').split('\n').filter(line => line.trim());
  const [editor, setEditor] = useClinicalDraft(patient.id, "treatmentPlan", null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(null);
  const [choices, setChoices] = useState({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [filter, setFilter] = useState(() => patient.medications?.some(m => m.status === 'active') ? 'active' : 'all');
  const [metric, setMetric] = useState('');
  const meds = patient.medications || [];
  const sourceFiles = source => {
    const name = citedFileName(source) || source;
    return files.filter(file => file.name.toLocaleLowerCase() === String(name).trim().toLocaleLowerCase());
  };
  const allergies = patient.allergies || [];
  const counts = Object.fromEntries(Object.keys(medicationStates).map(state => [state, meds.filter(m => (m.status || 'unknown') === state).length]));
  const visibleMeds = meds.filter(m => filter === 'all' || (m.status || 'unknown') === filter);
  const plottedGroups = groups.filter(g => g.canPlot);
  const group = plottedGroups.find(g => g.key === metric) || plottedGroups[0];
  const latest = group?.points.at(-1);
  const today = localCalendarDate();
  const due = plan?.status === 'active' && plan?.reviewDate && plan.reviewDate <= today;
  const openEditor = () => { setEditor(editor || { ...emptyPlan, ...plan, _revision:patient.revision }); setError(''); setNotice(''); };
  const save = async event => {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError('');
    try {
      const { _revision, ...treatmentPlan } = editor;
      await api(`/api/patients/${patient.id}`, 'PATCH', { expectedRevision: _revision, treatmentPlan });
      await onChanged?.();
      setEditor(null); setNotice('治疗方案已保存');
    } catch (err) {
      setError(err.message);
      if (err.code === 'REVISION_CONFLICT') {
        try { const latestPatient = await api(`/api/patients/${patient.id}`); setConflict(latestPatient); setChoices({}); }
        catch (loadError) { setError(`${err.message}；加载最新档案失败：${loadError.message}`); }
      }
    }
    finally { saving.current = false; setBusy(false); }
  };
  const reconcile = async () => {
    const next = { ...editor, _revision:conflict.revision };
    for (const key of Object.keys(emptyPlan)) if (choices[key] === 'latest') next[key] = conflict.treatmentPlan?.[key] ?? emptyPlan[key];
    setEditor(next); setConflict(null); setError(''); setNotice('已保留选择的草稿，请核对后再次保存。');
    await onChanged?.();
  };
  const field = key => ({ value: editor[key], onChange: event => setEditor({ ...editor, [key]: event.target.value }) });
  return <div className="treatment-workspace">
    <div className={`treatment-allergy ${allergies.length ? 'has-allergy' : patient.allergyStatus === 'none_known' ? '' : 'is-unknown'}`}>
      {!!allergies.length && <ShieldAlert size={19}/>}<div><b>过敏史</b><span>{allergies.length ? allergies.map(a => typeof a === 'string' ? a : [a.substance, a.reaction].filter(Boolean).join('：')).join('；') : patient.allergyStatus === 'none_known' ? '无已知过敏' : '未记录'}</span></div>
      <button className="text-button" onClick={onEditMedications}>{allergies.length || patient.allergyStatus === 'none_known' ? '编辑过敏史' : '补充过敏史'} <ArrowUpRight size={14}/></button>
    </div>
    {notice && <p className="treatment-notice" role="status"><Check size={16}/>{notice}</p>}
    <div className="treatment-summary" aria-label="治疗概况">
      <div><span>当前用药</span><strong>{counts.active}<small>种</small></strong><span>{counts.unknown ? `${counts.unknown} 种用药状态未记录` : '按已保存的用药记录'}</span></div>
      <div><span>治疗阶段</span><strong>{plan ? planStates[plan.status] : '待建立'}</strong><span>{plan?.startDate ? `${plan.startDate} 开始` : '记录目标与干预措施'}</span></div>
      <div><span>下次复评</span><strong className={due ? 'is-due' : ''}>{plan?.reviewDate || '待安排'}</strong><span>{due ? '已到复评日期，请核对进展' : '结合疗效与耐受情况复评'}</span></div>
    </div>
    {editor && <form className="treatment-editor" onSubmit={save} aria-label="编辑治疗方案">
      <header><div><h3>{plan ? '编辑治疗方案' : '建立治疗方案'}</h3></div></header>
      <fieldset disabled={busy || patient.archived}>
        <div className="treatment-form-grid">
          <label className="wide">方案名称<input autoFocus required maxLength={120} placeholder="例如：本阶段治疗与康复计划" {...field('title')}/></label>
          <label>治疗阶段<select {...field('status')}>{Object.entries(planStates).map(([id,label]) => <option value={id} key={id}>{label}</option>)}</select></label>
          <label>开始日期<input type="date" {...field('startDate')}/></label>
          <label>下次复评日期<input type="date" min={editor.startDate || undefined} {...field('reviewDate')}/></label>
          <label className="wide">治疗目标<textarea rows={2} maxLength={2000} placeholder="记录本阶段希望改善的问题与目标" {...field('goal')}/></label>
          <label className="wide">治疗与干预<textarea rows={3} maxLength={4000} placeholder="记录治疗、康复、生活方式干预及注意事项；每行一项" {...field('interventions')}/></label>
          <label className="wide">预后与疗效评估<textarea rows={3} maxLength={2000} placeholder="记录已观察的变化、耐受情况与医生评估" {...field('prognosis')}/></label>
          <label>评估日期<input type="date" required={!!editor.prognosis.trim()} {...field('assessmentDate')}/></label>
          <label className="source-field">记录来源<input maxLength={200} placeholder="例如：复诊记录、医生评估" {...field('source')}/></label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {conflict && <section aria-label="方案版本核对" className="plan-conflict">
          <h4>最新档案与本地草稿</h4><p>已加载版本 {conflict.revision}。逐项选择要保留的内容，确认后仍需点击保存方案。</p>
          {Object.entries({title:'方案名称',goal:'治疗目标',interventions:'治疗与干预',startDate:'开始日期',reviewDate:'复评日期',status:'治疗阶段',prognosis:'疗效评估',assessmentDate:'评估日期',source:'记录来源'}).map(([key,label])=><div key={key}><b>{label}</b><p>最新：{(key === 'status' ? planStates[conflict.treatmentPlan?.[key]] : conflict.treatmentPlan?.[key]) || '未记录'}</p><p>草稿：{(key === 'status' ? planStates[editor[key]] : editor[key]) || '未记录'}</p><label>{label}保留版本<select value={choices[key] || 'local'} onChange={e=>setChoices({...choices,[key]:e.target.value})}><option value="local">保留本地草稿</option><option value="latest">采用最新记录</option></select></label></div>)}
          <button type="button" onClick={reconcile}>确认选择并继续编辑</button>
        </section>}
        <footer><span>用药剂量与频次在用药记录中单独核对。</span><button type="button" className="secondary" onClick={()=>{setEditor(null);setConflict(null);}}>取消</button><button type="submit" className="primary" disabled={!!conflict}>{busy ? '正在保存…' : '保存方案'}</button></footer>
      </fieldset>
    </form>}
    <div className="treatment-grid">
      <div className="treatment-main">
        <section className="treatment-card" aria-label="用药管理">
          <header><div><h3>用药管理 <small>{meds.length} 种记录</small></h3></div><button className="text-button" onClick={onEditMedications}>管理用药 <ArrowUpRight size={15}/></button></header>
          <div className="treatment-filters" aria-label="筛选用药状态">{[['active',`正在使用 ${counts.active}`],['unknown',`未记录状态 ${counts.unknown}`],['stopped',`已停用 ${counts.stopped}`],['all','全部']].map(([id,label])=><button key={id} aria-pressed={filter===id} className={filter===id?'selected':''} onClick={()=>setFilter(id)}>{label}</button>)}</div>
          {visibleMeds.length ? <ul className="treatment-medications">{visibleMeds.map((med,i)=><li key={i}><div className="treatment-pill-icon"><Pill size={19}/></div><div className="treatment-med-content"><div className="treatment-med-name"><h4>{med.name}</h4><span className={`treatment-med-state ${med.status || 'unknown'}`}>{medicationStates[med.status] || medicationStates.unknown}</span></div><p className="treatment-med-dose">{med.dose || '剂量未记录'}<span aria-hidden="true"> · </span>{med.frequency || '频次未记录'}</p>{(med.startDate || med.status === 'stopped' && (med.stoppedAt || med.stopReason)) && <p className="treatment-med-dates">{[med.startDate && `${med.startDate} 开始`, med.status === 'stopped' && med.stoppedAt && `${med.stoppedAt} 停用`, med.status === 'stopped' && med.stopReason && `停药原因：${med.stopReason}`].filter(Boolean).join(' · ')}</p>}{med.note && <p>{med.note}</p>}{diagnosisSources(med).length ? <details className="treatment-provenance"><summary>资料来源</summary>{diagnosisSources(med).map(source=><p key={source}>{source}{sourceFiles(source).length === 1 && <button className="text-button" onClick={()=>onNavigate('library', {focusFile:sourceFiles(source)[0].id})}>查看原始资料</button>}{sourceFiles(source).length > 1 && <button className="text-button" onClick={()=>onNavigate('library')}>同名资料有多份，到资料库核对</button>}</p>)}</details> : <p className="treatment-muted">用药来源未记录</p>}</div></li>)}</ul> : <div className="treatment-empty compact"><Pill size={25}/><p>{meds.length ? `暂无「${medicationStates[filter] || '全部'}」用药记录` : '尚无用药记录。'}</p><button className="text-button" onClick={onEditMedications}>添加用药</button></div>}
          {followupActive && <footer className="treatment-med-footer"><span>服药执行情况需通过随访核对</span><button className="text-button" onClick={()=>onNavigate('followups')}>安排用药随访 <ArrowUpRight size={14}/></button></footer>}
        </section>
        <section className="treatment-plan treatment-card" aria-label="当前治疗方案">
          <header><div><h3>当前治疗方案</h3></div>{plan && <button className="text-button" disabled={patient.archived || busy} onClick={openEditor}>编辑方案 <Plus size={15}/></button>}</header>
          {plan ? <><div className="treatment-plan-title"><h4>{plan.title}</h4><span className="treatment-badge">{planStates[plan.status]}</span></div><div className="treatment-goal"><span>治疗目标</span><p>{plan.goal || '尚未填写治疗目标'}</p></div><h5>治疗与干预</h5>{interventions.length ? <ul className="treatment-interventions">{interventions.map((line,i)=><li key={i}>{line}</li>)}</ul> : <p className="treatment-muted">尚未记录干预措施</p>}{plan.source && <p className="treatment-provenance">记录来源 · {plan.source}</p>}</> : <div className="treatment-empty compact inline"><ClipboardList size={20}/><p>尚未建立治疗方案。可记录治疗目标、干预措施与复评日期。</p><button className="secondary" disabled={patient.archived || busy} onClick={openEditor}><Plus size={15}/> 建立治疗方案</button></div>}
        </section>
      </div>
      <aside className="treatment-aside">
        <section className="treatment-card treatment-trends" aria-label="疗效观察">
          <header><div><h3>疗效观察</h3></div><Activity size={19}/></header>
          {group ? <><label className="treatment-metric-label">观察指标<select aria-label="选择观察指标" value={group.key} onChange={event=>setMetric(event.target.value)}>{plottedGroups.map(g=><option key={g.key} value={g.key}>{g.item} · {g.unit || '单位未记录'}</option>)}</select></label><div className="treatment-latest"><strong>{group.latestConflict ? '同日多值' : latest.value}</strong><span>{group.unit || '单位未记录'}<small>{latest.date}</small></span></div><Plot group={group} compact/><p className="treatment-muted">{group.conflict ? `${group.conflictDates.join('、')} 存在同日不同数值，散点展示，需核对原始记录。` : group.distinctDates < 2 ? '目前仅一个日期的记录，补充复查后可查看趋势。' : `${group.distinctDates} 个日期的记录 · 数值变化需结合临床评估`}</p></> : <div className="treatment-empty compact"><Activity size={26}/><p>补充检验记录后，在这里查看指标变化。</p></div>}
          <button className="text-button" onClick={()=>onNavigate('labs')}>查看全部检验 <ArrowUpRight size={14}/></button>
        </section>
        {plan && <section className="treatment-card treatment-outcome" aria-label="预后与疗效评估">
          <header><div><h3>预后与疗效评估</h3></div></header>
          {plan?.prognosis ? <><span className="treatment-review-date">{plan.assessmentDate} · 评估记录</span><p className="treatment-prognosis">{plan.prognosis}</p></> : <p className="treatment-muted">尚未记录评估。结合症状、检验与耐受情况，记录本阶段的疗效和预后判断。</p>}
          <button className="text-button" disabled={patient.archived || busy} onClick={openEditor}>{plan?.prognosis ? '更新评估' : '记录评估'} <ArrowUpRight size={14}/></button>
        </section>}
        {plan && <section className="treatment-card treatment-review" aria-label="治疗与复评时间线">
          <header><h3>治疗与复评</h3><CalendarDays size={18}/></header>
          <ol><li><span>方案开始</span><time>{plan?.startDate || '尚未记录'}</time></li><li><span>最近评估</span><time>{plan?.assessmentDate || '尚未记录'}</time></li><li className={due?'is-due':''}><span>下次复评{due && ' · 已到期'}</span><time>{plan?.reviewDate || '尚未安排'}</time></li></ol>
          {followupActive && (reviewReminder ? <p className="treatment-muted">复评日期 {plan.reviewDate} 已安排提醒{reviewReminder.status === 'completed' ? '，提醒已触发' : ''}。<button className="text-button" onClick={()=>onNavigate('followups', {focusFollowupId:reviewReminder.id})}>查看现有计划</button></p> : plan?.status === 'active' && !patient.archived && isCalendarDate(plan?.reviewDate) ? <button className="text-button" onClick={()=>onNavigate('followups', {patientId:patient.id,reviewDate:plan.reviewDate,title:plan.title})}>按复评日期安排随访 <ArrowUpRight size={14}/></button> : !plan?.reviewDate && !patient.archived ? <button className="text-button" onClick={openEditor}>填写复评日期</button> : null)}
          {!followupActive && !plan?.reviewDate && !patient.archived && <button className="text-button" onClick={openEditor}>填写复评日期</button>}
          {followupActive && <button className="text-button" onClick={()=>onNavigate('followups')}>管理随访提醒 <ArrowUpRight size={14}/></button>}
        </section>}
      </aside>
    </div>
  </div>;
}
