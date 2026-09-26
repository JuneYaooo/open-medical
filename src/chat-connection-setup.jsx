import { MacPermissionHelp } from './mac-permission-help';
import { useState } from 'react';
import { api } from './agent-runtime';
const when=value=>value?new Date(value).toLocaleString():'尚未同步';

export function ConnectionForm({initial,onSaved}) {
 const [saved,setSaved]=useState(initial),[form,setForm]=useState({...initial,token:''}),[check,setCheck]=useState(null),[confirmed,setConfirmed]=useState(false),[editing,setEditing]=useState(!initial.enabled),[admin,setAdmin]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const wechat=saved.channel==='wechat';
 const update=(key,value)=>{setForm(v=>({...v,[key]:value}));setConfirmed(false);setNotice('');};
 const accept=value=>{setSaved(value);setForm({...value,token:''});onSaved(value);};
 const act=async fn=>{setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const test=()=>act(async()=>{const result=await api(`/api/chat-followups/connections/${saved.channel}/test`,'POST',{});setCheck(result);setSaved(v=>({...v,status:result}));});
 const usable=saved.enabled && saved.status?.ready;
 return <div className="chat-setup">
  <ol className="chat-setup-steps" aria-label="接入步骤"><li aria-current={editing?'step':undefined}>1 · {wechat?'检查微信与权限':'连接企业服务'}</li><li aria-current={!editing?'step':undefined}>2 · 关联患者会话</li><li>3 · 同步并复核</li></ol>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {saved.enabled&&!editing?<section className="chat-setup-connected"><h3>{wechat?'微信读取已配置':'企业服务已配置'}</h3><p>{wechat?'人工核验的账号':'企业 ID'}：{saved.accountId}</p><p role="status">{saved.status?.message}</p>{wechat&&<p className="muted">账号由你核验，应用不能自动证明登录身份。换号后请重新配置并关联会话。</p>}
   <div className="toolbar-actions"><button disabled={busy} onClick={test}>{busy?'正在检查…':'重新检查连接'}</button><button disabled={busy} onClick={()=>{setEditing(true);setCheck(null);setConfirmed(false);}}>更换连接</button><button disabled={busy} onClick={()=>act(async()=>{accept(await api(`/api/chat-followups/connections/${saved.channel}`,'POST',{...saved,enabled:false,autoUntil:'',autoSummarize:false}));setEditing(true);setNotice('连接已停用，已有记录保留');})}>停用连接</button></div>
   {wechat&&!usable&&<MacPermissionHelp onRecheck={test} busy={busy}/>}
   {usable?<div className="chat-setup-next"><h3>下一步：关联患者或家属</h3><p>选择患者，核对聊天对象。同步后的内容先进入待复核草稿。</p><a className="chat-next-link" href="/?view=followups&followupTab=chat">去关联患者会话 →</a></div>:<p className="muted">先重新检查连接，通过后再关联会话。已保存配置不代表当前服务可用。</p>}
   {usable&&<AutomaticSettings key={`${saved.channel}:${saved.revision}`} initial={saved} onSaved={value=>{accept(value);setNotice(value.autoUntil?'自动同步设置已保存':'自动同步已停止');}}/>}
  </section>:<>
   {wechat?<section className="chat-setup-detect"><h3>先检查本机微信</h3><p>打开并登录 Mac 微信，再检查客户端、辅助功能与录屏权限。这一步不会读取聊天内容。</p><button disabled={busy} onClick={test}>{busy?'正在检查…':'检查微信与权限'}</button>{check&&<p role="status">{check.message}</p>}
    {check&&!check.ready&&<MacPermissionHelp onRecheck={test} busy={busy}/>}
   </section>:<section className="chat-setup-detect"><h3>{saved.accountId?'重新连接企业服务':'尚未配置企业服务'}</h3><p>医生使用已配置的企业连接，无需管理 SDK 或密钥。请由管理员完成一次接入，再关联患者会话。</p><button type="button" aria-expanded={admin} onClick={()=>setAdmin(v=>!v)}>{admin?'收起管理员配置':'管理员配置'}</button></section>}
   {(wechat?check?.ready:admin)&&<form className="chat-connection-form" onSubmit={e=>{e.preventDefault();act(async()=>{const value=await api(`/api/chat-followups/connections/${saved.channel}/connect`,'POST',{...form,revision:saved.revision,accountConfirmed:confirmed});accept(value);setCheck(value.status);if(value.enabled){setEditing(false);setNotice(wechat?'权限检查通过，账号核验声明已保存。请继续关联患者会话。':'企业服务验证通过，可以关联患者会话。');}else setNotice('配置已保存，但连接验证未通过，尚未启用。请按提示修正后重试。');});}}>
    <h3>{wechat?'核对你正在使用的账号':'管理员接入'}</h3>
    {wechat?<><p>在微信中查看当前登录账号，填写微信号用于区分本机的会话关联。此字段不是登录凭据，也不会自动验证身份。</p><label>已核对的微信号<input required maxLength={200} value={form.accountId} onChange={e=>update('accountId',e.target.value)} autoComplete="off"/></label><label className="chat-check"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已在微信中核对当前登录账号，了解换号后需要重新关联</label></>:<><p>先开通会话存档，并由管理员部署采集服务。以下是服务的连接信息，不是患者或医生的微信登录信息。</p><label>企业 ID<input required maxLength={200} value={form.accountId} onChange={e=>update('accountId',e.target.value)}/></label><label>采集器地址<input required type="url" value={form.endpoint} onChange={e=>update('endpoint',e.target.value)} placeholder="管理员提供的 HTTPS 服务地址"/></label><label>采集器连接密钥<input required={!saved.hasToken} type="password" autoComplete="new-password" value={form.token} onChange={e=>update('token',e.target.value)} placeholder={saved.hasToken?'已保存，留空保留':'管理员提供的连接密钥'}/></label><details><summary>管理员需要准备什么？</summary><ol><li>确认会话存档权限和获准读取的员工范围。</li><li>部署随安装包提供的 integrations/wecom-archive 采集器，配置官方 SDK、存档 Secret 与 RSA 私钥。</li><li>在此填写企业 ID、服务地址与连接密钥，点击验证。</li></ol><p>存档 Secret 和私钥保留在采集器，不填入工作台。</p></details></>}
    <button type="submit" disabled={busy||(wechat&&!confirmed)}>{busy?'正在验证…':wechat?'确认账号并验证连接':'验证并连接企业服务'}</button>
    {check&&!wechat&&<p role="status">{check.message}</p>}
   </form>}
   {saved.enabled&&<button disabled={busy} onClick={()=>{setEditing(false);setForm({...saved,token:''});}}>返回已保存连接</button>}
  </>}
  <p className="muted">最近同步：{when(saved.lastSyncAt)}{saved.lastError?` · ${saved.lastError}`:''}</p>
 </div>;
}

function AutomaticSettings({initial,onSaved}) {
 const [form,setForm]=useState({...initial}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[automatic,setAutomatic]=useState(Boolean(initial.autoUntil&&Date.parse(initial.autoUntil)>Date.now())),[consent,setConsent]=useState(false);
 const update=(key,value)=>{setForm(v=>({...v,[key]:value}));setNotice('');};
 const action=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
 return <form className="chat-connection-form" onSubmit={e=>{e.preventDefault();action(async()=>{const value=await api(`/api/chat-followups/connections/${form.channel}`,'POST',{...form,autoUntil:automatic?form.autoUntil:'',automaticConsent:consent,modelConsent:form.modelConsent===true});onSaved(value);});}}>
  <details><summary>自动同步</summary><p>{form.channel==='wechat'?'定时读取一个已校准会话。请在微信打开并保持该会话；切换聊天、掉线或验证失败时停止，不会自动搜索联系人。':'同步已关联会话，保存原文并生成待复核草稿。'}默认只采集原文；可单独授权模型自动整理。工作台退出后停止运行。</p>
   <label className="chat-check"><input type="checkbox" checked={automatic} onChange={e=>{setAutomatic(e.target.checked);setConsent(false);}}/>在有限时段内自动同步</label>
   {automatic&&<>{form.channel==='wechat'&&<label>定时读取的会话<select required value={form.autoBindingId||''} onChange={e=>{update('autoBindingId',e.target.value);setConsent(false);}}><option value="">请选择已校准会话</option>{(initial.availableBindings||[]).map(b=><option key={b.id} value={b.id}>{b.patientName} · {b.title}</option>)}</select></label>}<label className="chat-check"><input type="checkbox" checked={Boolean(form.autoSummarize)} onChange={e=>{update('autoSummarize',e.target.checked);update('modelConsent',false);}}/>自动调用当前模型整理新增草稿</label>{form.autoSummarize&&<label className="chat-check"><input type="checkbox" required checked={Boolean(form.modelConsent)} onChange={e=>update('modelConsent',e.target.checked)}/>允许在此时段内将新增草稿原文发送给当前模型服务；更换模型后重新授权</label>}<label>间隔（分钟）<input type="number" min="5" max="1440" value={form.intervalMinutes} onChange={e=>update('intervalMinutes',Number(e.target.value))}/></label><label>截止时间（最长 24 小时）<input type="datetime-local" required value={form.autoUntil?(()=>{const d=new Date(form.autoUntil);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16);})():''} onChange={e=>update('autoUntil',e.target.value?new Date(e.target.value).toISOString():'')}/></label><label className="chat-check"><input required type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>我确认在此时段内读取此账号已关联的会话{form.channel==='wechat'?'中的上述会话，并允许显示微信窗口':''}</label></>}
  </details>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <button disabled={busy} type="submit">保存自动同步设置</button>
  {initial.autoUntil&&Date.parse(initial.autoUntil)>Date.now()&&<button disabled={busy} type="button" onClick={()=>action(async()=>onSaved(await api(`/api/chat-followups/connections/${form.channel}`,'POST',{...initial,autoUntil:'',autoSummarize:false})))}>停止自动同步</button>}
 </form>;
}
