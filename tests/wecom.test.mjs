import {openPatient} from "./navigation-ui.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { encrypt, getSignature } from '@wecom/crypto';
import { fixture } from './helpers.mjs';

async function setup(t, mode = {}) {
  const calls = [], corpId = `ww${randomUUID()}`;
  const config = { corpId, corpSecret: 'isolated-secret', callbackToken: 'isolated-token', aesKey: randomBytes(32).toString('base64').slice(0,43),
    fetch: async (url, init) => {
      const path = new URL(url).pathname, data = init.body ? JSON.parse(init.body) : {};
      calls.push({ path, data });
      let result;
      if (path.endsWith('/gettoken')) result = { access_token: 'isolated-access-token', expires_in: 7200 };
      else if (path.endsWith('/batch/get_by_user')) {
        if (mode.failPage && data.cursor) return Response.json({ errcode: 48002, errmsg: 'secret must never appear in UI' });
        result = { external_contact_list: [{ external_contact: { external_userid: data.cursor ? 'external-2' : 'external-1', name: data.cursor ? '合成家属' : '合成客户' }, follow_info: { userid: data.userid_list[0] } }], next_cursor: data.cursor ? '' : 'page2' };
      } else if (path.endsWith('/add_msg_template')) {
        if (mode.timeout) throw new Error('network with secret must not be logged');
        if (mode.reject) return Response.json({ errcode: 45009, errmsg: 'limit' });
        result = { msgid: 'synthetic-msg', fail_list: mode.failRecipient ? ['external-1'] : [] };
      } else if (path.endsWith('/get_groupmsg_send_result')) result = { send_list: [{ external_userid: 'external-1', status: 1 }], next_cursor: '' };
      else throw new Error(`Unexpected SDK endpoint ${path}`);
      return Response.json({ errcode: 0, errmsg: 'ok', ...result });
    } };
  const f = await fixture(t, { wecom: config });
  const patient = (await f.json('/api/patients', 'POST', { name: '合成企业微信患者' })).data;
  const sync = () => f.json('/api/wecom/sync', 'POST', { member: 'doctor-a' });
  const bind = async () => (await f.json('/api/wecom/bindings', 'POST', { patientId: patient.id, member: 'doctor-a', external: 'external-1', relationship: 'family', confirmed: true })).data;
  const draft = async binding => (await f.json('/api/wecom/tasks', 'POST', { patientId: patient.id, bindingId: binding.id, requestId: randomUUID(), text: '合成随访提醒，仅测试' })).data;
  return { ...f, config, calls, patient, sync, bind, draft };
}

test('WeCom is disabled without credentials, guarded APIs and no secrets in status', async t => {
  const f = await fixture(t, { wecom: { corpId: '', corpSecret: '', callbackToken: '', aesKey: '' } });
  assert.equal((await f.json('/api/wecom/status')).data.configured, false);
  assert.equal((await f.json('/api/wecom/sync', 'POST', { member: 'doctor' })).status, 503);
  assert.equal((await fetch(f.origin + '/api/wecom/status')).status, 401);
  assert.equal((await fetch(f.origin + '/api/wecom/callback')).status, 503);
});

test('SDK pagination -> explicit family binding -> durable draft -> one submission -> provider receipt', async t => {
  const f = await setup(t);
  const status = (await f.json('/api/wecom/status')).data;
  assert.equal(status.configured, true); assert.doesNotMatch(JSON.stringify(status), /isolated-secret|isolated-token|isolated-access/);
  assert.equal((await f.sync()).data.count, 2);
  assert.equal((await f.json(`/api/wecom/bindings?patientId=${f.patient.id}`)).data.bindings.length, 0);
  assert.equal((await f.json('/api/wecom/bindings', 'POST', { patientId: f.patient.id, member: 'doctor-a', external: 'external-1', relationship: 'self' })).status, 400);
  const binding = await f.bind(), task = await f.draft(binding);
  assert.equal(task.status, 'draft');
  assert.equal(f.calls.filter(c => c.path.endsWith('/add_msg_template')).length, 0);
  const first = await f.json(`/api/wecom/tasks/${task.id}/submit`, 'POST', { confirmed: true });
  assert.equal(first.data.status, 'awaiting_member');
  await f.json(`/api/wecom/tasks/${task.id}/submit`, 'POST', { confirmed: true });
  assert.equal(f.calls.filter(c => c.path.endsWith('/add_msg_template')).length, 1);
  assert.equal((await f.json(`/api/wecom/tasks/${task.id}/refresh`, 'POST', {})).data.status, 'sent');
  assert.equal(f.server.wecom.tasks(f.patient.id)[0].status, 'sent');
  assert.equal(f.server.store.db.prepare('SELECT COUNT(*) n FROM patient_messages').get().n, 0);
  await f.json(`/api/wecom/bindings/${binding.id}`, 'DELETE');
  assert.equal(f.server.wecom.bindings(f.patient.id).length, 0);
  f.server.patients.remove(f.patient.id);
  assert.equal(f.server.store.db.prepare('SELECT COUNT(*) n FROM wecom_tasks').get().n, 0);
});

test('partial sync preserves prior snapshot, ambiguous submission never auto retries', async t => {
  const mode = {}, f = await setup(t, mode);
  await f.sync(); const before = f.server.wecom.contacts();
  mode.failPage = true;
  const failed = await f.sync(); assert.equal(failed.status, 502); assert.doesNotMatch(JSON.stringify(failed.data), /secret must/);
  assert.deepEqual(f.server.wecom.contacts(), before);
  const binding = await f.bind(), task = await f.draft(binding);
  mode.timeout = true;
  assert.equal((await f.json(`/api/wecom/tasks/${task.id}/submit`, 'POST', { confirmed: true })).data.status, 'unknown');
  assert.equal((await f.json(`/api/wecom/tasks/${task.id}/submit`, 'POST', { confirmed: true })).status, 409);
  assert.equal(f.calls.filter(c => c.path.endsWith('/add_msg_template')).length, 1);
  assert.equal((await f.json(`/api/wecom/tasks/${task.id}/refresh`, 'POST', {})).status, 400);
});

test('draft idempotency, unbinding blocks stale draft and explicit API rejection is never delivered', async t => {
  const mode = {}, f = await setup(t, mode); await f.sync(); const binding = await f.bind();
  const input = { patientId: f.patient.id, bindingId: binding.id, requestId: randomUUID(), text: 'synthetic' };
  const task = (await f.json('/api/wecom/tasks', 'POST', input)).data;
  assert.equal((await f.json('/api/wecom/tasks', 'POST', input)).data.id, task.id);
  assert.equal((await f.json('/api/wecom/tasks', 'POST', { ...input, text: 'changed' })).status, 409);
  await f.json(`/api/wecom/bindings/${binding.id}`, 'DELETE');
  assert.equal((await f.json(`/api/wecom/tasks/${task.id}/submit`, 'POST', { confirmed: true })).status, 400);
  const newBinding = await f.bind(), rejected = await f.draft(newBinding); mode.reject = true;
  assert.equal((await f.json(`/api/wecom/tasks/${rejected.id}/submit`, 'POST', { confirmed: true })).data.status, 'rejected');
  mode.reject = false; mode.failRecipient = true;
  const recipientFail = await f.draft(newBinding);
  assert.equal((await f.json(`/api/wecom/tasks/${recipientFail.id}/submit`, 'POST', { confirmed: true })).data.status, 'rejected');
});

function query(config, message, id = config.corpId) {
  const cipher = encrypt(config.aesKey, message, id), timestamp = String(Math.floor(Date.now()/1000)), nonce = 'synthetic-nonce';
  return { cipher, params: new URLSearchParams({ timestamp, nonce, msg_signature: getSignature(config.callbackToken, timestamp, nonce, cipher), echostr: cipher }) };
}

test('signed callbacks verify corp, reject forgery, deduplicate and invalidate deleted contacts without ingesting chat', async t => {
  const f = await setup(t); await f.sync(); await f.bind();
  const echo = query(f.config, 'echo-ok');
  assert.equal(await (await fetch(`${f.origin}/api/wecom/callback?${echo.params}`)).text(), 'echo-ok');
  const wrongCorp = query(f.config, 'echo', 'other-corp');
  assert.equal((await fetch(`${f.origin}/api/wecom/callback?${wrongCorp.params}`)).status, 401);
  echo.params.set('msg_signature', '0'.repeat(40));
  assert.equal((await fetch(`${f.origin}/api/wecom/callback?${echo.params}`)).status, 401);
  const event = query(f.config, `<xml><ToUserName><![CDATA[${f.config.corpId}]]></ToUserName><Event>change_external_contact</Event><ChangeType>del_external_contact</ChangeType><ExternalUserID>external-1</ExternalUserID><UserID>doctor-a</UserID><CreateTime>1234567890</CreateTime></xml>`);
  const post = () => fetch(`${f.origin}/api/wecom/callback?${event.params}`, { method: 'POST', body: `<xml><Encrypt><![CDATA[${event.cipher}]]></Encrypt></xml>` });
  assert.equal(await (await post()).text(), 'success'); assert.equal(await (await post()).text(), 'success');
  assert.equal(f.server.store.db.prepare('SELECT COUNT(*) n FROM wecom_events').get().n, 1);
  assert.equal(f.server.wecom.contacts().find(c => c.external === 'external-1').active, 0);
  assert.equal(f.server.store.db.prepare('SELECT COUNT(*) n FROM patient_messages').get().n, 0);
  assert.equal((await fetch(`${f.origin}/api/wecom/callback?${event.params}`, {method:'POST', body:'x'.repeat(65537)})).status, 413);
});

test('browser: discover connector, sync, verify family, draft, cancel, submit and refresh receipt', async t => {
  const { existsSync, mkdirSync } = await import('node:fs');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!existsSync(chrome) || !existsSync('dist/index.html')) return t.skip('Chrome/build unavailable');
  const { chromium } = await import('playwright-core');
  const f = await setup(t), browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close()); const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(f.origin + '/?view=home');
  await page.locator(".app-navigation").waitFor();
  await openPatient(page, f.patient.name);
  await page.getByRole('button', { name: '沟通与随访', exact: true }).click();
  const panel = page.getByRole('region', { name: '企业微信患者联系' });
  await panel.getByLabel('负责成员 UserID').fill('doctor-a');
  await panel.getByRole('button', { name: '同步该成员客户' }).click();
  await panel.getByLabel('选择客户').selectOption(JSON.stringify(['doctor-a', 'external-1']));
  await panel.getByLabel('与患者关系').selectOption('family');
  assert.equal(await panel.getByRole('button', { name: '确认关联', exact: true }).isDisabled(), true);
  await panel.getByLabel('我已核实此客户与当前患者的关系').check();
  await panel.getByRole('button', { name: '确认关联', exact: true }).click();
  await panel.getByRole('button', { name: '解除关联', exact: true }).waitFor();
  const binding = f.server.wecom.bindings(f.patient.id)[0];
  await panel.getByLabel('接收客户').selectOption(binding.id);
  await panel.getByLabel('随访内容').fill('合成随访：请核对复诊时间。');
  await panel.getByRole('button', { name: '保存草稿', exact: true }).click();
  const submit = panel.getByRole('button', { name: '核对并提交企业微信任务' });
  await submit.waitFor();
  page.once('dialog', d => d.dismiss()); await submit.click();
  assert.equal(f.calls.filter(c => c.path.endsWith('/add_msg_template')).length, 0);
  page.once('dialog', d => d.accept()); await submit.click();
  await panel.getByText('待成员发送', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '查询发送结果' }).click();
  await panel.getByText('已发送 · 不代表已读', { exact: true }).waitFor();
  mkdirSync('output/wecom', {recursive:true}); await panel.screenshot({ path: 'output/wecom/patient-contact.png' });
  await page.reload();
  await page.locator(".app-navigation").waitFor();
  await openPatient(page, f.patient.name);
  await page.getByRole('button', { name: '沟通与随访', exact: true }).click();
  await panel.getByText('已发送 · 不代表已读', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});
