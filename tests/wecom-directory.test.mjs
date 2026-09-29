import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.mjs';
import { careTools } from '../server/care/tools.mjs';

// Synthetic WeCom: one assistant with three customers and one customer group.
function directoryFetch(calls, mode = {}) {
  return async (url, init) => {
    const path = new URL(url).pathname, data = init?.body ? JSON.parse(init.body) : {};
    calls.push({ path, data });
    const ok = value => Response.json({ errcode: 0, errmsg: 'ok', ...value });
    if (path.endsWith('/gettoken')) return ok({ access_token: 'synthetic-token', expires_in: 7200 });
    if (path.endsWith('/get_follow_user_list')) return ok({ follow_user: ['assistant'] });
    if (path.endsWith('/get_corp_tag_list')) return ok({ tag_group: [{ group_name: '病种', tag: [{ id: 't1', name: '术后' }] }] });
    if (path.endsWith('/batch/get_by_user')) return ok({ next_cursor: '', external_contact_list: [
      { external_contact: { external_userid: 'wm-phone', name: '小王', type: 1 }, follow_info: { userid: 'assistant', remark: '', remark_mobiles: ['138 0013 8000'], tag_id: ['t1'], createtime: 1758000000 } },
      { external_contact: { external_userid: 'wm-number', name: '晴天', type: 1 }, follow_info: { userid: 'assistant', remark: 'P-0042 女儿', createtime: 1758100000 } },
      { external_contact: { external_userid: 'wm-stranger', name: '路人甲', type: 1 }, follow_info: { userid: 'assistant', remark: '咨询', createtime: 1758200000 } },
    ] });
    if (path.endsWith('/groupchat/list')) return ok({ group_chat_list: [{ chat_id: 'wr-group', status: 0 }], next_cursor: '' });
    if (path.endsWith('/groupchat/get')) return ok({ group_chat: { chat_id: 'wr-group', name: '术后康复群', owner: 'assistant', notice: '每周五答疑', create_time: 1758000000,
      member_list: [{ userid: 'assistant', type: 1 }, { userid: 'wm-phone', type: 2, name: '小王' }, { userid: 'wm-stranger', type: 2, name: '路人甲' }] } });
    if (path.endsWith('/externalcontact/remark')) return mode.remarkFails ? Response.json({ errcode: 60011, errmsg: 'no privilege' }) : ok({});
    if (path.endsWith('/add_msg_template')) return ok({ msgid: 'group-msg', fail_list: [] });
    if (path.endsWith('/get_groupmsg_send_result')) return ok({ send_list: [{ chat_id: 'wr-group', status: 1 }], next_cursor: '' });
    throw new Error(`Unexpected endpoint ${path}`);
  };
}

async function setup(t, mode = {}) {
  const calls = [];
  const f = await fixture(t, {
    wecom: { corpId: `ww${randomUUID().slice(0, 8)}`, corpSecret: 'synthetic-contact-secret', callbackToken: '', aesKey: '', fetch: directoryFetch(calls, mode) },
    care: { intervalMs: 3600000, kfPollMs: null },
  });
  const add = async body => (await f.json('/api/patients', 'POST', body)).data;
  const wang = await add({ name: '王建国', phone: '13800138000' });
  const li = await add({ name: '李秀兰', patientNumber: 'P-0042' });
  return { ...f, calls, wang, li, care: f.server.care };
}

test('directory sync stores remark, phone, tags and groups, then suggests patients with reasons', async t => {
  const f = await setup(t);
  await f.care.drain();
  const status = (await f.json('/api/wecom/directory/sync', 'POST', {})).data;
  assert.equal(status.contacts, 3); assert.equal(status.groups, 1); assert.deepEqual(status.members, ['assistant']);
  assert.equal(f.server.wecom.directory.due(), false);
  const { contacts, counts } = (await f.json('/api/wecom/contacts')).data;
  assert.deepEqual(counts, { bound: 0, suggested: 2, unmatched: 1 });
  const byPhone = contacts.find(c => c.external === 'wm-phone');
  assert.deepEqual(byPhone.tags, ['术后']); assert.equal(byPhone.groups[0].name, '术后康复群');
  assert.equal(byPhone.suggestion.candidates[0].patientId, f.wang.id);
  assert.match(byPhone.suggestion.candidates[0].reasons.join(), /手机号/);
  const byNumber = contacts.find(c => c.external === 'wm-number');
  assert.equal(byNumber.suggestion.candidates[0].patientId, f.li.id);
  assert.equal(byNumber.suggestion.relationship, 'family');
  assert.equal(contacts.at(-1).state, 'unmatched');
  // Nothing is linked until the doctor confirms.
  assert.equal(f.server.wecom.bindings(f.wang.id).length, 0);
  const card = (await f.json(`/api/wecom/patients/${f.wang.id}`)).data;
  assert.equal(card.linked.length, 0); assert.equal(card.suggestions[0].external, 'wm-phone');
  assert.equal((await f.json('/api/wecom/contacts?q=路人')).data.contacts.length, 1);
  const agenda = (await f.json('/api/doctor/overview')).data.work.items;
  assert.deepEqual(agenda.find(i => i.id === 'care-contacts').action, { type: 'view', view: 'care', tab: 'contacts', label: '去确认' });
  assert.equal((await f.json('/api/care/overview')).data.stats.contactMatches, 2);
});

test('confirmed link writes the remark back; family links and remark failures keep the binding', async t => {
  const f = await setup(t);
  await f.json('/api/wecom/directory/sync', 'POST', {});
  const self = (await f.json('/api/wecom/bindings', 'POST', { patientId: f.wang.id, member: 'assistant', external: 'wm-phone', relationship: 'self', confirmed: true })).data;
  assert.deepEqual(self.remarkWriteBack, { ok: true, remark: '王建国' });
  assert.deepEqual(f.calls.find(c => c.path.endsWith('/externalcontact/remark')).data, { userid: 'assistant', external_userid: 'wm-phone', remark: '王建国' });
  const family = (await f.json('/api/wecom/bindings', 'POST', { patientId: f.li.id, member: 'assistant', external: 'wm-number', relationship: 'family', confirmed: true })).data;
  assert.equal(family.remarkWriteBack.skipped, true);
  assert.equal(f.calls.filter(c => c.path.endsWith('/externalcontact/remark')).length, 1);
  const card = (await f.json(`/api/wecom/patients/${f.wang.id}`)).data;
  assert.equal(card.linked[0].remark, '王建国'); assert.equal(card.linked[0].groups[0].name, '术后康复群');
  const groups = (await f.json('/api/wecom/groups')).data.groups;
  assert.deepEqual(groups[0].patients.map(p => p.patientName), ['王建国']); assert.equal(groups[0].unlinkedCustomers, 1);
  assert.deepEqual((await f.json('/api/wecom/contacts')).data.counts, { bound: 2, suggested: 0, unmatched: 1 });
});

test('remark write-back failure is reported without undoing the link', async t => {
  const f = await setup(t, { remarkFails: true });
  await f.json('/api/wecom/directory/sync', 'POST', {});
  const r = (await f.json('/api/wecom/bindings', 'POST', { patientId: f.wang.id, member: 'assistant', external: 'wm-phone', relationship: 'self', confirmed: true })).data;
  assert.equal(r.remarkWriteBack.ok, false); assert.match(r.remarkWriteBack.detail, /60011/);
  assert.equal(f.server.wecom.bindings(f.wang.id).length, 1);
});

test('group broadcast is one owner-confirmed WeCom task, idempotent and refreshed to sent', async t => {
  const f = await setup(t);
  await f.json('/api/wecom/directory/sync', 'POST', {});
  const requestId = randomUUID();
  const draft = (await f.json('/api/wecom/group-tasks', 'POST', { chatId: 'wr-group', text: '周五停诊一次', requestId })).data;
  assert.equal((await f.json('/api/wecom/group-tasks', 'POST', { chatId: 'wr-group', text: '别的内容', requestId })).status, 409);
  assert.equal((await f.json(`/api/wecom/group-tasks/${draft.id}/submit`, 'POST', {})).status, 400);
  const task = (await f.json(`/api/wecom/group-tasks/${draft.id}/submit`, 'POST', { confirmed: true })).data;
  assert.equal(task.status, 'awaiting_member');
  await f.json(`/api/wecom/group-tasks/${draft.id}/submit`, 'POST', { confirmed: true });
  const sends = f.calls.filter(c => c.path.endsWith('/add_msg_template'));
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].data, { chat_type: 'group', sender: 'assistant', chat_id_list: ['wr-group'], allow_select: false, text: { content: '周五停诊一次' } });
  assert.equal((await f.json(`/api/wecom/group-tasks/${draft.id}/refresh`, 'POST', {})).data.status, 'sent');
  assert.equal((await f.json('/api/wecom/groups/wr-group')).data.tasks[0].status, 'sent');
});

test('chat tools only propose links and group messages; confirming applies them', async t => {
  const f = await setup(t);
  const tools = Object.fromEntries(careTools(() => f.care, f.server.pendingActions).map(tool => [tool.definition.function.name, tool.execute]));
  await tools.wecom_sync();
  const found = await tools.wecom_customers({ state: 'suggested' });
  assert.equal(found.customers.length, 2);
  const target = found.customers.find(c => c.external === 'wm-phone');
  const proposal = await tools.wecom_bind_propose({ patientId: f.wang.id, member: target.member, external: target.external, relationship: 'self', reasons: target.suggestion.candidates[0].reasons });
  assert.equal(proposal.status, 'pending'); assert.equal(f.server.wecom.bindings(f.wang.id).length, 0);
  assert.equal((await f.json(`/api/pending-actions/${proposal.id}/confirm`, 'POST', {})).status, 200);
  assert.equal(f.server.wecom.bindings(f.wang.id).length, 1);
  await f.care.drain();
  assert.ok(f.calls.some(c => c.path.endsWith('/externalcontact/remark')));
  assert.equal((await tools.wecom_patient_contacts({ patientId: f.wang.id })).linked.length, 1);

  const group = await tools.wecom_group_message_propose({ chatId: 'wr-group', text: '本周五答疑取消' });
  assert.equal(f.calls.filter(c => c.path.endsWith('/add_msg_template')).length, 0);
  await f.json(`/api/pending-actions/${group.id}/confirm`, 'POST', {});
  await f.care.drain();
  assert.equal(f.calls.filter(c => c.path.endsWith('/add_msg_template')).length, 1);
  assert.equal((await tools.wecom_groups({ chatId: 'wr-group' })).tasks[0].status, 'awaiting_member');
  assert.throws(() => tools.wecom_group_message_propose({ chatId: 'missing', text: 'x' }), /客户群/);
});

test('the care tick syncs the directory when due', async t => {
  const f = await setup(t);
  await f.care.tick(); await f.care.drain();
  assert.equal(f.server.wecom.directory.status().contacts, 3);
  const before = f.calls.length;
  await f.care.tick(); await f.care.drain();
  assert.equal(f.calls.filter((c, i) => i >= before && c.path.endsWith('/batch/get_by_user')).length, 0);
});

test('browser: 客户与群 opens on pending matches, links with one click, creates a patient and broadcasts to a group', async t => {
  const { existsSync } = await import('node:fs');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!existsSync(chrome) || !existsSync('dist/index.html')) return t.skip('Chrome/build unavailable');
  const { chromium } = await import('playwright-core');
  const f = await setup(t);
  await f.care.drain();
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(12000);
  const shots = process.env.CARE_CONTACT_SHOTS || '';
  const shot = name => shots ? page.screenshot({ path: `${shots}-${name}.png`, fullPage: true }) : null;
  await page.goto(f.origin);
  await page.getByRole('navigation', { name: '主要业务' }).getByRole('button', { name: '患者消息' }).click();
  await page.getByRole('button', { name: /客户与群/ }).click();
  const region = page.getByRole('region', { name: '客户与群' });
  await region.getByRole('button', { name: /待确认匹配/, pressed: true }).waitFor();
  await region.getByText('依据：备注手机号与档案电话一致').waitFor();
  await shot('1-suggested');
  const phoneCard = region.getByRole('listitem').filter({ hasText: '138 0013 8000' });
  await phoneCard.getByRole('button', { name: '是本人' }).click();
  await region.getByText('已关联，企业微信备注已改为「王建国」。').waitFor();
  assert.equal(f.server.wecom.bindings(f.wang.id)[0].relationship, 'self');
  // The family hint in the remark makes 是家属 the default.
  const familyCard = region.getByRole('listitem').filter({ hasText: 'P-0042' });
  assert.match(await familyCard.getByRole('button', { name: '是家属' }).getAttribute('class'), /primary/);
  await familyCard.getByRole('button', { name: '是家属' }).click();
  await region.getByText('已关联。', { exact: true }).waitFor();

  await region.getByRole('button', { name: /未关联/ }).click();
  await region.getByRole('button', { name: '新建患者「咨询」' }).click();
  await region.getByText(/已新建患者「咨询」/).waitFor();
  await shot('2-unmatched');

  await region.getByRole('button', { name: /客户群/ }).click();
  await region.getByText('群里的患者：').waitFor();
  await shot('3-groups');
  await region.getByRole('button', { name: '群发消息' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('内容').fill('周五下午停诊一次');
  await dialog.getByRole('button', { name: '确认，交给群主发送' }).click();
  await region.getByText(/等待群主 assistant 在企业微信确认发送/).waitFor();
  assert.equal(f.calls.filter(c => c.path.endsWith('/add_msg_template')).length, 1);
  await region.getByRole('button', { name: '成员与群发记录' }).click();
  await region.getByRole('button', { name: '查询发送结果' }).click();
  await region.getByText('群主已发送到群里。').waitFor();
  assert.deepEqual(errors, []);
});
