import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

test('followup overview pages include all plans with stable boundaries and validate offset',async t=>{
  const f=await fixture(t,{followupOptions:{autoStart:false}});
  const patient=(await f.json('/api/patients','POST',{name:'分页合成患者'})).data;
  const due = new Date(Date.now()+86400000).toISOString();
  for(let i=0;i<9;i++) {
    const r=await f.json(`/api/patients/${patient.id}/followups`,'POST',{name:`随访 ${i}`,once:true,firstDueAt:due});
    assert.ok(r.status<300,JSON.stringify(r.data));
  }
  const ids=[];
  for(let offset=0;offset<9;offset+=4){
    const r=await f.json(`/api/followups/overview?limit=4&offset=${offset}`);
    assert.equal(r.status,200);assert.equal(r.data.total,9);
    assert.equal(r.data.hasMore,offset<8);ids.push(...r.data.jobs.map(j=>j.id));
  }
  assert.equal(new Set(ids).size,9);
  assert.equal((await f.json('/api/followups/overview?offset=-1')).status,400);
  assert.equal((await f.json('/api/followups/overview?offset=1.5')).status,400);
});
