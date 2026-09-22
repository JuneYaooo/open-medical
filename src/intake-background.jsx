import { useEffect, useState } from 'react';
import { api } from './agent-runtime';

// File upload continues across in-app navigation. Once saved, the server owns the job.
export const intakeUploads = new Map();
export function IntakeBackground({ onOpen }) {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    let alive=true, fetching=false;
    const refresh=async()=>{
      if(fetching) return;
      fetching=true;
      try {
        const [sessions, pending, applied]=await Promise.all([api('/api/sessions'),api('/api/pending-actions'),api('/api/pending-actions?status=applied')]);
        const completed=new Set(applied.actions.filter(a=>a.type==='patient-create').map(a=>a.payload.sourceSessionId));
        const tasks=sessions.sessions.filter(s=>s.intake && !completed.has(s.id));
        const running=tasks.filter(s=>s.intake.job?.status==='running' || s.running || intakeUploads.has(s.id)).length;
        const draftIds=new Set(pending.actions.filter(a=>a.type==='patient-create').map(a=>a.payload.sourceSessionId));
        const drafts=tasks.filter(s=>draftIds.has(s.id) && s.intake.job?.status!=='running').length;
        const failed=tasks.filter(s=>!draftIds.has(s.id) && !intakeUploads.has(s.id) && (['failed','interrupted'].includes(s.intake.job?.status) || (!s.intake.job && (s.intake.issueCount || ['failed','cancelled','interrupted'].includes(s.lastRunStatus))))).length;
        const needsInput=tasks.filter(s=>s.intake.job?.status==='needs_input').length;
        if(alive) setSummary(running || drafts || failed || needsInput ? {running,drafts,failed,needsInput} : null);
      } catch { /* Preserve the last known task indicator during a transient disconnect. */ }
      finally {fetching=false;}
    };
    refresh();const timer=setInterval(refresh,1500);
    return ()=>{alive=false;clearInterval(timer);};
  },[]);
  if(!summary) return null;
  return <aside aria-label="后台建档状态" style={{position:'fixed',right:24,bottom:24,zIndex:40,background:'var(--bg-panel, white)',border:'1px solid var(--border, #ddd)',borderRadius:12,padding:'12px 16px',boxShadow:'0 4px 18px #0001',maxWidth:340}}>
    <p role="status" style={{margin:'0 0 8px'}}>患者建档：{[summary.running && `${summary.running} 项后台处理`,summary.drafts && `${summary.drafts} 份草稿待核对`,summary.failed && `${summary.failed} 项未完成`,summary.needsInput && `${summary.needsInput} 项待补充信息`].filter(Boolean).join(' · ')}</p>
    <button className="secondary" onClick={onOpen}>查看建档任务</button>
  </aside>;
}
