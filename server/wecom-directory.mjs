import { AppError, check, identifier, string } from './errors.mjs';
import { sqliteTransaction } from './sqlite-transaction.mjs';

// Customer and group directory of the WeCom members that use 客户联系.
// Everything is pulled on a schedule so the doctor never types UserIDs;
// matching only suggests patients, binding always needs a confirmation.
export const DIRECTORY_SYNC_MS = 6 * 3600000;
const FAMILY = /家属|家人|妈|母亲|爸|父亲|女儿|儿子|爱人|老伴|丈夫|妻子|老公|老婆|孙|外婆|奶奶|爷爷|外公|姥/;
const digits = value => String(value || '').replace(/\D/g, '');
const iso = ms => new Date(ms).toISOString();
const seconds = value => Number(value) > 0 ? iso(Number(value) * 1000) : null;

export class WecomDirectory {
  constructor(connector, { now = Date.now } = {}) {
    this.c = connector;
    this.db = connector.db;
    this.now = now;
    this.running = null;
    const columns = this.db.prepare('PRAGMA table_info(wecom_contacts)').all().map(c => c.name);
    if (!columns.includes('data')) this.db.exec("ALTER TABLE wecom_contacts ADD COLUMN data TEXT NOT NULL DEFAULT '{}'");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wecom_groups (corp TEXT NOT NULL, chat_id TEXT NOT NULL, name TEXT NOT NULL, owner TEXT NOT NULL, active INTEGER NOT NULL, updated TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(corp,chat_id));
      CREATE TABLE IF NOT EXISTS wecom_group_tasks (id TEXT PRIMARY KEY, corp TEXT NOT NULL, chat_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wecom_directory_state (corp TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    for (const row of this.db.prepare("SELECT data FROM wecom_group_tasks WHERE corp=? AND json_extract(data,'$.status')='submitting'").all(this.c.corpId)) {
      const task = JSON.parse(row.data); task.status = 'unknown'; task.detail = '提交过程中服务中断，结果未知；请在企业微信核实，勿重复提交。'; this.saveTask(task);
    }
  }
  get corpId() { return this.c.corpId; }

  // ---------- state ----------
  state() {
    const row = this.db.prepare('SELECT data FROM wecom_directory_state WHERE corp=?').get(this.corpId);
    return { members: [], lastSyncAt: null, lastError: null, groupsError: null, ...(row ? JSON.parse(row.data) : {}) };
  }
  setState(changes) {
    const data = JSON.stringify({ ...this.state(), ...changes });
    this.db.prepare('INSERT INTO wecom_directory_state VALUES (?,?) ON CONFLICT(corp) DO UPDATE SET data=excluded.data').run(this.corpId, data);
  }
  due() {
    if (!this.c.client || this.running) return false;
    const { lastSyncAt, lastAttemptAt } = this.state();
    const last = Math.max(Date.parse(lastSyncAt || '') || 0, Date.parse(lastAttemptAt || '') || 0);
    return this.now() - last >= DIRECTORY_SYNC_MS;
  }
  status() {
    const one = (sql, ...args) => this.db.prepare(sql).get(...args)?.n || 0;
    const s = this.state();
    return {
      configured: Boolean(this.c.client), syncing: Boolean(this.running), members: s.members, lastSyncAt: s.lastSyncAt, lastError: s.lastError, groupsError: s.groupsError,
      contacts: one('SELECT COUNT(*) n FROM wecom_contacts WHERE corp=? AND active=1', this.corpId),
      bound: one('SELECT COUNT(DISTINCT c.member||char(1)||c.external) n FROM wecom_contacts c JOIN wecom_bindings b ON b.corp=c.corp AND b.member=c.member AND b.external=c.external WHERE c.corp=? AND c.active=1', this.corpId),
      groups: one('SELECT COUNT(*) n FROM wecom_groups WHERE corp=? AND active=1', this.corpId),
    };
  }

  // ---------- sync ----------
  sync() {
    this.c.ready();
    if (!this.running) this.running = this.pull().finally(() => { this.running = null; });
    return this.running;
  }
  async pull() {
    const client = this.c.client;
    this.setState({ lastAttemptAt: iso(this.now()) });
    try {
      const members = (await client.getFollowUserList()).follow_user || [];
      check(Array.isArray(members), 'WECOM_RESPONSE', '成员列表返回格式异常');
      let tags = new Map();
      try {
        const body = await client.getCorpTagList();
        tags = new Map((body.tag_group || []).flatMap(g => (g.tag || []).map(t => [t.id, t.name])));
      } catch { /* tag names are optional */ }
      const records = [];
      for (let i = 0; i < members.length; i += 100) {
        const cursors = new Set(); let cursor = '';
        do {
          check(!cursors.has(cursor) && cursors.size < 1000, 'WECOM_PAGINATION', '客户分页异常，本次结果未保存');
          cursors.add(cursor);
          const page = await client.batchGetByUser({ userid_list: members.slice(i, i + 100), cursor, limit: 100 });
          check(Array.isArray(page.external_contact_list), 'WECOM_RESPONSE', '客户列表返回格式异常');
          for (const item of page.external_contact_list) records.push(contactRecord(item, tags));
          cursor = page.next_cursor || '';
        } while (cursor);
      }
      sqliteTransaction(this.db, () => {
        const off = this.db.prepare('UPDATE wecom_contacts SET active=0 WHERE corp=? AND member=?');
        for (const member of members) off.run(this.corpId, member);
        const put = this.db.prepare('INSERT INTO wecom_contacts(corp,member,external,name,active,updated,data) VALUES (?,?,?,?,1,?,?) ON CONFLICT(corp,member,external) DO UPDATE SET name=excluded.name,active=1,updated=excluded.updated,data=excluded.data');
        for (const r of records) if (members.includes(r.member)) put.run(this.corpId, r.member, r.external, r.name, iso(this.now()), JSON.stringify(r.data));
      });
      let groupsError = null;
      try { await this.pullGroups(members); }
      catch (error) { groupsError = error instanceof AppError ? error.message : this.c.apiFailure(error); }
      this.setState({ members, lastSyncAt: iso(this.now()), lastError: null, groupsError });
      return this.status();
    } catch (error) {
      const message = error instanceof AppError ? error.message : this.c.apiFailure(error);
      this.setState({ lastError: message });
      throw error instanceof AppError ? error : new AppError('WECOM_API', message, 502);
    }
  }
  async pullGroups(members) {
    const client = this.c.client, ids = [];
    if (!members.length) return;
    const cursors = new Set(); let cursor = '';
    do {
      check(!cursors.has(cursor) && cursors.size < 1000, 'WECOM_PAGINATION', '客户群分页异常');
      cursors.add(cursor);
      const page = await client.groupChatList({ status_filter: 0, owner_filter: { userid_list: members }, cursor, limit: 1000 });
      check(Array.isArray(page.group_chat_list), 'WECOM_RESPONSE', '客户群列表返回格式异常');
      ids.push(...page.group_chat_list.map(g => g.chat_id));
      cursor = page.next_cursor || '';
    } while (cursor);
    const groups = [];
    for (const chatId of ids) {
      const g = (await client.groupChatGet({ chat_id: chatId, need_name: 1 })).group_chat || {};
      groups.push({
        chatId, name: String(g.name || '').slice(0, 200), owner: String(g.owner || ''),
        data: {
          notice: String(g.notice || '').slice(0, 1000), createdAt: seconds(g.create_time), admins: (g.admin_list || []).map(a => a.userid),
          members: (g.member_list || []).map(m => ({ id: String(m.userid), external: Number(m.type) === 2, name: String(m.group_nickname || m.name || '').slice(0, 100), joinedAt: seconds(m.join_time) })),
        },
      });
    }
    sqliteTransaction(this.db, () => {
      const off = this.db.prepare('UPDATE wecom_groups SET active=0 WHERE corp=? AND owner=?');
      for (const member of members) off.run(this.corpId, member);
      const put = this.db.prepare('INSERT INTO wecom_groups VALUES (?,?,?,?,1,?,?) ON CONFLICT(corp,chat_id) DO UPDATE SET name=excluded.name,owner=excluded.owner,active=1,updated=excluded.updated,data=excluded.data');
      for (const g of groups) put.run(this.corpId, g.chatId, g.name, g.owner, iso(this.now()), JSON.stringify(g.data));
    });
  }

  // ---------- reading ----------
  contactRows(where = '', ...args) {
    return this.db.prepare(`SELECT member,external,name,active,updated,data FROM wecom_contacts WHERE corp=? ${where} ORDER BY name,member`).all(this.corpId, ...args).map(contactView);
  }
  bindingsByContact() {
    const map = new Map();
    for (const b of this.db.prepare('SELECT b.id,b.member,b.external,b.patient_id,b.relationship,b.verified_at,p.data FROM wecom_bindings b JOIN patients p ON p.id=b.patient_id WHERE b.corp=?').all(this.corpId)) {
      const key = `${b.member}\u0001${b.external}`, p = JSON.parse(b.data);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ id: b.id, patientId: b.patient_id, patientName: p.name, patientNumber: p.patientNumber || '', relationship: b.relationship, verifiedAt: b.verified_at });
    }
    return map;
  }
  kfOwners() {
    try {
      return new Map(this.db.prepare("SELECT patient_id, json_extract(data,'$.kfExternalUserId') k FROM care_patient_settings WHERE json_extract(data,'$.kfExternalUserId') IS NOT NULL").all().map(r => [r.k, r.patient_id]));
    } catch { return new Map(); }
  }
  // Candidate patients for one customer, strongest evidence first.
  candidates(contact, patients, kfOwners) {
    const remark = `${contact.remark || ''} ${contact.description || ''}`;
    const scored = [];
    for (const p of patients) {
      const reasons = []; let score = 0;
      const add = (points, reason) => { score += points; reasons.push(reason); };
      if (kfOwners.get(contact.external) === p.id) add(5, '同一微信用户已在微信客服中关联到该患者');
      const phone = digits(p.phone);
      if (phone.length >= 7 && (contact.mobiles || []).some(m => digits(m) === phone || digits(m).endsWith(phone.slice(-8)) && phone.length >= 8)) add(4, '备注手机号与档案电话一致');
      if (p.patientNumber && p.patientNumber.length >= 3 && remark.includes(p.patientNumber)) add(4, '备注中含患者编号');
      if (p.name && p.name.length >= 2 && remark.includes(p.name)) add(2, '备注含患者姓名');
      else if (p.name && contact.name === p.name) add(1, '微信昵称与患者姓名相同');
      if (score) scored.push({ patientId: p.id, patientName: p.name, patientNumber: p.patientNumber || '', score, reasons });
    }
    scored.sort((a, b) => b.score - a.score || a.patientName.localeCompare(b.patientName));
    const top = scored.slice(0, 3);
    const relationship = FAMILY.test(remark) ? 'family' : 'self';
    // Two patients with the same best score are never presented as "the" match.
    const confident = top.length > 0 && top[0].score >= 2 && (top.length === 1 || top[1].score < top[0].score);
    return { candidates: top, relationship, confident };
  }
  // Customers with link state: bound / suggested / unmatched.
  contacts({ status, query, limit = 500 } = {}) {
    const patients = this.c.patients.all().filter(p => !p.archived);
    const bindings = this.bindingsByContact(), kf = this.kfOwners();
    const groups = this.groupsByExternal();
    const q = String(query || '').trim();
    const list = [];
    for (const contact of this.contactRows('AND active=1')) {
      const bound = bindings.get(`${contact.member}\u0001${contact.external}`) || [];
      const match = bound.length ? { candidates: [], relationship: null, confident: false } : this.candidates(contact, patients, kf);
      const state = bound.length ? 'bound' : match.candidates.length ? 'suggested' : 'unmatched';
      if (status && !String(status).split(',').includes(state)) continue;
      if (q && ![contact.name, contact.remark, contact.description, ...(contact.mobiles || []), ...(contact.tags || []), ...bound.map(b => b.patientName)].some(v => String(v || '').includes(q))) continue;
      list.push({ ...contact, state, bindings: bound, suggestion: match, groups: groups.get(contact.external) || [] });
    }
    const rank = { suggested: 0, unmatched: 1, bound: 2 };
    list.sort((a, b) => rank[a.state] - rank[b.state] || (b.suggestion.candidates[0]?.score || 0) - (a.suggestion.candidates[0]?.score || 0) || (b.addedAt || '').localeCompare(a.addedAt || ''));
    return { contacts: list.slice(0, Math.min(Number(limit) || 500, 2000)), counts: { bound: list.filter(c => c.state === 'bound').length, suggested: list.filter(c => c.state === 'suggested').length, unmatched: list.filter(c => c.state === 'unmatched').length }, status: this.status() };
  }
  groupRows(where = '', ...args) {
    return this.db.prepare(`SELECT chat_id,name,owner,active,updated,data FROM wecom_groups WHERE corp=? ${where} ORDER BY name`).all(this.corpId, ...args)
      .map(r => ({ chatId: r.chat_id, name: r.name || '未命名客户群', owner: r.owner, active: Boolean(r.active), updated: r.updated, ...JSON.parse(r.data) }));
  }
  groupsByExternal() {
    const map = new Map();
    for (const g of this.groupRows('AND active=1')) for (const m of g.members) if (m.external) {
      if (!map.has(m.id)) map.set(m.id, []);
      map.get(m.id).push({ chatId: g.chatId, name: g.name });
    }
    return map;
  }
  patientsByExternal() {
    const map = new Map();
    for (const list of this.bindingsByContact().values()) for (const b of list) {
      const row = this.db.prepare('SELECT external FROM wecom_bindings WHERE id=?').get(b.id);
      if (!map.has(row.external)) map.set(row.external, []);
      if (!map.get(row.external).some(x => x.patientId === b.patientId)) map.get(row.external).push({ patientId: b.patientId, patientName: b.patientName, relationship: b.relationship });
    }
    return map;
  }
  groups({ query } = {}) {
    const patients = this.patientsByExternal(), q = String(query || '').trim();
    return {
      groups: this.groupRows('AND active=1').filter(g => !q || g.name.includes(q) || g.notice.includes(q)).map(g => {
        const externals = g.members.filter(m => m.external);
        const linked = externals.flatMap(m => (patients.get(m.id) || []).map(p => ({ ...p, member: m.name })));
        return { chatId: g.chatId, name: g.name, owner: g.owner, notice: g.notice, createdAt: g.createdAt, updated: g.updated, memberCount: g.members.length, customerCount: externals.length, patients: linked, unlinkedCustomers: externals.length - new Set(linked.map(p => p.patientId)).size };
      }),
      status: this.status(),
    };
  }
  group(chatId) {
    const g = this.groupRows('AND chat_id=?', string(chatId, '客户群 ID', 200))[0];
    check(g, 'NOT_FOUND', '未找到客户群，请先同步', 404);
    const patients = this.patientsByExternal();
    return { ...g, members: g.members.map(m => ({ ...m, patients: m.external ? patients.get(m.id) || [] : [] })), tasks: this.tasks(g.chatId) };
  }
  // Everything WeCom knows about one patient, plus customers that look like them.
  patient(patientId) {
    const patient = this.c.patients.row(identifier(patientId));
    const bindings = this.c.bindings(patient.id);
    const contacts = new Map(this.contactRows().map(c => [`${c.member}\u0001${c.external}`, c]));
    const groups = this.groupsByExternal();
    const linked = bindings.map(b => {
      const c = contacts.get(`${b.member}\u0001${b.external}`) || {};
      return { bindingId: b.id, member: b.member, external: b.external, relationship: b.relationship, verifiedAt: b.verified_at, active: Boolean(b.active), name: c.name || b.name || b.external, remark: c.remark || '', description: c.description || '', mobiles: c.mobiles || [], tags: c.tags || [], addedAt: c.addedAt || null, groups: groups.get(b.external) || [] };
    });
    const kf = this.kfOwners(), suggestions = [];
    const boundKeys = new Set(this.db.prepare('SELECT member||char(1)||external k FROM wecom_bindings WHERE corp=?').all(this.corpId).map(r => r.k));
    for (const c of this.contactRows('AND active=1')) {
      if (boundKeys.has(`${c.member}\u0001${c.external}`)) continue;
      const match = this.candidates(c, [patient], kf);
      if (match.candidates.length) suggestions.push({ ...c, reasons: match.candidates[0].reasons, score: match.candidates[0].score, relationship: match.relationship });
    }
    suggestions.sort((a, b) => b.score - a.score);
    return { configured: Boolean(this.c.client), status: this.status(), linked, suggestions: suggestions.slice(0, 5) };
  }

  // ---------- remark write-back ----------
  remarkFor(patient) { return `${patient.name}${patient.patientNumber ? `·${patient.patientNumber}` : ''}`.slice(0, 20); }
  // Only the member sees the remark; a failure never undoes the binding.
  async writeRemark(bindingId) {
    this.c.ready();
    const b = this.db.prepare('SELECT * FROM wecom_bindings WHERE id=? AND corp=?').get(identifier(bindingId), this.corpId);
    check(b, 'NOT_FOUND', '未找到客户关联', 404);
    const patient = this.c.patients.row(b.patient_id);
    const row = this.db.prepare('SELECT data FROM wecom_contacts WHERE corp=? AND member=? AND external=?').get(this.corpId, b.member, b.external);
    const data = row ? JSON.parse(row.data || '{}') : {};
    if (b.relationship === 'family' || (data.remark || '').includes(patient.name)) return { ok: true, skipped: true, remark: data.remark || '' };
    const remark = this.remarkFor(patient);
    try {
      await this.c.client.remark({ userid: b.member, external_userid: b.external, remark });
      if (row) this.db.prepare('UPDATE wecom_contacts SET data=? WHERE corp=? AND member=? AND external=?').run(JSON.stringify({ ...data, remark }), this.corpId, b.member, b.external);
      return { ok: true, remark };
    } catch (error) { return { ok: false, detail: this.c.apiFailure(error) }; }
  }

  // ---------- group broadcast (the owner confirms in WeCom) ----------
  saveTask(task) {
    task.updatedAt = iso(this.now());
    this.db.prepare('INSERT INTO wecom_group_tasks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.id, this.corpId, task.chatId, JSON.stringify(task));
    return task;
  }
  task(id) {
    const row = this.db.prepare('SELECT data FROM wecom_group_tasks WHERE id=? AND corp=?').get(identifier(id), this.corpId);
    check(row, 'NOT_FOUND', '未找到群发任务', 404);
    return JSON.parse(row.data);
  }
  tasks(chatId) {
    const sql = chatId ? "SELECT data FROM wecom_group_tasks WHERE corp=? AND chat_id=? ORDER BY rowid DESC LIMIT 50" : "SELECT data FROM wecom_group_tasks WHERE corp=? ORDER BY rowid DESC LIMIT 50";
    return this.db.prepare(sql).all(...[this.corpId, chatId].filter(Boolean)).map(r => JSON.parse(r.data));
  }
  normalizeGroupMessage(input) {
    this.c.ready();
    const g = this.groupRows('AND chat_id=? AND active=1', string(input.chatId, '客户群 ID', 200))[0];
    check(g, 'WECOM_GROUP', '客户群不存在或已解散，请先同步', 404);
    const text = string(input.text, '群发内容', 2000);
    check(Buffer.byteLength(text) <= 4000, 'INVALID_INPUT', '群发内容超过 4000 字节');
    return { chatId: g.chatId, groupName: g.name, owner: g.owner, text };
  }
  groupDraft(input) {
    const value = this.normalizeGroupMessage(input);
    const id = identifier(input.requestId);
    const previous = this.db.prepare('SELECT data FROM wecom_group_tasks WHERE id=?').get(id);
    if (previous) {
      const task = JSON.parse(previous.data);
      check(task.chatId === value.chatId && task.text === value.text, 'CONFLICT', '该请求已保存其他群发内容', 409);
      return task;
    }
    return this.saveTask({ id, ...value, status: 'draft', createdAt: iso(this.now()) });
  }
  async groupSubmit(id, input = {}) {
    this.c.ready(); check(input.confirmed === true, 'WECOM_CONFIRM', '请核对客户群与内容后确认提交');
    const task = this.task(id);
    if (['awaiting_member', 'sent'].includes(task.status)) return task;
    check(task.status === 'draft', 'WECOM_TASK_STATE', '该任务已经提交，不能重复发送；结果不明时请先在企业微信核实', 409);
    task.status = 'submitting'; this.saveTask(task);
    try {
      const result = await this.c.client.addMsgTemplate({ chat_type: 'group', sender: task.owner, chat_id_list: [task.chatId], allow_select: false, text: { content: task.text } });
      task.msgid = result.msgid || '';
      task.status = result.msgid ? 'awaiting_member' : 'unknown';
      task.detail = task.msgid ? `已创建群发任务，等待群主 ${task.owner} 在企业微信确认发送。` : '响应缺少任务编号，请到企业微信核实，勿重复提交。';
    } catch (error) {
      task.status = error?.constructor?.name === 'WecomApiError' || Number.isInteger(error?.errcode) ? 'rejected' : 'unknown';
      task.detail = this.c.apiFailure(error) + (task.status === 'unknown' ? ' 结果待核实，请勿重复提交。' : '');
    }
    return this.saveTask(task);
  }
  async groupRefresh(id) {
    this.c.ready(); const task = this.task(id);
    check(task.msgid, 'WECOM_TASK_STATE', '没有企业微信任务编号，请在企业微信后台核实');
    try {
      let cursor = '', match; const seen = new Set();
      do {
        check(!seen.has(cursor) && seen.size < 100, 'WECOM_PAGINATION', '发送结果分页异常'); seen.add(cursor);
        const result = await this.c.client.request({ url: '/externalcontact/get_groupmsg_send_result', method: 'POST', data: { msgid: task.msgid, userid: task.owner, limit: 100, cursor } });
        match = result.send_list?.find(r => r.chat_id === task.chatId);
        cursor = result.next_cursor || '';
      } while (!match && cursor);
      if (!match) return task;
      task.status = Number(match.status) === 1 ? 'sent' : Number(match.status) === 0 ? 'awaiting_member' : 'delivery_failed';
      task.detail = task.status === 'sent' ? '群主已发送到群里。' : task.status === 'awaiting_member' ? '仍待群主发送。' : `企业微信发送未完成，状态码 ${match.status}。`;
      return this.saveTask(task);
    } catch (error) { throw error instanceof AppError ? error : new AppError('WECOM_API', this.c.apiFailure(error), 502); }
  }
  // Awaiting tasks are re-checked by the care engine for a week.
  async refreshAwaiting() {
    if (!this.c.client) return;
    const cutoff = iso(this.now() - 7 * 86400000);
    for (const t of this.tasks().filter(t => t.status === 'awaiting_member' && t.msgid && t.createdAt >= cutoff && (!t.checkedAt || this.now() - Date.parse(t.checkedAt) >= 600000)).slice(0, 10)) {
      try { await this.groupRefresh(t.id); } catch { /* next round */ }
      const fresh = this.task(t.id); fresh.checkedAt = iso(this.now()); this.saveTask(fresh);
    }
  }
}

function contactRecord(item, tags) {
  const c = item.external_contact || {}, f = item.follow_info || {};
  const external = string(c.external_userid, '客户 ID', 200);
  return {
    member: String(f.userid || ''), external, name: String(c.name || external).slice(0, 200),
    data: {
      type: Number(c.type) === 2 ? 'wecom' : 'wechat', gender: Number(c.gender) === 1 ? 'male' : Number(c.gender) === 2 ? 'female' : null,
      corpName: String(c.corp_name || f.remark_corp_name || '').slice(0, 100), remark: String(f.remark || '').slice(0, 100), description: String(f.description || '').slice(0, 300),
      mobiles: (f.remark_mobiles || []).map(String).slice(0, 5), tags: (f.tag_id || []).map(id => tags.get(id)).filter(Boolean).slice(0, 30), addedAt: seconds(f.createtime),
    },
  };
}
function contactView(row) {
  const data = JSON.parse(row.data || '{}');
  return { member: row.member, external: row.external, name: row.name, active: Boolean(row.active), updated: row.updated, remark: '', description: '', mobiles: [], tags: [], ...data, displayName: data.remark || row.name };
}
