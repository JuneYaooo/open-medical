import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { fixture } from './helpers.mjs';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const skip = !existsSync(chrome) || !existsSync('dist/index.html');
const output = 'output/playwright/audit-20260925';
async function setup(t) {
  const f = await fixture(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { mkdirSync(output, {recursive:true}); await page.screenshot({path:`${output}/${t.name.replace(/[^a-z0-9-]/gi,'_')}.png`,fullPage:true}); await browser.close(); assert.deepEqual(errors, []); });
  return {...f, page};
}

test('navigation patient tabs survive reload and browser back-forward without wrong identity', {skip}, async t => {
  const {page, origin, json} = await setup(t);
  const patient = (await json('/api/patients','POST',{name:'导航合成患者'})).data;
  await page.goto(origin+'/?view=patients');
  await page.locator('.patient-card').filter({hasText:patient.name}).click();
  await page.getByRole('button',{name:'用药与过敏',exact:true}).click();
  await page.waitForURL(/tab=medications/);
  assert.equal(new URL(page.url()).searchParams.get('patient'),patient.id);
  assert.ok(!page.url().includes(encodeURIComponent(patient.name)));
  await page.reload();
  await page.getByRole('button',{name:'核对与编辑',exact:true}).waitFor();
  await page.getByRole('navigation',{name:'主要业务'}).getByRole('button',{name:'随访',exact:true}).click();
  await page.getByRole('heading',{name:'随访管理',exact:true}).waitFor();
  await page.goBack();
  await page.getByRole('button',{name:'核对与编辑',exact:true}).waitFor();
  assert.match(await page.locator('.patients-toolbar').innerText(),/导航合成患者/);
  await page.goForward();
  await page.getByRole('heading',{name:'随访管理',exact:true}).waitFor();
  await page.goBack();
  await page.getByRole('button',{name:'返回列表',exact:true}).click();
  await page.waitForURL(url=>!url.searchParams.has('patient'));
  await page.reload();
  await page.getByRole('heading',{name:'患者管理',exact:true}).waitFor();
});

test('navigation task reload keeps task and all tool routes restore the selected page', {skip}, async t => {
  const {page, origin, session} = await setup(t);
  const task = await session('导航恢复任务');
  await page.goto(origin+'/?view=tasks');
  await page.getByRole('button',{name:/导航恢复任务/}).first().click();
  await page.waitForURL(/view=workbench/);
  assert.equal(new URL(page.url()).searchParams.get('session'),task.id);
  await page.reload();
  await page.locator('.conversation-head h1').filter({hasText:task.title}).waitFor();
  for (const [view, title] of [['literature','文献'],['clinical-ref','临床'],['drg','DRG'],['data-analysis','数据分析']]) {
    await page.goto(origin+'/?view='+view);
    await page.locator('h1').filter({hasText:title}).first().waitFor();
    await page.reload();
    await page.locator('h1').filter({hasText:title}).first().waitFor();
  }
});

test('recovery bootstrap and patient list failure offer retry without claiming empty data', {skip}, async t => {
  const {page, origin} = await setup(t);
  await page.route('**/api/bootstrap',route=>route.fulfill({status:503,body:'unavailable'}));
  await page.goto(origin);
  await page.getByRole('heading',{name:'暂时无法连接工作台'}).waitFor();
  await page.unroute('**/api/bootstrap');
  await page.getByRole('button',{name:'重新连接',exact:true}).click();
  await page.getByRole('textbox',{name:'任务内容'}).waitFor();
  await page.route('**/api/patients?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成列表失败'})}));
  await page.getByRole('navigation',{name:'主要业务'}).getByRole('button',{name:'患者',exact:true}).click();
  await page.getByRole('button',{name:'重新加载患者'}).waitFor();
  assert.equal(await page.getByText('建立第一份患者档案',{exact:true}).count(),0);
  await page.unroute('**/api/patients?*');
  await page.getByRole('button',{name:'重新加载患者'}).click();
  await page.getByRole('heading',{name:'建立第一份患者档案'}).waitFor();
  await page.getByRole('button',{name:'手动填写基本信息'}).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({state:'hidden'});
});

test('followup queue exposes plans beyond twenty and deletion requires a reviewable choice', {skip}, async t => {
  const {page, origin, json} = await setup(t);
  const patient = (await json('/api/patients','POST',{name:'排程合成患者'})).data;
  const other = (await json('/api/patients','POST',{name:'排程合成患者乙'})).data;
  for(let i=0;i<23;i++) { const result = await json(`/api/patients/${i < 20 ? patient.id : other.id}/followups`,'POST',{name:`计划${String(i).padStart(2,'0')}`,once:true,firstDueAt:new Date(Date.now()+(i+1)*86400000).toISOString(),checklist:['核实反馈']}); assert.ok(result.status < 300,JSON.stringify(result.data)); }
  await page.goto(origin+'/?view=followups');
  await page.getByRole('button',{name:'计划与模板',exact:true}).click();
  await page.getByRole('button',{name:/显示更多计划/}).click();
  assert.equal(await page.locator('.job-list li').filter({hasText:'排程合成患者'}).count(),23);
  const row = page.locator('.job-list li').filter({hasText:'计划22'});
  await row.getByRole('button',{name:'删除',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'删除随访计划'});
  await modal.waitFor();
  await page.screenshot({path:`${output}/followup-delete-confirm.png`});
  await modal.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await row.count(),1);
  await row.getByRole('button',{name:'删除',exact:true}).click();
  await modal.getByRole('button',{name:'确认删除',exact:true}).click();
  await page.getByRole('status').filter({hasText:'随访计划已删除'}).waitFor();
  assert.equal(await row.count(),0);
  await page.locator('.job-list li').filter({hasText:'计划21'}).getByRole('button',{name:'打开患者',exact:true}).click();
  await page.getByRole('button',{name:'随访计划',exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('patient'),other.id);
});

test('draft navigation retains unsent home text and attachments until explicit new task', {skip}, async t => {
  const {page, origin} = await setup(t);
  await page.goto(origin);
  await page.getByRole('textbox',{name:'任务内容'}).fill('暂存的合成病例整理要求');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button',{name:'添加材料',exact:true}).click();
  const uploaded = page.waitForResponse(r=>r.url().endsWith('/files')&&r.request().method()==='POST');
  await (await chooser).setFiles({name:'draft.txt',mimeType:'text/plain',buffer:Buffer.from('仅用于导航验证的合成材料')});
  await uploaded;
  await page.locator('.attach-chip',{hasText:'draft.txt'}).waitFor();
  await page.getByRole('navigation',{name:'主要业务'}).getByRole('button',{name:'患者',exact:true}).click();
  await page.goBack();
  assert.equal(await page.getByRole('textbox',{name:'任务内容'}).inputValue(),'暂存的合成病例整理要求');
  assert.match(await page.locator('.hub-composer').innerText(),/draft\.txt/);
  await page.getByRole('button',{name:'清空草稿',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'任务内容'}).inputValue(),'');
});

test('literature abstract failure recovers in place and repeated import creates one task', {skip}, async t => {
  const {page, origin, json} = await setup(t);
  const article={pmid:'123456',title:'Synthetic literature recovery',journal:'Fixture Journal',year:'2026',authors:['Fixture A']};
  await page.route('**/api/literature/search?*',route=>route.fulfill({json:{count:1,source:'pubmed',articles:[article]}}));
  let failed = true;
  await page.route('**/api/literature/article?*',route=>route.fulfill(failed ? {status:503,json:{error:'合成摘要连接失败'}} : {json:{...article,abstract:'Recovered synthetic abstract'}}));
  let imports=0;
  await page.route('**/api/literature/import',async route=>{imports++; await new Promise(resolve=>setTimeout(resolve,150)); await route.fulfill({json:{ok:true}});});
  await page.goto(origin+'/?view=literature');
  await page.locator('.literature-view input').first().fill('synthetic recovery');
  await page.locator('.literature-view').getByRole('button',{name:'检索',exact:true}).click();
  await page.getByRole('button',{name:article.title}).click();
  await page.getByRole('button',{name:'重试摘要'}).waitFor();
  failed=false;
  await page.getByRole('button',{name:'重试摘要'}).click();
  await page.getByText('Recovered synthetic abstract',{exact:true}).waitFor();
  await page.getByRole('button',{name:'导入为材料',exact:true}).dblclick();
  await page.waitForURL(/view=workbench/);
  assert.equal(imports,1);
  const sessions=(await json('/api/sessions')).data.sessions;
  assert.equal(sessions.filter(s=>s.title.includes(article.title)).length,1);
});

test('statistics and clinical scale input changes remove obsolete results', {skip}, async t => {
  const {page, origin} = await setup(t);
  await page.goto(origin+'/?view=data-analysis');
  await page.getByPlaceholder('预期差值 Δ').fill('5');
  await page.getByPlaceholder('标准差 σ').fill('10');
  await page.getByRole('button',{name:'计算',exact:true}).click();
  await page.getByText(/共 126 例/).waitFor();
  await page.getByPlaceholder('预期差值 Δ').fill('6');
  assert.equal(await page.getByText(/共 126 例/).count(),0);
  await page.goto(origin+'/?view=clinical-ref');
  await page.getByRole('combobox',{name:'选择量表'}).selectOption('bmi');
  await page.getByLabel(/体重/).fill('60');
  await page.getByLabel(/身高/).fill('170');
  await page.getByRole('button',{name:'计算',exact:true}).click();
  await page.locator('.drg-result').waitFor();
  await page.getByLabel(/体重/).fill('80');
  assert.equal(await page.locator('.drg-result').count(),0);
});

test('doctor preferences failed save keeps typed changes and can retry successfully', {skip}, async t=>{
  const {page,origin}=await setup(t);
  await page.goto(origin);
  await page.locator(".app-navigation").waitFor();
  await page.getByRole('button',{name:'设置与连接',exact:true}).click();await page.getByRole('button',{name:'医生档案与记忆',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByText('结构化偏好表单（高级）',{exact:true}).click();
  await dialog.getByLabel('科室',{exact:true}).fill('合成偏好草稿');
  await page.route('**/api/doctor/profile',route=>route.request().method()==='PATCH'?route.fulfill({status:409,json:{error:'合成保存失败'}}):route.continue());
  await dialog.getByRole('button',{name:'保存偏好',exact:true}).click();
  await dialog.getByRole('alert').filter({hasText:'合成保存失败'}).waitFor();
  assert.equal(await dialog.getByLabel('科室',{exact:true}).inputValue(),'合成偏好草稿');
  await page.unroute('**/api/doctor/profile');
  await dialog.getByRole('button',{name:'保存偏好',exact:true}).click();
  await dialog.getByRole('status').filter({hasText:'偏好已保存'}).waitFor();
});

test('research rapid task changes never show files from an earlier slow response', {skip}, async t=>{
  const {page,origin,session,json}=await setup(t);
  const a=await session('慢速数据任务'),b=await session('当前数据任务');
  await json(`/api/sessions/${a.id}/files`,'POST',{name:'slow.csv',text:'value\n1'});
  await json(`/api/sessions/${b.id}/files`,'POST',{name:'current.csv',text:'value\n2'});
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  await page.route(`**/api/sessions/${a.id}`,async route=>{await gate;await route.continue();});
  await page.goto(origin+'/?view=data-analysis');
  await page.getByRole('combobox',{name:'选择数据所在任务'}).selectOption(a.id);
  await page.getByRole('combobox',{name:'选择数据所在任务'}).selectOption(b.id);
  await page.getByRole('combobox',{name:'选择 CSV 数据'}).selectOption({label:'current.csv'});
  const completed=page.waitForResponse(r=>r.url().endsWith(`/api/sessions/${a.id}`));release();await completed;
  await page.getByRole('combobox',{name:'选择 CSV 数据'}).selectOption({label:'current.csv'});
  assert.equal(await page.locator('option',{hasText:'slow.csv'}).count(),0);
});

test('patient open failure keeps the previously selected identity and offers the list', {skip}, async t=>{
  const {page,origin,json}=await setup(t);
  const a=(await json('/api/patients','POST',{name:'原患者合成'})).data;
  const b=(await json('/api/patients','POST',{name:'失败患者合成'})).data;
  await page.goto(origin+'/?view=patients');
  await page.locator('.patient-card').filter({hasText:a.name}).click();
  await page.getByRole('button',{name:'返回列表',exact:true}).click();
  await page.route(`**/api/patients/${b.id}`,route=>route.fulfill({status:503,json:{error:'合成患者读取失败'}}));
  await page.locator('.patient-card').filter({hasText:b.name}).click();
  await page.getByRole('alert').filter({hasText:'合成患者读取失败'}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('om.currentPatient')),a.id);
  assert.equal(await page.locator('.patient-card').count(),2);
  await page.unroute(`**/api/patients/${b.id}`);
  await page.locator('.patient-card').filter({hasText:b.name}).click();
  await page.getByRole('heading',{name:b.name,exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('om.currentPatient')),b.id);
});


test('business tool directory excludes agent internals and guides document model setup', {skip}, async t => {
  const {page,origin}=await setup(t);
  await page.goto(origin+'/?view=tools');
  const card=page.locator('.directory-tools article').filter({has:page.getByRole('heading',{name:'文档与表格',exact:true})});
  await card.getByRole('link',{name:/配置模型/}).click();
  await page.getByRole('dialog',{name:'切换模型',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  for(const name of ['浏览器','终端与代码','技能与连接','DRG 测算']) assert.equal(await page.getByRole('heading',{name,exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'工作环境',exact:true}).count(),0);
});

test('document processing uses project scope without exposing runtime configuration', {skip}, async t => {
  const {page,origin}=await setup(t);
  await page.route('**/api/bootstrap',async route=>{const response=await route.fetch(); const data=await response.json(); await route.fulfill({json:{...data,modelConfigured:true}});});
  await page.goto(origin+'/?view=tools');
  assert.equal(await page.getByRole('button',{name:'重新检查环境'}).count(),0);
  await page.getByRole('link',{name:/文档与表格.*开始处理/}).click();
  await page.getByRole('main',{name:'项目目录'}).getByText('选择项目，在任务中处理文档与表格。',{exact:true}).waitFor();
});
