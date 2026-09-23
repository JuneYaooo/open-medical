import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { DeepSeekProvider } from '../server/provider.mjs';
import { fixture } from './helpers.mjs';
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function readBatch(messages) {
  const batch=messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content)}catch{return {}}}).findLast(value=>Array.isArray(value.materials) || value.intakeNotesSaved || value.awaitingNotes);
  if (batch?.materials || batch?.awaitingNotes) return {message:{role:'assistant',content:'',tool_calls:[{id:`notes-${messages.length}`,type:'function',function:{name:'save_intake_notes',arguments:JSON.stringify({batchId:batch.batchId,notes:'合成协议验收笔记，来源已随批次保存。'})}}]}};
  if (batch?.complete) return null;
  return {message:{role:'assistant',content:'',tool_calls:[{id:`read-${messages.length}`,type:'function',function:{name:'read_intake_batch',arguments:JSON.stringify(batch?.nextCursor || {})}}]}};
}

test('upload-first intake automatically runs, allows natural-language correction, then saves sources with confirmed patient', {skip:!existsSync(chrome)||!existsSync('dist/index.html')}, async t=>{
  const provider=new DeepSeekProvider({apiKey:'synthetic',model:'intake-ui-test'});
  let turns=0;
  provider.complete=async messages=>{
    const batch=readBatch(messages); if(batch) return batch;
    if(messages.filter(m=>m.role==='tool').some(m=>m.name==='patient_create_propose' || m.content.includes('提案已创建'))) return {message:{role:'assistant',content:'资料已整理，请核对建档草稿。'}};
    turns++;
    return {message:{role:'assistant',content:'',tool_calls:[{id:`intake-${turns}`,type:'function',function:{name:'patient_create_propose',arguments:JSON.stringify({name:turns===1?'自动建档样本':'纠正后样本',gender:'male',summary:'从上传资料整理',clinicalSummary:{text:'2026-09-20就诊记录有合成诊断与合成检验。',source:'history.txt 第1-2行'},note:'合成核对备注：报告编号待核对',diagnoses:[{name:'合成诊断',source:'history.txt 第1行'}],labs:[{item:'合成检验',value:12,unit:'g/L',date:'2026-09-20',source:'history.txt 第2行'}]})}}]}};
  };
  const f=await fixture(t,{provider});
  const browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1400,height:1100}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.origin + "/?view=home");
  await page.getByRole('button',{name:'上传资料建档',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'上传资料建档'});
  await dialog.getByRole('button',{name:'选择资料并自动解析'}).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b=>b.textContent.includes('选择资料并自动解析'))?.disabled);
  assert.equal(await dialog.getByRole('textbox').count(),0);
  await dialog.locator('input[type=file]').setInputFiles({name:'history.txt',mimeType:'text/plain',buffer:Buffer.from('自动建档样本 男 合成诊断\n合成检验 12 g/L 2026-09-20')});
  await dialog.getByRole('button',{name:'确认建档',exact:true}).waitFor({timeout:30000});
  await dialog.getByRole('heading',{name:'病史摘要',exact:true}).waitFor();
  assert.equal((await f.json('/api/patients')).data.patients.length,0);
  await dialog.getByRole('textbox').fill('姓名更正为纠正后样本');
  await dialog.getByRole('button',{name:'按补充内容重新整理'}).click();
  await dialog.getByText('纠正后样本',{exact:true}).waitFor({timeout:30000});
  await dialog.getByRole('button',{name:'确认建档',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  await page.getByRole('region',{name:'患者资料面板'}).getByRole('heading',{name:'患者资料总览'}).waitFor();
  const history=page.getByRole('article',{name:'病程概览'});
  assert.match(await history.innerText(),/2026-09-20就诊记录/);
  assert.doesNotMatch(await history.innerText(),/合成核对备注/);
  await history.getByText('资料备注与待核对信息',{exact:true}).click();
  assert.match(await history.innerText(),/合成核对备注/);
  const patients=(await f.json('/api/patients')).data.patients;
  assert.equal(patients.length,1);assert.equal(patients[0].name,'纠正后样本');
  const session=(await f.json(`/api/sessions/${patients[0].sessionId}`)).data;
  assert.ok(session.files.some(file=>file.name==='history.txt'));
  const actions=[...(await f.json('/api/pending-actions?status=applied')).data.actions,...(await f.json('/api/pending-actions?status=rejected')).data.actions];
  assert.equal(actions.filter(a=>a.status==='applied').length,1);
  assert.equal(actions.filter(a=>a.status==='rejected').length,1);
  assert.equal(turns,2);assert.deepEqual(errors,[]);
});

test('unreadable upload does not invoke model or create patient; manual creation remains optional', {skip:!existsSync(chrome)},async t=>{
  let calls=0;const provider=new DeepSeekProvider({apiKey:'synthetic',model:'intake-ui-test'});
  provider.complete=async()=>{calls++;throw new Error('should not run')};
  const f=await fixture(t,{provider}),browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();await page.goto(f.origin + "/?view=home");
  await page.getByRole('button',{name:'上传资料建档',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'上传资料建档'});
  await dialog.getByRole('button',{name:'选择资料并自动解析'}).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b=>b.textContent.includes('选择资料并自动解析'))?.disabled);
  await dialog.locator('input[type=file]').setInputFiles({name:'empty.docx',mimeType:'application/octet-stream',buffer:Buffer.alloc(0)});
  await dialog.getByRole('alert').filter({hasText:'没有可解析的资料'}).waitFor();
  assert.equal(calls,0);assert.equal((await f.json('/api/patients')).data.patients.length,0);
  await dialog.getByRole('button',{name:'没有资料？手动建档'}).click();
  await page.getByRole('dialog',{name:'新建患者',exact:true}).getByLabel('姓名 *').waitFor();
});

test('36 real uploaded images skip one duplicate, prepare all 35 locally, restore and confirm without losing OCR', {skip:!process.env.MEDICAL_BATCH_DIRECTORY||!existsSync(chrome),timeout:240000}, async t=>{
  const {readdir}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const provider=new DeepSeekProvider({apiKey:'synthetic',model:'batch-ui-test'});
  let calls=0, proposed=false;
  provider.complete=async (messages, tools)=>{
    if (!tools.length) return {message:{role:'assistant',content:'合成协议验收：继续按游标读取所有材料，再提交合成草稿。'}};
    const batch=readBatch(messages); if(batch) return batch;
    calls++;
    if(proposed) return {message:{role:'assistant',content:'已生成合成验收草稿'}};
    proposed=true;
    return {message:{role:'assistant',content:'',tool_calls:[{id:'batch-proposal',type:'function',function:{name:'patient_create_propose',arguments:JSON.stringify({name:'批量导入验收样本',summary:'仅供批量上传协议验收，不包含临床结论'})}}]}};
  };
  const f=await fixture(t,{provider}),browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.origin + "/?view=home");await page.getByRole('button',{name:'上传资料建档',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'上传资料建档'});
  await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent.includes('选择资料并自动解析'))?.disabled);
  const paths=(await readdir(process.env.MEDICAL_BATCH_DIRECTORY)).filter(name=>/^微信图片_2025-08-19_.*\.jpg$/.test(name)).sort().map(name=>join(process.env.MEDICAL_BATCH_DIRECTORY,name));
  assert.equal(paths.length,36);
  await dialog.locator('input[type=file]').setInputFiles(paths);
  await dialog.getByText('已自动跳过 1 份重复资料，保留已有内容，不影响解析。').waitFor({timeout:60000});
  await dialog.getByRole('button',{name:'确认建档',exact:true}).waitFor({timeout:180000});
  const sessions=(await f.json('/api/sessions')).data.sessions;
  const source=(await f.json(`/api/sessions/${sessions[0].id}`)).data;
  assert.equal(source.files.length,35);
  assert.equal(source.files.filter(file=>file.extraction.ocr?.status==='ready').length,35);
  assert.ok(source.files.every(file=>file.text.length>100));
  assert.equal(source.intakeIssues.length,0);
  const completedAt=source.files.map(file=>file.extraction.ocr.completedAt);
  const repeated=await f.json(`/api/sessions/${source.id}/files/${source.files[0].id}/prepare`,'POST',{});
  assert.equal(repeated.data.extraction.ocr.completedAt,completedAt[0]);
  await page.reload();await page.getByRole('button',{name:'上传资料建档',exact:true}).first().click();
  await dialog.getByRole('button',{name:'核对这份草稿'}).click();
  await dialog.getByRole('button',{name:'确认建档',exact:true}).waitFor();
  assert.match(await dialog.innerText(),/已载入所选任务的 35 份资料/);
  await dialog.getByRole('button',{name:'确认建档',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const patient=(await f.json('/api/patients')).data.patients[0];
  const chart=(await f.json(`/api/sessions/${patient.sessionId}`)).data;
  const images=chart.files.filter(file=>file.extraction?.type==='image');
  assert.equal(images.length,35);assert.ok(images.every(file=>file.extraction.ocr?.status==='ready'));
  assert.deepEqual(images.map(file=>file.text),source.files.map(file=>file.text));
  assert.equal(calls,2);assert.deepEqual(errors,[]);
  t.diagnostic(JSON.stringify({uploads:36,unique:35,ocrReady:35,restored:true,originalsCopied:35,modelCalls:calls}));
});

test('partial upload failures do not block good files; incomplete draft requires acknowledgement even after reload', {skip:!existsSync(chrome)}, async t=>{
  const provider=new DeepSeekProvider({apiKey:'synthetic',model:'partial-ui-test'});
  provider.complete=async messages=>readBatch(messages) || (messages.filter(m=>m.role==='tool').some(m=>m.content.includes('提案已创建'))?{message:{role:'assistant',content:'待核对'}}:{message:{role:'assistant',content:'',tool_calls:[{id:'partial',type:'function',function:{name:'patient_create_propose',arguments:JSON.stringify({name:'部分资料样本',summary:'资料不完整，待补充'})}}]}});
  const f=await fixture(t,{provider}),browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();await page.goto(f.origin + "/?view=home");await page.getByRole('button',{name:'上传资料建档',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'上传资料建档'});
  await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent.includes('选择资料并自动解析'))?.disabled);
  await dialog.locator('input[type=file]').setInputFiles([{name:'good.txt',mimeType:'text/plain',buffer:Buffer.from('部分资料样本 合成病史')},{name:'bad.txt',mimeType:'text/plain',buffer:Buffer.alloc(0)}]);
  await dialog.getByRole('button',{name:'确认建档',exact:true}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'确认建档',exact:true}).isDisabled(),true);
  await page.reload();await page.getByRole('button',{name:'上传资料建档',exact:true}).first().click();
  await dialog.getByRole('button',{name:'核对这份草稿'}).click();
  await dialog.getByRole('button',{name:'确认建档',exact:true}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'确认建档',exact:true}).isDisabled(),true);
  await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'确认建档',exact:true}).click();
  await dialog.waitFor({state:'hidden'});assert.equal((await f.json('/api/patients')).data.patients.length,1);
});

test('new intake and explicit resume isolate multiple patients, failed uploads and saved drafts', {skip:!existsSync(chrome)}, async t=>{
  const provider=new DeepSeekProvider({apiKey:'synthetic',model:'task-choice-test'});
  let fail=true;
  provider.complete=async messages=>{
    if(fail) throw new Error('合成解析失败');
    return readBatch(messages) || (messages.some(m=>m.role==='tool' && m.content.includes('提案已创建'))
      ? {message:{role:'assistant',content:'待核对'}}
      : {message:{role:'assistant',content:'',tool_calls:[{id:'choice',type:'function',function:{name:'patient_create_propose',arguments:JSON.stringify({name:'患者乙草稿',summary:'合成隔离验收'})}}]}});
  };
  const f=await fixture(t,{provider}),browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
  const first=await f.session('上传资料建档');
  await f.json(`/api/sessions/${first.id}/files`,'POST',{name:'患者甲.txt',text:'患者甲的资料，仅属于患者甲。',mimeType:'text/plain'});
  const page=await browser.newPage();await page.goto(f.origin + "/?view=home");
  const open=()=>page.getByRole('button',{name:'上传资料建档',exact:true}).first().click();
  await open();const dialog=page.getByRole('dialog',{name:'上传资料建档'});
  const task=name=>dialog.getByRole('article',{name:`建档任务：${name}`});
  await task('患者甲.txt').waitFor();
  assert.equal(await dialog.getByRole('list',{name:'已上传资料'}).count(),0);
  assert.equal(await dialog.getByRole('textbox').count(),0);
  const upload=name=>dialog.locator('input[type=file]').setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(`${name} 的独立病史`)});
  await upload('患者乙.txt');
  await dialog.getByRole('alert').waitFor();
  const sessions=(await f.json('/api/sessions')).data.sessions;
  const second=sessions.find(s=>s.id!==first.id && s.title==='上传资料建档');assert.ok(second);assert.equal(second.lastRunStatus,'failed');
  assert.deepEqual((await f.json(`/api/sessions/${second.id}`)).data.files.map(x=>x.name),['患者乙.txt']);
  await dialog.getByRole('textbox').fill('不能带到其他患者的纠正');
  await dialog.getByRole('button',{name:'为另一位患者新建'}).click();
  await task('患者甲.txt').waitFor();await task('患者乙.txt').waitFor();
  await task('患者甲.txt').getByRole('button',{name:'继续这个任务'}).click();
  await dialog.getByText('已载入所选任务的 1 份资料，无需重新上传。').waitFor();
  assert.equal(await dialog.getByRole('textbox').inputValue(),'');
  assert.deepEqual(await dialog.locator('ul[aria-label="已上传资料"] li').allTextContents(),['患者甲.txt']);
  await dialog.getByRole('button',{name:'为另一位患者新建'}).click();
  await task('患者乙.txt').getByRole('button',{name:'继续这个任务'}).click();
  await dialog.getByText('已载入所选任务的 1 份资料，无需重新上传。').waitFor();
  fail=false;
  await dialog.getByRole('button',{name:'继续解析已保存资料',exact:true}).click();
  await dialog.getByRole('button',{name:'确认建档',exact:true}).waitFor();
  await dialog.getByRole('button',{name:'为另一位患者新建'}).click();
  await task('患者乙.txt').getByRole('button',{name:'核对这份草稿'}).waitFor();
  // A wholly unreadable new patient's upload still has a recoverable, separate task.
  await dialog.locator('input[type=file]').setInputFiles({name:'患者丙.txt',mimeType:'text/plain',buffer:Buffer.alloc(0)});
  await dialog.getByRole('alert').filter({hasText:'没有可解析的资料'}).waitFor();
  await page.reload();await open();
  await task('患者丙.txt').waitFor();await task('患者甲.txt').waitFor();
  assert.equal(await dialog.getByRole('button',{name:'确认建档',exact:true}).count(),0);
  await task('患者乙.txt').getByRole('button',{name:'核对这份草稿'}).click();
  await dialog.getByRole('button',{name:'确认建档',exact:true}).waitFor();
  assert.deepEqual(await dialog.locator('ul[aria-label="已上传资料"] li').allTextContents(),['患者乙.txt']);
  assert.equal(await dialog.getByRole('checkbox').count(),0);
  await dialog.getByRole('button',{name:'确认建档',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.reload();await open();await task('患者甲.txt').waitFor();
  assert.equal(await task('患者乙.txt').count(),0);await task('患者丙.txt').waitFor();
  assert.deepEqual((await f.json(`/api/sessions/${first.id}`)).data.files.map(x=>x.name),['患者甲.txt']);
  const patient=(await f.json('/api/patients')).data.patients[0];
  const chart=(await f.json(`/api/sessions/${patient.sessionId}`)).data;
  assert.deepEqual(chart.files.filter(x=>x.name!=='建档时的对话输入.txt').map(x=>x.name),['患者乙.txt']);
  assert.ok(!chart.files.some(x=>x.text?.includes('不能带到其他患者的纠正')));
});

test('background intake survives closing during upload, navigation and reload; progress becomes a reviewable draft', {skip:!existsSync(chrome)}, async t=>{
  let releaseModel, releaseUpload;
  const modelGate=new Promise(resolve=>{releaseModel=resolve;});
  const uploadGate=new Promise(resolve=>{releaseUpload=resolve;});
  t.after(()=>{releaseModel();releaseUpload();});
  let entered=false;
  const provider=new DeepSeekProvider({apiKey:'synthetic',model:'background-ui-test'});
  provider.complete=async messages=>{
    entered=true;await modelGate;
    return readBatch(messages) || (messages.some(m=>m.role==='tool' && m.content.includes('提案已创建'))
      ? {message:{role:'assistant',content:'后台整理完成'}}
      : {message:{role:'assistant',content:'',tool_calls:[{id:'background',type:'function',function:{name:'patient_create_propose',arguments:JSON.stringify({name:'后台验收患者',summary:'关闭窗口后完成'})}}]}});
  };
  const f=await fixture(t,{provider}),browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('**/api/sessions/*/files',async route=>{if(route.request().method()==='POST') await uploadGate;await route.continue();});
  await page.goto(f.origin + "/?view=home");await page.getByRole('button',{name:'上传资料建档',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'上传资料建档'});
  await dialog.locator('input[type=file]').setInputFiles({name:'后台患者.txt',mimeType:'text/plain',buffer:Buffer.from('后台验收患者 病史资料')});
  await dialog.getByRole('button',{name:'后台处理，关闭窗口'}).click();await dialog.waitFor({state:'hidden'});
  releaseUpload();
  for(let i=0;i<100 && !entered;i++) await new Promise(r=>setTimeout(r,50));
  assert.ok(entered,'server began processing after modal closed during upload');
  const source=(await f.json('/api/sessions')).data.sessions.find(s=>s.title==='上传资料建档');
  assert.equal(source.intake.job.status,'running');
  const other=await f.session('同时处理其他任务');
  const local=await f.chat(other.id,'整理任务资料',{mode:'local'});assert.equal(local.status,200);
  await page.reload();
  const indicator=page.getByRole('complementary',{name:'后台建档状态'});
  await indicator.getByText(/1 项后台处理/).waitFor();
  await indicator.getByRole('button',{name:'查看建档任务'}).click();
  await dialog.getByRole('button',{name:'查看处理进度'}).click();
  await dialog.getByRole('button',{name:'后台处理，关闭窗口'}).click();
  assert.equal((await f.json(`/api/sessions/${source.id}/intake-job`)).data.job.status,'running');
  releaseModel();
  await indicator.getByText(/1 份草稿待核对/).waitFor({timeout:30000});
  assert.equal((await f.json('/api/patients')).data.patients.length,0);
  await indicator.getByRole('button',{name:'查看建档任务'}).click();
  assert.equal(await dialog.getByRole('button',{name:'继续这个任务'}).count(),0);
  await dialog.getByRole('button',{name:'核对这份草稿'}).click();
  await dialog.getByRole('button',{name:'确认建档',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.equal((await f.json('/api/patients')).data.patients[0].name,'后台验收患者');
  await indicator.waitFor({state:'hidden'});
});
