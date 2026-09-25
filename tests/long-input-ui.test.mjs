import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {fixture} from './helpers.mjs';
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('browser long pasted task chunks completely, finishes and retains the original after reload',{
 skip:!existsSync(chrome)||!existsSync('dist/index.html'),timeout:120000,
},async t=>{
 const input='只总结合成资料，不执行写入。BEGIN_LONG\n'+'合成记录：中文🧪，数值12.5 mg。\n'.repeat(4500)+'\nEND_LONG';
 const pieces=[];
 const clean=[];const f=await fixture({after:fn=>clean.push(fn)},{provider:{apiKey:'synthetic',model:'long-input-ui',async complete(messages){
  if(messages[0].content.includes('长输入分片压缩器')){pieces.push(JSON.parse(messages.at(-1).content).part.text);return{message:{role:'assistant',content:'只总结合成资料，不执行写入。BEGIN_LONG；数值12.5 mg；END_LONG。'}};}
  if(messages[0].content.includes('会话历史压缩器'))return{message:{role:'assistant',content:'合成资料历史。'}};
  return{message:{role:'assistant',content:'LONG_INPUT_UI_COMPLETE：12.5 mg，未执行写入。'}};
 }}});
 const browser=await chromium.launch({executablePath:chrome,headless:true});t.after(async()=>{await browser.close();for(const fn of clean)await fn();});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.origin);await page.getByRole('textbox',{name:'医疗任务内容'}).fill(input);assert.ok(await page.getByRole('textbox',{name:'医疗任务内容'}).inputValue()===input);await page.getByRole('button',{name:'发送任务',exact:true}).click();
 let finished;
 for(let i=0;i<100;i++){
  const rows=(await f.json('/api/sessions')).data.sessions;
  if(rows[0]){const state=(await f.json('/api/sessions/'+rows[0].id)).data;const run=state.runs.at(-1);if(run&&['failed','completed','cancelled'].includes(run.status)){assert.equal(run.status,'completed',run.error);finished=state;break;}}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.ok(finished, 'long input run did not complete');
 await page.getByText('LONG_INPUT_UI_COMPLETE：12.5 mg，未执行写入。',{exact:true}).first().waitFor({timeout:20000});
 assert.ok(pieces.length>1);assert.ok(pieces.join('')===input);
 const sessions=(await f.json('/api/sessions')).data.sessions;assert.equal(sessions.length,1);const s=(await f.json('/api/sessions/'+sessions[0].id)).data;
 assert.equal(s.runs.at(-1).status,'completed');assert.ok(s.messages.some(m=>m.role==='user'&&m.content===input));
 await page.reload();const saved=(await f.json('/api/sessions/'+s.id)).data;assert.ok(saved.messages.some(m=>m.role==='user'&&m.content===input));assert.deepEqual(errors,[]);
 await page.goto(f.origin);const overflow='x'.repeat(200001);await page.getByRole('textbox',{name:'医疗任务内容'}).fill(overflow);await page.getByRole('button',{name:'发送任务',exact:true}).click();await page.getByRole('alert').filter({hasText:'任务超过 20 万字符，请拆成多个任务或上传为资料；输入内容已保留。'}).waitFor();assert.equal((await page.getByRole('textbox',{name:'医疗任务内容'}).inputValue()).length,overflow.length);assert.equal((await f.json('/api/sessions')).data.sessions.length,1);
 t.diagnostic(JSON.stringify({inputChars:input.length,chunks:pieces.length,status:s.runs.at(-1).status,originalRetained:true}));
});
