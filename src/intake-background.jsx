import { useEffect, useState } from 'react';
import { api } from './agent-runtime';
import './intake-background.css';

// File upload continues across in-app navigation. Once saved, the server owns the job.
export const intakeUploads = new Map();
export function IntakeBackground({ onOpen }) {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    // 有建档任务在跑时 1.5 秒刷新一次，其余时间 8 秒，避免空闲时频繁请求。
    let alive=true, fetching=false, timer=null, busy=intakeUploads.size>0;
    const schedule=()=>{ if(alive) timer=setTimeout(refresh, busy || intakeUploads.size ? 1500 : 8000); };
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
        busy=running>0;
        if(alive) setSummary(running || drafts || failed || needsInput ? {running,drafts,failed,needsInput} : null);
      } catch { /* Preserve the last known task indicator during a transient disconnect. */ }
      finally {fetching=false;schedule();}
    };
    refresh();
    return ()=>{alive=false;clearTimeout(timer);};
  },[]);
  if(!summary) return null;
  return <aside aria-label="后台建档状态" className="intake-background-status">
    <p role="status">患者建档：{[summary.running && `${summary.running} 项后台处理`,summary.drafts && `${summary.drafts} 份草稿待核对`,summary.failed && `${summary.failed} 项未完成`,summary.needsInput && `${summary.needsInput} 项待补充信息`].filter(Boolean).join(' · ')}</p>
    <button className="secondary" onClick={onOpen}>查看建档任务</button>
  </aside>;
}
