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
  disabled.attach({ config: () => ({ channel:AIBOT_CHANNEL, enabled:false }), secret: () => ({ token:'sec' }), ingest: () => calls++ });
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
