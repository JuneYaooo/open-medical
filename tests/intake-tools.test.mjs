import test from 'node:test';
import assert from 'node:assert/strict';
import { configureIntakeTools } from '../server/medical/intake-tools.mjs';
import { ToolRegistry } from '../server/core/tool-registry.mjs';

test('intake reader enforces selected-source coverage, bounded batches and strips unrelated tools',async()=>{
  const sources=Array.from({length:35},(_,i)=>({id:`source-${i}`,name:`sample-${i}.txt`,text:Array.from({length:80},(_,line)=>`合成第${line+1}行 source ${i}`).join('\n')}));
  const registry=new ToolRegistry(['read_source','patient_create_propose','code_execute','shell','web_search'].map(name=>({definition:{type:'function',function:{name,description:name,parameters:{type:'object',properties:{}}}},execute:()=>({ok:true})})));
  configureIntakeTools(registry,{materials:sources});
  assert.equal(registry.has('code_execute'),false);assert.equal(registry.has('shell'),false);assert.equal(registry.has('web_search'),false);
  const ctx={sources:[...sources,{id:'inline',name:'本轮输入',text:'this is not uploaded material'}]};
  const propose=registry.get('patient_create_propose').execute;
  assert.throws(()=>propose({},ctx),/还有资料未读完/);
  const read=registry.get('read_intake_batch').execute;
  let cursor={}, all=[], batches=0;
  do {
    const out=read(cursor,ctx);batches++;
    assert.ok(out.materials.length<=5);assert.ok(JSON.stringify(out).length<20000);
    for(const file of out.materials)all.push(file.sourceId);
    registry.get("save_intake_notes").execute({batchId:out.batchId,notes:"合成来源事实"});
    cursor=out.nextCursor;
  } while(cursor);
  assert.equal(new Set(all).size,35);assert.ok(!all.includes('inline'));assert.equal(batches,7);
  assert.deepEqual(propose({},ctx),{ok:true});
  assert.equal(read({fileIndex:0,startLine:1},ctx).complete,true);
  const replay=registry.get('save_intake_notes').execute({batchId:'batch-1',notes:'重复提交不得覆盖原笔记'});
  assert.equal(replay.alreadySaved,true);
  assert.equal(registry.get('read_intake_notes').execute({index:0}).notes[0].notes,'合成来源事实');
});

test('intake batch resumes inside a long file without dropping or duplicating lines',()=>{
  const text=Array.from({length:300},(_,i)=>`${i}-`+'验收文本'.repeat(50)).join('\n');
  const source={id:'long',name:'long.txt',text};
  const registry=new ToolRegistry(['read_source','patient_create_propose'].map(name=>({definition:{type:'function',function:{name,description:name,parameters:{type:'object',properties:{}}}},execute:()=>({ok:true})})));
  configureIntakeTools(registry,{materials:[source]});
  const read=registry.get('read_intake_batch').execute,ctx={sources:[source]};
  let cursor={}, lines=[];
  do {const result=read(cursor,ctx);for(const item of result.materials)lines.push(...item.text.split('\n'));registry.get("save_intake_notes").execute({batchId:result.batchId,notes:"合成来源事实"});cursor=result.nextCursor;}while(cursor);
  assert.equal(lines.length,300);assert.equal(new Set(lines).size,300);assert.match(lines.at(-1),/^300: 299-/);
  assert.deepEqual(registry.get('patient_create_propose').execute({},ctx),{ok:true});
});

test('saved batch checkpoints resume at the first unread material and preserve earlier facts',()=>{
 const materials=Array.from({length:6},(_,i)=>({id:`m${i}`,name:`record${i}.txt`,text:'原始记录'}));
 const create=()=>new ToolRegistry(['read_source','patient_create_propose'].map(name=>({definition:{type:'function',function:{name,parameters:{type:'object',properties:{}}}},execute:()=>({ok:true})})));
 const first=create();let saved;
 configureIntakeTools(first,{materials},value=>{saved=value;});
 const read=first.get('read_intake_batch').execute({}, {sources:materials});
 first.get('save_intake_notes').execute({batchId:read.batchId,notes:'前五份已核对的来源事实'});
 const resumed=create();configureIntakeTools(resumed,{materials},()=>{},saved);
 assert.equal(resumed.get('read_intake_notes').execute({}).notes[0].notes,'前五份已核对的来源事实');
 const next=resumed.get('read_intake_batch').execute({}, {sources:materials});
 assert.deepEqual(next.materials.map(source=>source.sourceId),['m5']);
 assert.throws(()=>resumed.get('patient_create_propose').execute({}, {sources:materials}),/保存最后一批/);
 resumed.get('save_intake_notes').execute({notes:'第六份来源事实'});
 assert.deepEqual(resumed.get('patient_create_propose').execute({}, {sources:materials}),{ok:true});
});

test('an unsaved intake batch can be recovered verbatim after model context compaction', () => {
  const sources=[{id:'source',name:'record.txt',text:'姓名合成。\n高血压，待核对。'}];
  const registry=new ToolRegistry(['read_source','patient_create_propose'].map(name=>({definition:{type:'function',function:{name,parameters:{type:'object',properties:{}}}},execute:()=>({ok:true})})));
  configureIntakeTools(registry,{materials:sources});
  const read=registry.get('read_intake_batch').execute;
  const first=read({}, {sources}),recovered=read({}, {sources});
  assert.equal(recovered.awaitingNotes,true);
  assert.equal(recovered.batchId,first.batchId);
  assert.deepEqual(recovered.materials,first.materials);
  registry.get('save_intake_notes').execute({notes:'记录高血压，待核对。'});
  assert.equal(read({}, {sources}).complete,true);
  assert.equal(registry.get('read_intake_notes').execute({}).batchesSaved,1);
});
