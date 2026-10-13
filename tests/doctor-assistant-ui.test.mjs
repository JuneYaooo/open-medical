import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { fixture } from './helpers.mjs';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = 'output/playwright/doctor-assistant-features-20261013';

test('doctor configures reminder channels and approves a Feishu knowledge group through the UI', { skip: !existsSync(chrome), timeout: 60000 }, async t => {
  mkdirSync(out + '/screenshots', { recursive: true });
  mkdirSync(out + '/raw', { recursive: true });
  const sent = [], replies = []; let handler;
  const response = data => ({ ok: true, status: 200, json: async () => data });
  const now = Date.now();
  const f = await fixture(t, { followupOptions: { autoStart: false }, doctorNotificationOptions: { autoStart: false,
    fetchImpl: async (url, init) => {
      if (url.includes('get_bot_qrcode')) return response({ qrcode: 'test-only', qrcode_img_content: 'https://example.invalid/test-qr' });
      if (url.includes('get_qrcode_status')) return response({ status: 'confirmed', bot_token: 'test-token', ilink_user_id: 'test-doctor', ilink_bot_id: 'test-bot' });
      sent.push(JSON.parse(init.body)); return response({ code: 0, ret: 0 });
    } }, knowledgeBotOptions: {
    fetchImpl: async (url, init) => {
      if (url.endsWith('/internal')) return response({ code: 0, tenant_access_token: 'test-access', expire: 7200 });
      if (url.endsWith('/info')) return response({ code: 0, bot: { open_id: 'ou_bot' } });
      if (url.includes('/chats/')) return response({ code: 0, data: { name: '熊猫学习群' } });
      replies.push(JSON.parse(init.body)); return response({ code: 0 });
    }, createSocket: (options, receive) => ({ start: async () => { handler = receive; options.onReady(); }, close() {} }),
  } });
  const patient = (await f.json('/api/patients', 'POST', { name: '熊猫' })).data;
  await f.json(`/api/patients/${patient.id}/care-tasks`, 'POST', { title: '核对复诊材料', kind: 'test', dueAt: new Date(now - 60000).toISOString() });
  const doc = await f.server.guidelines.addDocument({ title: '复诊资料整理规范', collection: '门诊工作资料', text: '复诊前核对资料日期与来源。整理患者反馈和需要补充的材料。' });
  f.server.guidelines.updateMetadata(doc.id, { expectedRevision: 0, reviewStatus: 'reviewed', reviewNote: '已核对资料内容' });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: out + '/raw', size: { width: 1440, height: 1000 } } });
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(15000);
  const video = page.video();
  t.after(async () => { await context.close(); await video.saveAs(out + '/raw/医生提醒与飞书知识库.webm'); await video.delete(); await browser.close(); });
  await page.goto(f.origin + '/?view=settings&settingsTab=notifications');
  const feishu = page.getByRole('region', { name: '飞书医生提醒' });
  await feishu.getByLabel('飞书机器人 Webhook').fill('https://open.feishu.cn/open-apis/bot/v2/hook/test-only');
  await feishu.getByLabel('启用每日随访与待跟进提醒').check();
  await feishu.getByRole('button', { name: '保存提醒设置' }).click(); await feishu.getByText('提醒设置已保存。').waitFor();
  await feishu.getByRole('button', { name: '发送今日提醒' }).click(); await feishu.getByText('平台已接受今日提醒', { exact: true }).waitFor();
  assert.equal(sent.length, 1); assert.match(sent[0].content.text, /1 位患者/); assert.doesNotMatch(sent[0].content.text, /熊猫/);
  await feishu.getByText('查看提醒内容预览').click(); await page.screenshot({ path: out + '/screenshots/01-医生提醒.png', fullPage: true });
  const wechat = page.getByRole('region', { name: '微信医生提醒' }); await wechat.getByRole('button', { name: '微信扫码连接' }).click();
  await wechat.getByAltText('微信连接二维码').waitFor(); await page.screenshot({ path: out + '/screenshots/02-微信扫码.png', fullPage: true });
  await wechat.getByText('微信已扫码连接。可以先发送测试消息，再启用每日提醒。').waitFor();
  await wechat.getByRole('button', { name: '发送测试提醒' }).click(); await wechat.getByText('平台已接受测试消息，请在微信或飞书中确认收到。').waitFor();
  assert.equal(sent.at(-1).msg.to_user_id, 'test-doctor');
  await page.getByRole('button', { name: '飞书知识库机器人', exact: true }).click();
  await page.getByLabel('App ID', { exact: true }).fill('cli_1234567890abcdef'); await page.getByLabel('App Secret', { exact: true }).fill('test-app-secret');
  await page.getByLabel(/门诊工作资料 · 1 篇已复核/).check(); await page.getByLabel('启用飞书知识库机器人', { exact: true }).check();
  await page.getByRole('button', { name: '保存机器人配置' }).click(); await page.getByText(/配置已保存。启用后/).waitFor(); await f.server.knowledgeBot.connection;
  const event = id => ({ sender: { sender_type: 'user' }, message: { chat_type: 'group', chat_id: 'oc_testgroup', message_id: `om_${id}`, create_time: String(Date.now()), message_type: 'text', mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }], content: JSON.stringify({ text: '@_user_1 复诊' }) } });
  handler(event('discover')); await Promise.all([...f.server.knowledgeBot.jobs]); assert.equal(replies.length, 0);
  await page.getByRole('button', { name: '刷新群与连接状态' }).click(); await page.getByLabel(/熊猫学习群/).check();
  await page.getByRole('button', { name: '保存机器人配置' }).click(); await page.getByText(/配置已保存。启用后/).waitFor(); await f.server.knowledgeBot.connection;
  handler(event('answer')); await Promise.all([...f.server.knowledgeBot.jobs]); assert.equal(replies.length, 1); assert.match(JSON.parse(replies[0].content).text, /出处：第/);
  await page.getByRole('button', { name: '刷新群与连接状态' }).click(); await page.getByText(/最近一次知识库回复已被飞书接受/).waitFor();
  await page.screenshot({ path: out + '/screenshots/03-飞书知识库机器人.png', fullPage: true });
  await page.reload(); await page.getByRole('button', { name: '飞书知识库机器人', exact: true }).click(); await page.getByLabel(/熊猫学习群/).waitFor(); assert.equal(await page.getByLabel(/熊猫学习群/).isChecked(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.app-settings-content').evaluate(e => e.scrollWidth <= e.clientWidth + 2), true);
  await page.screenshot({ path: out + '/screenshots/04-窄屏配置.png', fullPage: true });
  assert.deepEqual(errors, []);
  writeFileSync(out + '/ui-verification.json', JSON.stringify({ mockExternalTransport: true, syntheticPatients: ['熊猫'], reminder: sent[0].content.text, knowledgeReply: JSON.parse(replies[0].content).text, errors }, null, 2));
});
