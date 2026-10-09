import { MacPermissionHelp } from './mac-permission-help';
import { useEffect, useRef, useState } from 'react';
import { api } from './agent-runtime';
const when=value=>value?new Date(value).toLocaleString():'尚未同步';
// 微信号格式:6–20 位、字母开头,只含字母/数字/下划线/减号。软提示不拦截——
// 用户最常犯的错是把昵称/手机号填进来,当场提醒比提交后报错友好。
const looksLikeWxid=value=>/^[a-zA-Z][a-zA-Z0-9_-]{5,19}$/.test(String(value||'').trim());

function WindowsWechatHelp({onRecheck,busy}) {
 return <section className="chat-permission-help" aria-label="恢复 Windows 微信读取"><h3>无法检测到微信</h3><p>请打开并登录微信桌面版后重新检测。定位与回复只按备注名精确匹配并核验头像，不会在微信中搜索或盲发。</p>
  <ol><li>确认微信已启动并完成登录（首次登录请在手机上确认）。</li><li>在系统「时间和语言 → 语言」中安装中文文本识别（OCR）组件。</li><li>若提示缺少桌面控制组件，请更新工作台安装包。</li></ol>
  <div className="toolbar-actions"><button type="button" disabled={busy} onClick={onRecheck}>{busy?'正在检查…':'重新检测'}</button></div>
 </section>;
}
export function ConnectionForm({initial,onSaved}) {
 const [saved,setSaved]=useState(initial),[form,setForm]=useState({...initial,token:''}),[check,setCheck]=useState(null),[confirmed,setConfirmed]=useState(false),[editing,setEditing]=useState(!initial.enabled),[admin,setAdmin]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const wechat=saved.channel==='wechat';
 const onMac=(saved.platform||'darwin')==='darwin';
 const update=(key,value)=>{setForm(v=>({...v,[key]:value}));setConfirmed(false);setNotice('');};
 const accept=value=>{setSaved(value);setForm({...value,token:''});onSaved(value);};
 const act=async fn=>{setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const test=()=>act(async()=>{const result=await api(`/api/chat-followups/connections/${saved.channel}/test`,'POST',{});setCheck(result);setSaved(v=>({...v,status:result}));});
 const autoChecked=useRef(false);
 useEffect(()=>{if(wechat&&!autoChecked.current){autoChecked.current=true;test();}},[wechat]);
 const usable=saved.enabled && saved.status?.ready;
 return <div className="chat-setup">
  <ol className="chat-setup-steps" aria-label="接入步骤"><li aria-current={editing?'step':undefined}>1 · {wechat?'检查微信与权限':'连接企业服务'}</li><li aria-current={!editing?'step':undefined}>2 · 关联患者会话</li><li>3 · 同步并复核</li></ol>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {saved.enabled&&!editing?<section className="chat-setup-connected"><h3>{wechat?'微信读取已配置':'企业服务已配置'}</h3><p>{wechat?'已对齐账号':'企业 ID'}：{saved.accountId}</p><p role="status">{saved.status?.message}</p>{wechat&&<p className="muted">账号由你声明并核对，应用不能自动证明登录身份；换号后这里会提示重新配置，已有关联随之失效。</p>}
   <div className="toolbar-actions"><button disabled={busy} onClick={test}>{busy?'正在检查…':'重新检查连接'}</button><button disabled={busy} onClick={()=>{setEditing(true);setCheck(null);setConfirmed(false);}}>更换连接</button>{wechat&&<button disabled={busy} onClick={()=>act(async()=>{const next=!saved.autoReply;const value=await api(`/api/chat-followups/connections/${saved.channel}`,'POST',{...saved,autoReply:next,autoReplyConsent:next});accept(value);return next?'已开启自动起草回复：绑定会话的新消息会自动生成待审核回复，需逐条通过后才经桌面微信发送。':'已关闭自动起草回复。';})}>{saved.autoReply?'关闭自动起草回复':'开启自动起草回复'}</button>}<button disabled={busy} onClick={()=>act(async()=>{accept(await api(`/api/chat-followups/connections/${saved.channel}`,'POST',{...saved,enabled:false,autoUntil:'',autoSummarize:false}));setEditing(true);setNotice('连接已停用，已有记录保留');})}>停用连接</button></div>
   {wechat&&saved.autoReply&&<p role="status">自动起草已开启：红旗症状自动使用固定安全话术，其余按患者简报与知识库起草；草稿在随访页逐条审核，任何自动发送都不会发生。</p>}
   {wechat&&!usable&&(onMac?<MacPermissionHelp onRecheck={test} busy={busy}/>:<WindowsWechatHelp onRecheck={test} busy={busy}/>)}
   {usable?<div className="chat-setup-next"><h3>下一步：关联患者或家属</h3><p>选择患者，核对聊天对象。同步后的内容先进入待复核草稿。</p><a className="chat-next-link" href="/?view=followups&followupTab=chat">去关联患者会话 →</a></div>:<p className="muted">先重新检查连接，通过后再关联会话。已保存配置不代表当前服务可用。</p>}
   {usable&&<AutomaticSettings key={`${saved.channel}:${saved.revision}`} initial={saved} onSaved={value=>{accept(value);setNotice(value.autoUntil?'自动同步设置已保存':'自动同步已停止');}}/>}
  </section>:<>
   {wechat?<section className="chat-setup-detect"><h3>先检查本机微信</h3><p>{onMac?'打开并登录 Mac 微信，再检查客户端、辅助功能与录屏权限。':'打开并登录微信桌面版；读取与回复使用窗口自动化和系统本地 OCR，定位只按备注名精确匹配并核验头像，不会在微信中搜索。'}这一步不会读取聊天内容。</p>
    {check?<p role="status">{check.ready?'✓ ':''}{check.message}</p>:<p role="status">{busy?'正在自动检查本机微信…':'尚未检查，点击下方按钮开始。'}</p>}
    <button disabled={busy} onClick={test}>{busy?'正在检查…':'检查微信与权限'}</button>
    {check&&!check.ready&&(onMac?<MacPermissionHelp onRecheck={test} busy={busy}/>:<WindowsWechatHelp onRecheck={test} busy={busy}/>)}
   </section>:<section className="chat-setup-detect"><h3>{saved.accountId?'重新连接企业服务':'尚未配置企业服务'}</h3><p>医生使用已配置的企业连接，无需管理 SDK 或密钥。请由管理员完成一次接入，再关联患者会话。</p><button type="button" aria-expanded={admin} onClick={()=>setAdmin(v=>!v)}>{admin?'收起管理员配置':'管理员配置'}</button></section>}
   {(wechat?check?.ready:admin)&&<form className="chat-connection-form" onSubmit={e=>{e.preventDefault();act(async()=>{const value=await api(`/api/chat-followups/connections/${saved.channel}/connect`,'POST',{...form,revision:saved.revision,accountConfirmed:confirmed});accept(value);setCheck(value.status);if(value.enabled){setEditing(false);setNotice(wechat?'权限检查通过，账号核验声明已保存。请继续关联患者会话。':'企业服务验证通过，可以关联患者会话。');}else setNotice('配置已保存，但连接验证未通过，尚未启用。请按提示修正后重试。');});}}>
    <h3>{wechat?'核对你正在使用的账号':'管理员接入'}</h3>
    {wechat?<><p>微信桌面版不向应用暴露登录身份，需要你声明当前账号：填入当前登录的微信号。它只作本机的账号标记——所有会话关联都挂在它下面，换号后旧关联自动失效，避免把消息读进别的账号的会话。</p><label>已核对的微信号<input required maxLength={200} value={form.accountId} onChange={e=>update('accountId',e.target.value)} autoComplete="off" placeholder="例如 wangming_2024，不是昵称"/></label>{form.accountId&&!looksLikeWxid(form.accountId)&&<p className="chat-warn" role="note">这不太像微信号：微信号是 6–20 位、字母开头，只含字母/数字/下划线/减号；中文或空格多半是昵称。去哪看可展开下方说明。</p>}<details><summary>在微信里哪里看自己的微信号？</summary><ol><li>微信桌面版：左下角「☰」→ 设置 → 账号与安全 → 微信号。</li><li>手机微信：我 → 设置 → 账号与安全 → 微信号。</li><li>它以字母开头（未改过则是 wxid_ 开头），不是昵称，也不是绑定的手机号。</li></ol></details><label className="chat-check"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已在微信中核对当前登录账号，了解换号后需要重新关联</label></>:<><p>先开通会话存档，并由管理员部署采集服务。以下是服务的连接信息，不是患者或医生的微信登录信息。</p><label>企业 ID<input required maxLength={200} value={form.accountId} onChange={e=>update('accountId',e.target.value)}/></label><label>采集器地址<input required type="url" value={form.endpoint} onChange={e=>update('endpoint',e.target.value)} placeholder="管理员提供的 HTTPS 服务地址"/></label><label>采集器连接密钥<input required={!saved.hasToken} type="password" autoComplete="new-password" value={form.token} onChange={e=>update('token',e.target.value)} placeholder={saved.hasToken?'已保存，留空保留':'管理员提供的连接密钥'}/></label><details><summary>管理员需要准备什么？</summary><ol><li>确认会话存档权限和获准读取的员工范围。</li><li>部署随安装包提供的 integrations/wecom-archive 采集器，配置官方 SDK、存档 Secret 与 RSA 私钥。</li><li>在此填写企业 ID、服务地址与连接密钥，点击验证。</li></ol><p>存档 Secret 和私钥保留在采集器，不填入工作台。</p></details></>}
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
 return <form className="chat-connection-form" onSubmit={e=>{e.preventDefault();action(async()=>{const value=await api(`/api/chat-followups/connections/${form.channel}`,'POST',{...form,autoBindingId:form.autoWatch==='all'?'__all__':form.autoBindingId,autoUntil:automatic?form.autoUntil:'',automaticConsent:consent,modelConsent:form.modelConsent===true});onSaved(value);});}}>
  <details><summary>自动同步</summary><p>{form.channel==='wechat'?(form.autoWatch==='all'?'每到间隔自动监听会话列表：发现已关联会话有新消息（列表行内容变化）才定位进入读取，单轮最多读取 8 个会话；期间微信窗口会被周期性操作，请保持微信登录且窗口可见。':'定时读取一个已校准会话：应用按备注名自动定位并核验头像后读取，期间微信需保持登录且窗口可见；定位或核验失败时自动停止，不会自动搜索联系人。'):'同步已关联会话，保存原文并生成待复核草稿。'}默认只采集原文；可单独授权模型自动整理。工作台退出后停止运行。</p>
   <label className="chat-check"><input type="checkbox" checked={automatic} onChange={e=>{setAutomatic(e.target.checked);setConsent(false);}}/>在有限时段内自动同步</label>
   {automatic&&<>{form.channel==='wechat'&&<label>定时读取的会话<select required value={form.autoWatch==='all'?'__all__':(form.autoBindingId||'')} onChange={e=>{const all=e.target.value==='__all__';update('autoBindingId',all?'__all__':e.target.value);update('autoWatch',all?'all':'');setConsent(false);}}><option value="">请选择</option><option value="__all__">全部已关联会话（监听会话列表）</option>{(initial.availableBindings||[]).map(b=><option key={b.id} value={b.id}>{b.patientName} · {b.title}</option>)}</select></label>}<label className="chat-check"><input type="checkbox" checked={Boolean(form.autoSummarize)} onChange={e=>{update('autoSummarize',e.target.checked);update('modelConsent',false);}}/>自动调用当前模型整理新增草稿</label>{form.autoSummarize&&<label className="chat-check"><input type="checkbox" required checked={Boolean(form.modelConsent)} onChange={e=>update('modelConsent',e.target.checked)}/>允许在此时段内将新增草稿原文发送给当前模型服务；更换模型后重新授权</label>}<label>间隔（分钟）<input type="number" min="5" max="1440" value={form.intervalMinutes} onChange={e=>update('intervalMinutes',Number(e.target.value))}/></label><label>截止时间（最长 24 小时）<input type="datetime-local" required value={form.autoUntil?(()=>{const d=new Date(form.autoUntil);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16);})():''} onChange={e=>update('autoUntil',e.target.value?new Date(e.target.value).toISOString():'')}/></label><label className="chat-check"><input required type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>我确认在此时段内读取此账号已关联的会话{form.channel==='wechat'?(form.autoWatch==='all'?'中的全部会话，并允许显示与操作微信窗口':'中的上述会话，并允许显示微信窗口'):''}</label></>}
  </details>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <button disabled={busy} type="submit">保存自动同步设置</button>
  {initial.autoUntil&&Date.parse(initial.autoUntil)>Date.now()&&<button disabled={busy} type="button" onClick={()=>action(async()=>onSaved(await api(`/api/chat-followups/connections/${form.channel}`,'POST',{...initial,autoUntil:'',autoSummarize:false})))}>停止自动同步</button>}
 </form>;
}

export function AibotConnectionForm({initial,onSaved}) {
 const [saved,setSaved]=useState(initial),[form,setForm]=useState({...initial,token:'',autoReply:Boolean(initial.autoReply),autoReplyConsent:false}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const update=(key,value)=>setForm(v=>({...v,[key]:value}));
 const accept=value=>{setSaved(value);setForm(v=>({...value,token:'',autoReply:Boolean(value.autoReply),autoReplyConsent:false}));onSaved(value);};
 const act=async fn=>{setBusy(true);setError('');setNotice('');try{const message=await fn();if(typeof message==='string')setNotice(message);}catch(e){setError(e.message);}finally{setBusy(false);}};
 const toggleAutoReply=()=>act(async()=>{const next=!saved.autoReply;const value=await api(`/api/chat-followups/connections/${saved.channel}`,'POST',{...saved,autoReply:next,autoReplyConsent:next,enabled:saved.enabled});accept(value);return next?'已开启自动起草：@ 消息会自动生成待审核回复，不会自动发送。':'已关闭自动起草。';});
 return <div className="chat-setup"><h3>{saved.plugin?.name}</h3>
  <p>企微群聊里 @ 机器人的消息与患者单聊会实时进入工作台：绑定会话后进入待复核草稿或待分配消息。机器人只接收 @ 自己的群消息，看不到群里的其他聊天。</p>
  <details><summary>准备智能机器人</summary><ol><li>企业管理后台 → 智能机器人：创建机器人，连接方式选「长连接」并开启 API 模式。</li><li>把机器人页的 Bot ID 和 Secret 填到下方，验证后启用。</li><li>把机器人加进患者群（或在单聊中使用）。@ 消息实时到达；未绑定的会话先在关联页的会话列表中出现，绑定后新消息才入库。</li></ol></details>
  <form className="chat-connection-form" onSubmit={e=>{e.preventDefault();act(async()=>{const value=await api(`/api/chat-followups/connections/${saved.channel}/connect`,'POST',{...form,revision:saved.revision});accept(value);setNotice(value.enabled?'连接验证通过，长连接已启动。请去关联患者会话。':'配置已保存，但连接验证未通过，尚未启用。请核对 ID 与 Secret。');});}}>
   <label>机器人 ID（Bot ID）<input required maxLength={200} value={form.accountId} onChange={e=>update('accountId',e.target.value)} autoComplete="off"/></label>
   <label>机器人 Secret<input required={!saved.hasToken} type="password" autoComplete="new-password" value={form.token} onChange={e=>update('token',e.target.value)} placeholder={saved.hasToken?'已保存，留空保留':'企业管理后台机器人页的 Secret'}/></label>
   <label className="chat-check"><input type="checkbox" checked={Boolean(form.autoReply)} onChange={e=>{update('autoReply',e.target.checked);update('autoReplyConsent',false);}}/>自动起草回复（@ 消息自动生成待审核回复草稿，需医生逐条通过后才发送，永不自动发送）</label>
   {form.autoReply&&<label className="chat-check"><input required type="checkbox" checked={Boolean(form.autoReplyConsent)} onChange={e=>update('autoReplyConsent',e.target.checked)}/>允许将 @ 消息、患者简报与知识库片段发送给当前模型服务起草回复；红旗症状直接使用固定安全话术不经模型</label>}
   <button disabled={busy} type="submit">{busy?'正在验证…':'验证并启用连接'}</button>
  </form>
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
  <p role="status">{saved.status?.message}</p>
  {saved.enabled&&<><div className="toolbar-actions"><button disabled={busy} onClick={()=>act(async()=>{const status=await api(`/api/chat-followups/connections/${saved.channel}/test`,'POST',{});setSaved(v=>({...v,status}));})}>检查连接</button><button disabled={busy} onClick={toggleAutoReply}>{saved.autoReply?'关闭自动起草':'开启自动起草'}</button><button disabled={busy} onClick={()=>act(async()=>accept(await api(`/api/chat-followups/connections/${saved.channel}`,'POST',{...saved,enabled:false,autoUntil:'',autoSummarize:false})))}>停用连接</button></div><a className="chat-next-link" href="/?view=followups&followupTab=chat">去关联患者会话 →</a><AutomaticSettings key={`${saved.channel}:${saved.revision}`} initial={saved} onSaved={accept}/></>}
  <p className="muted">最近同步：{when(saved.lastSyncAt)}{saved.lastError?` · ${saved.lastError}`:''}</p>
 </div>;
}

export function ServiceConnectionForm({initial,onSaved}) {
 const [saved,setSaved]=useState(initial),[form,setForm]=useState({...initial,token:''}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const wx=saved.plugin?.protocol==='wx-cli';
 const update=(key,value)=>setForm(v=>({...v,[key]:value}));
 const accept=value=>{setSaved(value);setForm({...value,token:''});onSaved(value);};
 const act=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
 return <div className="chat-setup"><h3>{saved.plugin?.name}</h3>
  <p>{wx?'连接已启动的 wx-cli 服务，读取本机数据库中的历史消息。选择会话并关联患者后，同步内容进入待复核草稿。':'连接兼容采集服务，关联患者会话后同步原文，核对并归档。'}</p>
  {wx&&<details><summary>准备 wx-cli 服务</summary><p>在运行微信的 Mac 上安装并配置 wx-cli，再运行 <code>wx-cli server run</code>。使用 <code>wx-cli server status --format json</code> 查看 current_account.wxid，填写到下方账号 ID。</p><p>密钥和数据库由 wx-cli 管理；本插件读取文本及媒体描述，暂不解码附件或发送消息。首次同步扫描所关联会话的本地历史。自动同步间隔至少 5 分钟。</p><a href="https://github.com/pandorafuture/wx-cli" target="_blank" rel="noreferrer">wx-cli 安装与支持范围</a></details>}
  <form className="chat-connection-form" onSubmit={e=>{e.preventDefault();act(async()=>accept(await api(`/api/chat-followups/connections/${saved.channel}/connect`,'POST',{...form,revision:saved.revision})));}}>
   <label>{wx?'账号 ID（current_account.wxid）':'账号 ID（采集协议 corpId）'}<input required maxLength={200} value={form.accountId} onChange={e=>update('accountId',e.target.value)} autoComplete="off"/></label>
   <label>服务地址<input required type="url" value={form.endpoint} onChange={e=>update('endpoint',e.target.value)} placeholder={wx?'http://127.0.0.1:9100':'https://collector.example.com'}/></label>
   <label>连接密钥<input type="password" value={form.token} onChange={e=>update('token',e.target.value)} autoComplete="new-password" placeholder={saved.hasToken?'已保存，留空保留':wx?'本机未设置 token 时可留空':'采集服务的 Bearer token'}/></label>
   <button disabled={busy} type="submit">{busy?'正在连接…':'验证并启用连接'}</button>
  </form>
  <p role="status">{saved.status?.message}</p>{error&&<p role="alert">{error}</p>}
  {saved.enabled&&<><div className="toolbar-actions"><button disabled={busy} onClick={()=>act(async()=>{const status=await api(`/api/chat-followups/connections/${saved.channel}/test`,'POST',{});setSaved(v=>({...v,status}));})}>检查已保存连接</button><button disabled={busy} onClick={()=>{if(window.confirm('下次同步将重新扫描已关联会话的全部本地历史，已保存消息会去重。继续？'))act(async()=>accept(await api(`/api/chat-followups/connections/${saved.channel}/rescan`,'POST',{revision:saved.revision,confirmed:true})));}}>重新扫描历史</button><button disabled={busy} onClick={()=>act(async()=>accept(await api(`/api/chat-followups/connections/${saved.channel}`,'POST',{...saved,enabled:false,autoUntil:'',autoSummarize:false})))}>停用连接</button></div><a className="chat-next-link" href="/?view=followups&followupTab=chat">去关联患者会话 →</a><AutomaticSettings key={`${saved.channel}:${saved.revision}`} initial={saved} onSaved={accept}/></>}
  <p className="muted">最近同步：{when(saved.lastSyncAt)}{saved.lastError?` · ${saved.lastError}`:''}</p>
 </div>;
}
