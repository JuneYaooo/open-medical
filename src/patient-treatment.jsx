import { useRef, useState } from 'react';
import { Activity, ArrowUpRight, CalendarDays, Check, ClipboardList, Plus, Pill, ShieldAlert } from 'lucide-react';
import { api } from './agent-runtime';
import { localCalendarDate } from '../shared/calendar-date.mjs';
import './patient-treatment.css';

const medicationStates = { active: '正在使用', unknown: '待核对', stopped: '已停用' };
const planStates = { active: '进行中', paused: '已暂停', completed: '已完成' };
const emptyPlan = { title: '', goal: '', interventions: '', startDate: '', reviewDate: '', status: 'active', prognosis: '', assessmentDate: '', source: '' };

export function TreatmentPanel({ patient, groups, Plot, onEditMedications, onNavigate, onChanged }) {
  const plan = patient.treatmentPlan;
  const [editor, setEditor] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [filter, setFilter] = useState(() => patient.medications?.some(m => m.status === 'active') ? 'active' : 'all');
  const [metric, setMetric] = useState('');
  const meds = patient.medications || [];
  const allergies = patient.allergies || [];
  const counts = Object.fromEntries(Object.keys(medicationStates).map(state => [state, meds.filter(m => (m.status || 'unknown') === state).length]));
  const visibleMeds = meds.filter(m => filter === 'all' || (m.status || 'unknown') === filter);
  const plottedGroups = groups.filter(g => g.canPlot);
  const group = plottedGroups.find(g => g.key === metric) || plottedGroups[0];
  const latest = group?.points.at(-1);
  const today = localCalendarDate();
  const due = plan?.status === 'active' && plan?.reviewDate && plan.reviewDate <= today;
  const openEditor = () => { setEditor({ ...emptyPlan, ...plan }); setError(''); setNotice(''); };
  const save = async event => {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError('');
    try {
      await api(`/api/patients/${patient.id}`, 'PATCH', { expectedRevision: patient.revision, treatmentPlan: editor });
      await onChanged?.();
      setEditor(null); setNotice('治疗方案已保存');
    } catch (err) { setError(err.message); }
    finally { saving.current = false; setBusy(false); }
  };
  const field = key => ({ value: editor[key], onChange: event => setEditor({ ...editor, [key]: event.target.value }) });
  return <div className="treatment-workspace">
    <div className={`treatment-allergy ${allergies.length ? 'has-allergy' : ''}`}>
      <ShieldAlert size={19}/><div><b>过敏与用药安全</b><span>{allergies.length ? allergies.map(a => typeof a === 'string' ? a : [a.substance, a.reaction].filter(Boolean).join('：')).join('；') : patient.allergyStatus === 'none_known' ? '已核对 · 无已知过敏' : '过敏史尚未核对'}</span></div>
      <button className="text-button" onClick={onEditMedications}>核对记录 <ArrowUpRight size={14}/></button>
    </div>
    {notice && <p className="treatment-notice" role="status"><Check size={16}/>{notice}</p>}
    <div className="treatment-summary" aria-label="治疗概况">
      <div><span>当前用药</span><strong>{counts.active}<small>种</small></strong><span>{counts.unknown ? `${counts.unknown} 种用药状态待核对` : '按已核对的用药记录'}</span></div>
      <div><span>治疗阶段</span><strong className="summary-word">{plan ? planStates[plan.status] : '待建立'}</strong><span>{plan?.startDate ? `${plan.startDate} 开始` : '记录目标与干预措施'}</span></div>
      <div><span>下次复评</span><strong className={`summary-word ${due ? 'is-due' : ''}`}>{plan?.reviewDate || '待安排'}</strong><span>{due ? '已到复评日期，请核对进展' : '结合疗效与耐受情况复评'}</span></div>
    </div>
    {editor && <form className="treatment-editor" onSubmit={save} aria-label="编辑治疗方案">
      <header><div><span className="treatment-kicker">CARE PLAN</span><h3>{plan ? '编辑治疗方案' : '建立治疗方案'}</h3></div></header>
      <fieldset disabled={busy}>
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
        <footer><span>用药剂量与频次在用药记录中单独核对。</span><button type="button" className="secondary" onClick={()=>setEditor(null)}>取消</button><button type="submit" className="primary">{busy ? '正在保存…' : '保存方案'}</button></footer>
      </fieldset>
    </form>}
    <div className="treatment-grid">
      <div className="treatment-main">
        <section className="treatment-plan treatment-card" aria-label="当前治疗方案">
          <header><div><span className="treatment-kicker">CARE PLAN</span><h3>当前治疗方案</h3></div><button className="text-button" onClick={openEditor}>{plan ? '编辑方案' : '建立方案'} <Plus size={15}/></button></header>
          {plan ? <><div className="treatment-plan-title"><h4>{plan.title}</h4><span className="treatment-badge">{planStates[plan.status]}</span></div><div className="treatment-goal"><span>治疗目标</span><p>{plan.goal || '尚未填写治疗目标'}</p></div><h5>治疗与干预</h5>{plan.interventions ? <ul className="treatment-interventions">{plan.interventions.split('\n').filter(line=>line.trim()).map((line,i)=><li key={i}><span>{String(i+1).padStart(2,'0')}</span><p>{line}</p></li>)}</ul> : <p className="treatment-muted">尚未记录干预措施</p>}{plan.source && <p className="treatment-provenance">记录来源 · {plan.source}</p>}</> : <div className="treatment-empty"><ClipboardList size={28}/><h4>从一个清晰的治疗目标开始</h4><p>把治疗措施、复评日期与预后评估放在一起，持续跟进患者的变化。</p><button className="secondary" onClick={openEditor}><Plus size={15}/> 建立治疗方案</button></div>}
        </section>
        <section className="treatment-card" aria-label="用药管理">
          <header><div><span className="treatment-kicker">MEDICATIONS</span><h3>用药管理 <small>{meds.length} 种记录</small></h3></div><button className="text-button" onClick={onEditMedications}>管理用药 <ArrowUpRight size={15}/></button></header>
          <div className="treatment-filters" aria-label="筛选用药状态">{[['active',`正在使用 ${counts.active}`],['unknown',`待核对 ${counts.unknown}`],['stopped',`已停用 ${counts.stopped}`],['all','全部']].map(([id,label])=><button key={id} aria-pressed={filter===id} className={filter===id?'selected':''} onClick={()=>setFilter(id)}>{label}</button>)}</div>
          {visibleMeds.length ? <ul className="treatment-medications">{visibleMeds.map((med,i)=><li key={i}><div className="treatment-pill-icon"><Pill size={19}/></div><div className="treatment-med-content"><div className="treatment-med-name"><h4>{med.name}</h4><span className={`treatment-med-state ${med.status || 'unknown'}`}>{medicationStates[med.status] || medicationStates.unknown}</span></div><dl><div><dt>剂量</dt><dd>{med.dose || '未记录'}</dd></div><div><dt>频次 / 用法</dt><dd>{med.frequency || '未记录'}</dd></div></dl>{med.note && <p>{med.note}</p>}{(med.source || med.sources?.length) && <details className="treatment-provenance"><summary>资料来源</summary><p>{med.sources?.length ? med.sources.join('；') : med.source}</p></details>}</div></li>)}</ul> : <div className="treatment-empty compact"><Pill size={25}/><p>{meds.length ? `暂无「${medicationStates[filter] || '全部'}」用药记录` : '尚无用药记录，先核对患者当前用药。'}</p><button className="text-button" onClick={onEditMedications}>核对并添加用药</button></div>}
          <footer className="treatment-med-footer"><span>服药执行情况需通过随访核对</span><button className="text-button" onClick={()=>onNavigate('followups')}>安排用药随访 <ArrowUpRight size={14}/></button></footer>
        </section>
      </div>
      <aside className="treatment-aside">
        <section className="treatment-card treatment-trends" aria-label="疗效观察">
          <header><div><span className="treatment-kicker">OBSERVATIONS</span><h3>疗效观察</h3></div><Activity size={19}/></header>
          {group ? <><label className="treatment-metric-label">观察指标<select aria-label="选择观察指标" value={group.key} onChange={event=>setMetric(event.target.value)}>{plottedGroups.map(g=><option key={g.key} value={g.key}>{g.item} · {g.unit || '单位未记录'}</option>)}</select></label><div className="treatment-latest"><strong>{group.conflict ? '待核对' : latest.value}</strong><span>{group.unit || '单位未记录'}<small>{latest.date}</small></span></div><Plot group={group} compact/><p className="treatment-muted">{group.conflict ? '存在同日不同数值，散点展示，需核对原始记录。' : group.distinctDates < 2 ? '目前仅一个日期的记录，补充复查后可查看趋势。' : `${group.distinctDates} 个日期的记录 · 数值变化需结合临床评估`}</p></> : <div className="treatment-empty compact"><Activity size={26}/><p>补充检验记录后，在这里查看指标变化。</p></div>}
          <button className="text-button" onClick={()=>onNavigate('labs')}>查看全部检验 <ArrowUpRight size={14}/></button>
        </section>
        <section className="treatment-card treatment-outcome" aria-label="预后与疗效评估">
          <header><div><span className="treatment-kicker">CLINICAL REVIEW</span><h3>预后与疗效评估</h3></div></header>
          {plan?.prognosis ? <><span className="treatment-review-date">{plan.assessmentDate} · 评估记录</span><p className="treatment-prognosis">{plan.prognosis}</p></> : <p className="treatment-muted">尚未记录评估。结合症状、检验与耐受情况，记录本阶段的疗效和预后判断。</p>}
          <button className="text-button" onClick={openEditor}>{plan?.prognosis ? '更新评估' : '记录评估'} <ArrowUpRight size={14}/></button>
        </section>
        <section className="treatment-card treatment-review" aria-label="治疗与复评时间线">
          <header><h3>治疗与复评</h3><CalendarDays size={18}/></header>
          <ol><li><span>方案开始</span><time>{plan?.startDate || '尚未记录'}</time></li><li><span>最近评估</span><time>{plan?.assessmentDate || '尚未记录'}</time></li><li className={due?'is-due':''}><span>下次复评{due && ' · 已到期'}</span><time>{plan?.reviewDate || '尚未安排'}</time></li></ol>
          <p className="treatment-muted">复评日期用于计划记录；需要提醒时，请建立随访计划。</p><button className="text-button" onClick={()=>onNavigate('followups')}>管理随访提醒 <ArrowUpRight size={14}/></button>
        </section>
      </aside>
    </div>
  </div>;
}
