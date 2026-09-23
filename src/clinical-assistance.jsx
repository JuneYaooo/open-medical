import {useState} from 'react';
import {ASSISTANCE_PROFILES,suggestedProfiles,assistanceDraft} from '../shared/clinical-assistance.mjs';
import './clinical-assistance.css';
export function ClinicalAssistance({patient,session,onNavigate,onOpenTask}) {
 const suggested=suggestedProfiles(patient);
 const [profileId,setProfileId]=useState(suggested[0]?.id || 'general');
 const [question,setQuestion]=useState('');
 const profile=ASSISTANCE_PROFILES.find(p=>p.id===profileId) || ASSISTANCE_PROFILES[0];
 const diagnoses=(patient.diagnoses||[]).map(d=>typeof d==='string'?d:d.name).filter(Boolean);
 const medications=patient.medications||[];
 const unknown=medications.filter(m=>!m.status || m.status==='unknown').length;
 const start=kind=>onOpenTask(patient.sessionId,{draft:assistanceDraft(kind,profile,question)});
 const results=(session?.artifacts||[]).filter(a=>['treatment_review','similar_cases'].includes(a.type)).slice(-2);
 return <section className="clinical-assistance" aria-label="患者诊疗辅助面板">
  <div className="assistance-context">
   <span className="assistance-caption">已登记诊断</span>
   <p>{diagnoses.slice(0,2).join(' · ') || '尚未登记诊断'}</p>
   {diagnoses.length>2 && <details className="assistance-diagnoses"><summary>查看全部 {diagnoses.length} 项诊断</summary><ul>{diagnoses.map((d,i)=><li key={i}>{d}</li>)}</ul><button className="text-button" onClick={()=>onNavigate('diagnoses')}>打开诊断与病史</button></details>}
   <div className="assistance-status"><button onClick={()=>onNavigate('medications')}>{unknown ? `${unknown} 条用药状态待核对` : '查看用药记录'}</button><span>{patient.allergies?.length?'已有过敏记录':patient.allergyStatus==='none_known'?'无已知过敏（已核对）':'过敏史待核对'}</span></div>
  </div>
  <div className="assistance-layout"><div className="assistance-main">
   <section className="assistance-question"><h2>这次想了解什么？</h2><label className="sr-only" htmlFor="assistance-question">本次诊疗问题</label><textarea id="assistance-question" aria-label="本次诊疗问题" value={question} onChange={e=>setQuestion(e.target.value)} placeholder="例如：现有治疗方案是否合适？还需要补充哪些检查？"/>
   <div className="assistance-question-footer"><span>结合当前患者资料</span><button className="primary" onClick={()=>start('assessment')}>准备诊疗评估</button></div></section>
   <details className="assistance-disclosure"><summary>调整评估重点 <span>{profile.name}</span></summary><div className="assistance-detail-body"><label>关注方向<select aria-label="诊疗关注方向" value={profileId} onChange={e=>setProfileId(e.target.value)}>{ASSISTANCE_PROFILES.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><p>评估时会核对以下方面；这不是已确认的问题清单。</p><ul>{profile.topics.map(topic=><li key={topic}>{topic}</li>)}</ul><a href={profile.source} target="_blank" rel="noreferrer">{profile.sourceName}</a><div className="assistance-links"><button className="text-button" onClick={()=>onNavigate('diagnoses')}>诊断与病史</button><button className="text-button" onClick={()=>onNavigate('labs')}>检验趋势</button></div></div></details>
   <details className="assistance-disclosure"><summary>用药核对、检查与随访</summary><div className="assistance-detail-body assistance-more-actions"><div><h3>用药核对</h3><p>{medications.length ? `已登记 ${medications.length} 条用药记录，核对目前使用情况与安全性。` : '尚无结构化用药记录，可结合原始材料核对。'}</p><button className="secondary" onClick={()=>start('medication')}>准备用药核对</button></div><div><h3>检查与随访</h3><p>整理已有安排和下一步待确认事项。</p><button className="secondary" onClick={()=>start('followup')}>整理下一步问题</button><div className="assistance-links"><button className="text-button" onClick={()=>onNavigate('tracking')}>检查与转诊</button><button className="text-button" onClick={()=>onNavigate('followups')}>随访计划</button></div></div></div></details>
  </div><aside className="assistance-evidence" aria-label="诊疗参考入口"><h3>也可以先看看</h3><button className="assistance-reference" aria-label="看看相似患者" onClick={()=>start('similar')}><b>看看相似患者 <span aria-hidden="true">↗</span></b><small>本地患者 · 网上病例</small></button><button className="assistance-reference" aria-label="相关指南与文献" onClick={()=>start('literature')}><b>相关指南与文献 <span aria-hidden="true">↗</span></b><small>诊疗指南 · 临床研究</small></button>{results.length>0 && <details className="assistance-saved"><summary>已有参考结果 · {results.length}</summary>{results.map(a=><button key={a.id} className="text-button" onClick={()=>onOpenTask(patient.sessionId,{tab:'results',artifactId:a.id})}>{a.title || '查看结果'} · {a.status==='approved'?'已复核':'待核对'}</button>)}</details>}</aside></div>
  <p className="assistance-footnote">点选后生成任务草稿，发送后开始分析或检索；结果供医生核对。</p>
 </section>;
}
