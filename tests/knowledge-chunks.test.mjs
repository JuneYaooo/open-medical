import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {GuidelineLibrary,chunkify} from '../server/medical/guidelines.mjs';

test('long knowledge paragraphs reach embeddings in full with original line references',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());let indexed=[];
 const vectorStore={upsertDoc:async(id,model,pieces)=>{indexed=pieces;}};
 let inputs=[];const embedder={model:'synthetic',available:()=>true,embed:async texts=>{inputs=texts;return texts.map(()=>[1,0]);}};
 const library=new GuidelineLibrary(store,embedder,vectorStore);
 const long='甲'.repeat(4500)+'尾部独有内容';const text='第一行\n'+long+'\n第三行';
 const doc=await library.addDocument({title:'合成长段落',text});
 assert.equal(doc.indexing.status,'ready');assert.ok(inputs.every(s=>s.length<=2000));assert.ok(inputs.some(s=>s.includes('尾部独有内容')));assert.ok(indexed.some(c=>c.text.includes('尾部独有内容')));
 const pieces=chunkify(text,2000);assert.equal(pieces.filter(c=>c.startLine===2).map(c=>c.text).join(''),long+'\n第三行');
 assert.equal(library.readLines(doc.id,2,2).lines[0],long);
});

test('failed semantic indexing preserves usable original text and explicit failure status',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const library=new GuidelineLibrary(store,{model:'offline',available:()=>true,embed:async()=>{throw Error('unavailable');}},{upsertDoc:async()=>{}});
 const doc=await library.addDocument({title:'离线合成资料',text:'用于合成回归测试。'.repeat(30)});
 assert.equal(doc.indexing.status,'failed');assert.equal(library.get(doc.id).indexing.status,'failed');assert.match(library.get(doc.id).text,/合成回归/);
});
