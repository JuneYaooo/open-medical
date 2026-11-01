import { WechatImportForm } from '../../channel-wechat/ui/WechatImportForm.jsx';
import { WechatConnection } from '../../channel-wechat/ui/WechatConnection.jsx';
import { EXPERIMENTAL_CHANNELS, ExperimentalChip, ExperimentalNote } from '../../channel-wechat/ui/ExperimentalNote.jsx';
import { AibotConnectionForm } from '../../channel-wecom/ui/ConnectionForm.jsx';
import { SavedConnection, ServiceConnectionForm } from '../../channel/ui/ConnectionForm.jsx';
import { useEffect, useRef, useState } from 'react';
import { api, refreshPlugins } from '../../../src/agent-runtime';
import { usePluginConnected } from '../../../src/plugin-slots.jsx';
import { patientOptionLabel } from '../../../src/patient-labels';
import './chat-followups.css';

// The channel plugins own their connection forms; this panel only chooses the
// form for the selected channel so the followup plugin stays the settings owner.
const ConnectionForm = props => props.initial.channel === 'wechat'
  ? <WechatConnection {...props} />
  : <SavedConnection {...props} />;

const names={wechat:'微信桌面',wecom:'企业微信存档','wecom-aibot':'企微智能机器人','wx-cli':'微信 · wx-cli'};
const when=value=>value?new Date(value).toLocaleString():'尚未同步';
const localDate=()=>{const d=new Date();d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16);};
// 从工作台发送依赖 Windows 桌面组件的已验证发送链；其他平台只读取，回复需在微信中手动发送。
const SEND_UNSUPPORTED='从工作台回复目前仅支持 Windows 微信；请复制内容后在微信中手动发送。';
// 渠道按"解决什么问题"分组,而不是按协议平铺:普通医生只关心实时随访还是历史导入。
// 顺序即推荐顺序;说明用白话,技术细节留给各表单里的折叠区。
const CHANNEL_GROUPS=[
 {label:'实时随访：患者新消息自动进来',hint:'患者在微信或企业微信里发消息后，系统自动读取并整理成待复核草稿。按你们实际用哪个聊天工具，选一个配置即可。',channels:['wechat','wecom-aibot','wecom']},
 {label:'历史记录服务：读取已部署的聊天记录服务',hint:'适用于已自行部署 wx-cli 的电脑。只想导入微信导出的聊天文件时无需配置连接，直接到「随访 → 聊天随访」或患者「消息记录」中导入即可。',channels:['wx-cli']},
];
export function ChatConnectionSettings() {
 const [connections,setConnections]=useState(null),[error,setError]=useState(''),[channel,setChannel]=useState('wechat'),[version,setVersion]=useState(0);
 useEffect(()=>{let alive=true;api('/api/chat-followups/settings').then(v=>{if(alive){setConnections(v.connections);setError('');}}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[version]);
 useEffect(()=>{if(connections?.length&&!connections.some(c=>c.channel===channel))setChannel(connections[0].channel);},[connections]);
 const selected=connections?.find(c=>c.channel===channel);
 // Connect/disconnect changes plugin activation. Refresh bootstrap so the
 // patient tabs, directory cards and agenda sources update without restarting.
 const accept=value=>{setConnections(old=>old.map(v=>v.channel===value.channel?value:v));refreshPlugins().catch(()=>{});};
 // 静态两组之外(第三方插件装的渠道)兜底收进"已安装的连接插件",保证任何渠道都有 tab。
 const groups=connections?(()=>{const known=new Set(CHANNEL_GROUPS.flatMap(g=>g.channels));const extra=connections.filter(c=>!known.has(c.channel));return extra.length?[...CHANNEL_GROUPS,{label:'已安装的连接插件',hint:'管理已安装的连接。',channels:extra.map(c=>c.channel)}]:CHANNEL_GROUPS;})():CHANNEL_GROUPS;
 return <section className="chat-settings"><h2>患者随访</h2>
  <p>连接患者或家属所在的聊天渠道后，新消息进入随访并由你核对归档。带绿点的渠道已连接。</p>
  {error&&<p role="alert">{error}<button onClick={()=>setVersion(v=>v+1)}>重新加载连接</button></p>}
  {!connections&&!error&&<p role="status">正在读取连接配置…</p>}
  {connections&&groups.map(group=>{
   const items=connections.filter(c=>group.channels.includes(c.channel));
   if(!items.length)return null;
   return <div className="chat-channel-group" key={group.label}>
    <h3>{group.label}</h3>

    <nav className="chat-tabs" aria-label={group.label}>{items.map(({channel:id,plugin})=><button key={id} aria-pressed={channel===id} onClick={()=>setChannel(id)}>{connections.find(c=>c.channel===id)?.enabled&&<span className="chat-tab-dot" aria-hidden="true"/>}{plugin?.name||names[id]||id}{EXPERIMENTAL_CHANNELS.has(id)&&<> <ExperimentalChip/></>}</button>)}</nav>
   </div>;})}
  {selected&&EXPERIMENTAL_CHANNELS.has(channel)&&channel!=='wechat'&&channel!=='wecom-aibot'&&<ExperimentalNote/>}

  {selected&&(['wechat','wecom'].includes(channel)?<ConnectionForm key={channel} initial={selected} onSaved={accept}/>:channel==='wecom-aibot'?<AibotConnectionForm key={channel} initial={selected} onSaved={accept}/>:<ServiceConnectionForm key={channel} initial={selected} onSaved={accept}/>)}
 </section>;
}
export function ChatFollowupsPanel({patients,onSettings,initialPatientId}) {
 const [patientId,setPatientId]=useState(initialPatientId||'');
 const connected=usePluginConnected('followup');
 return <section className="chat-followups" aria-label="聊天随访"><header><div><h2>聊天随访</h2><p>关联患者或家属会话，整理新增聊天，再核对归档。</p></div>{onSettings&&<button onClick={onSettings}>配置随访连接</button>}</header>
  {!connected&&<p className="muted">尚未连接微信或企业微信：可以导入微信导出的聊天文件整理随访；实时读取会话需先在设置中连接。</p>}
  {!initialPatientId&&<details className="chat-binding-form"><summary>批量导入聊天记录（微信导出 ZIP 或第三方工具的 TXT 文件夹）</summary><BatchImportForm patients={patients}/></details>}
  {!initialPatientId&&<label className="chat-patient-picker">选择患者<select aria-label="选择患者" value={patientId} onChange={e=>setPatientId(e.target.value)}><option value="">请选择患者</option>{patients.map(p=><option key={p.id} value={p.id}>{patientOptionLabel(p)}</option>)}</select></label>}
  {patientId?<PatientChats key={patientId} patientId={patientId} connected={connected}/>:<p className="chat-empty">{connected?'先选择患者，再关联本人或家属的微信会话。':'先选择患者，再导入该患者的微信聊天记录。'}</p>}
 </section>;
}
// 批量导入:支持两种格式——微信原生导出 ZIP(内含多份聊天 TXT,会话名取自
// 文件名,服务端批量预览+匹配)和第三方工具导出的散装 TXT(头部带「联系人:」)。
// 自动按「已绑定备注名 > 患者姓名」匹配患者 → 医生核对/改判后逐会话导入
// 各患者的待复核草稿。匹配不上的行必须人工指派,绝不按模糊猜测自动归档。
function BatchImportForm({patients}) {
 const [rows,setRows]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirmed,setConfirmed]=useState(false);
 const update=(i,key,value)=>setRows(old=>old.map((r,idx)=>idx===i?{...r,[key]:value,done:false,error:''}:old));
 const onFiles=async list=>{
  setBusy(true);setError('');setNotice('');
  try{
   const picked=[...list].filter(f=>/\.(txt|zip)$/i.test(f.name));
   if(!picked.length)throw new Error('请选择微信导出的 ZIP 或第三方工具导出的 .txt 文件');
   const zip=picked.find(f=>/\.zip$/i.test(f.name));
   if(zip){
    if(picked.length>1)throw new Error('ZIP 请单独选择，不要与散装 TXT 混选');
    if(zip.size>4*1024*1024)throw new Error('ZIP 超过 4MB，请分批导出');
    const data=await new Promise((res,rej)=>{const r=new FileReader();r.onerror=()=>rej(new Error('文件读取失败'));r.onload=()=>res(String(r.result).split(',')[1]);r.readAsDataURL(zip);});
    const preview=await api('/api/chat-followups/imports/preview','POST',{filename:zip.name,data,consent:true});
    if(!preview.batch)throw new Error('该 ZIP 只包含一个会话，请在所选患者下的「导入微信聊天记录」中处理');
    setRows(preview.conversations.map(c=>({file:c.name,contact:c.name,chars:c.chars,snippet:c.snippet,previewId:preview.id,conversationId:c.id,patientId:c.match?.patientId||'',relationship:'self',match:c.match||null,done:false,error:''})));
   } else {
    const parsed=[];
    for(const f of picked){
     if(f.size>4*1024*1024)throw new Error(`${f.name} 超过 4MB，请分批导出`);
     const text=await f.text();
     const contact=(text.match(/^联系人[::](.+)$/m)?.[1]||'').trim();
     if(!contact)throw new Error(`${f.name} 头部没有「联系人:」字段，请确认是导出工具生成的聊天 TXT`);
     const data=await new Promise((res,rej)=>{const r=new FileReader();r.onerror=()=>rej(new Error('文件读取失败'));r.onload=()=>res(String(r.result).split(',')[1]);r.readAsDataURL(f);});
     parsed.push({file:f.name,contact,text,data});
    }
    const matched=(await api('/api/chat-followups/imports/match','POST',{names:parsed.map(p=>p.contact)})).matchResults||[];
    setRows(parsed.map(p=>{
     const hit=matched.find(m=>m.name===p.contact)?.match;
     return {file:p.file,contact:p.contact,text:p.text,data:p.data,patientId:hit?.patientId||'',relationship:'self',match:hit||null,done:false,error:''};
    }));
   }
   setConfirmed(false);
  }catch(e){setError(e.message);}finally{setBusy(false);}
 };
 const importAll=async()=>{
  setBusy(true);setError('');setNotice('');
  const targets=rows.filter(r=>r.patientId&&!r.done);
  let ok=0;
  try{
   for(const r of targets){
    const i=rows.indexOf(r);
    try{
     let result;
     if(r.previewId){
      // 原生 ZIP:服务端已持有会话文本,逐会话确认导入。
      result=await api('/api/chat-followups/imports','POST',{patientId:r.patientId,previewId:r.previewId,conversationId:r.conversationId,title:r.contact,speakerName:r.contact,relationship:r.relationship,confirmed:true});
     } else {
      const preview=await api('/api/chat-followups/imports/preview','POST',{patientId:r.patientId,filename:r.file,data:r.data,consent:true});
      result=await api('/api/chat-followups/imports','POST',{patientId:r.patientId,previewId:preview.id,title:r.contact,speakerName:r.contact,relationship:r.relationship,confirmed:true});
     }
     setRows(old=>old.map((row,idx)=>idx===i?{...row,done:true,added:result.added}:row));ok++;
    }catch(e){setRows(old=>old.map((row,idx)=>idx===i?{...row,error:e.message}:row));}
   }
   setNotice(`已导入 ${ok}/${targets.length} 个会话；各内容已进入对应患者的待复核草稿。`);
  }finally{setBusy(false);}
 };
 const pending=rows.filter(r=>!r.done);
 return <div className="chat-binding-form">
  <p>微信「合并转发」导出的 ZIP（可含多份聊天 TXT）一次选入；或先用本机导出脚本把会话导出成 TXT 文件夹再多选。系统按会话名/「联系人」自动匹配患者（已绑定备注名优先，其次患者姓名），匹配不上的请人工指派或留空跳过。批量预览 5 分钟内有效。</p>
  <label>选择微信导出 ZIP 或聊天 TXT（可多选）<input type="file" multiple accept=".txt,.zip" disabled={busy} onChange={e=>{const list=e.target.files;e.target.value='';if(list&&list.length)onFiles(list);}}/></label>
  {busy&&<p role="status">正在解析与匹配…</p>}
  {error&&<p role="alert">{error}</p>}
  {!!rows.length&&<table className="chat-import-batch"><thead><tr><th>会话</th><th>联系人</th><th>匹配依据</th><th>导入到患者</th><th>关系</th><th>状态</th></tr></thead><tbody>
   {rows.map((r,i)=><tr key={(r.conversationId||r.file)+`:${i}`}>
    <td>{r.file}{r.chars?` · ${r.chars} 字`:''}{r.snippet&&<><br/><small className="muted">{r.snippet.slice(0,60)}…</small></>}</td><td>{r.contact}</td>
    <td>{r.match?(r.match.matchedBy==='binding'?`绑定备注名：${r.match.bindingTitle}`:`患者姓名：${r.match.patientName}`):<span className="muted">未匹配，请人工指派</span>}</td>
    <td><select aria-label={`指派患者：${r.contact}`} value={r.patientId} onChange={e=>update(i,'patientId',e.target.value)}><option value="">跳过（不导入）</option>{patients.map(p=><option key={p.id} value={p.id}>{patientOptionLabel(p)}</option>)}</select></td>
    <td><select aria-label={`关系：${r.contact}`} value={r.relationship} onChange={e=>update(i,'relationship',e.target.value)}><option value="self">本人</option><option value="family">家属</option></select></td>
    <td>{r.done?`✓ 已导入（${r.added??0} 条）`:r.error||'待导入'}</td>
   </tr>)}
  </tbody></table>}
  {!!rows.length&&<><label className="chat-check"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核对每行的患者归属与原文内容，确认导入</label>
  <button disabled={busy||!confirmed||!pending.some(r=>r.patientId)} onClick={importAll}>{busy?'正在导入…':`导入 ${pending.filter(r=>r.patientId).length} 个会话`}</button></>}
  {notice&&<p role="status">{notice}</p>}
 </div>;
}
function PatientChats({patientId,connected}) {
 const [state,setState]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[importing,setImporting]=useState(false),[adding,setAdding]=useState(false),[selected,setSelected]=useState([]);
 const [replies,setReplies]=useState([]);
 const [offset,setOffset]=useState(0);
 const alive=useRef(true);
 const refresh=async()=>{const value=await api(`/api/chat-followups/patients/${patientId}?offset=${offset}`);if(alive.current)setState(value);if(connected)api(`/api/chat-aibot/replies?patientId=${patientId}`).then(r=>{if(alive.current)setReplies(r.replies||[]);}).catch(()=>{});};
 useEffect(()=>{alive.current=true;refresh().catch(e=>{if(alive.current)setError(e.message);});return()=>{alive.current=false;};},[patientId,offset]);
 const act=async fn=>{setBusy(true);setError('');setNotice('');try{const message=await fn();if(alive.current){if(typeof message==='string')setNotice(message);await refresh();}}catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setBusy(false);}};
 return <>{error&&<p role="alert">{error}<button onClick={()=>act(refresh)}>重新加载聊天随访</button></p>}{notice&&<p role="status">{notice}</p>}
  {!state&&!error&&<p role="status">正在读取会话…</p>}
  {state&&<><div className="toolbar-actions">{connected&&<button disabled={busy} onClick={()=>setAdding(v=>!v)}>{adding?'取消关联':'关联会话'}</button>}<button disabled={busy} onClick={()=>setImporting(v=>!v)}>{importing?'收起导入':'导入微信聊天记录'}</button>{busy&&<>{state.connections.map(c=><button key={c.channel} onClick={()=>api(`/api/chat-followups/connections/${c.channel}/cancel`,'POST',{}).then(()=>setNotice('已请求停止同步')).catch(e=>setError(e.message))}>停止{c.plugin?.name||names[c.channel]||c.channel}读取</button>)}</>}</div>
   {importing&&<WechatImportForm patientId={patientId} onImported={refresh}/>}
   {connected&&adding&&<BindingForm patientId={patientId} connections={state.connections} onBound={()=>{setAdding(false);return refresh();}}/>}
   {!state.bindings.length&&!adding&&<p className="chat-empty">{connected?'此患者还没有关联会话。首次关联需要核实联系人和患者关系。':'此患者还没有导入的聊天记录。'}</p>}
   {state.bindings.some(b=>b.channel==='wechat'&&b.mode!=='import')&&<p className="muted">关联、读取与回复都支持按备注名自动定位：只点击会话列表中的精确同名行，并核验顶栏名或头像，不会在微信中搜索。读取可不勾选「读取前自动定位」，改为在微信中手动打开会话后再读。</p>}
   <div className="chat-bindings">{state.bindings.map(b=><article key={b.id}><div><strong>{b.title}</strong><p>{b.mode==='import'?'微信导出记录':(state.connections.find(c=>c.channel===b.channel)?.plugin?.name||names[b.channel]||b.channel)} · {b.speakerName} · {b.relationship==='family'?'家属':'本人'}{!b.currentAccount?' · 账号已改变，需重新关联':''}</p></div><BindingToolbar b={b} connections={state.connections} busy={busy} act={act}/>{b.channel==='wechat'&&b.mode!=='import'&&b.calibration&&(state.connections.find(c=>c.channel===b.channel)?.platform==='win32'?<BindingReply binding={b} disabled={busy||!b.currentAccount||!state.connections.find(c=>c.channel===b.channel)?.enabled} onDone={refresh}/>:<p className="muted">{SEND_UNSUPPORTED}</p>)}</article>)}</div>
   {!!replies.length&&<AibotReplies replies={replies} onChanged={refresh} wechatSend={state.connections.find(c=>c.channel==='wechat')?.platform==='win32'}/>}
   {!!state.inbox.length&&<section className="chat-inbox"><h3>待分配消息</h3><p>群聊或共享会话需要核对归属。只选择属于当前患者的消息。每个会话显示最近 100 条，分配后可继续查看。</p>{state.inbox.map(m=><label className="chat-check" key={m.id}><input type="checkbox" checked={selected.includes(m.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,m.id]:old.filter(id=>id!==m.id))}/><span>{m.text||`[${m.type}]`}<small>{when(m.sentAt||m.observedAt)}</small></span></label>)}<button disabled={busy||!selected.length} onClick={()=>act(async()=>{const groups=new Map();for(const m of state.inbox.filter(m=>selected.includes(m.id))){const ids=groups.get(m.bindingId)||[];ids.push(m.id);groups.set(m.bindingId,ids);}for(const [bindingId,messageIds] of groups)await api('/api/chat-followups/assign','POST',{bindingId,messageIds,confirmed:true});setSelected([]);return '已归入当前患者的待复核草稿';})}>确认选中消息属于当前患者</button></section>}
   <h3>随访草稿与记录</h3>{!state.drafts.length&&<p className="muted">同步后在这里查看原文、填写或生成摘要。</p>}
   {state.total>20&&<nav className="toolbar-actions" aria-label="聊天记录分页"><button disabled={busy||offset===0} onClick={()=>setOffset(Math.max(0,offset-20))}>上一页</button><span>共 {state.total} 份 · 第 {Math.floor(offset/20)+1} 页</span><button disabled={busy||offset+20>=state.total} onClick={()=>setOffset(offset+20)}>下一页</button></nav>}
   {state.drafts.map(d=><DraftCard key={`${d.id}:${d.revision}`} draft={d} onChanged={refresh}/>)}
  </>}
 </>;
}
// 会话绑定卡的操作区。Windows 微信绑定默认勾选「读取前自动定位」:与回复共用
// 按备注名的已验证定位链,无需先在微信中手动打开会话;取消勾选则读取当前打开的会话。
function BindingToolbar({b,connections,busy,act}) {
 const [autoRead,setAutoRead]=useState(true);
 const conn=connections.find(c=>c.channel===b.channel);
 const gated=busy||!b.currentAccount||!conn?.enabled;
 const canAuto=b.channel==='wechat'&&b.mode!=='import'&&conn?.platform==='win32';
 return <div className="toolbar-actions">
  {b.mode!=='import'&&b.channel!=='wecom-aibot'&&<button disabled={gated} onClick={()=>act(async()=>{const result=await api(`/api/chat-followups/connections/${b.channel}/sync`,'POST',{bindingId:b.id,consent:true,autoLocate:canAuto&&autoRead});return `${result.message}；新增 ${result.added} 条来源记录、${result.drafts} 份草稿。`;})}>{b.channel==='wechat'?(canAuto&&autoRead?'自动定位并读取会话':'读取已打开的会话'):'同步会话增量'}</button>}
  {canAuto&&<label className="chat-check chat-autoread"><input type="checkbox" checked={autoRead} onChange={e=>setAutoRead(e.target.checked)}/>读取前自动定位</label>}
  {b.channel==='wechat'&&b.mode!=='import'&&b.calibration?.avatarHash&&<button disabled={gated} onClick={()=>act(async()=>{const result=await api(`/api/chat-followups/bindings/${b.id}/avatar`,'POST',{consent:true});return result.message;})}>重新抓取头像指纹</button>}
  <button disabled={busy} onClick={()=>{if(window.confirm(`解除与「${b.title}」的关联？将停止后续采集，已归档记录保留。`))act(()=>api(`/api/chat-followups/bindings/${b.id}`,'DELETE'));}}>解除关联</button>
 </div>;
}
function BindingReply({binding,disabled,onDone}) {
 const [text,setText]=useState(''),[consent,setConsent]=useState(false),[auto,setAuto]=useState(Boolean(binding.calibration?.avatarHash)),[busy,setBusy]=useState(false),[error,setError]=useState('');
 return <details className="chat-reply"><summary>回复消息</summary>
  <label>回复内容<textarea rows={3} maxLength={2000} aria-label="回复内容" value={text} onChange={e=>{setText(e.target.value);setConsent(false);}} placeholder={`将粘贴到微信「${binding.title}」输入框并发送`}/></label>
  {binding.calibration?.avatarHash&&<label className="chat-check"><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/>自动定位到该会话（按备注名与头像核验，无需先在微信中手动打开）</label>}
  <label className="chat-check"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>我已核对待发送内容{auto?'':'，并已在微信中打开该会话'}</label>
  <p className="muted">发送前应用会核对会话身份与输入框内容；任何核验不通过都不会发送，也不会重试。</p>
  {error&&<p role="alert">{error}</p>}
  <button disabled={busy||disabled||!consent||!text.trim()} onClick={async()=>{setBusy(true);setError('');try{await api(`/api/chat-followups/bindings/${binding.id}/send`,'POST',{text,consent:true,autoLocate:auto});setText('');setConsent(false);await onDone();}catch(e){setError(e.message);}finally{setBusy(false);}}}>{busy?'正在核验发送…':'发送到微信'}</button>
 </details>;
}
function BindingForm({patientId,connections,onBound}) {
 const [form,setForm]=useState({channel:'wechat',title:'',speakerName:'',relationship:'self',conversationId:'',senderId:''}),[preview,setPreview]=useState(null),[availableChats,setAvailableChats]=useState(null),[candidates,setCandidates]=useState(null),[titleRegion,setTitleRegion]=useState(null),[messageRegion,setMessageRegion]=useState(null),[inputPoint,setInputPoint]=useState(null),[mode,setMode]=useState(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const update=(key,value)=>{setForm(old=>({...old,[key]:value}));setConfirmed(false);};
 const act=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const available=connections.find(c=>c.channel===form.channel)?.enabled;
 const platform=connections.find(c=>c.channel===form.channel)?.platform;
 const needsTitle=platform!=='win32';
 const labels=Object.fromEntries(connections.map(c=>[c.channel,c.plugin?.name||names[c.channel]||c.channel]));
 return <form className="chat-binding-form" onSubmit={e=>{e.preventDefault();act(async()=>{await api('/api/chat-followups/bindings','POST',{...form,patientId,confirmed,previewId:preview?.id,titleRegion,messageRegion,inputPoint});await onBound();});}}>
  <h3>关联患者会话</h3><div className="chat-form-grid"><label>渠道<select aria-label="渠道" value={form.channel} onChange={e=>{setForm(v=>({...v,channel:e.target.value,conversationId:'',title:'',senderId:''}));setConfirmed(false);setAvailableChats(null);setCandidates(null);setPreview(null);setMode(null);setTitleRegion(null);setMessageRegion(null);setInputPoint(null);}}>{Object.entries(labels).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>与患者的关系<select aria-label="与患者的关系" value={form.relationship} onChange={e=>update('relationship',e.target.value)}><option value="self">患者本人</option><option value="family">患者家属</option></select></label><label>{form.channel==='wechat'?'微信备注名':'会话名称'}<input required value={form.title} onChange={e=>update('title',e.target.value)} maxLength={150} placeholder={form.channel==='wechat'?'与微信中设置的备注名完全一致，可先点选下方候选':''}/></label><label>联系人称呼<input required value={form.speakerName} onChange={e=>update('speakerName',e.target.value)} maxLength={100}/></label></div>
  {!available&&<p role="status">请先在 <a className="chat-next-link" href="/?view=settings&settingsTab=followup">设置 → 消息渠道 → 患者随访</a> 中配置并启用{labels[form.channel]}；配置好回到这一步继续。</p>}
  {form.channel==='wecom-aibot'&&<p className="muted">列表是机器人已收到过消息的会话（群里 @ 机器人、或患者单聊之后才会出现）。绑定之前到达的消息不会补录；「会话名称」请填您认得的名字（如「3 床家属群」），机器人消息没有备注名可读。</p>}
  {form.channel!=='wechat'?<><button type="button" disabled={busy||!available} onClick={()=>act(async()=>setAvailableChats(await api(`/api/chat-followups/conversations?channel=${encodeURIComponent(form.channel)}`)))}>读取可关联会话</button>{availableChats&&<><label>选择服务会话<select aria-label="选择服务会话" value={form.conversationId} onChange={e=>{const id=e.target.value;const chat=availableChats.conversations.find(c=>c.id===id);setForm(v=>({...v,conversationId:id,title:chat?.title||v.title}));setConfirmed(false);}}><option value="">请选择并核对会话</option>{availableChats.conversations.map(c=><option key={c.id} value={c.id}>{c.title||"未命名会话"} · {when(c.lastMessageAt)}</option>)}</select></label><p className="muted">{availableChats.partial?'仅列出部分近期会话，请同步后刷新列表。':'已列出采集器可见的近期会话。'}关联后会重新扫描可用存档并去重，不保证能补齐过期历史。</p></>}</>:<><p>{needsTitle?'先填写会话名称，在微信打开对应聊天，再读取预览。应用尝试定位标题；请核对标题框并选择聊天内容区域，避开会话列表和输入框。':'推荐「按备注名定位」：可先「从微信读取会话候选」点选填入，再由应用自动打开该会话、抓取头像供你确认，区域用默认校准；也可以手动读取窗口框选。'}</p><div className="toolbar-actions">{platform==='win32'&&<button type="button" disabled={busy||!available||!form.title.trim()} onClick={()=>act(async()=>{const result=await api('/api/chat-followups/preview','POST',{consent:true,title:form.title,locateName:form.title});setPreview(result);setMode('auto');setTitleRegion(null);setMessageRegion(null);setInputPoint(null);})}>按备注名定位并读取预览</button>}<button type="button" disabled={busy||!available} onClick={()=>act(async()=>{const result=await api('/api/chat-followups/preview','POST',{consent:true,title:form.title});setPreview(result);setMode('manual');setTitleRegion(result.suggestedTitleRegion || null);setMessageRegion(null);setInputPoint(null);})}>读取当前微信窗口{platform==='win32'?'（手动框选）':'并校准'}</button>{platform==='win32'&&<button type="button" disabled={busy||!available} onClick={()=>act(async()=>{const result=await api('/api/chat-followups/contacts','POST',{consent:true});setCandidates(result.names||[]);})}>从微信读取会话候选</button>}</div>{candidates&&(candidates.length?<div className="chat-name-suggestions"><span className="muted">识别到当前微信窗口中的以下会话，点击填入备注名（仅作输入提示，关联时仍会定位并核验）：</span>{candidates.map(n=><button key={n} type="button" aria-pressed={form.title===n} onClick={()=>update('title',n)}>{n}</button>)}</div>:<p className="muted">当前画面没有识别到会话列表条目；请在微信中点击左上角的「返回」按钮回到会话列表后重试（不要按 Esc，Esc 会隐藏微信窗口）。</p>)}{busy&&<p role="status">正在定位并读取微信窗口…</p>}{preview&&mode==='auto'&&<div className="chat-calibration">{preview.avatar?<p role="status">已定位会话并抓取头像指纹（预览图消息区左侧的彩色头像块）。请核对这是「{form.title}」的会话，再勾选下方确认。</p>:<p role="status">已定位会话，但未能在预览中抓取头像；仍可关联，之后回复前需在微信中手动打开该会话。</p>}<div className="chat-preview"><img src={`data:image/png;base64,${preview.image}`} alt="定位到的微信会话窗口" draggable={false}/></div></div>}{preview&&mode==='manual'&&<RegionPicker preview={preview} titleRegion={titleRegion} messageRegion={messageRegion} inputPoint={inputPoint} onTitle={setTitleRegion} onMessages={setMessageRegion} onInput={setInputPoint} requireTitle={needsTitle}/>}</>}
  <label className="chat-check"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核实登录账号、会话身份和患者关系，允许读取此会话</label>
  {error&&<p role="alert">{error}</p>}<button type="submit" disabled={busy||!available||!confirmed||(form.channel==='wechat'?(mode==='auto'?!preview:(!messageRegion||(needsTitle&&!titleRegion))):!form.conversationId)}>{busy?'正在核验…':'确认关联'}</button>
 </form>;
}
function RegionPicker({preview,titleRegion,messageRegion,inputPoint,onTitle,onMessages,onInput,requireTitle}) {
 const [mode,setMode]=useState(requireTitle?'title':'messages'),[start,setStart]=useState(null),[drag,setDrag]=useState(null);
 const point=e=>{const b=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))};};
 const rect=(a,b)=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)});
 const draw=(r,key)=>r&&<span key={key} className={`chat-region ${key}`} style={{left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`}}/>;
 return <div className="chat-calibration">{requireTitle&&preview.suggestedTitleRegion&&<p role="status">已找到匹配的标题位置。请核对框选结果，再选择聊天内容区域。</p>}<div className="chat-tabs">{requireTitle&&<button type="button" aria-pressed={mode==='title'} onClick={()=>setMode('title')}>1. 框选会话标题{titleRegion?' ✓':''}</button>}<button type="button" aria-pressed={mode==='messages'} onClick={()=>setMode('messages')}>{requireTitle?'2. ':''}框选聊天内容{messageRegion?' ✓':''}</button><button type="button" aria-pressed={mode==='input'} onClick={()=>setMode('input')}>{requireTitle?'3. ':''}点选输入框{inputPoint?' ✓':''}</button></div><div className="chat-preview" onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);setStart(point(e));}} onPointerMove={e=>{if(start)setDrag(rect(start,point(e)));}} onPointerUp={e=>{if(start){const r=rect(start,point(e));if(mode==='input'){onInput({x:Math.round(start.x*10000)/10000,y:Math.round(start.y*10000)/10000});}else if(r.width>.02&&r.height>.015){(mode==='title'?onTitle:onMessages)(r);}}setStart(null);setDrag(null);}} onPointerCancel={()=>{setStart(null);setDrag(null);}}><img src={`data:image/png;base64,${preview.image}`} alt="当前微信窗口，仅在本机用于选择读取区域" draggable={false}/>{draw(titleRegion,'title')}{draw(messageRegion,'messages')}{draw(drag,'selection')}{inputPoint&&<span className="chat-region input-point" style={{left:`${inputPoint.x*100}%`,top:`${inputPoint.y*100}%`}}/>}</div></div>;
}
// 智能回复队列(企微机器人 + 微信桌面):红旗提问直接给安全话术,其余按知识库起草;
// 医生逐条通过后才发送——企微走原路回复/主动推送,微信走已验证的桌面发送链。
function AibotReplies({replies,onChanged,wechatSend}) {
 const pending=replies.filter(r=>r.status==='draft'),done=replies.filter(r=>r.status!=='draft');
 const act=async fn=>{try{await fn();await onChanged();}catch(e){onChanged();throw e;}};
 return <section className="chat-inbox" aria-label="机器人回复队列"><h3>智能回复{pending.length?`（待审核 ${pending.length}）`:''}</h3>
  <p>红旗症状自动使用固定安全话术；其余按患者简报与知识库起草。每条都需您通过后才发送（企微原路回复，微信经桌面发送链）。</p>
  {pending.map(r=><AibotReplyRow key={`${r.id}:${r.revision}`} row={r} act={act} canSend={r.channel!=='wechat'||wechatSend}/>)}
  {done.length>0&&<details><summary>已处理 {done.length} 条</summary>{done.map(r=><p key={`${r.id}:${r.revision}`} className="muted">{r.status==='sent'?'已发送':'不回复'} · {r.channel==='wechat'?'微信':r.channel==='wecom-aibot'?'企微':''} · {when(r.sentAt||r.createdAt)} · 问：{r.question} · 答：{r.text}</p>)}</details>}
 </section>;
}
function AibotReplyRow({row,act,canSend}) {
 const [text,setText]=useState(row.text),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 return <div className="chat-draft" style={{borderLeft:row.urgent?'3px solid #b91c1c':undefined}}>
  <p><strong>{row.urgent?'⚠ 红旗症状':`问：${row.question}`}</strong><span className="muted"> · {row.channel==='wechat'?'微信桌面':'企微机器人'}</span>{row.screen?.reasons?.length?` · 送审提示：${row.screen.reasons.join('、')}`:''}</p>
  <label>回复内容<textarea rows={3} maxLength={2000} aria-label="回复内容" value={text} onChange={e=>{setText(e.target.value);setConsent(false);}}/></label>
  <p className="muted">{!canSend?SEND_UNSUPPORTED:row.channel==='wechat'?'经桌面微信发送链发出（自动定位并核验会话）；发送时自动附 AI 助手免责声明。':'优先原路回复，失败自动回退主动推送；发送时自动附 AI 助手免责声明。'}</p>
  {error&&<p role="alert">{error}</p>}
  <div className="toolbar-actions">
   {canSend&&<><label className="chat-check"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>我已核对本条回复内容</label>
   <button disabled={busy||!consent||!text.trim()} onClick={()=>{setBusy(true);setError('');act(async()=>{await api(`/api/chat-aibot/replies/${row.id}/send`,'POST',{text,consent:true});}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>{busy?'正在发送…':'通过并发送'}</button></>}
   <button disabled={busy} onClick={()=>{if(window.confirm('确认不回复这条消息？')){setBusy(true);act(()=>api(`/api/chat-aibot/replies/${row.id}/dismiss`,'POST',{confirmed:true})).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}}>不回复</button>
  </div>
 </div>;
}
// AI drafting needs a connected model; manual notes and archiving do not.
let modelStatus=null;
function useModelConfigured(){
 const [configured,setConfigured]=useState(null);
 useEffect(()=>{let alive=true;(modelStatus||=api('/api/agent/health').then(h=>Boolean(h?.modelConfigured)).catch(()=>{modelStatus=null;return null;})).then(v=>{if(alive)setConfigured(v);});return()=>{alive=false;};},[]);
 return configured;
}
function DraftCard({draft,onChanged}) {
 const modelConfigured=useModelConfigured();
 const [note,setNote]=useState(draft.note),[contactedAt,setContactedAt]=useState(localDate()),[consent,setConsent]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[sources,setSources]=useState(null);
 const act=async fn=>{setBusy(true);setError('');try{await fn();await onChanged();}catch(e){setError(e.message);}finally{setBusy(false);}};
 return <article className="chat-draft"><header><strong>{draft.title}</strong><span>{draft.status==='archived'?'已归档':'待复核'} · {when(draft.createdAt)}</span></header>
  {draft.sourceRevoked&&<p role="alert">此记录的来源消息已撤回，原文仅保留用于追溯，请重新核验内容。</p>}
  <details><summary>查看本次聊天原文（{draft.messageIds.length} 条来源记录）</summary><pre>{draft.sourceText}</pre><button disabled={busy} onClick={()=>act(async()=>setSources((await api(`/api/chat-followups/drafts/${draft.id}/sources`)).messages))}>查看来源证据</button>{sources?.map(m=><div key={m.id}><small>采集于 {when(m.observedAt)} · {m.sentAt?`消息时间 ${when(m.sentAt)}`:'消息时间未识别'} · {m.sourceId}</small>{m.evidence?.coverage==='selected-export'&&<p>导入文件：{m.evidence.filename} · 附件 {m.evidence.attachments?.length||0} 个（未解析）</p>}{m.evidence?.image&&<img src={`data:image/png;base64,${m.evidence.image}`} alt="本次采集的聊天区域"/>}</div>)}</details>
  {draft.status==='archived'?<p className="chat-note">{draft.note}</p>:<><label>随访草稿<textarea aria-label="随访草稿" rows={6} maxLength={4500} value={note} onChange={e=>{setNote(e.target.value);setConfirmed(false);}} placeholder="核对原文后填写记录，或授权 AI 整理"/></label>{modelConfigured===false?<p className="chat-note">需先连接模型才能用 AI 整理草稿（设置 → 模型与运行）；也可以核对原文后直接填写记录。</p>:<label className="chat-check"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>允许将本次原文发送给已配置的模型，生成待复核草稿</label>}<div className="toolbar-actions">{modelConfigured!==false&&<button disabled={busy||!consent||draft.sourceRevoked||!modelConfigured} onClick={()=>act(async()=>{const result=await api(`/api/chat-followups/drafts/${draft.id}/summarize`,'POST',{revision:draft.revision,externalConsent:true});setNote(result.note);setConsent(false);})}>{busy?'处理中…':'AI 整理草稿'}</button>}<button disabled={busy||!note.trim()} onClick={()=>act(()=>api(`/api/chat-followups/drafts/${draft.id}/save`,'POST',{revision:draft.revision,note}))}>保存草稿</button></div>
  <label>核实后的联系时间<input type="datetime-local" value={contactedAt} onChange={e=>{setContactedAt(e.target.value);setConfirmed(false);}}/></label><label className="chat-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>已核对患者归属、发言人、时间和记录内容，确认登记为已完成联系</label><button disabled={busy||!confirmed||!note.trim()||!contactedAt} onClick={()=>act(()=>api(`/api/chat-followups/drafts/${draft.id}/archive`,'POST',{revision:draft.revision,note,contactedAt:new Date(contactedAt).toISOString(),confirmed:true}))}>确认归档到随访记录</button></>}
  {error&&<p role="alert">{error}</p>}
 </article>;
}

export default ChatConnectionSettings;
