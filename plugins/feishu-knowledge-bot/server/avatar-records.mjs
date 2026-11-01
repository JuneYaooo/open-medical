// Persistent records for the Feishu avatar: conversations, turns, the
// follow-up context window and saved insight reports. All rows live in this
// plugin's knowledge_bot_* tables.
import { check } from "../../../server/errors.mjs";

const DAY = 86400000;
export const CONTEXT_TTL = 30 * 60000;
export const CONTEXT_TURNS = 4;
export const DEFAULT_RETENTION_DAYS = 180;
export const CHAT_ID = /^oc_[a-zA-Z0-9]+$/;

const parse = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

const conversationOut = (row) => row && ({
  chatId: row.chat_id,
  chatType: row.chat_type,
  name: row.name,
  lastAt: row.last_at,
  lastText: row.last_text,
  needsAttention: row.needs_attention === 1,
  attentionKind: row.attention_kind,
  attentionReason: row.attention_reason,
  attentionAt: row.attention_at,
  paused: row.paused === 1,
  patientId: row.patient_id,
  patientName: row.patient_name,
  followUpAt: row.follow_up_at,
  followUpNote: row.follow_up_note,
  ...(row.unanswered !== undefined ? { unanswered: row.unanswered } : {}),
  ...(row.review_count !== undefined ? { reviewCount: row.review_count } : {}),
});

const turnOut = (row) => ({
  id: row.id,
  chatId: row.chat_id,
  messageId: row.message_id,
  senderId: row.sender_id,
  senderName: row.sender_name,
  direction: row.direction,
  text: row.text,
  sources: parse(row.sources, []),
  flags: parse(row.flags, {}),
  status: row.status,
  at: row.at,
});

export class AvatarRecords {
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
  }

  // ---------- conversations ----------
  conversation(appId, chatId) {
    return conversationOut(this.db.prepare("SELECT * FROM knowledge_bot_conversations WHERE app_id=? AND chat_id=?").get(appId, chatId));
  }
  requireConversation(appId, chatId) {
    check(typeof chatId === "string" && CHAT_ID.test(chatId), "INVALID_INPUT", "会话编号无效");
    const found = this.conversation(appId, chatId);
    check(found, "NOT_FOUND", "会话不存在或已删除", 404);
    return found;
  }
  touch(appId, chatId, { chatType, name, text, at }) {
    this.db.prepare(`INSERT INTO knowledge_bot_conversations(app_id,chat_id,chat_type,name,last_at,last_text) VALUES (?,?,?,?,?,?)
      ON CONFLICT(app_id,chat_id) DO UPDATE SET last_at=excluded.last_at,last_text=excluded.last_text,
      name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE knowledge_bot_conversations.name END`)
      .run(appId, chatId, chatType, String(name || "").slice(0, 200), at, String(text || "").slice(0, 200));
  }
  flag(appId, chatId, kind, reason) {
    // A red flag outranks other reasons; never downgrade an open red flag.
    const current = this.conversation(appId, chatId);
    if (!current) return;
    if (current.needsAttention && current.attentionKind === "red-flag" && kind !== "red-flag") {
      if (!current.attentionReason.includes(reason))
        this.db.prepare("UPDATE knowledge_bot_conversations SET attention_reason=? WHERE app_id=? AND chat_id=?")
          .run(`${current.attentionReason}；${reason}`.slice(0, 500), appId, chatId);
      return;
    }
    this.db.prepare("UPDATE knowledge_bot_conversations SET needs_attention=1,attention_kind=?,attention_reason=?,attention_at=? WHERE app_id=? AND chat_id=?")
      .run(kind, String(reason).slice(0, 500), this.now(), appId, chatId);
  }
  markHandled(appId, chatId) {
    this.requireConversation(appId, chatId);
    // A due "稍后联系" is part of the same open item and closes with it.
    this.db.prepare(`UPDATE knowledge_bot_conversations SET needs_attention=0,attention_kind='',attention_reason='',attention_at=NULL,
      follow_up_note=CASE WHEN follow_up_at<=? THEN '' ELSE follow_up_note END, follow_up_at=CASE WHEN follow_up_at<=? THEN NULL ELSE follow_up_at END
      WHERE app_id=? AND chat_id=?`).run(this.now(), this.now(), appId, chatId);
    this.db.prepare("UPDATE knowledge_bot_turns SET flags=json_set(flags,'$.handled',json('true')) WHERE app_id=? AND chat_id=? AND (json_extract(flags,'$.review') IS NOT NULL OR json_extract(flags,'$.redFlags') IS NOT NULL OR json_extract(flags,'$.inbound') IS NOT NULL)").run(appId, chatId);
    return this.conversation(appId, chatId);
  }
  setPaused(appId, chatId, paused) {
    check(typeof paused === "boolean", "INVALID_INPUT", "暂停设置须为布尔值");
    this.requireConversation(appId, chatId);
    this.db.prepare("UPDATE knowledge_bot_conversations SET paused=? WHERE app_id=? AND chat_id=?").run(paused ? 1 : 0, appId, chatId);
    return this.conversation(appId, chatId);
  }
  linkPatient(appId, chatId, { patientId, patientName }) {
    this.requireConversation(appId, chatId);
    check(patientId === null || patientId === "" || (typeof patientId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(patientId)), "INVALID_INPUT", "患者编号无效");
    check(patientName === undefined || (typeof patientName === "string" && patientName.length <= 100), "INVALID_INPUT", "患者姓名过长");
    this.db.prepare("UPDATE knowledge_bot_conversations SET patient_id=?,patient_name=? WHERE app_id=? AND chat_id=?")
      .run(patientId || "", patientId ? patientName || "" : "", appId, chatId);
    return this.conversation(appId, chatId);
  }
  followUp(appId, chatId, { days, note = "" }) {
    this.requireConversation(appId, chatId);
    check(days === null || (Number.isInteger(days) && days >= 0 && days <= 60), "INVALID_INPUT", "稍后联系须在 0–60 天内");
    check(typeof note === "string" && note.length <= 300, "INVALID_INPUT", "备注最多 300 字");
    this.db.prepare("UPDATE knowledge_bot_conversations SET follow_up_at=?,follow_up_note=? WHERE app_id=? AND chat_id=?")
      .run(days === null ? null : this.now() + days * DAY, days === null ? "" : note, appId, chatId);
    return this.conversation(appId, chatId);
  }
  remove(appId, chatId) {
    this.requireConversation(appId, chatId);
    this.db.prepare("DELETE FROM knowledge_bot_turns WHERE app_id=? AND chat_id=?").run(appId, chatId);
    this.db.prepare("DELETE FROM knowledge_bot_contexts WHERE app_id=? AND chat_id=?").run(appId, chatId);
    this.db.prepare("DELETE FROM knowledge_bot_conversations WHERE app_id=? AND chat_id=?").run(appId, chatId);
    return { ok: true };
  }
  list(appId, { q = "", filter = "all", limit = 30, offset = 0 } = {}) {
    check(["all", "attention", "review", "unanswered", "paused"].includes(filter), "INVALID_INPUT", "筛选条件无效");
    check(Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isInteger(offset) && offset >= 0, "INVALID_INPUT", "分页参数无效");
    check(typeof q === "string" && q.length <= 100, "INVALID_INPUT", "搜索词过长");
    const where = ["c.app_id=?"], args = [appId];
    if (q.trim()) {
      const like = `%${q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push("(c.name LIKE ? ESCAPE '\\' OR c.patient_name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM knowledge_bot_turns t WHERE t.app_id=c.app_id AND t.chat_id=c.chat_id AND t.text LIKE ? ESCAPE '\\'))");
      args.push(like, like, like);
    }
    if (filter === "attention") where.push("c.needs_attention=1");
    if (filter === "paused") where.push("c.paused=1");
    if (filter === "review") where.push("c.needs_attention=1 AND c.attention_kind IN ('review','model-review','inbound')");
    if (filter === "unanswered") where.push("EXISTS (SELECT 1 FROM knowledge_bot_turns t WHERE t.app_id=c.app_id AND t.chat_id=c.chat_id AND json_extract(t.flags,'$.noSource')=1)");
    const sql = `FROM knowledge_bot_conversations c WHERE ${where.join(" AND ")}`;
    const total = this.db.prepare(`SELECT COUNT(*) n ${sql}`).get(...args).n;
    const rows = this.db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM knowledge_bot_turns t WHERE t.app_id=c.app_id AND t.chat_id=c.chat_id AND json_extract(t.flags,'$.noSource')=1) AS unanswered,
      (SELECT COUNT(*) FROM knowledge_bot_turns t WHERE t.app_id=c.app_id AND t.chat_id=c.chat_id AND json_extract(t.flags,'$.review') IS NOT NULL AND json_extract(t.flags,'$.handled') IS NULL) AS review_count
      ${sql} ORDER BY c.needs_attention DESC, c.last_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { conversations: rows.map(conversationOut), total, limit, offset, stats: this.stats(appId) };
  }
  stats(appId) {
    const one = (sql) => this.db.prepare(sql).get(appId).n;
    return {
      attention: one("SELECT COUNT(*) n FROM knowledge_bot_conversations WHERE app_id=? AND needs_attention=1"),
      unanswered: one("SELECT COUNT(*) n FROM knowledge_bot_turns WHERE app_id=? AND json_extract(flags,'$.noSource')=1"),
      conversations: one("SELECT COUNT(*) n FROM knowledge_bot_conversations WHERE app_id=?"),
    };
  }
  thread(appId, chatId, { limit = 200 } = {}) {
    const conversation = this.requireConversation(appId, chatId);
    const turns = this.db.prepare("SELECT * FROM (SELECT * FROM knowledge_bot_turns WHERE app_id=? AND chat_id=? ORDER BY at DESC, id DESC LIMIT ?) ORDER BY at, id")
      .all(appId, chatId, limit).map(turnOut);
    return { conversation, turns };
  }

  // ---------- turns ----------
  record(appId, chatId, turn, retentionDays = DEFAULT_RETENTION_DAYS) {
    const at = turn.at ?? this.now();
    const id = Number(this.db.prepare("INSERT INTO knowledge_bot_turns(app_id,chat_id,message_id,sender_id,sender_name,direction,text,sources,flags,status,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(appId, chatId, turn.messageId || "", turn.senderId || "", String(turn.senderName || "").slice(0, 100), turn.direction,
        String(turn.text || "").slice(0, 8000), JSON.stringify(turn.sources || []), JSON.stringify(turn.flags || {}), turn.status || "", at).lastInsertRowid);
    this.prune(retentionDays);
    return id;
  }
  updateTurn(id, patch) {
    const row = this.db.prepare("SELECT * FROM knowledge_bot_turns WHERE id=?").get(id);
    if (!row) return null;
    const flags = { ...parse(row.flags, {}), ...(patch.flags || {}) };
    this.db.prepare("UPDATE knowledge_bot_turns SET status=?,flags=?,text=? WHERE id=?")
      .run(patch.status ?? row.status, JSON.stringify(flags), patch.text ?? row.text, id);
    return turnOut({ ...row, flags: JSON.stringify(flags), status: patch.status ?? row.status });
  }
  turn(id) {
    const row = this.db.prepare("SELECT * FROM knowledge_bot_turns WHERE id=?").get(id);
    return row ? turnOut(row) : null;
  }
  turnsSince(appId, since, chatId = "", limit = 400) {
    const rows = chatId
      ? this.db.prepare("SELECT * FROM knowledge_bot_turns WHERE app_id=? AND chat_id=? AND at>=? ORDER BY at DESC, id DESC LIMIT ?").all(appId, chatId, since, limit)
      : this.db.prepare("SELECT * FROM knowledge_bot_turns WHERE app_id=? AND at>=? ORDER BY at DESC, id DESC LIMIT ?").all(appId, since, limit);
    return rows.reverse().map(turnOut);
  }
  // Recent replies the doctor typed in this chat; the avatar uses them as the
  // doctor's own wording for later answers.
  doctorReplies(appId, chatId, limit = 3) {
    return this.db.prepare("SELECT text FROM knowledge_bot_turns WHERE app_id=? AND chat_id=? AND direction='out' AND json_extract(flags,'$.by')='doctor' AND status='sent' ORDER BY at DESC, id DESC LIMIT ?")
      .all(appId, chatId, limit).map((row) => row.text.slice(0, 500)).reverse();
  }
  lastInbound(appId, chatId) {
    const row = this.db.prepare("SELECT * FROM knowledge_bot_turns WHERE app_id=? AND chat_id=? AND direction='in' ORDER BY at DESC, id DESC LIMIT 1").get(appId, chatId);
    return row ? turnOut(row) : null;
  }
  // Deterministic tracking of questions the avatar could not answer.
  unanswered(appId, since, chatId = "") {
    const out = this.turnsSince(appId, since, chatId, 2000);
    const byChat = new Map();
    const result = [];
    for (const turn of out) {
      if (turn.direction === "in") { byChat.set(turn.chatId, turn); continue; }
      if (!turn.flags.noSource) continue;
      const question = byChat.get(turn.chatId);
      result.push({ turnId: turn.id, questionTurnId: question?.id || null, chatId: turn.chatId, question: question?.text || "", at: turn.at });
    }
    const groups = new Map();
    for (const item of result) {
      const key = item.question.replace(/[\s，。？?！!、,.]/g, "").slice(0, 40) || `#${item.turnId}`;
      const group = groups.get(key) || { question: item.question, count: 0, turnIds: [], refs: [], chats: new Set() };
      group.count++; group.turnIds.push(item.questionTurnId || item.turnId); group.refs.push({ turnId: item.questionTurnId || item.turnId, chatId: item.chatId }); group.chats.add(item.chatId);
      groups.set(key, group);
    }
    return {
      total: result.length,
      groups: [...groups.values()].map((g) => ({ question: g.question, count: g.count, turnIds: g.turnIds.slice(0, 10), refs: g.refs.slice(0, 10), chats: g.chats.size }))
        .sort((a, b) => b.count - a.count).slice(0, 50),
    };
  }
  prune(retentionDays = DEFAULT_RETENTION_DAYS) {
    const cutoff = this.now() - retentionDays * DAY;
    this.db.prepare("DELETE FROM knowledge_bot_turns WHERE at<?").run(cutoff);
    this.db.prepare("DELETE FROM knowledge_bot_conversations WHERE last_at<? AND needs_attention=0").run(cutoff);
    this.db.prepare("DELETE FROM knowledge_bot_insights WHERE created_at<?").run(cutoff);
    this.db.prepare("DELETE FROM knowledge_bot_contexts WHERE at<?").run(this.now() - CONTEXT_TTL);
  }

  // ---------- context window ----------
  context(key) {
    const row = this.db.prepare("SELECT at,turns FROM knowledge_bot_contexts WHERE key=?").get(key);
    if (!row) return null;
    if (this.now() - row.at > CONTEXT_TTL) {
      this.db.prepare("DELETE FROM knowledge_bot_contexts WHERE key=?").run(key);
      return null;
    }
    return { at: row.at, turns: parse(row.turns, []) };
  }
  saveContext(key, appId, chatId, turns) {
    this.db.prepare("INSERT INTO knowledge_bot_contexts(key,app_id,chat_id,at,turns) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at,turns=excluded.turns")
      .run(key, appId, chatId, this.now(), JSON.stringify(turns.slice(-CONTEXT_TURNS)));
    // Bounded like the old in-memory map.
    this.db.prepare("DELETE FROM knowledge_bot_contexts WHERE key NOT IN (SELECT key FROM knowledge_bot_contexts ORDER BY at DESC LIMIT 200)").run();
  }
  deleteContext(key) { this.db.prepare("DELETE FROM knowledge_bot_contexts WHERE key=?").run(key); }
  clearContexts(appId) {
    if (appId === undefined) this.db.prepare("DELETE FROM knowledge_bot_contexts").run();
    else this.db.prepare("DELETE FROM knowledge_bot_contexts WHERE app_id=?").run(appId);
  }

  // ---------- insights ----------
  saveInsight(appId, { id, chatId = "", rangeDays, data }) {
    this.db.prepare("INSERT INTO knowledge_bot_insights(id,app_id,chat_id,range_days,created_at,data) VALUES (?,?,?,?,?,?)")
      .run(id, appId, chatId, rangeDays, this.now(), JSON.stringify(data));
    return this.insight(appId, id);
  }
  insight(appId, id) {
    const row = this.db.prepare("SELECT * FROM knowledge_bot_insights WHERE app_id=? AND id=?").get(appId, id);
    check(row, "NOT_FOUND", "总结不存在或已过期", 404);
    return { id: row.id, chatId: row.chat_id, rangeDays: row.range_days, createdAt: row.created_at, ...parse(row.data, {}) };
  }
  insights(appId, limit = 20) {
    return this.db.prepare("SELECT id,chat_id,range_days,created_at,json_extract(data,'$.headline') AS headline FROM knowledge_bot_insights WHERE app_id=? ORDER BY created_at DESC LIMIT ?")
      .all(appId, limit).map((row) => ({ id: row.id, chatId: row.chat_id, rangeDays: row.range_days, createdAt: row.created_at, headline: row.headline || "" }));
  }
  deleteInsight(appId, id) {
    this.insight(appId, id);
    this.db.prepare("DELETE FROM knowledge_bot_insights WHERE app_id=? AND id=?").run(appId, id);
    return { ok: true };
  }

  // ---------- agenda ----------
  agenda(appId, now) {
    const rows = this.db.prepare("SELECT * FROM knowledge_bot_conversations WHERE app_id=? AND (needs_attention=1 OR (follow_up_at IS NOT NULL AND follow_up_at<=?))").all(appId, now);
    return rows.map(conversationOut);
  }
}
