import { useEffect, useState } from 'react';
import { api } from './agent-runtime';
const when=value=>value?new Date(value).toLocaleString():'尚未同步';
// 插件中心:可安装连接插件的目录与已安装管理。目录是随产品发布的静态清单——
// 产品只内置"会说协议的客户端",第三方工具一律由用户自行部署(边界见各条目风险说明)。
const PLUGIN_CATALOG=[
 {manifest:{manifestVersion:1,id:'wechat-exp',name:'微信历史导入（本机导出桥接）',protocol:'wx-cli',defaultEndpoint:'http://127.0.0.1:9101'},
  category:'聊天渠道',
  setup:true,
  desc:'把微信里的聊天记录备份并接入随访：读取会话列表、选择要导入的人并标注患者归属与关系，历史同步进待复核草稿。全程按钮操作，无需命令行。',
  goto:{tab:'followup',label:'去随访连接配置 →'},
  risk:'⚠ 该能力依赖一个外部导出组件（安装向导会自动下载）。该组件需要从微信进程内存提取数据库密钥，此行为可能被微信感知上报，存在账号被平台处罚的先例（一次性备份风险较低但不为零）。请仅用你自己拥有的账号与数据，知情后启用。'},
];
export function PluginCenter() {
 const [connections,setConnections]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const refresh=()=>{api('/api/chat-followups/settings').then(v=>setConnections(v.connections)).catch(e=>setError(e.message));};
 useEffect(refresh,[]);
 const act=async fn=>{setBusy(true);setError('');setNotice('');try{const message=await fn();if(typeof message==='string')setNotice(message);refresh();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const installed=id=>connections?.some(c=>c.channel===id);
 return <section aria-label="插件"><h2>插件</h2><p>一键安装连接插件，扩展随访能接入的聊天渠道。第三方插件的能力、数据读取方式与合规风险由其提供方决定（可能包含读取本机聊天数据等敏感操作，部分行为存在账号被平台处罚的先例），安装前请阅读各条目的风险说明。</p>
  {error&&<p role="alert">{error}</p>}
  {notice&&<p role="status">{notice}</p>}
  {!connections&&!error&&<p role="status">正在读取插件状态…</p>}
  {connections&&PLUGIN_CATALOG.map(entry=>{
   const done=installed(entry.manifest.id);
   return <div key={entry.manifest.id} className="chat-draft">
    <header><strong>{entry.manifest.name}</strong><span>{entry.category}{done?' · 已安装':''}</span></header>
    <p>{entry.desc}</p>
    <p role="status">{entry.risk}</p>
    <div className="toolbar-actions">
     <button disabled={busy||done} onClick={()=>act(()=>api('/api/chat-followups/plugins','POST',entry.manifest))}>{done?'已安装':'安装插件'}</button>
     {done&&entry.setup&&<PluginSetup entry={entry}/>}
     {done&&entry.goto&&<a className="chat-next-link" href={`/?view=settings&settingsTab=${entry.goto.tab}`}>{entry.goto.label}</a>}
    </div>
   </div>;})}
  {connections&&<details><summary>已安装的插件连接（{connections.filter(c=>!c.plugin?.builtin).length}）</summary>
   {!connections.some(c=>!c.plugin?.builtin)&&<p className="muted">还没有安装任何插件。</p>}
   {connections.filter(c=>!c.plugin?.builtin).map(c=><p key={c.channel}>{c.plugin?.name||c.channel} · {c.enabled?'已启用':'未启用'} · 最近同步：{when(c.lastSyncAt)} <button disabled={busy} onClick={()=>{if(window.confirm(`移除「${c.plugin?.name||c.channel}」插件并清除其连接密钥？已有聊天记录保留，随访连接里将不再显示该渠道。`))act(()=>api(`/api/chat-followups/plugins/${c.channel}`,'DELETE'));}}>移除插件</button></p>)}
   <p className="muted">插件的连接配置（账号、服务地址、同步开关）在 <a className="chat-next-link" href="/?view=settings&settingsTab=followup">随访连接</a> 对应渠道里管理。</p>
  </details>}
  <details><summary>高级：粘贴第三方连接清单 JSON 安装</summary>
   <AdvancedInstall busy={busy} act={act}/>
  </details>
 </section>;
}
// 微信历史导入的按钮式安装向导:下载组件 → 备份聊天记录(遇到多账号则选择) →
// 自动启用连接。每步一个按钮,状态由 /api/wechat-exp/status 轮询驱动。
// 插件中心和随访连接页共用;onDone 在步骤③连接成功后回调连接对象,便于宿主刷新状态。
export function PluginSetup({entry,onDone}) {
 const [status,setStatus]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[accounts,setAccounts]=useState(null),[wxid,setWxid]=useState('');
 const poll=async()=>{try{const s=await api('/api/wechat-exp/status','GET');setStatus(s);return s;}catch{return null;}};
 useEffect(()=>{poll();},[]);
 // 仅在任务进行中持续轮询;空闲时不轮询,避免页面永远达不到 networkidle(会挂起 UI 测试的 goto)。
 useEffect(()=>{ if(!status?.job) return; const t=setInterval(poll,2500); return()=>clearInterval(t); },[status?.job]);
 const runStep=async fn=>{setBusy(true);setError('');try{await fn();await poll();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const s=status||{toolReady:false,backupReady:false,account:'',bridgeRunning:false,job:null,warning:''};
 const connection=entry.connection||{channel:entry.manifest.id,endpoint:entry.manifest.defaultEndpoint};
 const enabled=async()=>{try{const settings=await api('/api/chat-followups/settings');const c=(settings.connections||[]).find(x=>x.channel===connection.channel);return Boolean(c?.enabled);}catch{return false;}};
 const step1=!s.toolReady&&(
  <div className="toolbar-actions">
   <button disabled={busy} onClick={()=>runStep(()=>api('/api/wechat-exp/download','POST',{}))}>{s.job?.kind==='download'?(s.job.note||'正在下载…'):'① 下载导出组件（约 45MB）'}</button>
   <span className="muted">组件由第三方发布，工作台不含它；下载后保存在本机数据目录。</span>
  </div>);
 const step2=s.toolReady&&!s.backupReady&&(
  <div className="toolbar-actions">
   {!accounts?<button disabled={busy} onClick={()=>runStep(async()=>{const r=await api('/api/wechat-exp/backup','POST',{days:30});if(r.needAccount){setAccounts(r.accounts);throw new Error('检测到多个微信账号，请在下方选择要备份的账号');}})}>{busy&&s.job?.kind==='backup'?(s.job.note||'正在备份…'):'② 备份微信聊天记录（最近 30 天）'}</button>
   :<>{<select aria-label="选择微信账号" value={wxid} onChange={e=>setWxid(e.target.value)}>{<option value="">选择微信账号</option>}{accounts.map(a=><option key={a} value={a}>{a}</option>)}</select>}<button disabled={busy||!wxid} onClick={()=>runStep(()=>api('/api/wechat-exp/backup','POST',{days:30,wxid}))}>用所选账号备份</button></>}
   <span className="muted">请保持微信在此电脑登录；备份期间请勿退出微信。</span>
  </div>);
 const step3=s.backupReady&&(
  <div className="toolbar-actions">
   <button disabled={busy} onClick={()=>runStep(async()=>{
     const accountId=s.account||(wxid||'');
     if(!accountId)throw new Error('未识别到微信账号，请先完成备份');
     const settings=await api('/api/chat-followups/settings');
     const existing=(settings.connections||[]).find(c=>c.channel===connection.channel);
     const value=await api(`/api/chat-followups/connections/${connection.channel}/connect`,'POST',{enabled:true,accountId,token:'',revision:existing?.revision??0,intervalMinutes:15});
     onDone?.(value);
     setNotice('微信历史导入已启用：到随访 → 关联会话 选择要导入的人。');
   })}>{busy?'正在启用…':`③ 启用微信历史导入${s.account?`（账号 ${s.account.slice(0,18)}）`:''}`}</button>
   <a className="chat-next-link" href="/?view=followups&followupTab=chat">去关联会话并导入 →</a>
  </div>);
 const doneStep=s.backupReady&&(
  <p className="muted">✓ 组件已就绪 · 备份完成（{when(s.lastBackupAt)}）· {s.bridgeRunning?'导入服务运行中':'导入服务随连接启停'}</p>);
 return <div className="chat-setup-steps" style={{display:'block'}}>
  {step1}{step2}{step3}{doneStep}
  {error&&<p role="alert">{error}</p>}
  {s.lastError&&<p role="alert">上次任务失败：{s.lastError}</p>}
 </div>;
}
function AdvancedInstall({busy,act}) {
 const [manifest,setManifest]=useState('{\n "manifestVersion": 1,\n "id": "my-connector",\n "name": "我的连接",\n "protocol": "wx-cli"\n}');
 return <form className="chat-connection-form" onSubmit={e=>{e.preventDefault();act(()=>api('/api/chat-followups/plugins','POST',JSON.parse(manifest)));}}><label>插件清单（JSON）<textarea rows={5} maxLength={2000} value={manifest} onChange={e=>setManifest(e.target.value)}/></label><button disabled={busy}>安装连接插件</button></form>;
}
