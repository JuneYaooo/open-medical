import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ExternalContact, WecomApiError } from 'wecom';
import { decrypt, getSignature } from '@wecom/crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AppError, check, identifier, string } from './errors.mjs';
import { sqliteTransaction } from './sqlite-transaction.mjs';

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, processEntities: false });
function xml(text) {
  check(!/<!DOCTYPE|<!ENTITY/i.test(text) && XMLValidator.validate(text) === true, 'WECOM_XML', '回调 XML 无效');
  const value = parser.parse(text)?.xml;
  check(value && typeof value === 'object', 'WECOM_XML', '回调 XML 无效');
  return value;
}
function field(value, name, max = 200) { return string(value, name, max); }
const now = () => new Date().toISOString();
const failure = error => error instanceof WecomApiError
  ? `企业微信拒绝请求（错误码 ${error.errcode}），请检查权限、可信 IP 或发送限制。`
  : '企业微信连接失败，请检查网络及配置。';

const VAULT_KEY = 'wecom:corp:v1';
const ENV = { corpId: 'MEDICAL_WECOM_CORP_ID', corpSecret: 'MEDICAL_WECOM_SECRET', callbackToken: 'MEDICAL_WECOM_CALLBACK_TOKEN', aesKey: 'MEDICAL_WECOM_AES_KEY' };
const FORMATS = {
  corpId: [/^[A-Za-z0-9]{6,64}$/, '企业 ID 格式无效（在企业微信管理后台「我的企业」底部）'],
  corpSecret: [/^[A-Za-z0-9_-]{10,128}$/, '客户联系 Secret 格式无效'],
  callbackToken: [/^[A-Za-z0-9]{1,32}$/, '回调 Token 须为 1–32 位英文或数字'],
  aesKey: [/^[A-Za-z0-9]{43}$/, 'EncodingAESKey 须为 43 位英文或数字'],
};

export class WeComConnector {
  constructor(store, patients, options = {}) {
    this.db = store.db;
    this.patients = patients;
    this.options = options;
    this.vault = options.vault || null;
    this.env = options.env || process.env;
    this.tokens = new Map();
    this.configure();
    this.syncing = new Set();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wecom_contacts (corp TEXT NOT NULL, member TEXT NOT NULL, external TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(corp,member,external));
      CREATE TABLE IF NOT EXISTS wecom_bindings (id TEXT PRIMARY KEY, corp TEXT NOT NULL, member TEXT NOT NULL, external TEXT NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, relationship TEXT NOT NULL, verified_at TEXT NOT NULL, UNIQUE(corp,member,external,patient_id));
      CREATE TABLE IF NOT EXISTS wecom_tasks (id TEXT PRIMARY KEY, corp TEXT NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wecom_events (id TEXT PRIMARY KEY, corp TEXT NOT NULL, received TEXT NOT NULL, data TEXT NOT NULL);
    `);
    // A process exit between request and response must never cause automatic resend.
    for (const row of this.db.prepare("SELECT data FROM wecom_tasks WHERE corp=? AND json_extract(data,'$.status')='submitting'").all(this.corpId)) {
      const task = JSON.parse(row.data); task.status = 'unknown'; this.saveTask(task);
    }
  }
  // Each value comes from the settings page (encrypted vault) first, then the
  // legacy desktop config file / environment. Explicit options win (tests).
  source(key) {
    if (this.options[key] !== undefined) return { value: this.options[key], from: 'options' };
    const saved = this.vault?.get(VAULT_KEY) || {};
    if (saved[key]) return { value: saved[key], from: 'settings' };
    return this.env[ENV[key]] ? { value: this.env[ENV[key]], from: 'env' } : { value: '', from: 'none' };
  }
  configure() {
    this.corpId = this.source('corpId').value;
    const corpSecret = this.source('corpSecret').value;
    this.callbackToken = this.source('callbackToken').value;
    this.aesKey = this.source('aesKey').value;
    this.corpSecret = corpSecret;
    this.tokens.clear();
    this.client = this.corpId && corpSecret ? new ExternalContact({ corpId: this.corpId, corpSecret,
      retryTimes: 0, timeout: 15000, tokenStore: this.tokens, ...(this.options.fetch ? { fetch: this.options.fetch } : {}) }) : null;
  }
  // Secrets are write-only: blank keeps the stored value, null removes it.
  saveConfig(input = {}) {
    check(this.vault, 'WECOM_UNCONFIGURED', '本机凭据库不可用', 503);
    const saved = { ...(this.vault.get(VAULT_KEY) || {}) };
    for (const key of Object.keys(FORMATS)) {
      if (input[key] === null) delete saved[key];
      else if (typeof input[key] === 'string' && input[key].trim()) {
        check(FORMATS[key][0].test(input[key].trim()), 'INVALID_INPUT', FORMATS[key][1]);
        saved[key] = input[key].trim();
      }
    }
    this.vault.set(VAULT_KEY, saved);
    this.configure();
    return this.publicConfig();
  }
  publicConfig() {
    const from = Object.fromEntries(Object.keys(FORMATS).map(key => [key, this.source(key).from]));
    return { corpId: this.corpId, hasContactSecret: Boolean(this.corpSecret), hasCallbackToken: Boolean(this.callbackToken), hasAesKey: Boolean(this.aesKey),
      callbackConfigured: this.status().callbackConfigured, from };
  }
  status() {
    return { configured: Boolean(this.client), corpId: this.corpId,
      callbackConfigured: Boolean(this.corpId && this.callbackToken && /^[A-Za-z0-9+/]{43}$/.test(this.aesKey)),
      callbackPath: '/api/wecom/callback', sdk: 'witjs/wecom 1.0.0-rc.2',
      capabilities: { contacts: true, followupTasks: true, chatArchive: false, automaticSend: false },
      lastEventAt: this.db.prepare('SELECT MAX(received) AS time FROM wecom_events WHERE corp=?').get(this.corpId)?.time || null };
  }
  apiFailure(error) {
    // SDK retryTimes=0 prevents ambiguous POST retries, but also skips its token
    // invalidation branch. Clear revoked tokens for the next explicit request.
    if (error instanceof WecomApiError && [40014, 42001].includes(error.errcode)) this.tokens.clear();
    return failure(error);
  }
  ready() { check(this.client, 'WECOM_UNCONFIGURED', '尚未配置企业微信，请先配置企业 ID 与客户联系 Secret。', 503); }
  contacts() { return this.db.prepare('SELECT member,external,name,active,updated FROM wecom_contacts WHERE corp=? ORDER BY name,member').all(this.corpId); }
  bindings(patientId) {
    this.patients.row(identifier(patientId));
    return this.db.prepare(`SELECT b.*, c.name, c.active FROM wecom_bindings b LEFT JOIN wecom_contacts c ON c.corp=b.corp AND c.member=b.member AND c.external=b.external WHERE b.corp=? AND b.patient_id=?`).all(this.corpId, patientId);
  }
  async sync(input) {
    this.ready();
    const member = field(input.member, '成员 UserID');
    check(!this.syncing.has(member), 'CONFLICT', '该成员正在同步，请稍候', 409);
    this.syncing.add(member);
    try {
      const records = new Map(), cursors = new Set(); let cursor = '';
      do {
        check(!cursors.has(cursor) && cursors.size < 1000, 'WECOM_PAGINATION', '客户分页异常，本次结果未保存');
        cursors.add(cursor);
        const page = await this.client.batchGetByUser({ userid_list: [member], cursor, limit: 100 });
        check(Array.isArray(page.external_contact_list), 'WECOM_RESPONSE', '客户列表返回格式异常');
        for (const item of page.external_contact_list) {
          if (item.follow_info?.userid !== member) continue;
          const c = item.external_contact;
          records.set(field(c.external_userid, '客户 ID'), field(c.name || c.external_userid, '客户昵称'));
        }
        cursor = page.next_cursor || '';
      } while (cursor);
      sqliteTransaction(this.db, () => {
        this.db.prepare('UPDATE wecom_contacts SET active=0 WHERE corp=? AND member=?').run(this.corpId, member);
        const put = this.db.prepare('INSERT INTO wecom_contacts VALUES (?,?,?,?,1,?) ON CONFLICT(corp,member,external) DO UPDATE SET name=excluded.name,active=1,updated=excluded.updated');
        for (const [external, name] of records) put.run(this.corpId, member, external, name, now());
      });
      return { count: records.size, contacts: this.contacts() };
    } catch (error) { throw error instanceof AppError ? error : new AppError('WECOM_API', this.apiFailure(error), 502); }
    finally { this.syncing.delete(member); }
  }
  bind(input) {
    this.ready(); this.patients.row(identifier(input.patientId));
    check(input.confirmed === true, 'WECOM_CONFIRM', '请先核实客户与患者的关系');
    check(['self', 'family'].includes(input.relationship), 'INVALID_INPUT', '请选择患者本人或家属');
    const member = field(input.member, '成员 UserID'), external = field(input.external, '客户 ID');
    check(this.db.prepare('SELECT 1 FROM wecom_contacts WHERE corp=? AND member=? AND external=? AND active=1').get(this.corpId, member, external), 'WECOM_CONTACT', '请先同步有效客户');
    const old = this.db.prepare('SELECT * FROM wecom_bindings WHERE corp=? AND member=? AND external=? AND patient_id=?').get(this.corpId, member, external, input.patientId);
    if (old) { check(old.relationship === input.relationship, 'CONFLICT', '该客户已有不同关系，请先解除旧关联', 409); return old; }
    const id = randomUUID();
    this.db.prepare('INSERT INTO wecom_bindings VALUES (?,?,?,?,?,?,?)').run(id, this.corpId, member, external, input.patientId, input.relationship, now());
    return this.bindings(input.patientId).find(b => b.id === id);
  }
  unbind(id) { this.db.prepare('DELETE FROM wecom_bindings WHERE id=? AND corp=?').run(identifier(id), this.corpId); return { removed: true }; }
  tasks(patientId) { this.patients.row(identifier(patientId)); return this.db.prepare('SELECT data FROM wecom_tasks WHERE corp=? AND patient_id=? ORDER BY rowid DESC').all(this.corpId, patientId).map(r => JSON.parse(r.data)); }
  task(id) {
    const row = this.db.prepare('SELECT data FROM wecom_tasks WHERE id=? AND corp=?').get(identifier(id), this.corpId);
    check(row, 'NOT_FOUND', '未找到企业微信任务', 404); return JSON.parse(row.data);
  }
  saveTask(task) { task.updatedAt = now(); this.db.prepare('INSERT INTO wecom_tasks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.id, this.corpId, task.patientId, JSON.stringify(task)); return task; }
  draft(input) {
    this.ready(); const patientId = identifier(input.patientId);
    const binding = this.bindings(patientId).find(b => b.id === input.bindingId && b.active);
    check(binding, 'WECOM_BINDING', '请选择已核实且有效的患者或家属关联');
    const text = field(input.text, '随访内容', 2000);
    check(Buffer.byteLength(text) <= 4000, 'INVALID_INPUT', '随访内容超过 4000 字节');
    // Browser retries use the same request ID; conflicting reuse is rejected.
    const id = identifier(input.requestId);
    const previous = this.db.prepare('SELECT data FROM wecom_tasks WHERE id=?').get(id);
    if (previous) {
      const task = JSON.parse(previous.data);
      check(task.corpId === this.corpId && task.patientId === patientId && task.bindingId === binding.id && task.text === text, 'CONFLICT', '该请求已保存其他草稿', 409);
      return task;
    }
    return this.saveTask({ id, corpId: this.corpId, patientId, bindingId: binding.id, member: binding.member, external: binding.external, recipient: binding.name, relationship: binding.relationship, text, status: 'draft', createdAt: now() });
  }
  async submit(id, input) {
    this.ready(); check(input.confirmed === true, 'WECOM_CONFIRM', '请核对收件人与内容后确认提交');
    const task = this.task(id);
    if (['awaiting_member', 'sent'].includes(task.status)) return task;
    check(task.status === 'draft', 'WECOM_TASK_STATE', '该任务已经提交，不能重复发送；结果不明时请先在企业微信核实', 409);
    check(this.bindings(task.patientId).some(b => b.id === task.bindingId && b.active), 'WECOM_BINDING', '客户关联已失效，请重新核对');
    task.status = 'submitting'; this.saveTask(task);
    try {
      const result = await this.client.addMsgTemplate({ chat_type: 'single', external_userid: [task.external], sender: task.member, allow_select: false, text: { content: task.text } });
      task.msgid = result.msgid || '';
      task.status = result.fail_list?.includes(task.external) ? 'rejected' : result.msgid ? 'awaiting_member' : 'unknown';
      task.detail = task.status === 'rejected' ? '企业微信未接受此客户，请核实客户关系或发送限制。' : task.status === 'unknown' ? '响应缺少任务编号，请到企业微信核实，勿重复提交。' : '已创建企业微信任务，等待成员确认发送。';
    } catch (error) {
      task.status = error instanceof WecomApiError ? 'rejected' : 'unknown';
      task.detail = this.apiFailure(error) + (task.status === 'unknown' ? ' 结果待核实，请勿重复提交。' : '');
    }
    return this.saveTask(task);
  }
  async refresh(id) {
    this.ready(); const task = this.task(id);
    check(task.msgid, 'WECOM_TASK_STATE', '没有企业微信任务编号，请在企业微信后台核实');
    try {
      let cursor = ''; const seen = new Set(); let match;
      do {
        check(!seen.has(cursor) && seen.size < 100, 'WECOM_PAGINATION', '发送结果分页异常'); seen.add(cursor);
        const result = await this.client.request({ url: '/externalcontact/get_groupmsg_send_result', method: 'POST', data: { msgid: task.msgid, userid: task.member, limit: 100, cursor } });
        match = result.send_list?.find(r => r.external_userid === task.external);
        cursor = result.next_cursor || '';
      } while (!match && cursor);
      if (match) {
        task.deliveryStatus = Number(match.status);
        task.status = Number(match.status) === 1 ? 'sent' : Number(match.status) === 0 ? 'awaiting_member' : 'delivery_failed';
        task.detail = task.status === 'sent' ? '企业微信报告已发送（不代表已读）。' : task.status === 'awaiting_member' ? '仍待成员发送。' : `企业微信发送未完成，状态码 ${match.status}。`;
        return this.saveTask(task);
      }
      return task;
    } catch (error) { throw error instanceof AppError ? error : new AppError('WECOM_API', this.apiFailure(error), 502); }
  }
  decode(query, cipher) {
    check(this.status().callbackConfigured, 'WECOM_UNCONFIGURED', '企业微信回调未配置', 503);
    const timestamp = query.get('timestamp'), nonce = query.get('nonce'), signature = query.get('msg_signature') || '';
    check(/^\d{1,12}$/.test(timestamp || '') && Math.abs(Date.now() / 1000 - Number(timestamp)) < 600 && nonce && nonce.length <= 200, 'WECOM_SIGNATURE', '回调时间戳或随机串无效', 401);
    check(typeof cipher === 'string' && /^[A-Za-z0-9+/=]+$/.test(cipher), 'WECOM_SIGNATURE', '回调密文无效', 401);
    const expected = getSignature(this.callbackToken, timestamp, nonce, cipher);
    check(/^[a-f0-9]{40}$/.test(signature) && timingSafeEqual(Buffer.from(signature), Buffer.from(expected)), 'WECOM_SIGNATURE', '回调签名无效', 401);
    try { const data = decrypt(this.aesKey, cipher); check(data.id === this.corpId, 'WECOM_CORP', '回调企业不匹配', 401); return data.message; }
    catch (error) { throw error instanceof AppError ? error : new AppError('WECOM_DECRYPT', '回调解密失败', 401); }
  }
  callback(query, raw) {
    if (raw === undefined) return this.decode(query, query.get('echostr'));
    const event = xml(this.decode(query, xml(raw).Encrypt));
    check(event.ToUserName === this.corpId, 'WECOM_CORP', '事件企业不匹配', 401);
    // 微信客服 callbacks only carry a sync token; the care engine pulls the
    // messages. Failures must not make WeCom retry the callback.
    if (event.Event === 'kf_msg_or_event') { try { this.onEvent?.(event); } catch { /* recorded by the handler */ } return 'success'; }
    // Customer-change notifications are not chat messages or clinical facts.
    if (event.Event !== 'change_external_contact') return 'success';
    const data = { event: event.Event, change: field(event.ChangeType, '变更类型'), external: field(event.ExternalUserID, '客户 ID'), member: field(event.UserID, '成员 ID'), time: field(event.CreateTime, '事件时间') };
    const id = createHash('sha256').update(this.corpId + JSON.stringify(data)).digest('hex');
    sqliteTransaction(this.db, () => {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO wecom_events VALUES (?,?,?,?)').run(id, this.corpId, now(), JSON.stringify(data));
      if (inserted.changes && ['del_external_contact', 'del_follow_user'].includes(data.change)) {
        this.db.prepare('UPDATE wecom_contacts SET active=0 WHERE corp=? AND member=? AND external=?').run(this.corpId, data.member, data.external);
      }
      // A new customer appears right away; the next contact sync fills in the name.
      if (inserted.changes && ['add_external_contact', 'add_half_external_contact', 'edit_external_contact'].includes(data.change)) {
        this.db.prepare('INSERT INTO wecom_contacts VALUES (?,?,?,?,1,?) ON CONFLICT(corp,member,external) DO UPDATE SET active=1,updated=excluded.updated').run(this.corpId, data.member, data.external, data.external, now());
      }
    });
    return 'success';
  }
}
