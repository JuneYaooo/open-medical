import { useEffect, useState } from 'react';
import { api } from './agent-runtime';
const when=value=>value?new Date(value).toLocaleString():'尚未同步';
// 插件中心:可安装连接插件的目录与已安装管理。目录是随产品发布的静态清单——
// 产品只内置"会说协议的客户端",第三方工具一律由用户自行部署(边界见各条目风险说明)。
const PLUGIN_CATALOG=[
 {manifest:{manifestVersion:1,id:'wechat-exp',name:'微信历史导入（本机导出桥接）',protocol:'wx-cli',defaultEndpoint:'http://127.0.0.1:9101'},
  category:'聊天渠道',
  desc:'把本机导出桥接服务里的微信会话接入随访：读取会话列表、选择要导入的人并标注患者归属与关系，历史同步进待复核草稿。',
  steps:'前提：自行部署并启动外部桥接服务（独立项目 wechat-exp-bridge，见其 README）。安装后到「随访连接」的「微信历史导入」连接里填账号 ID（wxid）并验证启用，服务地址已默认填好。',
  goto:{tab:'followup',label:'去随访连接配置 →'},
  risk:'⚠ 该类桥接依赖读取本机微信数据，取密钥行为存在账号被平台处罚的先例（一次性备份风险较低但不为零）。请知情后启用。'},
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
    <p className="muted">{entry.steps}</p>
    <p role="status">{entry.risk}</p>
    <div className="toolbar-actions">
     <button disabled={busy||done} onClick={()=>act(()=>api('/api/chat-followups/plugins','POST',entry.manifest))}>{done?'已安装':'安装插件'}</button>
     {done&&<a className="chat-next-link" href={`/?view=settings&settingsTab=${entry.goto.tab}`}>{entry.goto.label}</a>}
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
function AdvancedInstall({busy,act}) {
 const [manifest,setManifest]=useState('{\n "manifestVersion": 1,\n "id": "my-connector",\n "name": "我的连接",\n "protocol": "wx-cli"\n}');
 return <form className="chat-connection-form" onSubmit={e=>{e.preventDefault();act(()=>api('/api/chat-followups/plugins','POST',JSON.parse(manifest)));}}><label>插件清单（JSON）<textarea rows={5} maxLength={2000} value={manifest} onChange={e=>setManifest(e.target.value)}/></label><button disabled={busy}>安装连接插件</button></form>;
}
