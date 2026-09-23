import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentRuntime} from '../server/core/agent-runtime.mjs';
import {ToolRegistry} from '../server/core/tool-registry.mjs';
import {PermissionEngine} from '../server/core/permissions.mjs';
import {createMedicalWorkspaceDomain} from '../server/medical/medical-workspace-domain.mjs';
const permissions=new PermissionEngine({profile:'standard',grants:{'model.external':true}});
test('prepared responses avoid a redundant provider call but retain completion and delivery checks',async()=>{
 let completed=0,verified=0;const traces=[];
 const result=await new AgentRuntime({provider:{model:'test',complete(){throw Error('must not call provider');}}}).run({messages:[{role:'user',content:'render saved result'}],registry:new ToolRegistry(),permissions,domain:{preparedResponse:()=>({message:{role:'assistant',content:'已保存结果'}}),beforeComplete:()=>{completed++;}},onDelivery:()=>{verified++;return{delivered:false,evidence:[],gaps:[{reason:'synthetic_missing',detail:'Synthetic receipt unavailable'}]};},onTrace:trace=>traces.push(trace.type)});
 assert.equal(completed,1);assert.equal(verified,1);assert.equal(result.delivery.delivered,false);assert.ok(traces.includes('domain.response'));assert.ok(!traces.includes('model.request'));
});
test('medical prepared response uses only current terminal artifact and does not swallow later steering',()=>{
 const domain=createMedicalWorkspaceDomain();const artifact={id:'a',type:'similar_cases',createdAt:'2026-09-24T01:00:00Z',cases:[],searches:[],limitations:[],summary:'无候选'};
 const run={id:'r',policy:{workflow:'similar-case-search'},artifacts:[]};const workspace={runs:[run,{id:'old',artifacts:[artifact]}]};
 assert.equal(domain.preparedResponse(workspace,'r'),null);
 run.artifacts=[artifact];assert.match(domain.preparedResponse(workspace,'r').message.content,/本次检索已结束/);
 run.inputs=[{createdAt:new Date(artifact.createdAt).getTime()+1,message:'补充新的检索要求'}];assert.equal(domain.preparedResponse(workspace,'r'),null);
 run.inputs=[];run.policy.workflow='ordinary';assert.equal(domain.preparedResponse(workspace,'r'),null);
});
