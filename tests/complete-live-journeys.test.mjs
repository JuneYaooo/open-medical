// Explicit live provider opt-in. All business data is synthetic and databases isolated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { createServer } from '../server/agent.mjs';
import { createProvider } from '../server/core/providers.mjs';
import { backupDatabase } from '../scripts/backup.mjs';
const enabled=process.env.JOURNEY_LIVE==='1';
if(enabled&&existsSync('.env'))process.loadEnvFile('.env');
const output='output/playwright/journeys-20260924';mkdirSync(output,{recursive:true});

async function start(t,{blank=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'medical-live-journey-'));
 let database=join(dir,'state.sqlite'),server;
 const launch=async()=>{server=createServer({database,...(blank?{provider:createProvider({provider:'anthropic',apiKey:'',model:'unconfigured'})}:{}),followupOptions:{autoStart:false}});await new Promise(r=>server.listen(0,'127.0.0.1',r));};
 await launch();const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']});page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 t.after(async()=>{await page.screenshot({path:join(output,t.name.replace(/[^a-z0-9-]/gi,'_')+'.png'),fullPage:true});await browser.close();await server.shutdown();rmSync(dir,{recursive:true,force:true});assert.deepEqual(errors,[]);});
 const origin=()=>`http://127.0.0.1:${server.address().port}`;
 const json=async path=>{const r=await fetch(origin()+path,{headers:{'x-medical-token':server.token}});assert.ok(r.ok,path);return r.json();};
 await page.goto(origin());
 return {page,json,dir,get server(){return server;},restart:async(restore=false)=>{if(restore){const target=join(dir,'restored.sqlite');backupDatabase(database,target);database=target;}await server.shutdown();await launch();await page.goto(origin());},origin};
}
async function patient(page,name){
 await page.getByRole('navigation',{name:'主要业务'}).getByRole('button',{name:'患者',exact:true}).click();
 await page.locator('.patient-card',{hasText:name}).click();
}
async function finish(f,sessionId,before=0,workspace=false){
 const end=Date.now()+210000;let session;
 while(Date.now()<end){session=await f.json((workspace?'/api/workspaces/':'/api/sessions/')+sessionId);const r=session.runs.at(-1);if(session.runs.length>before&&r&&!['running','queued'].includes(r.status)){assert.equal(r.status,'completed',r.error);return session;}await new Promise(r=>setTimeout(r,500));}
 assert.fail('Live run did not complete within 210 seconds');
}
async function send(page,text){await page.getByRole('textbox',{name:'医疗工作需求',exact:true}).fill(text);await page.getByRole('button',{name:'发送任务',exact:true}).click();}

test('live journey empty settings to real connection first task restart and retained encrypted settings',{skip:!enabled,timeout:300000},async t=>{
 const f=await start(t,{blank:true}),{page}=f,provider=createProvider();assert.ok(provider.apiKey,'Project model configuration required');
 await page.locator('button[title^="当前模型"]').first().click();
 const dialog=page.getByRole('dialog');await dialog.getByLabel('服务商 / 接口协议').selectOption(provider.provider);
 await dialog.getByLabel('接口地址',{exact:true}).fill(provider.baseUrl);await dialog.getByLabel('模型名称',{exact:true}).fill(provider.model);
 await dialog.getByLabel(/^API Key/).fill(provider.apiKey);
 await dialog.getByRole('button',{name:'测试连接',exact:true}).click();await dialog.getByText(/已收到模型回复/).waitFor({timeout:40000});
 assert.equal((await f.json('/api/model-settings')).model,'unconfigured','Test must not activate configuration');
 await dialog.getByRole('button',{name:'保存并启用',exact:true}).click();await dialog.getByText(/已保存并启用/).waitFor();
 assert.equal(await dialog.getByLabel(/^API Key/).inputValue(),'');await dialog.getByRole('button',{name:'关闭模型设置'}).click();
 await page.getByRole('textbox',{name:'医疗任务内容'}).fill('这是合成软件验收。请仅回复“连接验收成功”，不调用工具。');await page.getByRole('button',{name:'发送任务',exact:true}).click();await page.locator('.composer').waitFor();
 const sessions=await f.json('/api/sessions');assert.equal(sessions.sessions.length,1);const id=sessions.sessions[0].id;
 const completed=await finish(f,id);assert.match(completed.messages.filter(m=>m.role==='assistant').at(-1).content,/连接验收成功/);
 await f.restart();const settings=await f.json('/api/model-settings');assert.equal(settings.model,provider.model);assert.equal(settings.source,'saved');assert.equal(settings.hasKey,true);
 await page.getByRole('button',{name:'任务记录',exact:true}).click();await page.getByRole('main',{name:'任务记录'}).getByRole('button',{name:/连接验收成功/}).click();await page.getByText('连接验收成功',{exact:true}).waitFor();
 assert.equal(readFileSync(join(f.dir,'state.sqlite')).includes(Buffer.from(provider.apiKey)),false);
});

test('live journey project proposal sandbox verification approval git rollback schedule restart',{skip:!enabled,timeout:420000},async t=>{
 const f=await start(t),{page}=f,root=join(f.dir,'project');mkdirSync(root);writeFileSync(join(root,'note.md'),'ORIGINAL_JOURNEY\n');
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();git('init','-q');git('add','note.md');git('-c','user.name=Journey Test','-c','user.email=journey@example.invalid','commit','-qm','initial synthetic fixture');git('config','user.name','Journey Test');git('config','user.email','journey@example.invalid');
 await page.getByRole('navigation',{name:'通用工作'}).getByRole('button',{name:'项目',exact:true}).click();await page.getByRole('button',{name:'连接项目',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill('项目执行闭环');await page.getByLabel('文件夹绝对路径',{exact:true}).fill(root);await page.getByLabel('授权此工作区读取该目录').check();await page.getByRole('button',{name:'创建工作区',exact:true}).click();
 await page.getByLabel('授权模式',{exact:true}).selectOption('workspace-write');await page.getByLabel('授权模式',{exact:true}).selectOption('review');
 const w=(await f.json('/api/workspaces')).workspaces[0];
 await page.getByRole('tab',{name:'设置',exact:true}).click();await page.getByText('高级授权（工具模式、可写子目录、独立 Git）',{exact:true}).click();await page.getByLabel('独立授权 Git 提交（不依赖“完全批准”档位）').check();await page.getByRole('button',{name:'保存高级授权',exact:true}).click();
 await page.getByText('工具、插件与记忆',{exact:true}).click();await page.getByText('授权与运行环境',{exact:true}).click();await page.getByLabel('隔离终端',{exact:true}).check();await page.getByLabel('沙箱镜像',{exact:true}).fill('open-medical-runtime:0.9-full');await page.getByLabel('我授权勾选的能力和上述来源').check();await page.getByRole('button',{name:'保存扩展授权',exact:true}).click();
 await page.getByRole('textbox',{name:'项目任务',exact:true}).fill('软件验收：读取 note.md，提出将其完整内容改成 AFTER_JOURNEY 加一个换行符的文件修改提案。仅用文件读取和写入提案工具，不运行终端、不提交 Git、不创建其他文件。由用户稍后审批。');await page.getByRole('textbox',{name:'项目任务',exact:true}).press('Enter');
 const run=await finish(f,w.id,0,true);assert.equal(readFileSync(join(root,'note.md'),'utf8'),'ORIGINAL_JOURNEY\n');assert.ok(run.approvals.some(a=>a.status==='pending'&&a.path==='note.md'));
 await page.getByText('代码验证与 Git 工作树',{exact:true}).click();const dev=page.locator('.workspace-development');await page.getByLabel('验证命令',{exact:true}).fill('node -e "require(\'node:assert/strict\').equal(require(\'node:fs\').readFileSync(\'note.md\',\'utf8\'),\'AFTER_JOURNEY\\n\');console.log(\'SNAPSHOT_VERIFIED\')"');
 await dev.getByRole('button',{name:/在隔离快照中验证/}).click();await dev.getByText(/SNAPSHOT_VERIFIED/).waitFor({timeout:45000});assert.equal(readFileSync(join(root,'note.md'),'utf8'),'ORIGINAL_JOURNEY\n');
 await page.getByRole('tab',{name:/^审批/}).click();await page.getByRole('button',{name:'批准并写入',exact:true}).click();
 await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='批准并写入'));
 assert.equal(readFileSync(join(root,'note.md'),'utf8'),'AFTER_JOURNEY\n');
 await page.getByRole('tab',{name:'设置',exact:true}).click();await dev.getByRole('button',{name:'读取 Git 状态',exact:true}).click();await dev.getByLabel('note.md',{exact:true}).check();await page.getByLabel('本地提交说明',{exact:true}).fill('Verify reviewed journey change');await dev.getByRole('button',{name:'确认提交 1 个所选文件到本地 Git',exact:true}).click();await dev.getByText('无可见变更',{exact:true}).waitFor();assert.equal(git('log','-1','--format=%s'),'Verify reviewed journey change');
 await page.getByRole('tab',{name:/^审批/}).click();await page.getByRole('button',{name:'生成回退提案',exact:true}).click();await page.getByRole('button',{name:'批准并写入',exact:true}).click();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='批准并写入'));assert.equal(readFileSync(join(root,'note.md'),'utf8'),'ORIGINAL_JOURNEY\n');
 await page.getByRole('tab',{name:'设置',exact:true}).click();await page.locator('.workspace-schedules > summary').click();
 await page.getByLabel('任务内容',{exact:true}).fill('软件验收，只回答 JOURNEY_SCHEDULE_OK，不调用工具。');const due=new Date(Math.ceil((Date.now()+15000)/60000)*60000);due.setMinutes(due.getMinutes()-due.getTimezoneOffset());await page.getByLabel('执行时间',{exact:true}).fill(due.toISOString().slice(0,16));await page.getByLabel('授权按此计划将任务和读取文件发送给当前模型').check();await page.getByRole('button',{name:'创建计划',exact:true}).click();await page.locator('.workspace-schedules article').waitFor();
 const before=(await f.json('/api/workspaces/'+w.id)).runs.length;await f.restart();await page.goto('about:blank');const scheduled=await finish(f,w.id,before,true);assert.match(scheduled.messages.filter(m=>m.role==='assistant').at(-1).content,/JOURNEY_SCHEDULE_OK/);assert.equal(scheduled.schedules.length,1);
 await page.goto(f.origin());await page.getByRole('navigation',{name:'通用工作'}).getByRole('button',{name:'项目',exact:true}).click();await page.locator('.directory-open',{hasText:'项目执行闭环'}).click();await page.getByText('JOURNEY_SCHEDULE_OK',{exact:true}).waitFor();
});

test('live journey one patient materials model chart proposal care followup backup restore and next consultation',{skip:!enabled,timeout:420000},async t=>{
 const f=await start(t),{page}=f;
 await page.getByRole('button',{name:'上传资料建档',exact:true}).click();await page.getByRole('button',{name:'没有资料？手动建档',exact:true}).click();
 await page.getByLabel('姓名 *',{exact:true}).fill('连续闭环合成患者');await page.getByLabel('患者编号（可选）',{exact:true}).fill('JOURNEY-001');await page.getByRole('button',{name:'创建患者档案',exact:true}).click();
 await page.getByRole('button',{name:'打开病例工作区',exact:true}).click();
 const p=(await f.json('/api/patients')).patients[0];
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'附件',exact:true}).click();await(await chooser).setFiles({name:'合成复诊记录.txt',mimeType:'text/plain',buffer:Buffer.from('软件验收合成资料，不对应真实患者。\n患者编号 JOURNEY-001。\n2026-09-24 检验：合成指标 321 TEST。\n过敏史尚未核对，不得记为无过敏。\n仅补充检验资料，不作临床建议。')});
 await page.waitForFunction(()=>!document.querySelector('.composer button:disabled')?.textContent.includes('上传'));
 // Wait for durable material persistence before asking the live model.
 for(let i=0;i<100;i++){if((await f.json('/api/sessions/'+p.sessionId)).files.length)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal((await f.json('/api/sessions/'+p.sessionId)).files.length,1);
 await send(page,'请读取选中的合成复诊记录，用 patient_record_propose 提议向当前患者补充检验：项目合成指标，数值321，单位TEST，日期2026-09-24。标注真实文件名和行号来源，保留过敏史未知与已有记录。只创建待医生核对的档案变更，不创建文书，不自动确认。');
 await finish(f,p.sessionId);
 assert.equal((await f.json('/api/patients/'+p.id)).labs.length,0,'No chart mutation before approval');
 assert.equal((await f.json('/api/pending-actions?patientId='+p.id)).actions.filter(x=>x.type==='patient-update'&&x.status==='pending').length,1);
 await patient(page,p.name);await page.getByRole('button',{name:'核对变更',exact:true}).click();await page.getByRole('dialog').getByText(/321/).first().waitFor();await page.getByRole('button',{name:'确认这些变更并写入',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 const saved=await f.json('/api/patients/'+p.id);assert.equal(saved.labs[0].value,321);assert.equal(saved.allergyStatus,'unknown');assert.match(saved.labs[0].source,/合成复诊记录/);
 await page.getByRole('button',{name:'沟通与随访',exact:true}).click();await page.getByRole('button',{name:'检查与转诊',exact:true}).click();await page.getByRole('button',{name:'新增待跟进',exact:true}).click();
 await page.getByLabel('跟进内容',{exact:true}).fill('合成复查结果');await page.getByLabel('跟进时间',{exact:true}).fill('2026-09-24T09:00');await page.getByRole('button',{name:'保存跟进事项',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 for(const [button,note] of [['登记已收到结果','已收到合成报告'],['保存医生核对','已逐项核对合成来源'],['登记告知并结束','已电话告知合成结果']]){
  await page.getByRole('button',{name:button,exact:true}).click();if(button==='登记已收到结果')await page.getByLabel('结果来源',{exact:true}).fill('合成复诊记录.txt L3');await page.getByLabel('处理记录',{exact:true}).fill(note);
  await page.getByRole('dialog').getByRole('button',{name:button,exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 }
 await page.getByRole('button',{name:'已结束',exact:true}).click();await page.locator('.care-tracking-card').waitFor();
 await page.getByRole('button',{name:'随访计划',exact:true}).click();await page.getByRole('button',{name:'记录一次联系',exact:true}).click();await page.getByLabel('随访记录',{exact:true}).fill('闭环完成，合成患者已收到反馈');await page.getByRole('button',{name:'保存随访结果',exact:true}).click();await page.getByRole('status').filter({hasText:'随访结果已保存'}).waitFor();
 await f.restart(true);await patient(page,p.name);await page.getByRole('button',{name:'沟通与随访',exact:true}).click();await page.getByRole('button',{name:'随访计划',exact:true}).click();await page.getByRole('button',{name:/随访记录 1/}).click();await page.getByText('闭环完成，合成患者已收到反馈',{exact:true}).waitFor();
 await page.getByRole('button',{name:'打开病例工作区',exact:true}).click();await send(page,'只读取这位患者最新档案和联系记录，回答合成指标数值与最近联系内容。不生成文书或提案。');
 const next=await finish(f,p.sessionId,1),answer=next.messages.filter(m=>m.role==='assistant').at(-1).content;assert.match(answer,/321/);assert.match(answer,/反馈|闭环/);
 assert.equal((await f.json('/api/patients/'+p.id)).labs.length,1);
 await page.getByRole('navigation',{name:'主要业务'}).getByRole('button',{name:'临床试验',exact:true}).click();await page.getByRole('button',{name:'添加试验方案',exact:true}).click();
 await page.locator('.trial-hub input[type=file]').setInputFiles({name:'合成筛选方案.txt',mimeType:'text/plain',buffer:Buffer.from('软件验收方案，不用于实际招募。\n入选标准：\n1、合成指标为321 TEST\n排除标准：\n1、已知药物过敏')});await page.getByText(/已读取方案原文/).waitFor();
 await page.getByLabel('试验名称',{exact:true}).fill('连续闭环合成方案');await page.getByLabel('方案版本与日期',{exact:true}).fill('合成版 2026-09-24');await page.getByLabel('入选标准（每行一项）',{exact:true}).fill('合成指标为321 TEST');await page.getByLabel('排除标准（每行一项）',{exact:true}).fill('已知药物过敏');await page.getByRole('button',{name:'保存试验方案',exact:true}).click();
 await page.getByLabel('选择初筛患者',{exact:true}).selectOption(p.id);await page.getByRole('button',{name:'开始自动初筛',exact:true}).click();await page.getByRole('navigation',{name:'主要业务'}).getByRole('button',{name:'患者',exact:true}).click();
 await page.getByRole('navigation',{name:'主要业务'}).getByRole('button',{name:'临床试验',exact:true}).click();await page.locator('.trial-card',{hasText:'连续闭环合成方案'}).getByRole('button',{name:'打开初筛',exact:true}).click();await page.getByLabel('选择初筛患者',{exact:true}).selectOption(p.id);await page.getByText('AI 初筛已完成',{exact:true}).waitFor({timeout:120000});
 await page.getByRole('button',{name:'全部条件（2）',exact:true}).click();assert.equal(await page.locator('.trial-ai-item').count(),2);await page.getByRole('button',{name:'将 AI 结果带入医生核对',exact:true}).click();await page.getByRole('button',{name:'保存初筛记录',exact:true}).click();await page.getByText('上次保存结论：',{exact:false}).waitFor();
 const trial=(await f.json('/api/trials')).trials[0],screened=await f.json(`/api/trials/${trial.id}/screenings/${p.id}`);assert.equal(screened.revision,1);assert.ok(screened.missing>=1,'Unknown allergy must remain missing, not eligible');
});

test('live journey literature search abstract citation import and durable task material',{skip:!enabled,timeout:180000},async t=>{
 const f=await start(t),{page}=f;await page.locator('.advanced-nav>summary').click();await page.getByRole('button',{name:'打开',exact:true}).click();await page.getByRole('button',{name:'文献检索 PubMed 检索与导入',exact:true}).click();
 await page.getByPlaceholder('英文关键词，或用中文描述论文主题').fill('hepatocellular carcinoma');await page.getByPlaceholder('起始年',{exact:true}).fill('2024');
 await page.locator('.literature-form select').selectOption('europepmc');await page.locator('.literature-form button[type=submit]').click();
 const item=page.locator('.literature-view .literature-item').first();await item.waitFor({timeout:90000});const title=await item.locator('.literature-title').innerText();await item.locator('.literature-title').click();
 await item.locator('.literature-abstract').waitFor({timeout:45000});
 await item.getByRole('button',{name:/复制引用/}).click();assert.ok((await page.evaluate(()=>navigator.clipboard.readText())).includes(title));
 await item.getByRole('button',{name:'导入为材料',exact:true}).click();await page.locator('.composer').waitFor({timeout:45000});
 const sessions=(await f.json('/api/sessions')).sessions;assert.equal(sessions.length,1);const s=await f.json('/api/sessions/'+sessions[0].id);assert.equal(s.files.length,1);assert.ok(s.files[0].text.includes(title));
 await f.restart();await page.getByRole('button',{name:'任务记录',exact:true}).click();await page.getByRole('main',{name:'任务记录'}).getByRole('button',{name:/文献 ·/}).click();await page.getByRole('button',{name:'查看资料',exact:true}).click();await page.getByText(s.files[0].name,{exact:false}).first().waitFor();
});
