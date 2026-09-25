import { WechatImportForm } from './wechat-import';
import { ConnectionForm } from './chat-connection-setup';
import { useEffect, useRef, useState } from 'react';
import { api } from './agent-runtime';
import { patientOptionLabel } from './patient-labels';
import './chat-followups.css';

const names={wechat:'微信桌面',wecom:'企业微信存档'};
const when=value=>value?new Date(value).toLocaleString():'尚未同步';
const localDate=()=>{const d=new Date();d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16);};
export function ChatConnectionSettings() {
 const [connections,setConnections]=useState(null),[error,setError]=useState(''),[channel,setChannel]=useState('wechat'),[version,setVersion]=useState(0);
 useEffect(()=>{let alive=true;api('/api/chat-followups/settings').then(v=>{if(alive){setConnections(v.connections);setError('');}}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[version]);
 return <section className="chat-settings"><h2>随访连接</h2><p>分别连接微信与企业微信，患者和家属的会话在随访中关联。</p>
  <nav className="chat-tabs" aria-label="随访连接渠道">{Object.entries(names).map(([id,name])=><button key={id} aria-pressed={channel===id} onClick={()=>setChannel(id)}>{name}</button>)}</nav>
  {error&&<p role="alert">{error}<button onClick={()=>setVersion(v=>v+1)}>重新加载连接</button></p>}
  {!connections&&!error&&<p role="status">正在读取连接配置…</p>}
  {connections&&<ConnectionForm key={channel} initial={connections.find(c=>c.channel===channel)} onSaved={c=>setConnections(old=>old.map(v=>v.channel===c.channel?c:v))}/>}
 </section>;
}
export function ChatFollowupsPanel({patients,onSettings,initialPatientId}) {
 const [patientId,setPatientId]=useState(initialPatientId||'');
 return <section className="chat-followups" aria-label="聊天随访"><header><div><h2>聊天随访</h2><p>关联患者或家属会话，整理新增聊天，再核对归档。</p></div>{onSettings&&<button onClick={onSettings}>配置随访连接</button>}</header>
  {!initialPatientId&&<label className="chat-patient-picker">选择患者<select aria-label="选择患者" value={patientId} onChange={e=>setPatientId(e.target.value)}><option value="">请选择患者</option>{patients.map(p=><option key={p.id} value={p.id}>{patientOptionLabel(p)}</option>)}</select></label>}
  {patientId?<PatientChats key={patientId} patientId={patientId}/>:<p className="chat-empty">先选择患者，再关联本人或家属的微信会话。</p>}
 </section>;
}
function PatientChats({patientId}) {
 const [state,setState]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[importing,setImporting]=useState(false),[adding,setAdding]=useState(false),[selected,setSelected]=useState([]);
 const [offset,setOffset]=useState(0);
 const alive=useRef(true);
 const refresh=async()=>{const value=await api(`/api/chat-followups/patients/${patientId}?offset=${offset}`);if(alive.current)setState(value);};
 useEffect(()=>{alive.current=true;refresh().catch(e=>{if(alive.current)setError(e.message);});return()=>{alive.current=false;};},[patientId,offset]);
 const act=async fn=>{setBusy(true);setError('');setNotice('');try{const message=await fn();if(alive.current){if(typeof message==='string')setNotice(message);await refresh();}}catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setBusy(false);}};
 return <>{error&&<p role="alert">{error}<button onClick={()=>act(refresh)}>重新加载聊天随访</button></p>}{notice&&<p role="status">{notice}</p>}
  {!state&&!error&&<p role="status">正在读取会话…</p>}
  {state&&<><div className="toolbar-actions"><button disabled={busy} onClick={()=>setAdding(v=>!v)}>{adding?'取消关联':'关联会话'}</button><button disabled={busy} onClick={()=>setImporting(v=>!v)}>{importing?'收起导入':'导入微信聊天记录'}</button>{busy&&<>{state.connections.map(c=><button key={c.channel} onClick={()=>api(`/api/chat-followups/connections/${c.channel}/cancel`,'POST',{}).then(()=>setNotice('已请求停止同步')).catch(e=>setError(e.message))}>停止{names[c.channel]}读取</button>)}</>}</div>
   {importing&&<WechatImportForm patientId={patientId} onImported={refresh}/>}
   {adding&&<BindingForm patientId={patientId} connections={state.connections} onBound={()=>{setAdding(false);return refresh();}}/>}
   {!state.bindings.length&&!adding&&<p className="chat-empty">此患者还没有关联会话。首次关联需要核实联系人和患者关系。</p>}
   {state.bindings.some(b=>b.channel==='wechat'&&b.mode!=='import')&&<p className="muted">读取微信前，请手动打开对应会话。应用核对标题和画面后读取，不会自动搜索或切换联系人。</p>}
   <div className="chat-bindings">{state.bindings.map(b=><article key={b.id}><div><strong>{b.title}</strong><p>{b.mode==='import'?'微信导出记录':names[b.channel]} · {b.speakerName} · {b.relationship==='family'?'家属':'本人'}{!b.currentAccount?' · 账号已改变，需重新关联':''}</p></div><div className="toolbar-actions">{b.mode!=='import'&&<button disabled={busy||!b.currentAccount||!state.connections.find(c=>c.channel===b.channel)?.enabled} onClick={()=>act(async()=>{const result=await api(`/api/chat-followups/connections/${b.channel}/sync`,'POST',{bindingId:b.id,consent:true});return `${result.message}；新增 ${result.added} 条来源记录、${result.drafts} 份草稿。`;})}>{b.channel==='wechat'?'读取已打开的会话':'同步企微增量'}</button>}<button disabled={busy} onClick={()=>{if(window.confirm(`解除与「${b.title}」的关联？将停止后续采集，已归档记录保留。`))act(()=>api(`/api/chat-followups/bindings/${b.id}`,'DELETE'));}}>解除关联</button></div></article>)}</div>
   {!!state.inbox.length&&<section className="chat-inbox"><h3>待分配消息</h3><p>群聊或共享会话需要核对归属。只选择属于当前患者的消息。每个会话显示最近 100 条，分配后可继续查看。</p>{state.inbox.map(m=><label className="chat-check" key={m.id}><input type="checkbox" checked={selected.includes(m.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,m.id]:old.filter(id=>id!==m.id))}/><span>{m.text||`[${m.type}]`}<small>{when(m.sentAt||m.observedAt)}</small></span></label>)}<button disabled={busy||!selected.length} onClick={()=>act(async()=>{const groups=new Map();for(const m of state.inbox.filter(m=>selected.includes(m.id))){const ids=groups.get(m.bindingId)||[];ids.push(m.id);groups.set(m.bindingId,ids);}for(const [bindingId,messageIds] of groups)await api('/api/chat-followups/assign','POST',{bindingId,messageIds,confirmed:true});setSelected([]);return '已归入当前患者的待复核草稿';})}>确认选中消息属于当前患者</button></section>}
   <h3>随访草稿与记录</h3>{!state.drafts.length&&<p className="muted">同步后在这里查看原文、填写或生成摘要。</p>}
   <nav className="toolbar-actions" aria-label="聊天记录分页"><button disabled={busy||offset===0} onClick={()=>setOffset(Math.max(0,offset-20))}>上一页</button><span>共 {state.total} 份 · 第 {Math.floor(offset/20)+1} 页</span><button disabled={busy||offset+20>=state.total} onClick={()=>setOffset(offset+20)}>下一页</button></nav>
   {state.drafts.map(d=><DraftCard key={`${d.id}:${d.revision}`} draft={d} onChanged={refresh}/>)}
  </>}
 </>;
}
function BindingForm({patientId,connections,onBound}) {
 const [form,setForm]=useState({channel:'wechat',title:'',speakerName:'',relationship:'self',conversationId:'',senderId:''}),[preview,setPreview]=useState(null),[availableChats,setAvailableChats]=useState(null),[titleRegion,setTitleRegion]=useState(null),[messageRegion,setMessageRegion]=useState(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const update=(key,value)=>{setForm(old=>({...old,[key]:value}));setConfirmed(false);};
 const act=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const available=connections.find(c=>c.channel===form.channel)?.enabled;
 return <form className="chat-binding-form" onSubmit={e=>{e.preventDefault();act(async()=>{await api('/api/chat-followups/bindings','POST',{...form,patientId,confirmed,previewId:preview?.id,titleRegion,messageRegion});await onBound();});}}>
  <h3>关联患者会话</h3><div className="chat-form-grid"><label>渠道<select aria-label="渠道" value={form.channel} onChange={e=>{update('channel',e.target.value);setPreview(null);}}>{Object.entries(names).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>与患者的关系<select aria-label="与患者的关系" value={form.relationship} onChange={e=>update('relationship',e.target.value)}><option value="self">患者本人</option><option value="family">患者家属</option></select></label><label>会话名称<input required value={form.title} onChange={e=>update('title',e.target.value)} maxLength={150}/></label><label>联系人称呼<input required value={form.speakerName} onChange={e=>update('speakerName',e.target.value)} maxLength={100}/></label></div>
  {!available&&<p role="status">请先在设置 → 随访连接中配置并启用{names[form.channel]}。</p>}
  {form.channel==='wecom'?<><button type="button" disabled={busy||!available} onClick={()=>act(async()=>setAvailableChats(await api('/api/chat-followups/conversations')))}>读取可关联的企微会话</button>{availableChats&&<><label>选择存档会话<select aria-label="选择存档会话" value={form.conversationId} onChange={e=>update('conversationId',e.target.value)}><option value="">请选择并核对会话</option>{availableChats.conversations.map(c=><option key={c.id} value={c.id}>{c.id} · {when(c.lastMessageAt)}</option>)}</select></label><p className="muted">{availableChats.partial?'仅列出部分近期会话，可在下方填写准确会话 ID。':'已列出采集器可见的近期会话。'}关联后会重新扫描可用存档并去重，不保证能补齐过期历史。</p></>}<details><summary>高级：手动填写会话与发送者 ID</summary><label>存档会话 ID<input value={form.conversationId} onChange={e=>update('conversationId',e.target.value)} placeholder="采集器中的 private:成员ID:客户ID 或 room:群ID"/></label><label>联系人发送者 ID<input value={form.senderId} onChange={e=>update('senderId',e.target.value)} placeholder="填写后可区分该联系人的发言；留空标为待核验"/></label></details></>:<><p>先填写会话名称，在微信打开对应聊天，再读取预览。应用尝试定位标题；请核对标题框并选择聊天内容区域，避开会话列表和输入框。</p><button type="button" disabled={busy||!available} onClick={()=>act(async()=>{const result=await api('/api/chat-followups/preview','POST',{consent:true,title:form.title});setPreview(result);setTitleRegion(result.suggestedTitleRegion || null);setMessageRegion(null);})}>{preview?'重新读取窗口':'读取当前微信窗口并校准'}</button>{preview&&<RegionPicker preview={preview} titleRegion={titleRegion} messageRegion={messageRegion} onTitle={setTitleRegion} onMessages={setMessageRegion}/>}</>}
  <label className="chat-check"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核实登录账号、会话身份和患者关系，允许读取此会话</label>
  {error&&<p role="alert">{error}</p>}<button type="submit" disabled={busy||!available||!confirmed||(form.channel==='wechat'?(!titleRegion||!messageRegion):!form.conversationId)}>{busy?'正在核验…':'确认关联'}</button>
 </form>;
}
function RegionPicker({preview,titleRegion,messageRegion,onTitle,onMessages}) {
 const [mode,setMode]=useState('title'),[start,setStart]=useState(null),[drag,setDrag]=useState(null);
 const point=e=>{const b=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))};};
 const rect=(a,b)=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)});
 const draw=(r,key)=>r&&<span key={key} className={`chat-region ${key}`} style={{left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`}}/>;
 return <div className="chat-calibration">{preview.suggestedTitleRegion&&<p role="status">已找到匹配的标题位置。请核对框选结果，再选择聊天内容区域。</p>}<div className="chat-tabs"><button type="button" aria-pressed={mode==='title'} onClick={()=>setMode('title')}>1. 框选会话标题{titleRegion?' ✓':''}</button><button type="button" aria-pressed={mode==='messages'} onClick={()=>setMode('messages')}>2. 框选聊天内容{messageRegion?' ✓':''}</button></div><div className="chat-preview" onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);setStart(point(e));}} onPointerMove={e=>{if(start)setDrag(rect(start,point(e)));}} onPointerUp={e=>{if(start){const r=rect(start,point(e));if(r.width>.02&&r.height>.015)(mode==='title'?onTitle:onMessages)(r);}setStart(null);setDrag(null);}} onPointerCancel={()=>{setStart(null);setDrag(null);}}><img src={`data:image/png;base64,${preview.image}`} alt="当前微信窗口，仅在本机用于选择读取区域" draggable={false}/>{draw(titleRegion,'title')}{draw(messageRegion,'messages')}{draw(drag,'selection')}</div><details><summary>用数值调整区域（百分比）</summary>{[['标题',titleRegion,onTitle],['聊天内容',messageRegion,onMessages]].map(([label,r,set])=><fieldset key={label}><legend>{label}</legend><div className="chat-region-fields">{[['x','左侧'],['y','顶部'],['width','宽度'],['height','高度']].map(([key,name])=><label key={key}>{name}<input type="number" min="0" max="100" step="0.1" value={r?Math.round(r[key]*1000)/10:''} onChange={e=>set({...r,x:r?.x||0,y:r?.y||0,width:r?.width||0,height:r?.height||0,[key]:Number(e.target.value)/100})}/></label>)}</div></fieldset>)}</details></div>;
}
function DraftCard({draft,onChanged}) {
 const [note,setNote]=useState(draft.note),[contactedAt,setContactedAt]=useState(localDate()),[consent,setConsent]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[sources,setSources]=useState(null);
 const act=async fn=>{setBusy(true);setError('');try{await fn();await onChanged();}catch(e){setError(e.message);}finally{setBusy(false);}};
 return <article className="chat-draft"><header><strong>{draft.title}</strong><span>{draft.status==='archived'?'已归档':'待复核'} · {when(draft.createdAt)}</span></header>
  {draft.sourceRevoked&&<p role="alert">此记录的来源消息已撤回，原文仅保留用于追溯，请重新核验内容。</p>}
  <details><summary>查看本次聊天原文（{draft.messageIds.length} 条来源记录）</summary><pre>{draft.sourceText}</pre><button disabled={busy} onClick={()=>act(async()=>setSources((await api(`/api/chat-followups/drafts/${draft.id}/sources`)).messages))}>查看来源证据</button>{sources?.map(m=><div key={m.id}><small>采集于 {when(m.observedAt)} · {m.sentAt?`消息时间 ${when(m.sentAt)}`:'消息时间未识别'} · {m.sourceId}</small>{m.evidence?.coverage==='selected-export'&&<p>导入文件：{m.evidence.filename} · 附件 {m.evidence.attachments?.length||0} 个（未解析）</p>}{m.evidence?.image&&<img src={`data:image/png;base64,${m.evidence.image}`} alt="本次采集的聊天区域"/>}</div>)}</details>
  {draft.status==='archived'?<p className="chat-note">{draft.note}</p>:<><label>随访草稿<textarea aria-label="随访草稿" rows={6} maxLength={4500} value={note} onChange={e=>{setNote(e.target.value);setConfirmed(false);}} placeholder="核对原文后填写记录，或授权 AI 整理"/></label><label className="chat-check"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>允许将本次原文发送给已配置的模型，生成待复核草稿</label><div className="toolbar-actions"><button disabled={busy||!consent||draft.sourceRevoked} onClick={()=>act(async()=>{const result=await api(`/api/chat-followups/drafts/${draft.id}/summarize`,'POST',{revision:draft.revision,externalConsent:true});setNote(result.note);setConsent(false);})}>{busy?'处理中…':'AI 整理草稿'}</button><button disabled={busy||!note.trim()} onClick={()=>act(()=>api(`/api/chat-followups/drafts/${draft.id}/save`,'POST',{revision:draft.revision,note}))}>保存草稿</button></div>
  <label>核实后的联系时间<input type="datetime-local" value={contactedAt} onChange={e=>{setContactedAt(e.target.value);setConfirmed(false);}}/></label><label className="chat-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>已核对患者归属、发言人、时间和记录内容，确认登记为已完成联系</label><button disabled={busy||!confirmed||!note.trim()||!contactedAt} onClick={()=>act(()=>api(`/api/chat-followups/drafts/${draft.id}/archive`,'POST',{revision:draft.revision,note,contactedAt:new Date(contactedAt).toISOString(),confirmed:true}))}>确认归档到随访记录</button></>}
  {error&&<p role="alert">{error}</p>}
 </article>;
}
