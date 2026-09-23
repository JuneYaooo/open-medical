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

test('comparison checks normalize publisher spacing, keep multiline source text, and identify unsourced fields',async()=>{
 const {comparisonIssues,quoteInEvidence,evidenceText,groundedCaseFindings}=await import('../server/medical/case-comparison.mjs');
 assert.equal(quoteInEvidence('A 2 cm HCC','<p>A 2\u2009cm HCC</p>'),true);
 assert.equal(quoteInEvidence('已确诊复发','疑似复发，尚未确诊'),false);
 const e=evidenceText({text:'第一行\n第二行'});assert.equal(quoteInEvidence('第一行\n第二行',e),true);
 const rows=['disease','stage','treatment','medications','demographics'].map(dimension=>({...row(dimension),currentQuote:'',candidateQuote:'',relation:'unknown'}));
 rows[2]={...row('treatment','partial'),current:'肝切除术后',candidate:'接受 TACE',currentQuote:'肝切除术后',candidateQuote:'received TACE',reason:'双方均接受 TACE'};
 assert.equal(comparisonIssues(rows,'肝切除术后','received TACE').length,0);
 assert.match(comparisonIssues(rows,'肝切除术后','no evidence').join(' '),/candidateQuote/);
 const findings=groundedCaseFindings(rows);assert.doesNotMatch(findings.reason,/双方均/);assert.match(findings.reason,/当前患者“肝切除术后”；候选病例“接受 TACE”/);
});
test('explicitly uncertain stage and medication status cannot inflate similarity coverage',()=>{
 const rows=verifyComparison([
 {...row('stage','partial'),current:'确切分期未知',currentQuote:'复发性质未确定'},
 {...row('medications','different'),current:'替诺福韦，当前服用状态未记录',currentQuote:'当前服用状态未记录'},
 {...row('treatment','partial'),current:'仅医嘱建议核对增强影像与病理',currentQuote:'建议核对增强影像与病理'},
 ],'复发性质未确定；当前服用状态未记录；建议核对增强影像与病理','乙事实');
 assert.ok(rows.every(r=>r.relation==='unknown'));assert.equal(comparisonScore(rows).coverage,0);
});
