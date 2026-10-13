import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fixture } from './helpers.mjs';
import { DoctorNotifications } from '../server/medical/doctor-notifications.mjs';
const NOW = Date.parse('2026-10-13T01:01:00Z');
const ok = data => ({ ok: true, status: 200, json: async () => data });
const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only';
async function due(f, name = '熊猫', offset = 60000) {
  const patient = (await f.json('/api/patients', 'POST', { name })).data;
  f.server.followups.create(patient.id, { name: '复诊反馈', once: true, firstDueAt: new Date(NOW + offset).toISOString() });
  return patient;
}
async function reminders(t, fetchImpl) {
  return fixture(t, { followupOptions: { now: () => NOW, autoStart: false }, doctorNotificationOptions: { now: () => NOW, autoStart: false, fetchImpl } });
}
const saveReminder = (f, extra = {}) => f.json('/api/doctor-notifications/feishu', 'PUT', { enabled: true, time: '09:00', timezone: 'Asia/Shanghai', expectedRevision: 0, webhook, ...extra });

test('doctor digest uses counts only, excludes future/archived patients, signs payload and survives restart without duplicate', async t => {
  const calls = [];
  const f = await reminders(t, async (url, init) => { calls.push({ url, ...init }); return ok({ code: 0 }); });
  await due(f); await due(f, '长颈鹿', 2 * 86400000);
  const archived = await due(f, '海豚');
  const db = f.server.store.db;
  const row = JSON.parse(db.prepare('SELECT data FROM patients WHERE id=?').get(archived.id).data);
  db.prepare('UPDATE patients SET data=? WHERE id=?').run(JSON.stringify({ ...row, archived: true }), archived.id);
  const saved = await saveReminder(f, { signingSecret: 'synthetic-signing-secret' });
  assert.equal(saved.status, 200); assert.equal(saved.data.preview.patients, 1);
  assert.ok(!JSON.stringify(saved.data).includes('synthetic-signing-secret'));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM agent_credentials').all()).includes('synthetic-signing-secret'));
  await f.server.doctorNotifications.tick(); await f.server.doctorNotifications.tick();
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].body);
  assert.match(body.content.text, /1 位患者/); assert.doesNotMatch(body.content.text, /熊猫|海豚|长颈鹿|复诊反馈/);
  assert.equal(body.sign, createHmac('sha256', `${body.timestamp}\nsynthetic-signing-secret`).update('').digest('base64'));
  const restarted = new DoctorNotifications(f.server.store, f.server.doctorNotifications.vault, { now: () => NOW, fetchImpl: async () => { throw Error('must not resend'); }, autoStart: false });
  await restarted.tick(); assert.equal(restarted.publicConfig('feishu').delivery.status, 'sent'); await restarted.stop();
  assert.equal((await f.json('/api/doctor-notifications/feishu', 'PUT', { expectedRevision: 0 })).status, 409);
  assert.equal((await fetch(f.origin + '/api/doctor-notifications')).status, 401);
});

test('failed and ambiguous deliveries do not loop; explicit receipt retry and channel disconnect work', async t => {
  let mode = 'network', calls = 0;
  const f = await reminders(t, async () => { calls++; if (mode === 'network') throw Error('secret-url'); return ok(mode === 'rejected' ? { code: 999 } : { code: 0 }); });
  await due(f); await saveReminder(f);
  const sent = await f.json('/api/doctor-notifications/feishu/send', 'POST', {});
  assert.equal(sent.data.delivery.status, 'unknown'); assert.doesNotMatch(JSON.stringify(sent.data), /secret-url/);
  await f.server.doctorNotifications.tick(); assert.equal(calls, 1);
  mode = 'rejected'; const failed = await f.json('/api/doctor-notifications/feishu/send', 'POST', { retryId: sent.data.delivery.id });
  assert.equal(failed.data.delivery.status, 'failed');
  mode = 'ok'; const good = await f.json('/api/doctor-notifications/feishu/send', 'POST', { retryId: failed.data.delivery.id });
  assert.equal(good.data.delivery.status, 'sent');
  assert.equal((await f.json('/api/doctor-notifications/feishu/send', 'POST', { retryId: failed.data.delivery.id })).status, 409);
  await f.json('/api/doctor-notifications/feishu/disconnect', 'POST', { expectedRevision: 1 });
  assert.equal((await f.json('/api/doctor-notifications/feishu/test', 'POST', {})).status, 400);
});

test('schedule honors timezone and disabled flag; bad webhook cannot be used for outbound requests', async t => {
  let calls = 0;
  const f = await reminders(t, async () => { calls++; return ok({ code: 0 }); }); await due(f);
  assert.equal((await saveReminder(f, { webhook: 'http://127.0.0.1/hook' })).status, 400);
  await saveReminder(f, { timezone: 'America/New_York', time: '23:00' });
  await f.server.doctorNotifications.tick(); assert.equal(calls, 0);
  await saveReminder(f, { expectedRevision: 1, enabled: false }); await f.server.doctorNotifications.tick(); assert.equal(calls, 0);
});

test('WeChat QR binds only confirmed doctor account and no credentials appear in API response', async t => {
  const sent = [];
  const f = await reminders(t, async (url, init) => {
    if (url.includes('get_bot_qrcode')) return ok({ qrcode: 'synthetic-qr', qrcode_img_content: 'https://example.invalid/qr' });
    if (url.includes('get_qrcode_status')) return ok({ status: 'confirmed', bot_token: 'synthetic-bot-token', ilink_user_id: 'doctor-animal', ilink_bot_id: 'bot-test', baseurl: 'https://ilinkai.weixin.qq.com' });
    sent.push(JSON.parse(init.body)); return ok({ ret: 0 });
  });
  const qr = await f.json('/api/doctor-notifications/wechat/qrcode', 'POST', {}); assert.match(qr.data.image, /^data:image\/png;base64,/);
  const connected = await f.json('/api/doctor-notifications/wechat/qrcode-status', 'POST', { id: qr.data.id });
  assert.equal(connected.data.config.hasConnection, true); assert.doesNotMatch(JSON.stringify(connected.data), /synthetic-bot-token|doctor-animal/);
  await f.json('/api/doctor-notifications/wechat/test', 'POST', {});
  assert.equal(sent[0].msg.to_user_id, 'doctor-animal');
  assert.equal((await f.json('/api/doctor-notifications/wechat/qrcode-status', 'POST', { id: qr.data.id })).status, 400);
});

const APP = 'cli_1234567890abcdef';
async function botFixture(t, { getProvider } = {}) {
  const replies = [], sockets = []; let clock = NOW;
  const f = await fixture(t, { followupOptions: { autoStart: false }, doctorNotificationOptions: { autoStart: false }, knowledgeBotOptions: {
    now: () => clock, getProvider,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/auth/v3/tenant_access_token/internal')) return ok({ code: 0, tenant_access_token: 'synthetic-access-token', expire: 7200 });
      if (url.endsWith('/bot/v3/info')) return ok({ code: 0, bot: { open_id: 'ou_bot' } });
      if (url.includes('/contact/v3/users/')) return ok({ code: 0, data: { user: { name: '熊猫' } } });
      if (url.includes('/chats/')) return ok({ code: 0, data: { name: '熊猫学习群' } });
      replies.push({ url, body: JSON.parse(init.body) }); return ok({ code: 0 });
    },
    createSocket: (options, handler) => { const socket = { handler, closed: false, start: async () => options.onReady(), close() { this.closed = true; } }; sockets.push(socket); return socket; },
  } });
  const lib = f.server.guidelines;
  for (const [collection, text, reviewed] of [['开放库', '复诊时核对资料日期与来源。', true], ['私有库', '复诊私有资料禁止出现。', true], ['开放库', '复诊未复核内容禁止出现。', false]]) {
    const doc = await lib.addDocument({ collection, title: collection + (reviewed ? '已复核' : '未复核'), text });
    if (reviewed) lib.updateMetadata(doc.id, { expectedRevision: 0, reviewStatus: 'reviewed', reviewNote: '来源已核对' });
  }
  const save = async extra => {
    const current = f.server.knowledgeBot.config();
    const result = await f.json('/api/knowledge-bot', 'PUT', { ...current, appId: APP, appSecret: 'synthetic-app-secret', enabled: true, collections: ['开放库'], groups: [], ...extra, expectedRevision: current.revision });
    await f.server.knowledgeBot.connection; return result;
  };
  const event = (id, overrides = {}) => ({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_panda' } }, message: { chat_type: 'group', chat_id: 'oc_group1', message_id: `om_${id}`, create_time: String(clock), message_type: 'text', mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }], content: JSON.stringify({ text: '@_user_1 复诊' }), ...overrides } });
  const receive = async e => { clock += 4000; f.server.knowledgeBot.receive(e); await Promise.all([...f.server.knowledgeBot.jobs]); };
  return { ...f, replies, sockets, save, event, receive };
}

test('Feishu group discovery requires explicit approval, exact bot mention, reviewed sources and cites local evidence', async t => {
  const f = await botFixture(t); const saved = await f.save();
  assert.equal(saved.status, 200); assert.equal(f.server.knowledgeBot.state, 'connected'); assert.doesNotMatch(JSON.stringify(saved.data), /synthetic-app-secret/);
  await f.receive(f.event('other', { mentions: [{ id: { open_id: 'ou_someone' } }] }));
  assert.equal(f.server.knowledgeBot.settings().discoveredGroups.length, 0);
  await f.receive(f.event('discover')); assert.equal(f.replies.length, 0);
  assert.equal(f.server.knowledgeBot.settings().discoveredGroups[0].name, '熊猫学习群');
  await f.save({ groups: ['oc_group1'] });
  // A configured external embedder must not receive questions from the group.
  let embeddings = 0;
  f.server.guidelines.embedder = { available: () => true, status: () => ({ enabled: true }), model: 'test', embed: async () => { embeddings++; return [[1, 0]]; } };
  f.server.guidelines.vectorStore = { stats: async () => ({ chunks: 0, models: [] }), search: async () => [], close: async () => {} };
  await f.receive(f.event('answer')); assert.equal(f.replies.length, 1);
  assert.equal(embeddings, 0);
  const text = JSON.parse(f.replies[0].body.content).text;
  assert.match(text, /核对资料日期与来源/); assert.match(text, /出处：第/); assert.doesNotMatch(text, /私有资料|未复核内容/);
  await f.receive(f.event('answer')); assert.equal(f.replies.length, 1);
  await f.receive(f.event('private', { chat_type: 'p2p' })); assert.equal(f.replies.length, 1);
  assert.equal((await f.json('/api/knowledge-bot', 'PUT', { ...f.server.knowledgeBot.config(), expectedRevision: 0 })).status, 409);
  await f.save({ enabled: false, groups: ['oc_group1'] }); await f.receive(f.event('disabled')); assert.equal(f.replies.length, 1);
  assert.ok(f.sockets.every(s => s.closed));
});

test('Feishu missing evidence stays explicit; revoked groups and unavailable libraries cannot be queried', async t => {
  const f = await botFixture(t); await f.save(); await f.receive(f.event('discover')); await f.save({ groups: ['oc_group1'] });
  await f.receive(f.event('missing', { content: JSON.stringify({ text: '@_user_1 完全不存在的关键词XYZ' }) }));
  assert.match(JSON.parse(f.replies[0].body.content).text, /没有找到相关依据/);
  await f.save({ groups: [] }); await f.receive(f.event('revoked')); assert.equal(f.replies.length, 1);
  assert.equal((await f.save({ collections: ['不存在'] })).status, 400);
  assert.equal((await f.save({ groups: ['oc_unknown'] })).status, 400);
});

test('Feishu changes cancel an in-flight search before external reply', async t => {
  const f = await botFixture(t); await f.save(); await f.receive(f.event('discover')); await f.save({ groups: ['oc_group1'] });
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.server.guidelines.search = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { hits: [] }; };
  f.server.knowledgeBot.receive(f.event('slow')); await ready;
  const stopping = f.server.knowledgeBot.save({ ...f.server.knowledgeBot.config(), enabled: false, expectedRevision: f.server.knowledgeBot.config().revision });
  release(); await stopping; assert.equal(f.replies.length, 0);
});

test('authorized Feishu single chat answers directly and keeps follow-ups apart from groups and other users', async t => {
  const inputs = [];
  const provider = { provider: 'local-test', model: 'knowledge-assistant', local: true, complete: async messages => { const input = JSON.parse(messages[1].content); inputs.push(input); return { message: { content: '核对资料日期与来源，再整理需要补充的资料。[1]' } }; } };
  const f = await botFixture(t, { getProvider: () => provider }); await f.save({ answerMode: 'assistant' });
  const direct = id => f.event(id, { chat_type: 'p2p', chat_id: 'oc_private', mentions: [], content: JSON.stringify({ text: '复诊' }) });
  await f.receive(direct('discovery')); assert.equal(f.replies.length, 0); assert.equal(inputs.length, 0);
  const chat = f.server.knowledgeBot.settings().discoveredGroups[0]; assert.equal(chat.chatType, 'p2p'); assert.equal(chat.senderId, 'ou_panda');
  assert.equal((await f.save({ groups: ['oc_private'] })).status, 400);
  await f.save({ privateChats: ['oc_private'], answerMode: 'assistant' });
  await f.receive(direct('first')); assert.equal(inputs.length, 1); assert.equal(inputs[0].history.length, 0);
  assert.match(JSON.parse(f.replies[0].body.content).text, /AI 整理/);
  await f.receive({ ...direct('followup'), message: { ...direct('followup').message, content: JSON.stringify({ text: '请列成要点' }) } });
  assert.equal(inputs[1].history.length, 1); assert.equal(inputs[1].history[0].question, '复诊');
  const foreign = direct('foreign'); foreign.sender.sender_id.open_id = 'ou_giraffe'; await f.receive(foreign); assert.equal(inputs.length, 2);
  // Discover and approve the group. Saving configuration intentionally clears old context.
  await f.receive(f.event('groupdiscovery')); await f.save({ privateChats: ['oc_private'], groups: ['oc_group1'], answerMode: 'assistant' });
  await f.receive(direct('newprivate')); await f.receive(f.event('groupfirst')); assert.equal(inputs.at(-1).history.length, 0);
  const other = f.event('otheruser'); other.sender.sender_id.open_id = 'ou_giraffe'; await f.receive(other); assert.equal(inputs.at(-1).history.length, 0);
  await f.receive(f.event('groupfollow')); assert.equal(inputs.at(-1).history.length, 1);
  await f.receive(f.event('threadfollow', { root_id: 'om_groupfirst' })); assert.equal(inputs.at(-1).history.length, 1);
  await f.receive(f.event('otherthread', { root_id: 'om_unknownroot' })); assert.equal(inputs.at(-1).history.length, 0);
  await f.receive({ ...direct('reset'), message: { ...direct('reset').message, content: JSON.stringify({ text: '/new' }) } });
  assert.match(JSON.parse(f.replies.at(-1).body.content).text, /已开启新话题/);
  await f.receive(direct('afterreset')); assert.equal(inputs.at(-1).history.length, 0);
  const before = f.replies.length;
  await f.save({ answerMode: 'assistant', groups: [], privateChats: [] }); await f.receive(direct('revoked')); assert.equal(f.replies.length, before);
});

test('same Feishu conversation queues rapid follow-ups in order; authorization changes abort pending model answers', async t => {
  let release, started;
  const entered = new Promise(r => { started = r; });
  const inputs = [];
  const f = await botFixture(t, { getProvider: () => ({ complete: async messages => { inputs.push(JSON.parse(messages[1].content)); if (inputs.length === 1) { started(); await new Promise(r => { release = r; }); } return { message: { content: '资料核对要点。[1]' } }; } }) });
  await f.save({ answerMode: 'assistant' }); await f.receive(f.event('discover')); await f.save({ groups: ['oc_group1'], answerMode: 'assistant' });
  f.server.knowledgeBot.receive(f.event('rapid1')); await entered;
  f.server.knowledgeBot.receive(f.event('rapid2', { content: JSON.stringify({ text: '继续说明' }) }));
  assert.equal(inputs.length, 1); release(); await Promise.all([...f.server.knowledgeBot.jobs]);
  assert.equal(inputs.length, 2); assert.equal(inputs[1].history.length, 1); assert.equal(f.replies.length, 2);
  let pending;
  const ready = new Promise(r => { pending = r; });
  f.server.knowledgeBot.getProvider = () => ({ complete: () => { pending(); return new Promise(() => {}); } });
  f.server.knowledgeBot.receive(f.event('slow')); await ready;
  await f.save({ enabled: false, answerMode: 'assistant', groups: ['oc_group1'] });
  assert.equal(f.replies.length, 2); assert.equal(f.server.knowledgeBot.contexts.size, 0);
});

test('model failures return honest excerpts; retired evidence is never posted after generation', async t => {
  let mode = 'fail';
  const f = await botFixture(t, { getProvider: () => ({ complete: async () => {
    if (mode === 'fail') throw new Error('secret provider detail');
    const doc = f.server.guidelines.list({ collection: '开放库', reviewStatus: 'reviewed' })[0];
    f.server.guidelines.updateMetadata(doc.id, { expectedRevision: doc.revision, reviewStatus: 'retired', reviewNote: '资料需重新核对' });
    return { message: { content: '不能发送的旧资料结论' } };
  } }) });
  await f.save({ answerMode: 'assistant' }); await f.receive(f.event('discover')); await f.save({ groups: ['oc_group1'], answerMode: 'assistant' });
  await f.receive(f.event('fallback')); const answer = JSON.parse(f.replies[0].body.content).text;
  assert.match(answer, /本次模型整理未完成/); assert.match(answer, /资料日期/); assert.doesNotMatch(answer, /secret provider/);
  mode = 'retire'; await f.receive(f.event('retire')); assert.equal(f.replies.length, 1);
  assert.equal((await f.json('/api/knowledge-bot/reset-context', 'POST', { expectedRevision: f.server.knowledgeBot.config().revision })).status, 200);
  assert.equal(f.server.knowledgeBot.contexts.size, 0);
});
