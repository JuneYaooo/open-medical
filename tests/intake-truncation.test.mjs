import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../server/core/providers.mjs';
import { compactContext } from '../server/core/context-manager.mjs';
import { AgentRuntime } from '../server/core/agent-runtime.mjs';
import { ToolRegistry } from '../server/core/tool-registry.mjs';
import { PermissionEngine } from '../server/core/permissions.mjs';

const cutoffStream=()=>new Response([
 {type:'message_start',message:{usage:{input_tokens:30}}},
 {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'internal reasoning only'}},
 {type:'message_delta',delta:{stop_reason:'max_tokens'},usage:{output_tokens:6000}},
 {type:'message_stop'},
].map(data=>`data: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});

test('Anthropic-compatible reasoning-only cutoff returns recoverable metadata, never a fabricated answer',async()=>{
 const provider=new AnthropicProvider({apiKey:'synthetic',model:'deepseek-flash',fetchImpl:async()=>cutoffStream()});
 const result=await provider.complete([{role:'user',content:'summary'}],[]);
 assert.equal(result.stopReason,'max_tokens');assert.equal(result.message.content,null);
 assert.equal(result.message.tool_calls,undefined);assert.equal(result.usage.output_tokens,6000);
});

test('actual 6000-token empty summary cutoff preserves archive and saved batch receipts, then main task continues',async()=>{
 let archived,compactions=0,requests=0;
 const transport=new AnthropicProvider({apiKey:'synthetic',model:'deepseek-flash',fetchImpl:async()=>cutoffStream()});
 const provider={model:'fixture',maxTokens:512,complete:async(messages,tools,options)=>{
   if(messages[0].content.includes('会话历史压缩器')) {compactions++;return transport.complete(messages,tools,{...options,maxTokens:6000});}
   if(++requests===1)return{message:{role:'assistant',content:null,tool_calls:Array.from({length:6},(_,i)=>({id:`call-${i}`,type:'function',function:{name:'read_record',arguments:JSON.stringify({index:i})}}))}};
   assert.ok(messages.some(m=>m.name==='context_summary'&&m.content.includes('未生成事实摘要')));
   assert.ok(messages.some(m=>m.role==='user'&&m.content==='继续建档，不要重传'));
   return {message:{role:'assistant',content:'继续处理已有资料'}};
 }};
 const registry=new ToolRegistry([{definition:{type:'function',function:{name:'read_record',parameters:{type:'object',properties:{index:{type:'integer'}},required:['index']}}},execute:()=>({intakeNotesSaved:true,batchesSaved:2,nextCursor:{fileIndex:10,startLine:1},text:'source material '.repeat(190)})}]);
 const result=await new AgentRuntime({provider,maxContextChars:12000,maxRounds:4}).run({messages:[{role:'user',content:'继续建档，不要重传'}],registry,permissions:new PermissionEngine({profile:'standard'}),offload:async()=>({id:'source-archive'}),compact:(messages,options)=>compactContext({...options,messages,provider,maxChars:12000,archive:async value=>{archived=structuredClone(value);return{id:'full-archive'};}})});
 assert.equal(result.text,'继续处理已有资料');assert.equal(compactions,1);assert.equal(requests,2);
 assert.equal(archived.filter(m=>m.role==='tool').length,6);
 assert.ok(archived.some(m=>m.content?.includes('source material')));
});

test('empty truncation retries boundedly without executing broken tools or pretending completion',async()=>{
 let count=0;
 const provider={model:'fixture',complete:async messages=>{
   count++;assert.ok(!messages.some(m=>m.role==='assistant'&&!m.content&&!m.tool_calls));
   if(count===1)return{message:{role:'assistant',content:null},stopReason:'max_tokens'};
   return{message:{role:'assistant',content:'恢复完成'}};
 }};
 const registry=new ToolRegistry(),permissions=new PermissionEngine({profile:'standard'});
 const result=await new AgentRuntime({provider,maxRounds:5}).run({messages:[{role:'user',content:'整理资料'}],registry,permissions});
 assert.equal(result.text,'恢复完成');assert.equal(count,2);
 provider.complete=async()=>({message:{role:'assistant',content:null},stopReason:'max_tokens'});
 await assert.rejects(new AgentRuntime({provider,maxRounds:5}).run({messages:[{role:'user',content:'整理资料'}],registry,permissions}),e=>e.code==='OUTPUT_LIMIT');
});

test('truncated empty or partial tool arguments are discarded instead of becoming executable empty objects',async()=>{
 for(const partial of ['', '{"notes":"unfinished']) {
  const provider=new AnthropicProvider({apiKey:'synthetic',fetchImpl:async()=>new Response([
   {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'unfinished',name:'save_intake_notes',input:{}}},
   {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:partial}},
   {type:'message_delta',delta:{stop_reason:'max_tokens'}},{type:'message_stop'},
  ].map(data=>`data: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})});
  const result=await provider.complete([{role:'user',content:'整理资料'}],[]);
  assert.equal(result.stopReason,'max_tokens');assert.equal(result.message.tool_calls,undefined);
 }
});
