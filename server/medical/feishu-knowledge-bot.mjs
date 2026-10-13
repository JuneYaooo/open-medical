import * as Lark from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'node:crypto';
import { check, AppError } from '../errors.mjs';
import { sqliteTransaction } from '../sqlite-transaction.mjs';

const KEY = 'feishu-knowledge-bot';
const BASE = 'https://open.feishu.cn/open-apis';
const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
function socketFactory(options, handler) {
  const socket = new Lark.WSClient({ ...options, logger: silentLogger });
  return { start: () => socket.start({ eventDispatcher: new Lark.EventDispatcher({ logger: silentLogger }).register({ 'im.message.receive_v1': handler }) }), close: () => socket.close({ force: true }) };
}

export class FeishuKnowledgeBot {
  constructor(store, vault, library, { fetchImpl = fetch, createSocket = socketFactory, now = () => Date.now(), autoStart = true } = {}) {
    Object.assign(this, { db: store.db, vault, library, fetchImpl, createSocket, now, autoStart });
    this.state = 'disabled'; this.message = ''; this.generation = 0; this.jobs = new Set(); this.controllers = new Set(); this.rate = new Map(); this.busy = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_bot_settings(id INTEGER PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_bot_groups(app_id TEXT,chat_id TEXT,data TEXT NOT NULL,PRIMARY KEY(app_id,chat_id));
      CREATE TABLE IF NOT EXISTS knowledge_bot_messages(app_id TEXT,message_id TEXT,at INTEGER,PRIMARY KEY(app_id,message_id));`);
  }
  config() { const row = this.db.prepare('SELECT data FROM knowledge_bot_settings WHERE id=1').get(); return row ? JSON.parse(row.data) : { enabled: false, appId: '', collections: [], groups: [], revision: 0 }; }
  settings() {
    const config = this.config();
    return { ...config, hasSecret: Boolean(this.vault.get(KEY).appSecret), state: this.state, message: this.message, busy: this.busy,
      availableCollections: this.library.collections().map(c => ({ name: c.name, documentCount: c.documentCount, reviewedCount: this.library.list({ collection: c.name, reviewStatus: 'reviewed' }).length })),
      discoveredGroups: this.db.prepare('SELECT chat_id,data FROM knowledge_bot_groups WHERE app_id=?').all(config.appId).map(r => ({ id: r.chat_id, ...JSON.parse(r.data) })) };
  }
  async save(input) {
    check(!this.busy, 'BUSY', '正在更新连接，请稍后再试', 409);
    const old = this.config();
    check(input.expectedRevision === old.revision, 'REVISION_CONFLICT', '配置已变化，请刷新后重试', 409);
    check(typeof input.enabled === 'boolean' && /^cli_[a-fA-F0-9]{16}$/.test(input.appId || ''), 'INVALID_INPUT', '请填写飞书自建应用的 App ID');
    check(input.appSecret === undefined || (typeof input.appSecret === 'string' && input.appSecret.length <= 512), 'INVALID_INPUT', '应用密钥格式无效');
    const secret = input.appId === old.appId ? this.vault.get(KEY) : {};
    if (input.appSecret?.trim()) secret.appSecret = input.appSecret.trim();
    check(secret.appSecret, 'NOT_CONFIGURED', '请填写 App Secret');
    const available = new Set(this.library.collections().map(c => c.name));
    check(Array.isArray(input.collections) && input.collections.length <= 30 && input.collections.every(c => typeof c === 'string' && available.has(c)), 'INVALID_INPUT', '请选择现有知识库');
    check(!input.enabled || input.collections.length, 'INVALID_INPUT', '请先选择允许群内检索的知识库');
    const known = new Set(this.db.prepare('SELECT chat_id FROM knowledge_bot_groups WHERE app_id=?').all(input.appId).map(r => r.chat_id));
    check(Array.isArray(input.groups) && input.groups.length <= 50 && input.groups.every(g => known.has(g)), 'INVALID_INPUT', '请从待授权群中选择');
    this.busy = true;
    try {
      await this.stop();
      const config = { enabled: input.enabled, appId: input.appId, collections: [...new Set(input.collections)], groups: [...new Set(input.groups)], revision: old.revision + 1 };
      sqliteTransaction(this.db, () => { this.vault.set(KEY, secret); this.db.prepare('INSERT OR REPLACE INTO knowledge_bot_settings VALUES(1,?)').run(JSON.stringify(config)); });
      this.start();
      return this.settings();
    } finally { this.busy = false; }
  }
  async request(path, init = {}, generation = this.generation) {
    check(generation === this.generation, 'CANCELLED', '连接已更新');
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000); timer.unref?.();
    try {
      const response = await this.fetchImpl(BASE + path, { ...init, redirect: 'error', signal: controller.signal });
      const data = await response.json();
      check(response.ok && data && typeof data === 'object' && data.code === 0, 'FEISHU_ERROR', '飞书请求失败，请检查应用权限与发布状态');
      check(generation === this.generation, 'CANCELLED', '连接已更新');
      return data;
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError('FEISHU_ERROR', '飞书网络连接失败，请检查网络与应用配置'); }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  async token(generation) {
    if (this.accessToken && this.tokenExpires > this.now()) return this.accessToken;
    const config = this.config();
    const data = await this.request('/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: config.appId, app_secret: this.vault.get(KEY).appSecret }) }, generation);
    check(typeof data.tenant_access_token === 'string' && data.tenant_access_token, 'FEISHU_ERROR', '飞书未返回访问令牌');
    this.accessToken = data.tenant_access_token; this.tokenExpires = this.now() + Math.max(0, Math.min(Number(data.expire) || 0, 7200) - 60) * 1000;
    return this.accessToken;
  }
  async authorized(path, init, generation) { const token = await this.token(generation); return this.request(path, { ...init, headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` } }, generation); }
  start() {
    const config = this.config(); if (!this.autoStart || !config.enabled) { this.state = 'disabled'; return; }
    const generation = this.generation;
    this.state = 'connecting'; this.message = '';
    this.connection = (async () => {
      const info = await this.authorized('/bot/v3/info', {}, generation);
      check(typeof info.bot?.open_id === 'string' && info.bot.open_id, 'FEISHU_ERROR', '请为自建应用开启机器人能力');
      this.botId = info.bot.open_id;
      const current = () => generation === this.generation;
      this.socket = this.createSocket({ appId: config.appId, appSecret: this.vault.get(KEY).appSecret,
        onReady: () => { if (current()) { this.state = 'connected'; this.message = ''; } },
        onError: () => { if (current()) { this.state = 'failed'; this.message = '长连接失败，请检查应用密钥、长连接订阅与发布状态，然后重新保存连接。'; } },
        onReconnecting: () => { if (current()) this.state = 'reconnecting'; },
        onReconnected: () => { if (current()) { this.state = 'connected'; this.message = ''; } },
      }, event => { if (current()) this.receive(event); });
      await this.socket.start();
    })().catch(() => { if (generation === this.generation) { this.state = 'failed'; this.message = '连接失败，请核对 App ID、App Secret 和机器人权限，再重新保存。'; } });
  }
  receive(event) {
    const config = this.config(), msg = event?.message;
    if (!config.enabled || !msg || event.sender?.sender_type !== 'user' || msg.chat_type !== 'group' || msg.message_type !== 'text' || !Array.isArray(msg.mentions) || !msg.mentions.some(m => m.id?.open_id === this.botId)) return;
    if (!/^oc_[a-zA-Z0-9]+$/.test(msg.chat_id || '') || !/^om_[a-zA-Z0-9]+$/.test(msg.message_id || '')) return;
    const at = Number(msg.create_time); if (!Number.isFinite(at) || Math.abs(this.now() - at) > 24 * 3600000) return;
    let question; try { question = JSON.parse(msg.content).text; } catch { return; }
    if (typeof question !== 'string' || question.length > 4000) return;
    for (const mention of msg.mentions) if (typeof mention.key === 'string') question = question.split(mention.key).join(' ');
    question = question.trim(); if (!question) return;
    this.db.prepare('DELETE FROM knowledge_bot_messages WHERE at<?').run(this.now() - 2 * 86400000);
    if (!this.db.prepare('INSERT OR IGNORE INTO knowledge_bot_messages VALUES(?,?,?)').run(config.appId, msg.message_id, this.now()).changes) return;
    const known = this.db.prepare('SELECT 1 FROM knowledge_bot_groups WHERE app_id=? AND chat_id=?').get(config.appId, msg.chat_id);
    if (!known && this.db.prepare('SELECT count(*) AS n FROM knowledge_bot_groups WHERE app_id=?').get(config.appId).n >= 50) return;
    if (!known) this.db.prepare('INSERT INTO knowledge_bot_groups VALUES(?,?,?)').run(config.appId, msg.chat_id, JSON.stringify({ name: '', firstSeen: this.now() }));
    // Only IDs and receipt timestamps are persisted; questions stay in memory.
    const generation = this.generation;
    const previous = this.rate.get(msg.chat_id) || 0;
    if (this.jobs.size >= 20 || this.now() - previous < 3000) return;
    this.rate.set(msg.chat_id, this.now());
    const job = (async () => {
      if (!known) {
        try {
          const group = await this.authorized(`/im/v1/chats/${encodeURIComponent(msg.chat_id)}`, {}, generation);
          if (typeof group.data?.name === 'string') this.db.prepare('UPDATE knowledge_bot_groups SET data=? WHERE app_id=? AND chat_id=?').run(JSON.stringify({ name: group.data.name.slice(0, 200), firstSeen: this.now() }), config.appId, msg.chat_id);
        } catch { /* Group name permission is optional; the ID remains usable. */ }
      }
      if (!config.groups.includes(msg.chat_id)) return;
      let reply = '请用 200 字以内的关键词或问题查询知识库。';
      if (question.length <= 200) {
        const hits = [];
        for (const collection of config.collections) {
          const result = await this.library.search({ query: question, collection, reviewStatus: 'reviewed', localOnly: true, limit: 3 });
          hits.push(...result.hits);
        }
        const selected = hits.sort((a, b) => b.score - a.score).filter((h, i, all) => all.findIndex(v => v.docId === h.docId) === i).slice(0, 3);
        // Sources may be edited/retired while a search is running.
        const valid = selected.filter(h => { try { const doc = this.library.get(h.docId); return doc.reviewStatus === 'reviewed' && config.collections.includes(doc.collection || '默认知识库') && doc.sha256 === h.sha256 && (doc.revision || 0) === h.revision; } catch { return false; } });
        reply = valid.length ? '在已开放知识库中找到以下相关原文：\n\n' + valid.map((h, i) => `${i + 1}. ${h.docTitle} · ${h.collection}\n${h.matches?.map(m => m.text).join('\n') || h.snippet}\n出处：第 ${h.startLine}–${h.endLine} 行`).join('\n\n') + '\n\n以上为资料摘录，请结合原文核对；不作个体诊疗判断。' : '已开放且已复核的知识库中没有找到相关依据。可以换用更具体的关键词，或请医生补充资料。';
      }
      if (generation !== this.generation || !this.config().enabled) return;
      await this.authorized(`/im/v1/messages/${encodeURIComponent(msg.message_id)}/reply`, { method: 'POST', body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text: reply }), uuid: randomUUID() }) }, generation);
      this.message = '最近一次知识库回复已被飞书接受';
    })().catch(() => { if (generation === this.generation) this.message = '最近一次群请求处理失败，请检查飞书权限与网络；可在群内重新提问。'; });
    this.jobs.add(job); void job.finally(() => this.jobs.delete(job));
  }
  async stop() {
    this.generation++; this.socket?.close(); this.socket = null;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([this.connection, ...this.jobs]);
    this.accessToken = ''; this.tokenExpires = 0; this.botId = ''; this.rate.clear(); this.state = 'disabled'; this.message = '';
  }
}
