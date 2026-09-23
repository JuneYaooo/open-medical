import test from 'node:test';
import assert from 'node:assert/strict';
import {ASSISTANCE_PROFILES,suggestedProfiles,assistanceDraft} from '../shared/clinical-assistance.mjs';
test('framework selection uses registered diagnoses, not free notes or lab guesses',()=>{
 assert.deepEqual(suggestedProfiles({note:'疑似肝细胞癌',labs:[{item:'AFP',value:500}]}),[]);
 assert.deepEqual(suggestedProfiles({diagnoses:[{name:'肝细胞癌'},{name:'慢性肾脏病'}]}).map(p=>p.id),['hcc','ckd']);
 assert.deepEqual(suggestedProfiles({diagnoses:[{name:'高血压'}]}),[]);
});
test('patient tasks carry question and framework while requesting fresh source review',()=>{
 for(const kind of ['similar','literature','assessment','medication','followup']){
  const draft=assistanceDraft(kind,ASSISTANCE_PROFILES[1],'近期检查够不够？');
  assert.match(draft,/近期检查够不够/);assert.match(draft,/读取当前关联患者最新档案/);assert.match(draft,/不代表患者已确诊或已分期/);
 }
 assert.match(assistanceDraft('similar',ASSISTANCE_PROFILES[1]),/脱敏医学关键词/);
 assert.match(assistanceDraft('literature',ASSISTANCE_PROFILES[1]),/版本、日期/);
});
