import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
import {dashboardHistory} from '../shared/patient-dashboard.mjs';
test('clinical history never promotes identity/OCR notes and retains uncertain wording and dated sequence',()=>{
 const note='身份编号待核对，OCR日期冲突';
 const p={note,visits:[{date:'2025-08-01',reason:'考虑复发，建议核对',note:'来源B'},{date:'2025-03-01',reason:'手术',note:'来源A'}]};
 const result=dashboardHistory(p);
 assert.deepEqual(result.map(v=>v.date),['2025-03-01','2025-08-01']);assert.equal(result[1].reason,'考虑复发，建议核对');assert.equal(result[1].note,'来源B');assert.equal(p.note,note);assert.deepEqual(dashboardHistory({note}),[]);
});
test('sourced clinical summary persists only after proposal confirmation; update preserves provenance notes and rejects missing source',async t=>{
 const f=await fixture(t),notes='OCR报告日期待核对';
 const tool=f.server.runtime.toolPlugins.get('patient_create_propose');
 const summary={text:'2025-03-01接受手术。2025-08-01复查考虑复发，尚需核对。',source:'合成病历.txt L1-L6'};
 const action=await tool.execute({name:'合成病史患者',clinicalSummary:summary,note:notes,summary:'核对带来源的病史摘要'});
 assert.equal((await f.json('/api/patients')).data.patients.length,0);
 const confirmed=await f.json(`/api/pending-actions/${action.id}/confirm`,'POST',{});
 assert.equal(confirmed.status,200);
 const p=(await f.json('/api/patients')).data.patients[0];
 const detail=(await f.json('/api/patients/'+p.id)).data;
 assert.deepEqual(detail.clinicalSummary,summary);assert.equal(detail.note,notes);
 const next={text:'2025-08-01复查提示考虑复发，非确诊。',source:'合成复查.txt L2-L3'};
 const update=await f.server.runtime.toolPlugins.get('patient_record_propose').execute({patientId:p.id,clinicalSummary:next,summary:'核对复查摘要'});
 assert.deepEqual((await f.json('/api/patients/'+p.id)).data.clinicalSummary,summary);
 assert.equal((await f.json(`/api/pending-actions/${update.id}/confirm`,'POST',{})).status,200);
 const saved=(await f.json('/api/patients/'+p.id)).data;assert.deepEqual(saved.clinicalSummary,next);assert.equal(saved.note,notes);
 const invalid=await f.json('/api/patients/'+p.id,'PATCH',{expectedRevision:saved.revision,clinicalSummary:{text:'缺少来源'}});assert.equal(invalid.status,400);
 assert.deepEqual((await f.json('/api/patients/'+p.id)).data.clinicalSummary,next);
});


test('short summary preserves qualifications and normalizes editor newlines without truncating legacy text', async()=>{
 const {parseClinicalSummary,formatClinicalSummary,SUMMARY_LIMIT}=await import('../shared/clinical-summary.mjs');
 const fields={current:'2026-06复诊，仍有不适。',problems:'疑似问题待排，尚未确诊。',course:'年初起病，\n治疗后改善，近期再次不适。'};
 const text=formatClinicalSummary(fields);
 assert.deepEqual(parseClinicalSummary(text),{...fields,course:'年初起病， 治疗后改善，近期再次不适。'});
 assert.equal(parseClinicalSummary('旧病史'.repeat(200)),null);
 assert.equal(parseClinicalSummary(formatClinicalSummary({...fields,current:'长'.repeat(SUMMARY_LIMIT+1)})),null);
 assert.equal(parseClinicalSummary('当前状态：暂无\n主要问题：暂无'),null);
});
