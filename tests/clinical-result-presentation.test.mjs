import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactLines} from '../shared/medical.mjs';
import {ToolRegistry} from '../server/core/tool-registry.mjs';
import {PermissionEngine} from '../server/core/permissions.mjs';
import {configureSimilarCaseTools} from '../server/medical/similar-case-workflow.mjs';

test('a sourced treatment review retains its conclusion and clinical questions',()=>{
 const lines=artifactLines({type:'treatment_review',summary:'历史方案不能代表目前用药。',concerns:['需核对用药状态'],infoGaps:['缺少近期资料'],questions:['是否调整用药？'],matches:[{sourceName:'资料.txt',line:2,quote:'历史医嘱'}]});
 assert.ok(lines.includes('历史方案不能代表目前用药。'));assert.ok(lines.some(x=>x.includes('是否调整用药')));
});
test('case delivery deduplicates DOI and saves the actual retrieved evidence',async()=>{
 const registry=new ToolRegistry();
 for(const name of ['online_case_search','literature_fetch'])registry.register({permission:'tools.execute',capability:{backend:'local'},definition:{type:'function',function:{name,parameters:{type:'object',additionalProperties:true}}},execute:async()=>name==='online_case_search'?{searches:[{status:'ok'},{status:'failed'}],candidates:[{pmid:'11',doi:'10.example/SAME',title:'Candidate A'},{pmid:'22',doi:'10.example/same',title:'Duplicate A'},{pmid:'33',title:'Title only'}]}:{abstract:'Original source abstract.'}});
 configureSimilarCaseTools(registry,{materials:[]},{policy:{searchScope:'online'}});
 const perms=new PermissionEngine({profile:'standard',grants:{}}),run=(name,args)=>registry.execute(name,args,{},perms);
 await run('online_case_search',{query:'synthetic'});await run('literature_fetch',{pmid:'11'});
 const report=await run('finish_similar_case_search',{summary:'合成结果',items:['11','22','33'].map(reference=>({reference,comparison:['disease','stage','treatment','medications','demographics'].map(dimension=>({dimension,current:'未取得',candidate:'未取得',currentQuote:'',candidateQuote:'',relation:'unknown',reason:'待核对'})),reason:'主题相关',differences:'临床差异待核对',outcome:{text:'合成结果',quote:reference==='11'?'Original source abstract.':'invented outcome'}})),limitations:[]});
 assert.equal(report.cases.length,2);assert.equal(report.cases[0].outcome.text,'合成结果');assert.equal(report.cases[1].outcome,undefined);assert.deepEqual(report.evidenceSummary,{candidates:2,abstracts:1,metadataOnly:1,failedSources:1});
 assert.equal(report.matches[0].evidence.text,'Original source abstract.');assert.equal(report.matches[1].evidence.text,'');
 assert.ok(artifactLines(report).includes('Candidate A'));assert.ok(artifactLines(report).some(l=>l.includes('仅题录')));
});
