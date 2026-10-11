import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
import {DeepSeekProvider} from '../server/provider.mjs';
import {PermissionEngine} from '../server/core/permissions.mjs';
import {RunProgress} from '../server/core/run-progress.mjs';
const tc=(name,args={})=>({id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
async function setup(t,provider){
 const f=await fixture(t,{provider});const patient=(await f.json('/api/patients','POST',{name:'合成方案评估患者',medications:[{name:'合成药',status:'unknown'}]})).data;
 await f.json(`/api/sessions/${patient.sessionId}/files`,'POST',{name:'方案.txt',text:'合成既往治疗方案，日期2025-08-14。\n用药状态尚待核对。'});
 const session=(await f.json(`/api/sessions/${patient.sessionId}`)).data;
 return {...f,patient,session};
}
test('assessment uses focused tools, validates read citations, delivers one draft and terminates',async t=>{
 const provider=new DeepSeekProvider({apiKey:'synthetic',model:'test'});let n=0,sourceId;
 provider.complete=async(messages,tools)=>{
  n++;assert.ok(n<=4,'must terminate, not repeat drafting');
  if(n===1){assert.ok(tools.length<=12);assert.ok(tools.some(t=>t.function.name==='knowledge_collections'));assert.ok(tools.some(t=>t.function.name==='web_search'));assert.ok(!tools.some(t=>t.function.name==='code_execute'));return {message:{role:'assistant',content:'正在核对',tool_calls:[tc('read_patient_brief'),tc('read_source',{sourceId,startLine:1,endLine:2})]}};}
  if(n===2){assert.ok(messages.some(m=>m.name==='runtime_observations'));return {message:{role:'assistant',content:'',tool_calls:[tc('draft_treatment_review',{summary:'仅能核对历史方案，当前状态待确认。',concerns:['需核实目前是否仍使用'],infoGaps:['缺少近期检查'],questions:['是否已有新医嘱？'],citations:[{sourceId,startLine:1,endLine:2}]})]}};}
  assert.equal(tools.length,0);return {message:{role:'assistant',content:'## 结论\n资料不足以判断当前方案，以上为待医生复核草稿。\n\n## 依据\n方案.txt 第1–2行。'}};
 };
 const f=await setup(t,provider);sourceId=f.session.files[0].id;
 const result=await f.chat(f.session.id,'这个患者的治疗方案是否合理',{mode:'standard',externalConsent:true,fileIds:[sourceId]});
 assert.equal(result.status,200);assert.doesNotMatch(result.text,/"type":"error"/);
 const s=(await f.json(`/api/sessions/${f.session.id}`)).data;
 assert.equal(s.runs.at(-1).status,'completed');assert.equal(s.runs.at(-1).outcome,'delivered');assert.equal(s.runs.at(-1).delivery.delivered,true);assert.equal(s.runs.at(-1).policy.workflow,'patient-assessment');assert.equal(s.artifacts.length,1);assert.equal(s.artifacts[0].matches.length,1);assert.equal(n,2,'persisted terminal draft needs no extra model request');
 assert.match(s.messages.at(-1).content,/需要核对的事项/);assert.doesNotMatch(s.messages.at(-1).content,/正在核对/);
});
test('verified evidence survives loss of conversation; invalid or unread citations cannot deliver',async t=>{
 const f=await setup(t,new DeepSeekProvider({apiKey:'synthetic',model:'test'}));
 const prepared=f.server.sessionBridge.prepareSend(f.session.id,{message:'治疗方案是否合理',mode:'standard',externalConsent:true,fileIds:f.session.files.map(f=>f.id)});
 const handle=prepared.handle, registry=f.server.workspaces.registry(f.session.id,handle.run.id),perms=new PermissionEngine({profile:'standard',grants:{}}),context={sources:handle.sources};
 const sourceId=f.session.files[0].id, args={summary:'合成草稿',concerns:[],infoGaps:[],questions:[],citations:[{sourceId,startLine:1,endLine:2}]};
 await assert.rejects(registry.execute('draft_treatment_review',args,context,perms),/本轮已读取/);
 const progress=new RunProgress(),call=tc('read_source',{sourceId,startLine:1,endLine:2}), archives=new Map();
 const output=await registry.execute('read_source',JSON.parse(call.function.arguments),context,perms);
 const save=async value=>{const id=String(archives.size);archives.set(id,value);return{id};};
 await progress.record(call,output,registry.get('read_source'),save);
 const restored=new RunProgress(progress.snapshot());assert.match(restored.message(10000).content,/日期2025-08-14/);
 assert.equal((await restored.record(call,output,registry.get('read_source'),save)).unchanged,true);
 const result=await registry.execute('draft_treatment_review',args,context,perms);assert.equal(result.matches[0].sourceId,sourceId);assert.equal(registry.definitions(perms).length,0);
 const again=await registry.execute('draft_treatment_review',args,context,perms);assert.equal(again.id,result.id);
 f.server.sessionBridge.cancel(f.session.id);
});

test('failed-run draft archival is reversible and never changes clinical review status',async t=>{
 const f=await setup(t,new DeepSeekProvider({apiKey:'synthetic',model:'test'}));
 f.server.workspaces.store.update(f.session.id,w=>{w.runs.push({id:'failed-assessment',status:'cancelled',artifacts:[{id:'draft-one',status:'draft',type:'treatment_review'},{id:'approved-one',status:'approved',type:'treatment_review'}]});});
 const path=`/api/sessions/${f.session.id}/runs/failed-assessment/archive-drafts`;
 assert.equal((await f.json(path,'POST',{archived:true})).status,200);
 let session=(await f.json(`/api/sessions/${f.session.id}`)).data;
 assert.deepEqual(session.artifacts.map(a=>a.id),['approved-one']);
 assert.equal(session.runs.at(-1).artifacts[0].status,'draft');
 await f.json(path,'POST',{archived:false});session=(await f.json(`/api/sessions/${f.session.id}`)).data;
 assert.equal(session.artifacts.length,2);
});
test('research has a reserved delivery phase and missing draft cannot appear completed',async t=>{
 const f=await setup(t,new DeepSeekProvider({apiKey:'synthetic',model:'test'}));
 const prepared=f.server.sessionBridge.prepareSend(f.session.id,{message:'治疗方案是否合理',mode:'standard',externalConsent:true,fileIds:f.session.files.map(f=>f.id)});
 const registry=f.server.workspaces.registry(f.session.id,prepared.handle.run.id),perms=new PermissionEngine({profile:'standard',grants:{}});
 for(let n=0;n<18;n++) await registry.execute('read_patient_brief',{}, {sources:prepared.handle.sources},perms);
 assert.deepEqual(registry.definitions(perms).map(t=>t.function.name),['draft_treatment_review']);
 await assert.rejects(registry.execute('read_patient_brief',{}, {sources:prepared.handle.sources},perms),/核对阶段已结束/);
 const {assessmentAnswer}=await import('../server/medical/assessment-tools.mjs');
 assert.throws(()=>assessmentAnswer(f.server.workspaces.store.get(f.session.id),prepared.handle.run.id,{text:'自称已完成'}),/未完成/);
 f.server.sessionBridge.cancel(f.session.id);
});

// 患者页一键入口：显式 workflow 路由不依赖草稿文本命中正则。
test('explicit workflow routes assessment even when the message misses the regex',async t=>{
 const provider=new DeepSeekProvider({apiKey:'synthetic',model:'test'});let n=0,sourceId;
 provider.complete=async()=>{
  n++;
  if(n===1)return {message:{role:'assistant',content:'正在核对',tool_calls:[tc('read_patient_brief'),tc('read_source',{sourceId,startLine:1,endLine:2})]}};
  if(n===2)return {message:{role:'assistant',content:'',tool_calls:[tc('draft_treatment_review',{summary:'仅能核对历史方案，当前状态待确认。',concerns:[],infoGaps:['缺少近期检查'],questions:[],citations:[{sourceId,startLine:1,endLine:2}]})]}};
  return {message:{role:'assistant',content:'## 结论\n以上为待医生复核草稿。'}};
 };
 const f=await setup(t,provider);sourceId=f.session.files[0].id;
 // 这句话不匹配 assessmentQuestion 正则；靠 workflow 字段路由。
 const result=await f.chat(f.session.id,'帮我看看现在这套处理对不对',{mode:'standard',externalConsent:true,fileIds:[sourceId],workflow:'patient-assessment'});
 assert.equal(result.status,200);
 const s=(await f.json(`/api/sessions/${f.session.id}`)).data;
 assert.equal(s.runs.at(-1).policy.workflow,'patient-assessment','显式 workflow 应路由到评估工作流');
 assert.equal(s.artifacts.length,1);
 // 同样的话不带 workflow 字段则走普通会话，不产生评估产物。
 const plain=await f.chat(f.session.id,'帮我看看现在这套处理对不对',{mode:'standard',externalConsent:true,fileIds:[sourceId],conversationParentRunId:null});
 assert.equal(plain.status,200);
 const s2=(await f.json(`/api/sessions/${f.session.id}`)).data;
 assert.notEqual(s2.runs.at(-1).policy.workflow,'patient-assessment');
});

// 联网搜索作为第三级证据源：保留在工具面并有独立预算，超限即拒绝。
test('web_search stays in the assessment toolset with its own budget',async t=>{
 const f=await setup(t,new DeepSeekProvider({apiKey:'synthetic',model:'test'}));
 const prepared=f.server.sessionBridge.prepareSend(f.session.id,{message:'治疗方案是否合理',mode:'standard',externalConsent:true,fileIds:f.session.files.map(x=>x.id)});
 const registry=f.server.workspaces.registry(f.session.id,prepared.handle.run.id),perms=new PermissionEngine({profile:'standard',grants:{}});
 const context={sources:prepared.handle.sources};
 // 内核 web_search 不联网也能确认预算包装：前三次执行放行，第四次拒绝。
 for(let n=0;n<3;n++) await assert.doesNotReject(()=>registry.execute('web_search',{query:'synthetic budget probe'},context,perms).catch(error=>{
  // 引擎链在本机可能返回 source-failure，属于正常结果而非预算拒绝。
  if(/ASSESSMENT_WEB_LIMIT/.test(error.message)) throw error;
 }));
 await assert.rejects(()=>registry.execute('web_search',{query:'synthetic over budget'},context,perms),/联网搜索预算已用完/);
 assert.ok(registry.definitions(perms).some(x=>x.function.name==='web_search'));
 f.server.sessionBridge.cancel(f.session.id);
});
