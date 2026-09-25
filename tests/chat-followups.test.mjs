import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { WecomArchiveClient, sequence } from '../server/chat-connectors/wecom-archive.mjs';
const config = { enabled:true,accountId:'synthetic-corp',endpoint:'http://127.0.0.1:9911',token:'not-a-real-token',revision:0 };
const msg=(id,seq='1')=>({id,seq,conversationId:'member:doctor/customer:family',senderId:'family',type:'text',direction:'in',sentAt:'2026-09-25T00:00:00.000Z',text:'合成测试：家属转述已预约复查'});
async function setup(t,overrides={}) {
  const f=await fixture(t,{chatFollowups:{archive:{status:async()=>({ready:true}),read:async()=>({messages:[msg('m1')],nextCursor:'1',hasMore:false})},...overrides}});
  const patient=(await f.json('/api/patients','POST',{name:'聊天合成患者'})).data;
  await f.json('/api/chat-followups/connections/wecom','POST',config);
  const bind=async(pid=patient.id)=>(await f.json('/api/chat-followups/bindings','POST',{patientId:pid,channel:'wecom',title:'测试家属',speakerName:'合成家属',relationship:'family',senderId:'family',conversationId:msg('x').conversationId,confirmed:true}));
  return {...f,patient,bind};
}
test('settings independently persist, redact credentials and reject stale or insecure configuration',async t=>{
 const f=await setup(t); const result=(await f.json('/api/chat-followups/settings')).data;
 assert.equal(result.connections[1].hasToken,true); assert.doesNotMatch(JSON.stringify(result),/not-a-real-token/);
 assert.equal(result.connections[0].enabled,false);
 assert.equal((await f.json('/api/chat-followups/connections/wecom','POST',config)).status,409);
 assert.equal((await f.json('/api/chat-followups/connections/wecom','POST',{...config,revision:1,endpoint:'http://example.com'})).status,400);
 assert.equal((await fetch(f.origin+'/api/chat-followups/settings')).status,401);
});
test('family binding -> sync -> source draft -> edit -> archive once; no automatic patient-message ingestion',async t=>{
 const f=await setup(t); assert.equal((await f.bind()).status,201);
 let sync=await f.json('/api/chat-followups/connections/wecom/sync','POST',{consent:true}); assert.equal(sync.status,200); assert.equal(sync.data.added,1);
 sync=await f.json('/api/chat-followups/connections/wecom/sync','POST',{consent:true}); assert.equal(sync.data.added,0);
 let state=(await f.json(`/api/chat-followups/patients/${f.patient.id}`)).data; assert.equal(state.drafts.length,1); let d=state.drafts[0]; assert.match(d.sourceText,/家属转述/); assert.equal(d.note,'');
 assert.equal((await f.json(`/api/patients/${f.patient.id}/messages`)).data.messages.length,0);
 assert.equal((await f.json(`/api/chat-followups/drafts/${d.id}/summarize`,'POST',{revision:d.revision})).status,412);
 d=(await f.json(`/api/chat-followups/drafts/${d.id}/save`,'POST',{revision:d.revision,note:'已核实家属反馈，复查预约待医生确认。'})).data;
 assert.equal((await f.json(`/api/chat-followups/drafts/${d.id}/archive`,'POST',{revision:d.revision,note:d.note,contactedAt:'2026-09-25T00:00:00Z'})).status,409);
 const input={revision:d.revision,note:d.note,contactedAt:'2026-09-25T00:00:00Z',confirmed:true};
 const first=await f.json(`/api/chat-followups/drafts/${d.id}/archive`,'POST',input); assert.equal(first.status,200); assert.equal(first.data.status,'archived');
 assert.equal((await f.json(`/api/chat-followups/drafts/${d.id}/archive`,'POST',input)).data.recordId,first.data.recordId);
 assert.equal((await f.json(`/api/chat-followups/drafts/${d.id}/sources`)).data.messages.length,1);
});
test('shared family conversation remains unassigned until explicit patient selection',async t=>{
 const f=await setup(t); await f.bind(); const p=(await f.json('/api/patients','POST',{name:'第二位合成患者'})).data; await f.bind(p.id);
 await f.json('/api/chat-followups/connections/wecom/sync','POST',{consent:true});
 const state=(await f.json(`/api/chat-followups/patients/${f.patient.id}`)).data; assert.equal(state.drafts.length,0); assert.equal(state.inbox.length,1);
 const input={bindingId:state.bindings[0].id,messageIds:[state.inbox[0].id],confirmed:true};
 assert.equal((await f.json('/api/chat-followups/assign','POST',input)).status,201);
 assert.equal((await f.json('/api/chat-followups/assign','POST',input)).status,409);
 assert.equal((await f.json(`/api/chat-followups/patients/${p.id}`)).data.inbox.length,0);
});
test('failed page does not advance checkpoint; changed account prevents old binding reuse',async t=>{
 const f=await setup(t,{archive:{read:async()=>{throw Error('private upstream details');}}}); await f.bind();
 assert.equal((await f.json('/api/chat-followups/connections/wecom/sync','POST',{consent:true})).status,502);
 assert.equal(f.server.chatFollowups.config('wecom').cursor,'0'); assert.doesNotMatch(JSON.stringify(f.server.chatFollowups.settings()),/private upstream/);
 await f.json('/api/chat-followups/connections/wecom','POST',{...config,revision:1,accountId:'new-corp'});
 const state=(await f.json(`/api/chat-followups/patients/${f.patient.id}`)).data; assert.equal(state.bindings[0].currentAccount,false);
});
test('collector protocol retains uint64 strings, refuses corp mismatch, redirect and malformed cursor',async()=>{
 assert.equal(sequence('18446744073709551615'),'18446744073709551615'); assert.throws(()=>sequence(9007199254740992));
 let payload={version:1,corpId:config.accountId,messages:[msg('large','9007199254740994')],nextCursor:'9007199254740994',hasMore:false};
 const client=new WecomArchiveClient({fetch:async(_url,init)=>{assert.equal(init.redirect,'error');return Response.json(payload);}});
 assert.equal((await client.read(config,'9007199254740993')).nextCursor,payload.nextCursor);
 payload={...payload,corpId:'wrong'}; await assert.rejects(client.read(config,'0'),/企业 ID/);
 payload={...payload,corpId:config.accountId,nextCursor:'0',hasMore:true}; await assert.rejects(client.read(config,'0'),/没有向前/);
});
test('cancel and account switch invalidate in-flight pages before any write',async t=>{
 let release,started;const began=new Promise(r=>started=r);
 const f=await setup(t,{archive:{read:()=>{started();return new Promise(r=>release=r);}}});await f.bind();
 const pending=f.json('/api/chat-followups/connections/wecom/sync','POST',{consent:true});await began;
 assert.equal((await f.json('/api/chat-followups/connections/wecom/sync','POST',{consent:true})).status,409);
 await f.json('/api/chat-followups/connections/wecom/cancel','POST',{});
 release({messages:[msg('cancelled')],nextCursor:'1',hasMore:false});assert.equal((await pending).status,409);
 assert.equal(f.server.chatFollowups.config('wecom').cursor,'0');assert.equal(f.server.store.db.prepare('SELECT COUNT(*) n FROM chat_messages').get().n,0);
});
test('unbinding preserves archived sources, including after account change, and stops future ingestion',async t=>{
 const f=await setup(t);const b=(await f.bind()).data;await f.json('/api/chat-followups/connections/wecom/sync','POST',{consent:true});
 const d=(await f.json(`/api/chat-followups/patients/${f.patient.id}`)).data.drafts[0];
 await f.json(`/api/chat-followups/drafts/${d.id}/archive`,'POST',{confirmed:true,revision:0,note:'测试人工核实',contactedAt:'2026-09-25T00:00:00Z'});
 await f.json('/api/chat-followups/connections/wecom','POST',{...config,revision:1,accountId:'different-corp'});
 assert.equal((await f.json(`/api/chat-followups/bindings/${b.id}`,'DELETE')).status,200);
 assert.equal((await f.json(`/api/chat-followups/drafts/${d.id}/sources`)).data.messages.length,1);
 assert.equal((await f.json(`/api/chat-followups/patients/${f.patient.id}`)).data.bindings.length,0);
 f.server.patients.remove(f.patient.id);
 assert.equal(f.server.store.db.prepare('SELECT COUNT(*) n FROM chat_messages').get().n,0);
});
test('completed pages survive later failure; retry does not duplicate a draft',async t=>{
 let fail=true; const f=await setup(t,{archive:{read:async(_c,cursor)=>{if(cursor==='0')return{messages:[msg('first')],nextCursor:'1',hasMore:true};if(fail)throw Error('failure');return{messages:[msg('second','2')],nextCursor:'2',hasMore:false};}}});await f.bind();
 assert.equal((await f.json('/api/chat-followups/connections/wecom/sync','POST',{consent:true})).status,502);assert.equal(f.server.chatFollowups.config('wecom').cursor,'1');
 fail=false;assert.equal((await f.json('/api/chat-followups/connections/wecom/sync','POST',{consent:true})).status,200);
 assert.equal((await f.json(`/api/chat-followups/patients/${f.patient.id}`)).data.drafts.length,2);
});
test('wechat requires calibrated, fresh identity proof and retains unknown speakers and times',async t=>{
 let observed='合成微信会话';const wechat={status:async()=>({ready:true}),capture:async()=>({image:'c3ludGhldGlj',width:1000,height:800}),title:async()=>observed,read:async()=>({text:'合成可见文字',fingerprint:'frame1',evidence:{coverage:'visible-window'}})};
 const f=await setup(t,{wechat});await f.json('/api/chat-followups/connections/wechat','POST',{enabled:true,accountId:'synthetic-account',revision:0});
 const preview=(await f.json('/api/chat-followups/preview','POST',{consent:true})).data;
 const input={channel:'wechat',patientId:f.patient.id,title:'合成微信会话',speakerName:'合成亲属',relationship:'family',confirmed:true,previewId:preview.id,titleRegion:{x:.4,y:.02,width:.3,height:.08},messageRegion:{x:.4,y:.12,width:.58,height:.6}};
 observed='另一个会话';assert.equal((await f.json('/api/chat-followups/bindings','POST',input)).status,409);
 observed=input.title;const b=(await f.json('/api/chat-followups/bindings','POST',input)).data;
 assert.equal((await f.json('/api/chat-followups/connections/wechat/sync','POST',{consent:true,bindingId:b.id})).status,200);
 const d=(await f.json(`/api/chat-followups/patients/${f.patient.id}`)).data.drafts[0];assert.match(d.sourceText,/发送时间未识别.*发言人待核验/);
 assert.equal((await f.json('/api/chat-followups/connections/wechat/sync','POST',{consent:true,bindingId:b.id})).data.added,0);
});
test('AI receives fixed source only and cannot overwrite a concurrently edited draft',async t=>{
 let release,started;const began=new Promise(r=>started=r);const f=await setup(t,{provider:()=>({complete:async(messages,tools)=>{assert.equal(tools.length,0);assert.match(messages[1].content,/家属转述/);started();return new Promise(r=>release=r);}})});await f.bind();await f.json('/api/chat-followups/connections/wecom/sync','POST',{consent:true});
 const d=(await f.json(`/api/chat-followups/patients/${f.patient.id}`)).data.drafts[0];
 const pending=f.json(`/api/chat-followups/drafts/${d.id}/summarize`,'POST',{revision:0,externalConsent:true});await began;
 await f.json(`/api/chat-followups/drafts/${d.id}/save`,'POST',{revision:0,note:'医生已经修改'});release({message:{content:'晚到的模型结果'}});
 assert.equal((await pending).status,409);assert.equal(f.server.chatFollowups.draft(d.id).note,'医生已经修改');
});
test('automatic AI requires separate consent, processes new sources once, and stops on model changes',async t=>{
 let calls=0; const provider={model:'synthetic',baseUrl:'http://synthetic.invalid',complete:async()=>{calls++;return{message:{content:'合成自动整理草稿'}};}};
 const f=await setup(t,{provider:()=>provider});await f.bind();const s=f.server.chatFollowups;
 const input={...config,revision:1,autoUntil:new Date(Date.now()+3600000).toISOString(),automaticConsent:true,autoSummarize:true};
 assert.equal((await f.json('/api/chat-followups/connections/wecom','POST',input)).status,412);
 assert.equal((await f.json('/api/chat-followups/connections/wecom','POST',{...input,modelConsent:true})).status,200);
 await s.tick();assert.equal(calls,1);assert.equal(s.list(f.patient.id).drafts[0].note,'合成自动整理草稿');
 const c=s.config('wecom');c.nextRun=0;s.write(c);await s.tick();assert.equal(calls,1);
 provider.model='changed';c.nextRun=0;s.write(c);await s.tick();assert.equal(s.config('wecom').autoSummarize,false);assert.match(s.config('wecom').lastError,/模型配置已改变/);
});
test('cancel prevents an in-flight model response from updating a draft',async t=>{
 let release,started;const began=new Promise(r=>started=r);
 const f=await setup(t,{provider:()=>({complete:async()=>{started();return new Promise(r=>release=r);}})});await f.bind();await f.server.chatFollowups.sync('wecom',{consent:true});
 const d=f.server.chatFollowups.list(f.patient.id).drafts[0];const pending=f.json(`/api/chat-followups/drafts/${d.id}/summarize`,'POST',{revision:0,externalConsent:true});await began;
 f.server.chatFollowups.cancel('wecom');release({message:{content:'不得写入'}});assert.equal((await pending).status,409);assert.equal(f.server.chatFollowups.draft(d.id).note,'');
});
test('draft pagination exposes all records beyond the first page',async t=>{
 const f=await setup(t);const b=(await f.bind()).data;const s=f.server.chatFollowups;
 for(let i=0;i<25;i++)s.ingest(s.config('wecom'),[msg(`page-${i}`)]);
 assert.equal(s.list(f.patient.id).drafts.length,20);assert.equal(s.list(f.patient.id).total,25);assert.equal(s.list(f.patient.id,20).drafts.length,5);assert.equal(s.list(f.patient.id,20).bindings[0].id,b.id);
});
test('group messages require attribution even when only one patient is bound',async t=>{
 const f=await setup(t);const s=f.server.chatFollowups;
 await f.json('/api/chat-followups/bindings','POST',{patientId:f.patient.id,channel:'wecom',title:'合成群聊',speakerName:'家属',relationship:'family',conversationId:'room:synthetic',confirmed:true});
 s.ingest(s.config('wecom'),[{...msg('group-message'),conversationId:'room:synthetic'}]);
 assert.equal(s.list(f.patient.id).drafts.length,0);assert.equal(s.list(f.patient.id).inbox.length,1);
});
test('setup checks permissions before configuration; failed validation saves but never enables',async t=>{
 let ready=false;const f=await setup(t,{wechat:{status:async()=>({ready,message:ready?'权限可用':'缺少权限'})}});
 assert.equal((await f.json('/api/chat-followups/connections/wechat/test','POST',{})).data.ready,false);
 assert.equal(f.server.chatFollowups.config('wechat').revision,0);
 const input={accountId:'synthetic',revision:0,accountConfirmed:true};
 assert.equal((await f.json('/api/chat-followups/connections/wechat/connect','POST',{...input,accountConfirmed:false})).status,412);
 let c=(await f.json('/api/chat-followups/connections/wechat/connect','POST',input)).data;assert.equal(c.enabled,false);assert.equal(c.status.ready,false);
 ready=true;c=(await f.json('/api/chat-followups/connections/wechat/connect','POST',{...input,revision:c.revision})).data;assert.equal(c.enabled,true);assert.ok(c.accountConfirmedAt);assert.equal(c.status.ready,true);
});
test('title region suggestions use only one exact confident upper-window match',async t=>{
 let lines=[{text:'测试标题',confidence:.95,box:{x:.4,y:.04,width:.2,height:.03}}];
 const f=await setup(t,{wechat:{capture:async()=>({image:'synthetic',width:1000,height:800,lines}),status:async()=>({ready:true})}});
 await f.json('/api/chat-followups/connections/wechat','POST',{enabled:true,accountId:'synthetic',revision:0});
 const preview=()=>f.json('/api/chat-followups/preview','POST',{consent:true,title:'测试标题'});
 assert.ok((await preview()).data.suggestedTitleRegion);lines.push({...lines[0]});assert.equal((await preview()).data.suggestedTitleRegion,null);
});

test('Mac schedules pin one calibrated binding and stop on mismatch; legacy rotation is disabled',async t=>{
 const reads=[];const f=await setup(t,{wechat:{capture:async()=>({image:'fixture',width:1000,height:800}),title:async()=> '合成微信会话',read:async b=>{reads.push(b.id);throw Error('mismatch');}}});const s=f.server.chatFollowups;
 s.save('wechat',{enabled:true,accountId:'synthetic',revision:0});
 const p=await s.preview({consent:true});const b=await s.bind({patientId:f.patient.id,channel:'wechat',title:'合成微信会话',speakerName:'家属',relationship:'family',confirmed:true,previewId:p.id,titleRegion:{x:.4,y:.02,width:.3,height:.06},messageRegion:{x:.4,y:.12,width:.58,height:.6}});
 const input={...s.config('wechat'),automaticConsent:true,autoUntil:new Date(Date.now()+3600000).toISOString()};
 assert.throws(()=>s.save('wechat',input));s.save('wechat',{...input,autoBindingId:b.id});await s.tick();assert.deepEqual(reads,[b.id]);assert.equal(s.config('wechat').autoUntil,'');
 const c=s.config('wechat');c.autoUntil=new Date(Date.now()+3600000).toISOString();c.autoBindingId='';c.nextRun=0;s.write(c);await s.tick();assert.deepEqual(reads,[b.id]);assert.equal(s.config('wechat').autoUntil,'');
});
