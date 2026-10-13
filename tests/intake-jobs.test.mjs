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

test('a textual claim of a submitted draft cannot become a confirmation-ready intake', async t => {
  const provider=new DeepSeekProvider({apiKey:'synthetic',model:'false-completion-test'});
  provider.complete=async()=>({message:{role:'assistant',content:'已调用 patient_create_propose 生成待核对草稿。提案已提交，请确认是否建档？'}});
  const f=await fixture(t,{provider}),s=await f.session('上传资料建档');
  await f.json(`/api/sessions/${s.id}/files`,'POST',{name:'source.txt',text:'合成患者，资料记录高血压。'});
  await f.json(`/api/sessions/${s.id}/intake-job`,'POST',{externalConsent:true});
  const job=await terminal(f,s.id);
  assert.equal(job.status,'failed');
  assert.match(job.error,/未生成可核对/);
  assert.equal(job.reply,'');
  assert.equal((await f.json(`/api/sessions/${s.id}`)).data.files.length,1);
  provider.complete=async()=>({message:{role:'assistant',content:'已读完资料，但未生成提案，请补充患者姓名。'}});
  await f.json(`/api/sessions/${s.id}/intake-job`,'POST',{externalConsent:true});
  const question=await terminal(f,s.id);
  assert.equal(question.status,'needs_input');
  assert.match(question.reply,/补充患者姓名/);
});

test('a repeated proposal in one intake keeps the complete draft and finalizes without another model call', async t => {
  const provider = new DeepSeekProvider({apiKey:'synthetic',model:'duplicate-proposal-test'});
  let round = 0;
  const tool = (name, args, suffix='') => ({id:`call-${round}-${suffix}`,type:'function',function:{name,arguments:JSON.stringify(args)}});
  provider.complete = async () => {
    const step = round++;
    if (step === 0) return {message:{role:'assistant',tool_calls:[tool('read_intake_batch',{})]}};
    if (step === 1) return {message:{role:'assistant',tool_calls:[tool('save_intake_notes',{notes:'合成患者，资料记录高血压。来源 source.txt 第1行。'})]}};
    if (step === 2) return {message:{role:'assistant',tool_calls:[tool('read_personal_context',{})]}};
    if (step === 3) return {message:{role:'assistant',tool_calls:[
      tool('patient_create_propose',{name:'合成患者',phone:'',summary:'完整草稿',diagnoses:[{name:'高血压',status:'confirmed',source:'source.txt 第1行'}],clinicalSummary:{text:'资料记载高血压。',source:'source.txt 第1行'}},'first'),
      tool('patient_create_propose',{name:'合成患者',summary:'占位校验'},'duplicate')
    ]}};
    throw new Error('the existing proposal should finish intake without another request');
  };
  const f=await fixture(t,{provider}),s=await f.session('上传资料建档');
  await f.json(`/api/sessions/${s.id}/files`,'POST',{name:'source.txt',text:'合成患者，资料记录高血压。'});
  await f.json(`/api/sessions/${s.id}/intake-job`,'POST',{externalConsent:true});
  const job=await terminal(f,s.id);
  assert.equal(job.status,'needs_input');
  assert.equal(round,4);
  const pending=(await f.json(`/api/pending-actions?type=patient-create&sourceSessionId=${s.id}`)).data.actions;
  assert.equal(pending.length,1);
  assert.equal(pending[0].payload.phone,'');
  assert.equal(pending[0].payload.diagnoses[0].name,'高血压');
  assert.equal(pending[0].payload.clinicalSummary.text,'资料记载高血压。');
  const firstId=pending[0].id;
  assert.equal((await f.json(`/api/pending-actions?type=patient-create&sourceSessionId=${s.id}&status=superseded`)).data.actions.length,0);
  // A deliberate rerun remains able to replace the previous draft.
  round=0;
  await f.json(`/api/sessions/${s.id}/intake-job`,'POST',{externalConsent:true});
  assert.equal((await terminal(f,s.id)).status,'needs_input');
  const next=(await f.json(`/api/pending-actions?type=patient-create&sourceSessionId=${s.id}`)).data.actions;
  assert.equal(next.length,1);
  assert.notEqual(next[0].id,firstId);
  provider.complete=async()=>({message:{role:'assistant',content:'新草稿已提交，请确认。'}});
  await f.json(`/api/sessions/${s.id}/intake-job`,'POST',{externalConsent:true});
  assert.equal((await terminal(f,s.id)).status,'failed');
  const retained=(await f.json(`/api/pending-actions?type=patient-create&sourceSessionId=${s.id}`)).data.actions;
  assert.equal(retained.length,1);
  assert.equal(retained[0].id,next[0].id);
  assert.equal(retained[0].payload.diagnoses[0].name,'高血压');
});
