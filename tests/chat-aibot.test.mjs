import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fixture } from './helpers.mjs';
import { WecomAibotChannel, AIBOT_CHANNEL } from '../server/chat-aibot.mjs';
import { toChatMessage } from '../server/chat-connectors/wecom-aibot-ws.mjs';
import { AppError } from '../server/errors.mjs';

class FakeSocket extends EventEmitter {
  constructor(mode){ super(); this.mode = mode; this.closed = false; }
  connect(){ setImmediate(() => { if (!this.closed) this.mode === 'ok' ? this.emit('authenticated') : this.emit('authError', 893001, 'bad secret'); }); }
  close(){ this.closed = true; }
  get live(){ return !this.closed && this.mode === 'ok'; }
  send(){}
  reply(){ return Promise.reject(new Error('未使用')); }
}

const groupFrame = (over={}) => ({ cmd:'aibot_msg_callback', headers:{req_id:'r1'}, body:{ msgid:'m1', aibotid:'bot', chatid:'wrAbc123', chattype:'group', from:{userid:'woDoc'}, msgtype:'text', text:{content:'@英俊的机器人 你好'}, ...over } });

test('toChatMessage maps group/single frames and strips the @-mention prefix', () => {
  const m = toChatMessage(groupFrame().body);
  assert.equal(m.id, 'aibot:m1');
  assert.equal(m.conversationId, 'room:wrAbc123');
  assert.equal(m.text, '你好'); // @ 前缀剥除
  assert.equal(m.direction, 'in');
  assert.equal(m.senderId, 'woDoc');
  assert.equal(m.sentAt, null);
  const single = toChatMessage(groupFrame({ chattype:'single', chatid:undefined, text:{content:'血压有点高'} }).body);  assert.equal(single.conversationId, 'woDoc');
  assert.equal(single.text, '血压有点高');
  const image = toChatMessage(groupFrame({ msgtype:'image', text:undefined }).body);
  assert.equal(image.text, '');
  assert.equal(image.type, 'image');
  assert.equal(toChatMessage({ msgtype:'text' }), null);
  assert.equal(toChatMessage(groupFrame({ chatid:'' }).body), null);
  assert.ok(toChatMessage(groupFrame({ text:{content:'x'.repeat(30000)} }).body).text.length <= 20000);
});

test('channel ingests pushed frames into chat followups and records seen conversations', () => {
  const ingested = [];
  const channel = new WecomAibotChannel();
  channel.attach({
    config: () => ({ channel:AIBOT_CHANNEL, enabled:true, accountId:'bot', revision:1 }),
    secret: () => ({ token:'sec' }),
    db: { exec(){} },
    ingest: (c, msgs) => ingested.push(...msgs),
  });
  channel.onMessage(groupFrame());
  assert.equal(ingested.length, 1);
  assert.deepEqual(channel.seenList().map(s => s.id), ['room:wrAbc123']);
  channel.onMessage(groupFrame({ msgid:'m2', chattype:'single', chatid:undefined, from:{userid:'woP'}, text:{content:'直接咨询'} }));
  assert.equal(ingested[1].conversationId, 'woP');
  assert.deepEqual(channel.seenList().map(s => s.id), ['woP', 'room:wrAbc123']);
  // 未启用时只记录 seen,不入库。
  const disabled = new WecomAibotChannel();
  let calls = 0;
  disabled.attach({ db: { exec(){} }, config: () => ({ channel:AIBOT_CHANNEL, enabled:false }), secret: () => ({ token:'sec' }), ingest: () => calls++ });
  disabled.onMessage(groupFrame());
  assert.equal(calls, 0);
});

test('status validates credentials, short-circuits when live and probes once otherwise', async () => {
  const channel = new WecomAibotChannel({ socketFactory: () => new FakeSocket('ok') });
  await assert.rejects(() => channel.status({ accountId:'', token:'sec' }), AppError);
  await assert.rejects(() => channel.status({ accountId:'bot', token:'' }), AppError);
  assert.deepEqual(await channel.status({ accountId:'bot', token:'sec' }), { ready:true, message:'机器人密钥有效，长连接已可建立' });
  const live = new WecomAibotChannel({ socketFactory: () => new FakeSocket('ok') });
  live.socket = new FakeSocket('ok');
  live.secret = 'sec';
  assert.match((await live.status({ accountId:'bot', token:'sec' })).message, /长连接在线/);
  const bad = new WecomAibotChannel({ socketFactory: () => new FakeSocket('bad') });
  assert.equal((await bad.status({ accountId:'bot', token:'wrong' })).ready, false);
});

test('read() stays a compatible no-op; conversations() exposes seen list', async () => {
  const channel = new WecomAibotChannel();
  assert.deepEqual(await channel.read({}, '7'), { messages:[], nextCursor:'7', hasMore:false });
  assert.equal((await channel.conversations()).partial, false);
});

test('aibot channel end-to-end: connect, bind group, push frame lands in inbox then assigned draft', async t => {
  const channel = new WecomAibotChannel({ socketFactory: () => new FakeSocket('ok') });
  const f = await fixture(t, { chatAibot: channel });
  const patient = (await f.json('/api/patients','POST',{name:'企微合成患者'})).data;
  const settings = (await f.json('/api/chat-followups/settings')).data;
  assert.ok(settings.connections.some(c => c.channel === 'wecom-aibot'));
  const connected = await f.json('/api/chat-followups/connections/wecom-aibot/connect','POST',{ enabled:true, accountId:'aib6rWjv', token:'synthetic-secret', revision:settings.connections.find(c=>c.channel==='wecom-aibot').revision, intervalMinutes:15 });
  assert.equal(connected.status, 200);
  assert.equal(connected.data.enabled, true);
  assert.equal(connected.data.hasToken, true);
  assert.doesNotMatch(JSON.stringify(connected.data), /synthetic-secret/);
  const bound = await f.json('/api/chat-followups/bindings','POST',{ patientId:patient.id, channel:'wecom-aibot', title:'3 床家属群', speakerName:'家属', relationship:'family', conversationId:'room:wrAbc123', confirmed:true });
  assert.equal(bound.status, 201);
  channel.onMessage(groupFrame());
  channel.onMessage(groupFrame({ msgid:'m2', from:{userid:'woOther'}, text:{content:'@英俊的机器人 复查需要带什么'} }));
  let state = (await f.json(`/api/chat-followups/patients/${patient.id}`)).data;
  assert.equal(state.inbox.length, 2); // 群消息进待分配,不自动成稿
  assert.equal(state.drafts.length, 0);
  const assigned = await f.json('/api/chat-followups/assign','POST',{ bindingId:state.bindings[0].id, messageIds:[state.inbox[0].id], confirmed:true });
  assert.equal(assigned.status, 201);
  state = (await f.json(`/api/chat-followups/patients/${patient.id}`)).data;
  assert.equal(state.drafts.length, 1);
  assert.match(state.drafts[0].sourceText, /复查需要带什么/); // @ 前缀已剥除
  const listed = (await f.json('/api/chat-followups/conversations?channel=wecom-aibot')).data;
  assert.deepEqual(listed.conversations.map(c => c.id), ['room:wrAbc123']);
});

// ---- 回复引擎 ----
import { randomUUID } from 'node:crypto';
import { SAFETY_REPLY } from '../server/care/red-flags.mjs';

class ReplySocket extends FakeSocket {
  constructor(mode){ super(mode); this.replies = []; this.pushes = []; }
  async reply(frame, body){ this.replies.push({ reqId: frame?.headers?.req_id, body }); if (this.mode === 'ok') return { errcode: 0 }; throw new Error('respond fail'); }
  async push(chatId, body){ this.pushes.push({ chatId, body }); if (this.mode === 'ok') return { errcode: 0 }; throw new Error('push fail'); }
}
const providerOf = (text) => { let calls = 0; return { complete: async () => { calls++; return { message: { content: text } }; }, get calls(){ return calls; } };
};
const knowledgeOf = () => ({ search: async ({ query }) => assert.ok(query), });
const briefOf = () => ({ read: () => ({ name: '张三' }) });
const stubFollowups = (channel, { enabled = true, ingested = [] } = {}) => {
  const store = { replies: [] };
  const binding = JSON.stringify({ id:'b1', patientId:'p1', title:'家属群', disabled:0 });
  channel.attach({
    config: () => ({ channel:AIBOT_CHANNEL, enabled, autoReply:true, accountId:'bot', revision:1 }),
    secret: () => ({ token:'sec' }),
    account: () => 'acc1',
    db: { exec(){}, prepare(sql) {
      if (sql.startsWith('INSERT INTO chat_aibot_replies')) return { run: (id, _pid, _bid, _ch, data) => { const row = JSON.parse(data); const i = store.replies.findIndex(r => r.id === id); if (i >= 0) store.replies[i] = row; else store.replies.push(row); } };
      if (sql.startsWith('SELECT data FROM chat_aibot_replies WHERE id=')) return { get: (id) => { const hit = store.replies.find(r => r.id === id); return hit ? { data: JSON.stringify(hit) } : null; } };
      if (sql.startsWith('SELECT data FROM chat_aibot_replies WHERE patient_id=')) return { all: () => store.replies.map(r => ({ data: JSON.stringify(r) })) };
      return { get: () => ({ data: binding }) };
    } },
    ingest: (c, msgs) => ingested.push(...msgs),
  });
  return store;
};
const waitDraft = async (channel, n = 1) => { for (let i = 0; i < 40; i++) { if (channel.replies('p1').length >= n) return; await new Promise(r => setTimeout(r, 50)); } };

test('red-flag question drafts the deterministic safety reply without the model', async () => {
  const ingested = []; const provider = providerOf('不该被调用');
  const channel = new WecomAibotChannel({ provider, guidelines: knowledgeOf(), patientBrief: briefOf() });
  stubFollowups(channel, { ingested });
  channel.onMessage(groupFrame({ msgid:'rf1', text:{content:'@英俊的机器人 我爸今天胸口痛得厉害还出汗'} }));
  await waitDraft(channel);
  const rows = channel.replies('p1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].urgent, true);
  assert.equal(rows[0].text, SAFETY_REPLY);
  assert.equal(provider.calls, 0);
});

test('normal question drafts via knowledge base and provider, then send records an outbound message', async () => {
  const ingested = []; const provider = providerOf('复查当天请携带既往报告，提前 30 分钟到院。');
  const channel = new WecomAibotChannel({ provider, guidelines: knowledgeOf(), patientBrief: briefOf() });
  stubFollowups(channel, { ingested });
  channel.socket = new ReplySocket('ok');
  channel.onMessage(groupFrame({ msgid:'q1', text:{content:'@英俊的机器人 复查要带什么'} }));
  await waitDraft(channel);
  const rows = channel.replies('p1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].urgent, false);
  assert.match(rows[0].text, /复查当天/);
  assert.equal(provider.calls, 1);
  const sent = await channel.sendReply(rows[0].id, { consent:true });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sentVia, 'respond');
  assert.match(channel.socket.replies[0].body.markdown.content, /AI 助手/); // 免责声明发送时追加
  const out = ingested.find(m => m.direction === 'out');
  assert.ok(out && out.conversationId === 'room:wrAbc123');
  // 重复发送被拒
  await assert.rejects(() => channel.sendReply(rows[0].id, { consent:true }), AppError);
});

test('respond failure falls back to active push; dismiss requires confirmation', async () => {
  const channel = new WecomAibotChannel({ provider: providerOf('好的，请按时到院。'), guidelines: knowledgeOf(), patientBrief: briefOf() });
  stubFollowups(channel);
  channel.socket = new ReplySocket('bad'); // respond 与 push 都会抛错
  channel.onMessage(groupFrame({ msgid:'q2', text:{content:'@英俊的机器人 明天门诊吗'} }));
  await waitDraft(channel);
  const row = channel.replies('p1')[0];
  await assert.rejects(() => channel.sendReply(row.id, { consent:true })); // push 也失败
  const socket = new ReplySocket('ok'); socket.mode = 'bad-respond-only';
  // respond 抛错、push 成功的回退路径:用自定义 socket
  const fallback = new ReplySocket('ok');
  fallback.reply = async () => { throw new Error('respond fail'); };
  channel.socket = fallback;
  const sent = await channel.sendReply(row.id, { consent:true });
  assert.equal(sent.sentVia, 'push');
  assert.equal(fallback.pushes.length, 1);
  await assert.rejects(() => channel.dismissReply(row.id, { confirmed:false }), AppError);
});

// ---- 微信侧自动起草(医生审核版) ----
test('wechat ingest drafts a reply and sendReply goes through the desktop send chain', async () => {
  const ingested = []; const provider = providerOf('请按时服药并记录血压，复诊时带来。');
  const channel = new WecomAibotChannel({ provider, guidelines: knowledgeOf(), patientBrief: briefOf() });
  const sent = [];
  const store = { replies: [] };
  channel.attach({
    config: (ch) => ch === 'wechat' ? { channel:'wechat', enabled:true, autoReply:true, accountId:'wx', revision:1 } : { channel:AIBOT_CHANNEL, enabled:false, autoReply:false },
    secret: () => ({ token:'sec' }),
    account: () => 'acc1',
    db: { exec(){}, prepare(sql) {
      if (sql.startsWith('INSERT INTO chat_aibot_replies')) return { run: (id, _pid, _bid, _ch, data) => { const row = JSON.parse(data); const i = store.replies.findIndex(r => r.id === id); if (i >= 0) store.replies[i] = row; else store.replies.push(row); } };
      if (sql.startsWith('SELECT data FROM chat_aibot_replies WHERE id=')) return { get: (id) => { const hit = store.replies.find(r => r.id === id); return hit ? { data: JSON.stringify(hit) } : null; } };
      if (sql.startsWith('SELECT data FROM chat_aibot_replies WHERE patient_id=')) return { all: () => store.replies.map(r => ({ data: JSON.stringify(r) })) };
      return { get: () => JSON.stringify({ id:'w1', patientId:'p1', title:'患者张三', conversationId:'wxid_zhang', mode:'sync', disabled:0 }) };
    } },
    ingest: (c, msgs) => ingested.push(...msgs),
    sendToBinding: async (input) => { sent.push(input); return { ok:true }; },
  });
  const binding = { id:'w1', patientId:'p1', title:'患者张三', conversationId:'wxid_zhang', mode:'sync' };
  await channel.onWechatIngested(binding, '最近血压有点高，要不要紧？');
  await waitDraft(channel);
  const rows = channel.replies('p1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'wechat');
  assert.equal(rows[0].urgent, false);
  assert.match(rows[0].text, /血压/);
  const done = await channel.sendReply(rows[0].id, { consent:true });
  assert.equal(done.status, 'sent');
  assert.equal(done.sentVia, 'desktop');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].bindingId, 'w1');
  assert.match(sent[0].text, /AI 助手/); // 免责声明
  assert.equal(sent[0].autoLocate, true);
});

test('wechat red-flag drafts the safety reply and room/import bindings are skipped', async () => {
  const provider = providerOf('不该被调用');
  const channel = new WecomAibotChannel({ provider, guidelines: knowledgeOf(), patientBrief: briefOf() });
  const calls = [];
  const store = { replies: [] };
  channel.attach({
    config: (ch) => ch === 'wechat' ? { channel:'wechat', enabled:true, autoReply:true, accountId:'wx', revision:1 } : { channel:AIBOT_CHANNEL, enabled:false },
    secret: () => ({ token:'sec' }),
    account: () => 'acc1',
    db: { exec(){}, prepare(sql) {
      if (sql.startsWith('INSERT INTO chat_aibot_replies')) return { run: (id, _pid, _bid, _ch, data) => { const row = JSON.parse(data); const i = store.replies.findIndex(r => r.id === id); if (i >= 0) store.replies[i] = row; else store.replies.push(row); } };
      if (sql.startsWith('SELECT data FROM chat_aibot_replies WHERE id=')) return { get: (id) => { const hit = store.replies.find(r => r.id === id); return hit ? { data: JSON.stringify(hit) } : null; } };
      if (sql.startsWith('SELECT data FROM chat_aibot_replies WHERE patient_id=')) return { all: () => store.replies.map(r => ({ data: JSON.stringify(r) })) };
      return { get: () => JSON.stringify({ id:'w2', patientId:'p1', title:'群', conversationId:'room:x', mode:'sync', disabled:0 }) };
    } },
    ingest: () => {},
    sendToBinding: async (input) => calls.push(input),
  });
  // 红旗:直接安全话术
  await channel.onWechatIngested({ id:'w2', patientId:'p1', title:'患者李四', conversationId:'wxid_li', mode:'sync' }, '突然说话不清，半边没力气');
  await waitDraft(channel);
  const rows = channel.replies('p1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].urgent, true);
  assert.equal(rows[0].text, SAFETY_REPLY);
  assert.equal(provider.calls ?? 0, 0);
  // 群聊绑定不起草
  await channel.onWechatIngested({ id:'w2', patientId:'p1', title:'群', conversationId:'room:x', mode:'sync' }, '群里普通消息');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(channel.replies('p1').length, 1);
});

// ---- 批量导入匹配 ----
test('import matching hits patient names, normalizes and returns null for strangers', async t => {
  const f = await fixture(t, {});
  const p = (await f.json('/api/patients','POST',{name:'匹配测试患者'})).data;
  const r = (await f.json('/api/chat-followups/imports/match','POST',{names:['匹配测试患者','陌生群聊','  匹配测试患者  ']})).data;
  assert.equal(r.matchResults.length, 3);
  assert.equal(r.matchResults[0].match.patientId, p.id);
  assert.equal(r.matchResults[0].match.matchedBy, 'name');
  assert.equal(r.matchResults[1].match, null);
  assert.equal(r.matchResults[2].match.patientId, p.id); // 归一化忽略首尾空格
  assert.equal((await f.json('/api/chat-followups/imports/match','POST',{names:[]})).status, 400);
});
