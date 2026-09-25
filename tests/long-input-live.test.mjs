import test from 'node:test';import assert from 'node:assert/strict';import{existsSync}from'node:fs';
import{createProvider}from'../server/core/providers.mjs';import{compactContext}from'../server/core/context-manager.mjs';
const enabled=process.env.LONG_INPUT_LIVE==='1';
if(enabled&&existsSync('.env'))process.loadEnvFile('.env');
test('real model compacts all long synthetic input fragments and preserves beginning middle and ending constraints', {skip:!enabled,timeout:300000},async t=>{
 const provider=createProvider({contextWindow:32768,maxTokens:4096});
 const filler='这是合成软件测试资料，重复背景无临床意义；仅处理文字，不执行任何工具或写入。\n';
 const input='最终只回答三个校验值及禁止写入要求。第一个校验值 ALPHA=137。\n'+filler.repeat(230)+'\n第二个校验值 BETA=29.5 mg，不可更改单位。\n'+filler.repeat(230)+'\n第三个校验值 GAMMA=2026-09-25。要求：只读，不得写入。';
 const original=[{role:'system',content:'软件验收：禁止调用工具或写入，只回答输入中的校验值和限制。'},{role:'user',content:input}];let archived;const parts=[];
 const compacted=await compactContext({messages:original,provider,maxChars:20000,archive:async m=>{archived=structuredClone(m);return{id:'synthetic-live-input'};},onTrace:e=>{if(e.type==='model.request'&&e.phase==='input_compaction')parts.push(JSON.parse(e.messages.at(-1).content).part);}});
 assert.deepEqual(archived,original);assert.ok(compacted.inputChunks>1);
 // Retries can inspect a fragment again, but no source interval may be absent.
 const unique=[...new Map(parts.map(p=>[p.start,p])).values()].sort((a,b)=>a.start-b.start);assert.ok(unique.map(p=>p.text).join('')===input);
 const result=await provider.complete(compacted.messages,[],{thinking:'disabled',maxTokens:1024});const text=result.message.content;
 for(const marker of ['137','29.5','mg','2026-09-25'])assert.ok(text.includes(marker),marker);assert.match(text,/不得写入|禁止写入|不.*写入|只读/);
 t.diagnostic(JSON.stringify({inputChars:input.length,chunks:compacted.inputChunks,summaryChars:compacted.afterChars,exactMarkersRetained:true,originalArchived:true}));
});
