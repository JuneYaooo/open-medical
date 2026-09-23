import test from 'node:test';
import assert from 'node:assert/strict';
import {savedDemographics,caseForDisplay} from '../shared/case-profile.mjs';
import {comparisonScore} from '../shared/case-comparison.mjs';
test('legacy abstract supplies demographics consistently without needing a new search',()=>{
 const item={differences:'候选为71岁男性',evidence:{text:'<h4>Case presentation</h4>A 71-year-old man with a five-year history of HCC.'}};
 const result=caseForDisplay(item),d=result.comparison.find(r=>r.dimension==='demographics');
 assert.equal(d.candidate,'71岁，男');assert.equal(d.candidateQuote,'A 71-year-old man');
 assert.equal(d.current,'尚未整理');assert.equal(d.relation,'unknown');assert.equal(comparisonScore(result.comparison).score,null);
 assert.equal(item.comparison,undefined);
});
test('narrative claims alone cannot create verified demographic facts',()=>{
 const result=caseForDisplay({differences:'候选为71岁男性',evidence:{text:'No patient demographic details in this saved excerpt.'}});
 assert.equal(result.comparison.find(r=>r.dimension==='demographics').candidate,'尚未整理');
});
test('multiple patients and implausible ages are not collapsed into one patient',()=>{
 assert.equal(savedDemographics('A 71-year-old man and a 45-year-old woman.'),null);
 assert.equal(savedDemographics('A 171-year-old man'),null);
 assert.equal(savedDemographics('71岁男性患者').text,'71岁，男');
 assert.equal(savedDemographics('A 58 year old woman').text,'58岁，女');
});
test('existing verified facts are preserved and missing fields are not claimed absent',()=>{
 const result=caseForDisplay({comparison:[{dimension:'demographics',candidate:'男，71岁',candidateQuote:'known quote',current:'女',currentQuote:'女',relation:'different'}],evidence:{text:'A 58-year-old woman'}});
 assert.equal(result.comparison.find(r=>r.dimension==='demographics').candidate,'男，71岁');
 assert.equal(result.comparison.find(r=>r.dimension==='disease').candidate,'尚未整理');
});
