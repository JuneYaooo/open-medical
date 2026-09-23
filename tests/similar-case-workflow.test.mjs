import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
import {DeepSeekProvider} from '../server/provider.mjs';
import {ToolRegistry} from '../server/core/tool-registry.mjs';
import {PermissionEngine} from '../server/core/permissions.mjs';
import {configureSimilarCaseTools,similarCaseQuestion} from '../server/medical/similar-case-workflow.mjs';
const call=(name,args={})=>({id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
test('similar case question routes away from chart extraction and delivers one report',async t=>{
 const provider=new DeepSeekProvider({apiKey:'test',model:'test'});let round=0;
 provider.complete=async (_messages,tools)=>{
  round++;
  if(round===1){assert.ok(tools.length<=9);assert.ok(!tools.some(t=>t.function.name==='code_execute'));return{message:{role:'assistant',content:'读取档案',tool_calls:[call('read_patient_brief'),call('similar_case_search',{caseText:'合成患者',diagnosis:'合成疾病',limit:3})]}};}
  if(round===2)return{message:{role:'assistant',content:'',tool_calls:[call('finish_similar_case_search',{summary:'本地未找到候选，未做网上检索。',items:[],limitations:['未覆盖网上病例']})]}};
  assert.equal(tools.length,0);return{message:{role:'assistant',content:'结束'}};
 };
 const f=await fixture(t,{provider});const p=(await f.json('/api/patients','POST',{name:'合成相似病例测试'})).data;
 await f.chat(p.sessionId,'看下这个患者的相似病例，只查本地',{mode:'standard',externalConsent:true});
 const s=(await f.json(`/api/sessions/${p.sessionId}`)).data;
 assert.equal(s.runs.at(-1).policy.workflow,'similar-case-search');assert.equal(s.runs.at(-1).status,'completed');assert.equal(s.runs.at(-1).outcome,'delivered');assert.equal(s.runs.at(-1).delivery.delivered,true);assert.equal(s.artifacts.length,1);assert.equal(s.artifacts[0].type,'similar_cases');assert.doesNotMatch(s.messages.at(-1).content,/读取档案/);assert.match(s.messages.at(-1).content,/本地检索返回 0/);
 // Old answer-with-artifact records are rechecked without rewriting the audit.
 f.server.workspaces.store.update(p.sessionId,w=>{
  const r=w.runs.at(-1);r.outcome='delivery_failed';r.delivery.delivered=false;
  r.delivery.gaps=[{reason:'no_verifiable_output',detail:'Old classifier error'}];
  w.messages.at(-1).outcome='delivery_failed';
 });
 let projected=f.server.sessionBridge.get(p.sessionId);
 assert.equal(projected.runs.at(-1).outcome,'delivered');
 assert.equal(projected.messages.at(-1).outcome,'delivered');
 assert.equal(f.server.workspaces.store.get(p.sessionId).runs.at(-1).outcome,'delivery_failed');
 f.server.workspaces.store.update(p.sessionId,w=>{
  w.runs.at(-1).toolFailures={write:{affectsDelivery:true,callId:'failed-write'}};
 });
 projected=f.server.sessionBridge.get(p.sessionId);
 assert.equal(projected.runs.at(-1).outcome,'delivery_failed');
 assert.equal(projected.messages.at(-1).outcome,'delivery_failed');

});
test('search requests are memoized, bounded and citations must be retrieved',async()=>{
 const registry=new ToolRegistry();let searches=0;
 for(const name of ['online_case_search','literature_fetch','read_patient_brief'])registry.register({permission:'tools.execute',capability:{backend:'local'},definition:{type:'function',function:{name,description:name,parameters:{type:'object',additionalProperties:true}}},execute:async args=>{
  if(name==='online_case_search'){searches++;return{candidates:[{pmid:'12345',title:'Synthetic case'}],searches:[{status:'ok'}]};}
  if(name==='literature_fetch')return{pmid:args.pmid,abstract:'Synthetic verified excerpt.'};
  return{generatedAt:Date.now(),name:'Synthetic patient'};
 }});
 configureSimilarCaseTools(registry,{materials:[]},{artifacts:[]});
 const permissions=new PermissionEngine({profile:'standard',grants:{}}),execute=(n,a)=>registry.execute(n,a,{},permissions);
 await execute('online_case_search',{query:'disease'});await execute('online_case_search',{query:'disease'});assert.equal(searches,1);
 await assert.rejects(execute('literature_fetch',{pmid:'999'}),/已返回/);
 await execute('literature_fetch',{pmid:'12345'});
 const draft={summary:'合成结果',items:[{reference:'12345',reason:'疾病关键词相关',differences:'治疗状态未知',quote:'Fabricated text'}],limitations:[]};
 await assert.rejects(execute('finish_similar_case_search',draft),/连续原文/);
 for(let i=4;i<16;i++)await execute('online_case_search',{query:'disease'});
 assert.deepEqual(registry.definitions(permissions).map(t=>t.function.name),['finish_similar_case_search']);
 draft.items[0].quote='Synthetic verified excerpt.';
 const a=await execute('finish_similar_case_search',draft);assert.equal(a.cases[0].scope,'已取得摘要，临床相似性待核对');assert.equal((await execute('finish_similar_case_search',draft)).id,a.id);assert.equal(registry.definitions(permissions).length,0);
 assert.ok(similarCaseQuestion('帮我找类似患者案例'));assert.equal(similarCaseQuestion('帮我整理出院小结'),false);
});
test('network failures remain explicit and unsearched online requests cannot finish',async()=>{
 const registry=new ToolRegistry();let attempts=0;
 registry.register({permission:'tools.execute',capability:{backend:'local'},definition:{type:'function',function:{name:'online_case_search',parameters:{type:'object',additionalProperties:true}}},execute:async()=>{attempts++;throw Error('Synthetic timeout');}});
 configureSimilarCaseTools(registry,{materials:[]},{policy:{searchScope:'online'}});
 const permissions=new PermissionEngine({profile:'standard',grants:{}}),execute=(n,a)=>registry.execute(n,a,{},permissions),draft={summary:'网络失败，未能取得候选。',items:[],limitations:['网络超时不是零命中。']};
 await assert.rejects(execute('finish_similar_case_search',draft),/要求的检索范围/);
 assert.equal((await execute('online_case_search',{query:'synthetic'})).failed,true);
 await execute('online_case_search',{query:'synthetic'});assert.equal(attempts,1);
 const result=await execute('finish_similar_case_search',draft);assert.equal(result.searches[0].status,'failed');assert.equal(result.cases.length,0);
});
