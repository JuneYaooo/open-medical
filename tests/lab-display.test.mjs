import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { PermissionEngine } from '../server/core/permissions.mjs';

const lab = (item, unit = 'U') => ({ item, unit, value: 0, date: '2026-01-01' });
test('display preferences persist through API and chat tools without changing clinical records', async t => {
  const f = await fixture(t);
  const p = (await f.json('/api/patients','POST',{name:'展示偏好验收',labs:[lab('A'),lab('A','mg'),lab('B')]})).data;
  const other = (await f.json('/api/patients','POST',{name:'另一患者'})).data;
  const path = `/api/patients/${p.id}/lab-display`;
  const initial = (await f.json(path)).data;
  assert.equal(initial.preferences.revision,0);
  const keys = initial.groups.map(g=>g.key);
  const changed = await f.json(path,'PATCH',{expectedRevision:0,order:keys.toReversed(),collapsed:[keys[0]],hidden:[keys[1]],compare:[keys[2]]});
  assert.equal(changed.status,200);
  assert.deepEqual((await f.json(path)).data.preferences,changed.data.preferences);
  assert.equal((await f.json(path,'PATCH',{expectedRevision:0,reset:true})).status,409);
  for (const input of [{hidden:['unknown']},{hidden:[keys[0],keys[0]]},{hidden:'A'},{reset:'true'},{unexpected:true}]) {
    assert.equal((await f.json(path,'PATCH',{expectedRevision:1,...input})).status,400);
  }
  const registry = f.server.workspaces.registry(p.sessionId,'display-test');
  const permission = new PermissionEngine({profile:'standard',grants:{}});
  const result = await registry.execute('patient_lab_display_get',{patientId:p.id},{},permission);
  assert.equal(result.preferences.revision,1);
  await assert.rejects(registry.execute('patient_lab_display_update',{patientId:other.id,expectedRevision:0,reset:true},{},permission),/当前患者/);
  const saved = await registry.execute('patient_lab_display_update',{patientId:p.id,expectedRevision:1,hidden:[]},{},permission);
  assert.equal(saved.preferences.revision,2);
  assert.deepEqual(saved.preferences.collapsed,[keys[0]]);
  assert.deepEqual(saved.preferences.hidden,[]);
  const chart = (await f.json(`/api/patients/${p.id}`)).data;
  assert.deepEqual(chart.labs,p.labs);
  assert.equal(chart.revision,p.revision);
  assert.equal(chart.labDisplay.revision,2);
  assert.equal((await f.json(`/api/patients/${other.id}/lab-display`)).data.preferences.revision,0);
  const reset = await f.json(path,'PATCH',{expectedRevision:2,reset:true});
  assert.deepEqual(reset.data.preferences,{revision:3});
});

test('a conversational run can read and save display choices through registered tools', async t => {
  let patientId, key;
  let round = 0;
  const provider = { provider:'stub', model:'stub', apiKey:'stub', async complete(_messages, tools) {
    round++;
    const name = round === 1 ? 'patient_lab_display_get' : 'patient_lab_display_update';
    if (round <= 2) {
      assert.ok(tools.some(t=>t.function.name===name));
      return {message:{role:'assistant',content:'',tool_calls:[{id:`display-${round}`,type:'function',function:{name,arguments:JSON.stringify(round===1 ? {patientId} : {patientId,expectedRevision:0,order:[key],collapsed:[key],compare:[]})}}]}};
    }
    return {message:{role:'assistant',content:'已保存展示偏好。'}};
  }};
  const f = await fixture(t,{provider});
  const p = (await f.json('/api/patients','POST',{name:'对话展示验收',labs:[lab('血红蛋白')]})).data;
  patientId=p.id; key=JSON.stringify(['血红蛋白','U']);
  const result = await f.chat(p.sessionId,'把血红蛋白排在前面并折叠，不用日期对照',{mode:'model',externalConsent:true,completion:{kind:'answer'}});
  assert.equal(result.status,200);
  const session=(await f.json(`/api/sessions/${p.sessionId}`)).data;
  assert.equal(session.runs.at(-1).status,'completed');
  assert.deepEqual((await f.json(`/api/patients/${p.id}/lab-display`)).data.preferences,{revision:1,order:[key],collapsed:[key],compare:[]});
});

test('large panels work in patient and global chat; removing a lab cleans its saved display key', async t => {
  const f=await fixture(t);
  const p=(await f.json('/api/patients','POST',{name:'多指标验收',labs:Array.from({length:45},(_,i)=>lab(`指标${i}`))})).data;
  const registry=f.server.workspaces.registry(p.sessionId,'large-display');
  const permission=new PermissionEngine({profile:'standard',grants:{}});
  const keys=(await registry.execute('patient_lab_display_get',{patientId:p.id},{},permission)).groups.map(g=>g.key);
  await registry.execute('patient_lab_display_update',{patientId:p.id,expectedRevision:0,order:keys,hidden:[keys[0]]},{},permission);
  const global=f.server.sessionBridge.ensureGlobalSession();
  const globalRegistry=f.server.workspaces.registry(global.id,'global-display');
  await globalRegistry.execute('patient_lab_display_update',{patientId:p.id,expectedRevision:1,compare:[keys[0]]},{},permission);
  assert.equal(f.server.patients.row(p.id).labDisplay.revision,2);
  const changed=await f.json(`/api/patients/${p.id}`,'PATCH',{expectedRevision:p.revision,labs:[]});
  assert.equal(changed.status,200);
  assert.deepEqual(changed.data.labDisplay,{revision:3,order:[],hidden:[],compare:[]});
});
