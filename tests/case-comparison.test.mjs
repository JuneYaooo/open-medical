import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyComparison} from '../server/medical/case-comparison.mjs';
import {comparisonScore} from '../shared/case-comparison.mjs';
const row=(dimension,relation='match')=>({dimension,relation,current:'合成当前事实',candidate:'合成候选事实',currentQuote:'甲事实',candidateQuote:'乙事实',reason:'依据双方原文判断'});
test('similarity uses only sourced dimensions and explicitly reports missing coverage',()=>{
 const rows=verifyComparison([row('disease'),row('stage','partial')],'甲事实','乙事实');
 const result=comparisonScore(rows);
 assert.equal(result.score,79);assert.equal(result.coverage,60);assert.equal(result.known,2);
 assert.equal(rows.find(r=>r.dimension==='medications').relation,'unknown');
 assert.equal(comparisonScore([row('disease')]).score,null);
 assert.equal(comparisonScore([row('stage'),row('treatment')]).score,null);
});
test('fabricated and title-only evidence never contributes to similarity',()=>{
 const rows=verifyComparison([row('disease'),row('stage')],'甲事实','没有这段引文');
 assert.equal(comparisonScore(rows).score,null);assert.equal(comparisonScore(rows).coverage,0);
 assert.ok(rows.every(r=>r.relation==='unknown' && !r.candidateQuote));
 assert.equal(comparisonScore(verifyComparison([row('disease'),row('stage')],'甲事实','')).score,null);
});
test('different disease is explicitly a literature clue even if other fields match',()=>{
 const r=comparisonScore([row('disease','different'),row('stage')]);
 assert.equal(r.clueOnly,true);assert.equal(r.score,42);
 assert.equal(comparisonScore([]).score,null);
});
