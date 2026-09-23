import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {fixture} from './helpers.mjs';
import {consultationLookupIssue} from '../src/workbench/run-status.js';
const delivery={delivered:false,evidence:[],gaps:[{reason:'tool_failed',tool:'literature_search'},{reason:'no_current_run_evidence'}]};
test('consultation lookup hint never hides write failures or missing requested files',()=>{
 const run={policy:{intent:'consultation'},delivery};
 assert.equal(consultationLookupIssue(run),true);
 assert.equal(consultationLookupIssue({...run,policy:{intent:'timeline'}}),false);
 for(const gap of [{reason:'required_file_not_written'},{reason:'tool_failed',tool:'propose_file_write'},{reason:'execution_not_passed'}])
  assert.equal(consultationLookupIssue({...run,delivery:{...delivery,gaps:[...delivery.gaps,gap]}}),false);
});
test('consultation displays lookup limitation instead of missing-file instructions; markdown spacing is compact',async(t)=>{
 const f=await fixture(t);const session=await f.session('咨询依据验证');
 f.server.workspaces.store.update(session.id,w=>{
  w.runs.push({id:'read-failed',status:'completed',policy:{intent:'consultation'},outcome:'delivery_failed',delivery,startedAt:Date.now(),partial:'咨询测试'});
  w.messages.push({role:'assistant',runId:'read-failed',outcome:'delivery_failed',content:'第一段。\n\n第二段。\n\n```text\n保留  空格\n换行\n```'});
 });
 f.server.workspaces.store.event(session.id,'read-failed','tool.failed',{tool:'literature_search',error:'文献源连接失败：请求超时'});
 for(let i=0;i<510;i++) f.server.workspaces.store.event(session.id,'read-failed','message.delta',{text:'测试'});
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();await page.goto(f.origin + "/?view=home");await page.locator(".advanced-nav>summary").click();await page.getByRole('button',{name:/咨询依据验证/}).first().click();
 await page.getByLabel('回答依据提示').waitFor();
 assert.match(await page.getByLabel('回答依据提示').innerText(),/请求超时/);
 assert.equal(await page.getByText('交付未完成',{exact:true}).count(),0);
 assert.equal(await page.locator('.message-content .wb-markdown').evaluate(e=>getComputedStyle(e).whiteSpace),'normal');
 assert.equal(await page.locator('.message-content pre').evaluate(e=>getComputedStyle(e).whiteSpace),'pre');
});
test('streaming respects upward wheel within 300px of bottom and follows again only after returning to bottom',async(t)=>{
 let emit,finish,text='';
 const provider={provider:'fixture',model:'fixture',apiKey:'synthetic',async complete(_m,_t,{onDelta,signal}){
  emit=(s)=>{text+=s;onDelta(s);};
  await new Promise((resolve,reject)=>{finish=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  return {message:{role:'assistant',content:text}};
 }};
 const f=await fixture(t,{provider});await f.session('滚动验证');
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});t.after(()=>{finish?.();return browser.close();});
 const page=await browser.newPage({viewport:{width:1200,height:800}});await page.goto(f.origin + "/?view=home");await page.locator(".advanced-nav>summary").click();await page.getByRole('button',{name:/滚动验证/}).first().click();
 await page.locator('.composer select').first().selectOption('auto');
 await page.getByRole('textbox',{name:'医疗工作需求'}).fill('请解释一个一般概念');await page.getByRole('button',{name:'发送任务',exact:true}).click();
 for(let i=0;i<100&&!emit;i++) await new Promise(r=>setTimeout(r,20));assert.ok(emit);
 emit(Array.from({length:35},(_,i)=>`段落 ${i}：这是用于滚动验证的合成内容。\n\n`).join(''));
 const pane=page.locator('.message-list');
 await page.getByText('段落 34：这是用于滚动验证的合成内容。',{exact:true}).waitFor({state:'attached'});
 await page.waitForFunction(()=>document.querySelector('.message-list')?.scrollTop>300);
 await pane.hover();await page.mouse.wheel(0,-160);
 await page.waitForFunction(()=>{const e=document.querySelector('.message-list');return e.scrollHeight-e.scrollTop-e.clientHeight>80;});
 const before=await pane.evaluate(e=>e.scrollTop);
 emit('新增段落 A。\n\n');await page.getByText('新增段落 A。',{exact:true}).waitFor({state:'attached'});
 const after=await pane.evaluate(e=>e.scrollTop);assert.ok(Math.abs(after-before)<8,`scroll was stolen: ${before} -> ${after}`);
 await page.mouse.wheel(0,10000);
 await page.waitForFunction(()=>{const e=document.querySelector('.message-list');return e.scrollHeight-e.scrollTop-e.clientHeight<24;});
 emit('新增段落 B。\n\n');await page.getByText('新增段落 B。',{exact:true}).waitFor({state:'attached'});
 assert.ok(await pane.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight<24));finish();
});
