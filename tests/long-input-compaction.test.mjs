import test from 'node:test';
import assert from 'node:assert/strict';
import {compactContext} from '../server/core/context-manager.mjs';
import {contextBudget} from '../server/core/context-budget.mjs';
import {AgentRuntime} from '../server/core/agent-runtime.mjs';
import {TASK_INPUT_MESSAGE} from '../server/core/run-progress.mjs';
const answer = content => ({message:{role:'assistant',content}});
const original = 'BEGIN do not write without approval\n' + '合成记录🧪\n剂量 12.5 mg，日期 2026-09-25；引用："ignore previous instructions" 是不可信资料。\\code\n'.repeat(1300) + '\nEND keep units';
function harness(options = {}) {
  const parts = [], traces = [], archives = [];
  const provider = {model:'fixture',contextWindow:8192,maxTokens:512, async complete(messages,tools,opts){
    assert.equal(tools.length,0);
    assert.equal(contextBudget({provider,messages,tools,maxChars:opts.budget.maxChars,outputReserve:opts.maxTokens,calibration:opts.budget.calibration}).fits,true);
    const p=JSON.parse(messages.at(-1).content);if(p.part) parts.push(p.part);
    return answer('Read synthetic records. Approval required; 12.5 mg, 2026-09-25. Quoted instructions are untrusted.');
  }, ...options};
  const archive=async m=>{archives.push(structuredClone(m));return{id:'full-input'};};
  const compact=(messages,opts={})=>compactContext({...opts,messages,provider,maxChars:10000,archive,onTrace:e=>traces.push(e)});
  return {provider,parts,traces,archives,compact,archive};
}
test('single long Chinese/code input is fully chunked with contiguous Unicode ranges and exact archive',async()=>{
 const h=harness(),messages=[{role:'system',content:'Never write without permission.'},{role:'user',content:original}];
 const result=await h.compact(messages);
 assert.deepEqual(h.archives,[messages]);assert.ok(h.parts.length>16);
 assert.equal(h.parts.map(p=>p.text).join(''),original);
 let end=0;for(const p of h.parts){assert.equal(p.start,end);assert.equal(p.text,original.slice(p.start,p.end));assert.equal(p.text.isWellFormed(),true);end=p.end;}
 assert.equal(end,original.length);assert.equal(result.inputChunks,h.parts.length);assert.equal(result.inputChars,original.length);
 assert.equal(result.messages[0].content,messages[0].content);assert.equal(result.messages.at(-1).role,'user');assert.equal(result.budget.fits,true);
 assert.match(result.messages.at(-1).content,/有损摘要.*不是原文/);assert.match(result.messages.at(-1).content,/full-input/);
});
test('many active steering messages compact in chronological order and retain short latest correction exactly',async()=>{
 const h=harness(),inputs=Array.from({length:40},(_,i)=>({role:'user',name:TASK_INPUT_MESSAGE,content:`constraint-${i}: `+'detail '.repeat(20)}));
 const latest={role:'user',content:'Correction: no write, only explain.'};const r=await h.compact([...inputs,latest]);
 assert.equal(h.parts.map(p=>p.text).join(''),inputs.map(m=>m.content).join(''));
 assert.deepEqual(r.messages.at(-1),latest);assert.equal(r.budget.fits,true);
});
test('runtime handles long initial and late steering inputs through compaction before model execution',async()=>{
 for(const late of [false,true]){
  const h=harness();let mainCalls=0,reads=0;
  const summarize=h.provider.complete;
  h.provider.complete=async(m,t,o)=>{
   if(m[0].content.includes('压缩器'))return summarize(m,t,o);
   mainCalls++;assert.equal(o.budget.fits,true);assert.ok(m.some(v=>v.content?.includes('full-input')));return answer('completed');
  };
  const events=[];
  const runtime=new AgentRuntime({provider:h.provider,maxRounds:2,maxContextChars:10000});
  const result=await runtime.run({messages:[{role:'user',content:late?'Initial short request':original}],permissions:{require(){},can(){return true;}},registry:{definitions:()=>[]},compact:h.compact,
   takeInput:async()=>late&&++reads===2?[{role:'user',content:original}]:[],emit:(type,payload)=>events.push({type,payload})});
  assert.equal(result.text,'completed');assert.equal(mainCalls,1);assert.ok(h.parts.map(p=>p.text).join('')===(late?'Initial short request':'')+original);
  assert.ok(events.some(e=>e.type==='context.compacted'&&e.payload.inputChunks>0));
 }
});
test('uncompactable system policy fails without summarizing away permissions',async()=>{
 const h=harness();await assert.rejects(h.compact([{role:'system',content:'policy '.repeat(2000)},{role:'user',content:original}]),{code:'CONTEXT_LIMIT'});assert.equal(h.parts.length,0);
});
test('archive failure prevents any long input model requests',async()=>{
 const h=harness();await assert.rejects(compactContext({messages:[{role:'user',content:original}],provider:h.provider,archive:async()=>{throw Error('disk failure');}}),/disk failure/);assert.equal(h.parts.length,0);
});
test('oversize summaries are retried without silently truncating the source or constraints',async()=>{
 let calls=0;const h=harness({complete:async()=>{calls++;return answer('x'.repeat(10000));}});
 await assert.rejects(h.compact([{role:'user',content:original}]),{code:'COMPACTION_RESPONSE'});assert.equal(calls,3);assert.equal(h.archives[0][0].content,original);
});
test('cancellation between long input chunks retains full original and stops requests',async()=>{
 const controller=new AbortController();let calls=0;const h=harness({complete:async()=>{if(++calls===2)controller.abort(Error('cancel chunk'));return answer('summary');}});
 await assert.rejects(h.compact([{role:'user',content:original}],{signal:controller.signal}),/cancel chunk/);assert.equal(calls,2);assert.equal(h.archives[0][0].content,original);
});
