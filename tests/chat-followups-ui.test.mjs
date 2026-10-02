import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {fixture} from './helpers.mjs';
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const skip=!existsSync(chrome)||!existsSync('dist/index.html');
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
async function setup(t){
 const f=await fixture(t,{chatFollowups:{archive:{status:async()=>({ready:true,message:'合成采集器连接成功'}),read:async()=>({messages:[{id:'ui-message',seq:'1',conversationId:'private:doctor:family',senderId:'family',type:'text',direction:'in',sentAt:'2026-09-25T00:00:00Z',text:'合成家属反馈：已预约复查。'}],nextCursor:'1',hasMore:false})},wechat:{status:async()=>({ready:true,message:'测试权限通过'}),capture:async()=>({image:pixel,width:1000,height:800}),title:async()=> '合成微信家属',read:async()=>({text:'合成可见会话：已预约复查',fingerprint:'ui-frame',evidence:{image:pixel,coverage:'visible-window'}})},provider:()=>({complete:async()=>({message:{content:'家属转述已预约复查；具体时间待确认。'}})})}});
 const patient=(await f.json('/api/patients','POST',{name:'聊天联调合成患者'})).data;
 const browser=await chromium.launch({executablePath:chrome,headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(12000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 t.after(async()=>{mkdirSync('output/playwright/chat-followups',{recursive:true});await page.screenshot({path:`output/playwright/chat-followups/${t.name.replace(/\W+/g,'-')}.png`,fullPage:true});await browser.close();assert.deepEqual(errors,[]);});
 return{...f,page,patient};
}
test('chat settings -> family binding -> source review -> AI draft -> archive through visible browser', {skip},async t=>{
 const {page,origin,patient,server}=await setup(t);
 await page.goto(origin+'/?view=settings');await page.getByRole('button',{name:'随访连接',exact:true}).click();await page.getByRole('button',{name:'企业微信存档',exact:true}).click();
 assert.equal(await page.getByLabel('企业 ID',{exact:true}).count(),0);await page.getByRole('button',{name:'管理员配置',exact:true}).click();await page.getByLabel('企业 ID',{exact:true}).fill('synthetic-corp');await page.getByLabel('采集器地址',{exact:true}).fill('http://127.0.0.1:9911');await page.getByLabel('采集器连接密钥',{exact:true}).fill('synthetic-secret');
 await page.getByRole('button',{name:'验证并连接企业服务',exact:true}).click();await page.getByText('企业服务验证通过，可以关联患者会话。',{exact:true}).waitFor();
 await page.reload();await page.getByRole('button',{name:'随访连接',exact:true}).click();await page.getByRole('button',{name:'企业微信存档',exact:true}).click();await page.getByRole('button',{name:'更换连接',exact:true}).click();await page.getByRole('button',{name:'管理员配置',exact:true}).click();assert.equal(await page.getByLabel('采集器连接密钥',{exact:true}).inputValue(),'');
 await page.getByRole('navigation',{name:'主要业务'}).getByRole('button',{name:'随访',exact:true}).click();await page.getByRole('button',{name:'聊天随访',exact:true}).click();await page.getByLabel('选择患者',{exact:true}).selectOption(patient.id);
 await page.getByRole('button',{name:'关联会话',exact:true}).click();const form=page.locator('.chat-binding-form');await form.getByLabel('渠道',{exact:true}).selectOption('wecom');await form.getByLabel('与患者的关系').selectOption('family');await form.getByLabel('会话名称').fill('合成企微家属');await form.getByLabel('联系人称呼').fill('合成家属');await form.getByText('高级：手动填写会话与发送者 ID',{exact:true}).click();await form.getByLabel('会话 ID',{exact:true}).fill('private:doctor:family');await form.getByLabel('联系人发送者 ID').fill('family');await form.getByRole('checkbox').check();await form.getByRole('button',{name:'确认关联',exact:true}).click();
 await page.getByRole('button',{name:'同步会话增量'}).click();const card=page.locator('.chat-draft').first();await card.waitFor();await card.locator('summary').click();assert.match(await card.locator('pre').innerText(),/家属转述/);
 assert.equal(await card.getByRole('button',{name:'AI 整理草稿'}).isDisabled(),true);await card.getByLabel('允许将本次原文发送给已配置的模型，生成待复核草稿').check();await card.getByRole('button',{name:'AI 整理草稿'}).click();await page.waitForFunction(()=>document.querySelector('.chat-draft textarea')?.value.includes('具体时间待确认'));
 await card.getByLabel('随访草稿',{exact:true}).fill('已核对家属反馈：预约复查，具体时间待确认。');await card.getByLabel('已核对患者归属、发言人、时间和记录内容，确认登记为已完成联系').check();await card.getByRole('button',{name:'确认归档到随访记录'}).click();await card.getByText(/已归档/).waitFor();
 assert.equal(server.store.db.prepare("SELECT COUNT(*) n FROM reminders WHERE json_extract(data,'$.outcome.contactMethod')='wecom'").get().n,1);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
});
test('wechat calibration and exact patient association are reachable without environment flags', {skip},async t=>{
 const {page,origin,patient}=await setup(t);await page.goto(origin+'/?view=settings&settingsTab=followup');await connectWechat(page);
 await page.getByRole('link',{name:'去关联患者会话 →',exact:true}).click();await page.getByLabel('选择患者',{exact:true}).selectOption(patient.id);await page.getByRole('button',{name:'关联会话',exact:true}).click();const form=page.locator('.chat-binding-form');await form.getByLabel('会话名称').fill('合成微信家属');await form.getByLabel('联系人称呼').fill('合成家属');await form.getByLabel('与患者的关系').selectOption('family');await form.getByRole('button',{name:'读取当前微信窗口并校准'}).click();await form.getByText('用数值调整区域（百分比）',{exact:true}).click();
 for(const [legend,values] of [['标题',[40,2,30,6]],['聊天内容',[40,12,58,60]]]){const group=form.getByRole('group',{name:legend,exact:true});for(const [i,label] of ['左侧','顶部','宽度','高度'].entries())await group.getByLabel(label,{exact:true}).fill(String(values[i]));}
 await form.getByRole('checkbox').check();await form.getByRole('button',{name:'确认关联',exact:true}).click();await page.getByRole('button',{name:'读取已打开的会话'}).click();await page.locator('.chat-draft').waitFor();await page.locator('.chat-draft summary').click();assert.match(await page.locator('.chat-draft pre').innerText(),/发言人待核验/);
});
test('automatic model permission is separate, expires and can be stopped from settings',{skip},async t=>{
 const {page,origin,server}=await setup(t);await page.goto(origin+'/?view=settings&settingsTab=followup');
 await connectWechat(page);
 const p=(await server.patients.create({name:'定时读取合成患者'}));
 const preview=await server.chatFollowups.preview({consent:true});
 const b=await server.chatFollowups.bind({channel:'wechat',patientId:p.id,title:'合成微信家属',speakerName:'家属',relationship:'family',confirmed:true,previewId:preview.id,titleRegion:{x:.4,y:.02,width:.3,height:.06},messageRegion:{x:.4,y:.12,width:.58,height:.6}});
 await page.reload();await page.getByRole('button',{name:'重新检查连接',exact:true}).click();
 await page.locator('.chat-connection-form summary').click();await page.getByLabel('在有限时段内自动同步').check();await page.getByLabel('定时读取的会话').selectOption(b.id);await page.getByLabel('自动调用当前模型整理新增草稿').check();
 const end=new Date(Date.now()+3600000);end.setMinutes(end.getMinutes()-end.getTimezoneOffset());await page.getByLabel('截止时间（最长 24 小时）').fill(end.toISOString().slice(0,16));
 await page.getByLabel('允许在此时段内将新增草稿原文发送给当前模型服务；更换模型后重新授权').check();await page.getByLabel(/我确认在此时段内读取此账号已关联的会话/).check();
 await page.getByRole('button',{name:'保存自动同步设置',exact:true}).click();await page.getByText('自动同步设置已保存',{exact:true}).waitFor();assert.equal(server.chatFollowups.config('wechat').autoSummarize,true);
 await page.getByRole('button',{name:'停止自动同步',exact:true}).click();await page.getByText('自动同步已停止',{exact:true}).waitFor();assert.equal(server.chatFollowups.config('wechat').autoUntil,'');assert.equal(server.chatFollowups.config('wechat').autoSummarize,false);
});

async function connectWechat(page) {
 assert.equal(await page.getByLabel('已核对的微信号').count(),0);
 await page.getByRole('button',{name:'检查微信与权限',exact:true}).click();
 await page.getByLabel('已核对的微信号').fill('synthetic-wechat');
 await page.getByLabel('我已在微信中核对当前登录账号，了解换号后需要重新关联').check();
 await page.getByRole('button',{name:'确认账号并验证连接',exact:true}).click();
 await page.getByText('权限检查通过，账号核验声明已保存。请继续关联患者会话。',{exact:true}).waitFor();
}

test('failed enterprise setup remains disabled and can retry without re-entering a saved secret',{skip},async t=>{
 const {page,origin,server}=await setup(t);let ready=false;
 server.chatFollowups.archive.status=async()=>({ready,message:ready?'测试连接恢复':'测试服务不可用'});
 await page.goto(origin+'/?view=settings&settingsTab=followup');await page.getByRole('button',{name:'企业微信存档',exact:true}).click();await page.getByRole('button',{name:'管理员配置',exact:true}).click();
 await page.getByLabel('企业 ID',{exact:true}).fill('synthetic-corp');await page.getByLabel('采集器地址',{exact:true}).fill('http://127.0.0.1:9911');await page.getByLabel('采集器连接密钥',{exact:true}).fill('synthetic-secret');
 await page.getByRole('button',{name:'验证并连接企业服务',exact:true}).click();await page.getByText('配置已保存，但连接验证未通过，尚未启用。请按提示修正后重试。',{exact:true}).waitFor();assert.equal(server.chatFollowups.config('wecom').enabled,false);assert.equal(await page.getByRole('link',{name:'去关联患者会话 →'}).count(),0);
 assert.equal(await page.getByLabel('采集器连接密钥',{exact:true}).inputValue(),'');ready=true;
 await page.getByRole('button',{name:'验证并连接企业服务',exact:true}).click();await page.getByRole('link',{name:'去关联患者会话 →',exact:true}).waitFor();assert.equal(server.chatFollowups.config('wecom').enabled,true);
});

test('native export import is usable before desktop connection setup and requires source review',{skip},async t=>{
 const {page,origin,patient}=await setup(t);await page.goto(origin+'/?view=followups&followupTab=chat');await page.getByLabel('选择患者',{exact:true}).selectOption(patient.id);
 await page.getByRole('button',{name:'导入微信聊天记录',exact:true}).click();const form=page.getByRole('form',{name:'导入微信聊天记录'});
 await form.getByLabel('微信导出文件').setInputFiles({name:'合成微信导出.txt',mimeType:'text/plain',buffer:Buffer.from('合成家属 2026-09-25 10:00\n已预约复查。')});
 await form.getByText('核对所选聊天原文',{exact:true}).waitFor();assert.equal(await form.getByRole('button',{name:'确认导入待复核草稿'}).isDisabled(),true);
 await form.getByLabel('导出会话名称',{exact:true}).fill('合成导出会话');await form.getByLabel('导出联系人称呼',{exact:true}).fill('合成家属');await form.getByLabel('导出联系人与患者的关系').selectOption('family');await form.getByRole('checkbox').check();await form.getByRole('button',{name:'确认导入待复核草稿'}).click();
 await page.getByText('已导入 1 条来源记录，生成 1 份待复核草稿。',{exact:true}).waitFor();await page.locator('.chat-draft summary').click();assert.match(await page.locator('.chat-draft pre').innerText(),/已预约复查/);
 assert.equal(await page.getByRole('button',{name:'读取已打开的会话'}).count(),0);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
});

test('failed Mac permission check explains stale grants and exposes only fixed desktop recovery actions',{skip},async t=>{
 const {page,origin,server}=await setup(t);server.chatFollowups.wechat.status=async()=>({ready:false,message:'辅助功能权限未生效'});
 await page.addInitScript(()=>{window.permissionActions=[];window.omwDesktop={openPermissionSettings:async k=>window.permissionActions.push(k),showInstalledApp:async()=>window.permissionActions.push('reveal')};});
 await page.goto(origin+'/?view=settings&settingsTab=followup');await page.getByRole('button',{name:'检查微信与权限',exact:true}).click();
 await page.getByRole('region',{name:'恢复 Mac 微信读取权限'}).waitFor();
 await page.getByRole('button',{name:'打开辅助功能设置',exact:true}).click();await page.getByRole('button',{name:'打开录屏设置',exact:true}).click();await page.getByRole('button',{name:'在访达中显示当前安装包',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.permissionActions),['accessibility','screen','reveal']);
 assert.equal(await page.getByRole('button',{name:'确认账号并验证连接',exact:true}).count(),0);
 server.chatFollowups.wechat.status=async()=>({ready:true,message:'测试权限已恢复'});await page.getByRole('button',{name:'重新检测权限',exact:true}).click();await page.getByLabel('已核对的微信号').waitFor();
});

test('wx-cli setup, session selection, review draft and plugin lifecycle through browser',{skip},async t=>{
 const {page,origin,patient,server}=await setup(t);
 const s=server.chatFollowups;
 s.registry.get('wx-cli').client={
  status:async c=>({ready:c.accountId==='wxid_synthetic',message:'合成 wx-cli 账号已核验'}),
  conversations:async()=>({conversations:[{id:'wxid_family',title:'合成微信家属',lastMessageAt:'2026-09-25T00:00:00Z'}],partial:false}),
  read:async()=>({messages:[{id:'wx-ui',conversationId:'wxid_family',senderId:'wxid_family',type:'text',text:'合成微信消息：已预约复查',direction:'in',sentAt:'2026-09-25T00:00:00Z'}],nextCursor:'1',hasMore:false}),
 };
 await page.goto(origin+'/?view=settings&settingsTab=followup');await page.getByRole('button',{name:'微信 · wx-cli',exact:true}).click();
 await page.getByLabel('账号 ID（current_account.wxid）').fill('wxid_synthetic');await page.getByRole('button',{name:'验证并启用连接',exact:true}).click();await page.getByText('合成 wx-cli 账号已核验',{exact:true}).waitFor();
 await page.getByRole('link',{name:'去关联患者会话 →'}).click();await page.getByLabel('选择患者',{exact:true}).selectOption(patient.id);await page.getByRole('button',{name:'关联会话',exact:true}).click();
 const form=page.locator('.chat-binding-form');await form.getByLabel('渠道',{exact:true}).selectOption('wx-cli');await form.getByRole('button',{name:'读取可关联会话'}).click();await form.getByLabel('选择服务会话').selectOption('wxid_family');assert.equal(await form.getByLabel('会话名称',{exact:true}).inputValue(),'合成微信家属');
 await form.getByLabel('联系人称呼',{exact:true}).fill('合成家属');await form.getByRole('checkbox').check();await form.getByRole('button',{name:'确认关联',exact:true}).click();await page.getByRole('button',{name:'同步会话增量'}).click();await page.locator('.chat-draft').waitFor();
 assert.equal(s.list(patient.id).drafts.length,1);
 await page.goto(origin+'/?view=settings&settingsTab=followup');await page.getByText('管理连接插件',{exact:true}).click();await page.getByLabel('插件清单（JSON）').fill(JSON.stringify({manifestVersion:1,id:'ui-connector',name:'测试系统连接',protocol:'archive-v1'}));await page.getByRole('button',{name:'安装连接插件'}).click();await page.getByRole('button',{name:'测试系统连接',exact:true}).waitFor();
 await page.reload();await page.getByRole('button',{name:'测试系统连接',exact:true}).click();await page.getByRole('heading',{name:'测试系统连接',exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
 await page.getByText('管理连接插件',{exact:true}).click();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'移除插件',exact:true}).click();await page.getByRole('button',{name:'测试系统连接',exact:true}).waitFor({state:'hidden'});
 assert.equal(s.registry.entries.has('ui-connector'),false);
 await page.getByRole('button',{name:'微信 · wx-cli',exact:true}).click();await page.getByRole('heading',{name:'微信 · wx-cli',exact:true}).waitFor();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
});
