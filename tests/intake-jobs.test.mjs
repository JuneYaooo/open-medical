import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { DeepSeekProvider } from '../server/provider.mjs';
import { IntakeJobs } from '../server/medical/intake-jobs.mjs';

async function terminal(f,id) {
  for(let i=0;i<100;i++) {
    const job=(await f.json(`/api/sessions/${id}/intake-job`)).data.job;
    if(job.status!=='running') return job;
    await new Promise(r=>setTimeout(r,20));
  }
  assert.fail('intake did not settle');
}
test('background jobs require consent, reject duplicate starts, support stop and retain durable status',async t=>{
  let entered=false;
  const provider=new DeepSeekProvider({apiKey:'synthetic',model:'job-test'});
  provider.complete=async (_messages,_tools,options)=>{
    entered=true;
    await new Promise((resolve,reject)=>{
      if(options.signal.aborted) return reject(new Error('aborted'));
      options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
    });
  };
  const f=await fixture(t,{provider}),s=await f.session('上传资料建档');
  await f.json(`/api/sessions/${s.id}/files`,'POST',{name:'source.txt',text:'合成病例资料'});
  assert.equal((await f.json(`/api/sessions/${s.id}/intake-job`,'POST',{})).status,400);
  assert.equal((await f.json(`/api/sessions/${s.id}/intake-job`,'POST',{externalConsent:true})).status,202);
  for(let i=0;i<100&&!entered;i++) await new Promise(r=>setTimeout(r,10));
  assert.ok(entered);
  assert.equal((await f.json(`/api/sessions/${s.id}`,'DELETE')).status,409);
  assert.equal((await f.json(`/api/sessions/${s.id}/files`,'POST',{name:'late.txt',text:'不得混入'})).status,409);
  assert.equal((await f.json(`/api/sessions/${s.id}/intake-job`,'POST',{externalConsent:true})).status,409);
  await f.json(`/api/sessions/${s.id}/intake-job`,'DELETE');
  const job=await terminal(f,s.id);assert.equal(job.status,'interrupted');
  assert.equal((await f.json(`/api/sessions/${s.id}`)).data.files.length,1);
  // Startup recovery exposes unfinished jobs, never silently restarts or marks them complete.
  f.server.sessionBridge.service.store.update(s.id,w=>{w.intakeJob.status='running';});
  const recovered=new IntakeJobs(f.server.sessionBridge,{list:()=>[]});
  assert.equal(recovered.get(s.id).status,'interrupted');
});
test('background model failure is visible in job status and can be retried without uploading again',async t=>{
  let fail=true;
  const provider=new DeepSeekProvider({apiKey:'synthetic',model:'job-test'});
  provider.complete=async()=>{if(fail) throw new Error('synthetic failure');return {message:{role:'assistant',content:'需要补充患者姓名'}};};
  const f=await fixture(t,{provider}),s=await f.session('上传资料建档');
  await f.json(`/api/sessions/${s.id}/files`,'POST',{name:'source.txt',text:'合成病例资料'});
  await f.json(`/api/sessions/${s.id}/intake-job`,'POST',{externalConsent:true});
  assert.equal((await terminal(f,s.id)).status,'failed');
  fail=false;
  await f.json(`/api/sessions/${s.id}/intake-job`,'POST',{externalConsent:true});
  const job=await terminal(f,s.id);assert.equal(job.status,'needs_input');assert.match(job.reply,/姓名/);
  assert.equal((await f.json(`/api/sessions/${s.id}`)).data.files.length,1);
});
