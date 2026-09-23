import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
import {DeepSeekProvider} from '../server/provider.mjs';
import {taskPresentation} from '../shared/task-presentation.mjs';
import {configureTaskPresentation} from '../server/medical/task-presentation.mjs';
import {ToolRegistry} from '../server/core/tool-registry.mjs';
import {PermissionEngine} from '../server/core/permissions.mjs';
const call=(name,args)=>({id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
test('explicit result intent preserves ordinary Q&A',()=>{
 for(const [text,kind]of [['这个患者的相似病例有哪些','similar_cases'],['请辅助诊断','diagnostic'],['搜索糖尿病文献','literature'],['计算BMI，身高170厘米体重65kg','calculator'],['BMI是什么意思','answer'],['解释文献中的这个词','answer'],['你好','answer']])assert.equal(taskPresentation(text),kind,text);
});
test('calculation tool facts persist as presentation, not clinical draft artifacts',async t=>{
 const provider=new DeepSeekProvider({apiKey:'test',model:'test'});let n=0;
 provider.complete=async()=>({message:++n===1?{role:'assistant',content:'',tool_calls:[call('medical_scale_calculate',{scaleId:'bmi',answers:{weight:65,height:170}})]}:{role:'assistant',content:'计算完成。'}});
 const f=await fixture(t,{provider});const s=await f.session('计算测试');await f.chat(s.id,'计算BMI，身高170厘米体重65kg',{mode:'standard',externalConsent:true});
 const result=(await f.json(`/api/sessions/${s.id}`)).data;
 assert.equal(result.runs.at(-1).status,'completed');assert.equal(result.runs.at(-1).displayResults[0].score,22.5);assert.equal(result.runs.at(-1).displayResults[0].inputs[0].label,'体重（kg）');assert.equal(result.artifacts.length,0);
});
test('diagnostic panel requires actual current patient source evidence',async()=>{
 const registry=new ToolRegistry();registry.register({permission:'tools.execute',capability:{backend:'local'},definition:{type:'function',function:{name:'read_patient_brief',parameters:{type:'object'}}},execute:()=>({symptom:'合成症状，待核对'})});
 const results=[];configureTaskPresentation(registry,'diagnostic',r=>results.push(r));
 const permissions=new PermissionEngine({profile:'standard',grants:{}}),run=(name,args)=>registry.execute(name,args,{},permissions);
 const draft={summary:'仅为合成参考',candidates:[{name:'待鉴别',support:'合成症状',against:'资料不足',missing:'需补资料',quote:'合成症状，待核对'}]};
 await assert.rejects(run('present_diagnostic_review',draft),/本次已读取/);await run('read_patient_brief',{});await run('present_diagnostic_review',draft);assert.equal(results.length,1);
});
test('material lookup returns evidence without creating review tasks, including older saved searches',async t=>{
 const provider=new DeepSeekProvider({apiKey:'test',model:'test'});let n=0;
 provider.complete=async()=>({message:++n===1?{role:'assistant',content:'',tool_calls:[call('search_materials',{query:'用药'})]}:{role:'assistant',content:'未取得足够原文，无法确认目前用药。'}});
 const f=await fixture(t,{provider});const s=await f.session('用药总结');await f.chat(s.id,'过往用药情况总结一下',{mode:'standard',externalConsent:true});
 const result=(await f.json(`/api/sessions/${s.id}`)).data;
 assert.equal(result.runs.at(-1).status,'completed');assert.equal(result.artifacts.length,0);
 f.server.workspaces.store.update(s.id,w=>{(w.runs.at(-1).artifacts ||= []).push({id:'old-search',type:'source_search',status:'draft'},{id:'real-result',type:'clinical_timeline',status:'draft'});});
 const projected=(await f.json(`/api/sessions/${s.id}`)).data;
 assert.deepEqual(projected.artifacts.map(a=>a.id),['real-result']);
 assert.deepEqual(projected.runs.at(-1).artifacts.map(a=>a.id),['real-result']);
 assert.ok(f.server.workspaces.store.get(s.id).runs.at(-1).artifacts.some(a=>a.id==='old-search'));
});
