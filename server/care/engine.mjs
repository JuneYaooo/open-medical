import { randomUUID } from "node:crypto";
import { check, string, identifier } from "../errors.mjs";
import { sqliteTransaction } from "../sqlite-transaction.mjs";
import { CareChannels } from "./channels.mjs";
import { AI_DISCLAIMER, SAFETY_REPLY, detectRedFlags, screenOutbound } from "./red-flags.mjs";
import { extractFollowup, runTriage } from "./triage.mjs";
import {
  DEFAULT_SETTINGS, alertRow, campaignRow, createCareSchema, replyRow,
  validatePatientSettings, validateSettings,
} from "./store.mjs";

const iso = (ms) => new Date(ms).toISOString();
const CARE_PROPOSALS = ["care-message", "care-campaign", "care-settings"];
const TERMINAL_STEPS = ["recorded", "no_reply", "failed", "skipped", "cancelled"];
// Sent steps that can still receive replies. "unknown" may have been delivered.
const OPEN_STEPS = ["sent", "awaiting_member", "unknown", "replied"];
// A step found more than this late (paused plan, app closed) is skipped, not sent.
const STALE_STEP_MS = 24 * 3600000;
const SETTLE_MS = 15 * 60000;
// Messages the care pipeline fully handled no longer count as unprocessed.
const DONE_MESSAGES = ["auto_replied", "handled", "skipped"];
// Old messages (app was closed, first sync) are triaged but never auto-answered.
const STALE_AUTO_REPLY_MS = 12 * 3600000;
// Member-confirmed 客户联系 tasks are re-checked this often, for up to a week.
const MEMBER_REFRESH_MS = 10 * 60000;
const MEMBER_REFRESH_LIMIT_MS = 7 * 86400000;
const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function mergeDefaults(saved) {
  const base = structuredClone(DEFAULT_SETTINGS);
  for (const key of Object.keys(base)) base[key] = { ...base[key], ...(saved?.[key] || {}) };
  return base;
}
function localDue(startDate, dayOffset, time) {
  const [y, m, d] = startDate.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y, m - 1, d + dayOffset, hh, mm).getTime();
}

// Patient care pipeline: record → triage → reply / alert, plus scheduled
// follow-up campaigns. Deterministic code owns every side effect; the model
// only classifies, drafts and summarizes.
export class CareEngine {
  constructor({ store, patients, followups, wecom, vault, guidelines, patientBrief, provider = () => null,
    fetch: fetchImpl = fetch, now = Date.now, intervalMs = 20000, kfPollMs = 60000, env = process.env } = {}) {
    this.store = store;
    this.db = store.db;
    this.patients = patients;
    this.followups = followups;
    this.guidelines = guidelines;
    this.patientBrief = patientBrief;
    this.provider = provider;
    this.now = now;
    this.intervalMs = intervalMs;
    // Without a public callback URL the desktop polls 微信客服; null disables.
    this.kfPollMs = kfPollMs;
    this.kf = { lastSyncAt: null, lastError: null, nextAt: 0, failures: 0, running: null };
    this.channels = new CareChannels({ vault, wecom, env, fetch: fetchImpl, now });
    this.pendingWork = new Set();
    this.lastTickAt = null;
    this.lastError = null;
    createCareSchema(this.db);
    // Watermark: history imported before the care pipeline existed is never
    // mass-triaged on first start.
    if (!this.db.prepare("SELECT 1 FROM care_settings WHERE id=1").get()) {
      const since = this.db.prepare("SELECT COALESCE(MAX(id),0) n FROM patient_messages").get().n;
      this.db.prepare("INSERT INTO care_settings(id,data) VALUES (1,?)").run(JSON.stringify({ ...structuredClone(DEFAULT_SETTINGS), state: { sinceMessageId: since, kfCursor: "" } }));
    }
    // A send interrupted between request and response is never retried.
    const interrupted = this.db.prepare("SELECT id FROM care_replies WHERE status='sending'").all();
    this.db.prepare("UPDATE care_replies SET status='unknown', data=json_set(data,'$.detail','发送过程中服务中断，结果未知；请在企业微信核实，勿重复发送。') WHERE status='sending'").run();
    for (const { id } of interrupted) {
      const r = this.reply(id);
      if (r.campaignId) this.updateStep(r.campaignId, r.stepId, { status: "unknown", sentAt: r.updatedAt, detail: r.detail });
    }
    if (wecom) wecom.onEvent = (event) => this.track(this.handleWecomEvent(event));
  }

  // ---------- settings ----------
  rawSettings() { return JSON.parse(this.db.prepare("SELECT data FROM care_settings WHERE id=1").get().data); }
  internal() { return this.rawSettings().state || {}; }
  setInternal(changes) {
    const raw = this.rawSettings();
    raw.state = { ...(raw.state || {}), ...changes };
    this.db.prepare("UPDATE care_settings SET data=? WHERE id=1").run(JSON.stringify(raw));
  }
  settings() { return mergeDefaults(this.rawSettings()); }
  publicSettings() {
    const channels = this.channels.public();
    return { ...this.settings(), updatedAt: this.rawSettings().updatedAt || null,
      channels: { corp: this.channels.wecom?.publicConfig() || null, kf: channels.kf, app: channels.app, list: channels.channels, notifier: channels.notifier, kfSync: this.kfStatus() } };
  }
  saveSettings(input = {}) {
    check(input && typeof input === "object", "INVALID_INPUT", "设置必须是对象");
    const next = validateSettings(input, this.settings());
    if (input.channels) {
      const c = input.channels;
      if (c.corp) {
        check(this.channels.wecom, "WECOM_UNCONFIGURED", "企业微信连接不可用", 503);
        this.channels.wecom.saveConfig(c.corp);
      }
      this.channels.save({ openKfId: c.kf?.openKfId ?? c.openKfId, kfSecret: c.kf?.secret ?? c.kfSecret, agentId: c.app?.agentId ?? c.agentId, appSecret: c.app?.secret ?? c.appSecret });
    }
    const raw = this.rawSettings();
    this.db.prepare("UPDATE care_settings SET data=? WHERE id=1").run(JSON.stringify({ ...next, state: raw.state, updatedAt: iso(this.now()) }));
    this.store.audit(null, "care.settings.updated", { keys: Object.keys(input) });
    return this.publicSettings();
  }
  patientSettings(patientId) {
    this.patients.row(identifier(patientId));
    const row = this.db.prepare("SELECT data FROM care_patient_settings WHERE patient_id=?").get(patientId);
    return { consent: false, consentAt: null, autoReplyMode: "inherit", channel: null, kfExternalUserId: null, ...(row ? JSON.parse(row.data) : {}) };
  }
  savePatientSettings(patientId, input = {}) {
    const next = validatePatientSettings(input, this.patientSettings(patientId));
    if (next.kfExternalUserId) {
      const other = this.db.prepare("SELECT patient_id FROM care_patient_settings WHERE json_extract(data,'$.kfExternalUserId')=? AND patient_id<>?").get(next.kfExternalUserId, patientId);
      check(!other, "CONFLICT", "该微信客服客户已关联其他患者", 409);
    }
    this.db.prepare("INSERT INTO care_patient_settings(patient_id,data) VALUES (?,?) ON CONFLICT(patient_id) DO UPDATE SET data=excluded.data").run(patientId, JSON.stringify(next));
    this.store.audit(this.patients.row(patientId).sessionId, "care.patient_settings.updated", { patientId, keys: Object.keys(input) });
    return next;
  }
  effectiveMode(patientId) {
    const ps = this.patientSettings(patientId);
    return ps.autoReplyMode && ps.autoReplyMode !== "inherit" ? ps.autoReplyMode : this.settings().autoReply.mode;
  }
  targets(patientId) {
    const ps = this.patientSettings(patientId);
    let bindingId = null;
    try { bindingId = this.channels.wecom?.client ? this.channels.wecom.bindings(patientId).find((b) => b.active)?.id || null : null; } catch { bindingId = null; }
    const last = ps.kfExternalUserId ? this.db.prepare("SELECT MAX(time) t FROM patient_messages WHERE patient_id=? AND channel='wecom-kf' AND direction='in'").get(patientId).t : null;
    const sent = last ? this.db.prepare("SELECT COUNT(*) n FROM care_replies WHERE patient_id=? AND channel='wecom-kf' AND status IN ('sending','sent','unknown') AND COALESCE(json_extract(data,'$.sentAt'),updated_at)>=?").get(patientId, last).n : 0;
    return { kfExternalUserId: ps.kfExternalUserId, bindingId, kfLastInboundAt: last, kfSentSinceInbound: sent };
  }
  modelReady() { return Boolean(this.provider()) && this.settings().processing.modelConsent === true; }
  patientName(patientId) {
    if (!patientId) return null;
    try { return this.patients.row(patientId).name; } catch { return null; }
  }

  // ---------- inbound ----------
  ingest(input = {}) {
    const attachments = Array.isArray(input.attachments) ? input.attachments.slice(0, 20).map((a) => ({
      type: String(a?.type || "file").slice(0, 40), name: String(a?.name || "").slice(0, 200), mediaId: String(a?.mediaId || "").slice(0, 300), url: String(a?.url || "").slice(0, 1000),
    })) : [];
    const text = typeof input.text === "string" && input.text.trim() ? input.text.slice(0, 20000) : attachments.length ? `[${attachments.map((a) => a.type).join("、")}]` : "";
    check(text, "INVALID_INPUT", "消息内容不能为空");
    check(["in", "out"].includes(input.direction || "in"), "INVALID_INPUT", "消息方向无效");
    const time = input.time ? new Date(input.time).getTime() : this.now();
    check(Number.isFinite(time), "INVALID_INPUT", "消息时间无效");
    const externalId = input.externalId ? String(input.externalId).slice(0, 300) : null;
    if (externalId) {
      const existing = this.db.prepare("SELECT id FROM patient_messages WHERE external_id=?").get(externalId);
      if (existing) return { id: existing.id, duplicate: true };
    }
    const patientId = input.patientId ? this.patients.row(identifier(input.patientId)).id : this.patientByKf(input.kfExternalUserId);
    const result = this.db.prepare("INSERT INTO patient_messages(patient_id,channel,direction,time,external_id,processed,data) VALUES (?,?,?,?,?,0,?)").run(
      patientId, String(input.channel || "ingest").slice(0, 40), input.direction || "in", iso(time), externalId,
      JSON.stringify({ text, attachments, sender: input.sender ? String(input.sender).slice(0, 200) : null, msgType: String(input.msgType || "text").slice(0, 40), kfExternalUserId: input.kfExternalUserId || null }));
    const id = Number(result.lastInsertRowid);
    this.discover();
    if (input.historical && this.message(id).state?.status === "pending") this.setState(id, { status: "recorded", reasons: ["接入前的历史消息，仅记录不分诊"] });
    this.kick();
    return { id, patientId, duplicate: false };
  }
  patientByKf(external) {
    if (!external) return null;
    const own = this.db.prepare("SELECT patient_id FROM care_patient_settings WHERE json_extract(data,'$.kfExternalUserId')=?").get(external);
    if (own) return own.patient_id;
    const corp = this.channels.config().corpId;
    try {
      const rows = this.db.prepare("SELECT DISTINCT patient_id FROM wecom_bindings WHERE corp=? AND external=?").all(corp, external);
      return rows.length === 1 ? rows[0].patient_id : null;
    } catch { return null; }
  }
  // Every message after the watermark gets a state row, whichever path
  // stored it (ingest API, WeCom, archive collector, CLI bridge).
  discover() {
    const since = this.internal().sinceMessageId || 0;
    const rows = this.db.prepare(`SELECT m.id, m.patient_id, m.direction FROM patient_messages m LEFT JOIN care_message_state s ON s.message_id=m.id
      WHERE m.id>? AND s.message_id IS NULL ORDER BY m.id LIMIT 500`).all(since);
    const put = this.db.prepare("INSERT OR IGNORE INTO care_message_state(message_id,patient_id,status,level,category,reasons,updated_at) VALUES (?,?,?,?,?,?,?)");
    for (const row of rows) {
      const status = row.direction === "out" ? "recorded" : row.patient_id ? "pending" : "unassigned";
      put.run(row.id, row.patient_id, status, "routine", row.direction === "out" ? "outbound" : null, "[]", iso(this.now()));
    }
    // Messages assigned to a patient elsewhere become processable.
    this.db.prepare(`UPDATE care_message_state SET status='pending', patient_id=(SELECT patient_id FROM patient_messages WHERE id=message_id), updated_at=?
      WHERE status='unassigned' AND (SELECT patient_id FROM patient_messages WHERE id=message_id) IS NOT NULL`).run(iso(this.now()));
    return rows.length;
  }
  message(id) {
    const row = this.db.prepare(`SELECT m.*, s.status s_status, s.level, s.category, s.reasons, s.reply_id, s.alert_id FROM patient_messages m
      LEFT JOIN care_message_state s ON s.message_id=m.id WHERE m.id=?`).get(Number(id));
    check(row, "NOT_FOUND", "消息不存在", 404);
    return this.messageView(row);
  }
  messageView(row) {
    const data = JSON.parse(row.data);
    return { id: row.id, patientId: row.patient_id, patientName: this.patientName(row.patient_id), channel: row.channel, direction: row.direction, time: row.time,
      text: data.text, attachments: data.attachments || [], sender: data.sender || null, kfExternalUserId: data.kfExternalUserId || null,
      state: row.s_status ? { status: row.s_status, level: row.level, category: row.category, reasons: JSON.parse(row.reasons || "[]"), replyId: row.reply_id, alertId: row.alert_id } : null };
  }
  setState(messageId, changes) {
    const fields = { status: changes.status, level: changes.level, category: changes.category, reasons: changes.reasons && JSON.stringify(changes.reasons), reply_id: changes.replyId, alert_id: changes.alertId };
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    this.db.prepare(`UPDATE care_message_state SET ${keys.map((k) => `${k}=?`).join(",")}, updated_at=? WHERE message_id=?`).run(...keys.map((k) => fields[k]), iso(this.now()), messageId);
    if (DONE_MESSAGES.includes(changes.status)) this.db.prepare("UPDATE patient_messages SET processed=1 WHERE id=?").run(messageId);
  }
  thread(patientId, beforeId, limit = 12) {
    return this.db.prepare("SELECT id,direction,time,data FROM patient_messages WHERE patient_id=? AND id<=? ORDER BY time DESC, id DESC LIMIT ?")
      .all(patientId, beforeId, limit).reverse().map((r) => ({ id: r.id, direction: r.direction, time: r.time, text: JSON.parse(r.data).text }));
  }
  async knowledge(text) {
    if (!this.guidelines) return [];
    try {
      const query = text.replace(/\s+/g, " ").slice(0, 120);
      const found = await this.guidelines.search({ query, limit: 4 });
      return (found.hits || []).map((hit, i) => ({ id: `K${i + 1}`, title: hit.docTitle, snippet: (hit.matches || []).map((m) => m.text).join("\n") || hit.snippet, docId: hit.docId, startLine: hit.startLine, endLine: hit.endLine }));
    } catch { return []; }
  }

  async processMessage(id, { force = false, signal } = {}) {
    const msg = this.message(id);
    check(msg.direction === "in", "INVALID_INPUT", "只处理患者发来的消息");
    if (!msg.state) { this.discover(); return this.message(id); }
    if (!msg.patientId) { this.setState(id, { status: "unassigned" }); return this.message(id); }
    if (!force && msg.state.status !== "pending") return msg;
    const patient = this.patients.row(msg.patientId);
    if (patient.archived) { this.setState(id, { status: "skipped", reasons: ["患者已归档"] }); return this.message(id); }
    const settings = this.settings();
    const ps = this.patientSettings(msg.patientId);
    const mode = this.effectiveMode(msg.patientId);
    const link = this.linkCampaignReply(msg);
    const flags = detectRedFlags(msg.text, settings.redFlags.extra);
    if (flags.length) {
      const alert = this.createAlert({ patientId: msg.patientId, messageId: id, level: "urgent", reason: `红旗症状：${flags.map((f) => f.label).join("、")}`, flags });
      let reply = null;
      if (mode !== "off") {
        const auto = ps.consent && this.channels.canAutoSend(this.channels.choose(ps.channel, this.targets(msg.patientId)));
        reply = this.createReply({ patientId: msg.patientId, messageId: id, text: SAFETY_REPLY, mode: auto ? "auto" : "draft", status: auto ? "queued" : "draft", reason: "红旗规则固定安全话术", channel: auto ? "wecom-kf" : undefined });
        if (auto) reply = await this.sendReply(reply.id, { auto: true });
      }
      this.setState(id, { status: "alerted", level: "urgent", category: "emergency", reasons: flags.map((f) => f.label), alertId: alert.id, replyId: reply?.id ?? null });
      this.store.audit(patient.sessionId, "care.message.triaged", { messageId: id, level: "urgent", rule: flags.map((f) => f.id) });
      return this.message(id);
    }
    if (!this.modelReady()) {
      this.setState(id, { status: "recorded", level: "routine", category: link ? "followup_reply" : null, reasons: [this.provider() ? "未授权模型分诊，等待医生查看" : "未配置模型，等待医生查看"] });
      return this.message(id);
    }
    let triage;
    try {
      const knowledge = await this.knowledge(msg.text);
      let brief = null;
      try { brief = this.patientBrief?.read(msg.patientId) || null; } catch { brief = null; }
      triage = await runTriage(this.provider(), { brief, thread: this.thread(msg.patientId, id), knowledge, campaignQuestions: link?.step.questions }, signal);
      triage.sources = knowledge.filter((k) => triage.sourceIds.includes(k.id)).map(({ id: sid, title, docId, startLine, endLine }) => ({ id: sid, title, docId, startLine, endLine }));
    } catch (error) {
      const alert = this.createAlert({ patientId: msg.patientId, messageId: id, level: "attention", reason: `自动分诊失败，需人工查看：${error.message}` });
      this.setState(id, { status: "failed", level: "attention", reasons: [error.message], alertId: alert.id });
      return this.message(id);
    }
    const category = link ? "followup_reply" : triage.category;
    const reasons = triage.reason ? [triage.reason] : [];
    let status = "recorded", alertId = null, replyId = null;
    if (triage.level !== "routine") {
      alertId = this.createAlert({ patientId: msg.patientId, messageId: id, level: triage.level, reason: triage.reason || "模型判断需要医生处理" }).id;
      status = "alerted";
      if (triage.reply && mode !== "off")
        replyId = this.createReply({ patientId: msg.patientId, messageId: id, text: this.withDisclaimer(triage.reply), mode: "draft", sources: triage.sources, reason: triage.reason }).id;
    } else if (triage.reply && mode !== "off") {
      const screen = screenOutbound(triage.reply);
      const channel = this.channels.choose(ps.channel, this.targets(msg.patientId));
      // Answers to follow-up questions are collected for the record, never auto-answered.
      const fresh = this.now() - Date.parse(msg.time) < STALE_AUTO_REPLY_MS;
      if (!fresh) reasons.push("消息已超过 12 小时，不自动回复");
      const auto = !link && fresh && mode === "auto" && ps.consent && settings.autoReply.categories.includes(category) && triage.canAutoReply && screen.ok && this.channels.canAutoSend(channel);
      let reply = this.createReply({ patientId: msg.patientId, messageId: id, text: this.withDisclaimer(triage.reply), mode: auto ? "auto" : "draft", status: auto ? "queued" : "draft", sources: triage.sources, reason: triage.reason, screen, channel });
      replyId = reply.id;
      status = "drafted";
      if (!screen.ok) reasons.push(...screen.reasons.map((r) => `未自动发送：${r}`));
      if (auto) {
        reply = await this.sendReply(reply.id, { auto: true });
        if (reply.status === "sent") status = "auto_replied";
        else alertId = this.createAlert({ patientId: msg.patientId, messageId: id, level: "attention", reason: `自动回复发送失败：${reply.detail}` }).id;
      }
    }
    this.setState(id, { status, level: triage.level, category, reasons, alertId, replyId });
    this.store.audit(patient.sessionId, "care.message.triaged", { messageId: id, level: triage.level, category, status, replyId });
    return this.message(id);
  }
  withDisclaimer(text) { return this.settings().autoReply.disclaimer ? `${text}\n${AI_DISCLAIMER}` : text; }
  markMessage(id, status) {
    check(["handled", "skipped", "pending"].includes(status), "INVALID_INPUT", "状态须为 handled/skipped/pending");
    this.message(id);
    this.setState(Number(id), { status });
    if (status === "pending") this.kick();
    return this.message(id);
  }
  assignMessage(id, patientId) {
    const msg = this.message(id);
    this.patients.assign(Number(id), identifier(patientId));
    if (msg.kfExternalUserId && !this.patientSettings(patientId).kfExternalUserId && !this.patientByKf(msg.kfExternalUserId))
      this.savePatientSettings(patientId, { kfExternalUserId: msg.kfExternalUserId });
    this.discover();
    this.kick();
    return this.message(id);
  }

  // ---------- replies ----------
  createReply({ patientId, messageId = null, text, mode = "draft", status = "draft", channel, sources = [], reason = "", screen = null, campaignId = null, stepId = null }) {
    const patient = this.patients.row(identifier(patientId));
    const body = string(text, "回复内容", 2000);
    const chosen = channel || this.channels.choose(this.patientSettings(patientId).channel, this.targets(patientId));
    const id = randomUUID(), time = iso(this.now());
    this.db.prepare("INSERT INTO care_replies(id,patient_id,message_id,channel,mode,status,text,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, patient.id, messageId, chosen, mode, status, body, JSON.stringify({ sources, reason, screen, campaignId, stepId, model: mode === "manual" ? null : this.provider()?.model || null }), time, time);
    return this.reply(id);
  }
  reply(id) {
    const row = this.db.prepare("SELECT * FROM care_replies WHERE id=?").get(String(id));
    check(row, "NOT_FOUND", "回复不存在", 404);
    return { ...replyRow(row), patientName: this.patientName(row.patient_id) };
  }
  updateReply(id, input = {}) {
    const reply = this.reply(id);
    check(reply.status === "draft", "CARE_REPLY_STATE", "只有草稿可以修改", 409);
    const text = string(input.text, "回复内容", 2000);
    const channel = input.channel === undefined ? reply.channel : input.channel;
    check(["wecom-kf", "wecom-contact", "manual"].includes(channel), "INVALID_INPUT", "渠道无效");
    this.db.prepare("UPDATE care_replies SET text=?, channel=?, updated_at=? WHERE id=? AND status='draft'").run(text, channel, iso(this.now()), reply.id);
    return this.reply(id);
  }
  discardReply(id) {
    const reply = this.reply(id);
    check(["draft", "failed"].includes(reply.status), "CARE_REPLY_STATE", "该回复已发送或正在发送", 409);
    this.db.prepare("UPDATE care_replies SET status='discarded', updated_at=? WHERE id=?").run(iso(this.now()), reply.id);
    if (reply.campaignId) this.updateStep(reply.campaignId, reply.stepId, { status: "skipped" });
    return this.reply(id);
  }
  async sendReply(id, { confirmed = false, auto = false } = {}) {
    const reply = this.reply(id);
    if (["sent", "awaiting_member"].includes(reply.status)) return reply;
    check(["draft", "queued", "failed"].includes(reply.status), "CARE_REPLY_STATE", reply.status === "unknown" ? "上次发送结果未知，请先在企业微信核实，勿重复发送" : "该回复不能发送", 409);
    check(auto || confirmed === true, "CARE_CONFIRM", "请核对收件人与内容后确认发送");
    const patient = this.patients.row(reply.patientId);
    check(!patient.archived, "PATIENT_ARCHIVED", "患者已归档，不能发送", 409);
    const targets = this.targets(reply.patientId);
    const claimed = this.db.prepare("UPDATE care_replies SET status='sending', updated_at=? WHERE id=? AND status=?").run(iso(this.now()), reply.id, reply.status);
    check(claimed.changes === 1, "CARE_REPLY_STATE", "该回复正在发送，请刷新", 409);
    let outcome;
    try {
      outcome = await this.channels.send(reply.channel, { patientId: reply.patientId, text: reply.text, requestId: reply.id, targets });
    } catch (error) {
      outcome = { status: error.code === "WECOM_CONNECTION" ? "unknown" : "failed", detail: error.message };
    }
    const time = iso(this.now());
    this.db.prepare("UPDATE care_replies SET status=?, updated_at=?, data=json_set(data,'$.detail',?,'$.externalId',?,'$.sentAt',?) WHERE id=?")
      .run(outcome.status, time, outcome.detail || "", outcome.externalId || null, ["sent", "awaiting_member"].includes(outcome.status) ? time : null, reply.id);
    if (outcome.status === "sent") {
      this.db.prepare("INSERT OR IGNORE INTO patient_messages(patient_id,channel,direction,time,external_id,processed,data) VALUES (?,?,?,?,?,1,?)")
        .run(reply.patientId, reply.channel, "out", time, `care-reply:${reply.id}`, JSON.stringify({ text: reply.text, careReplyId: reply.id, mode: reply.mode }));
      this.discover();
    }
    if (reply.messageId && outcome.status === "sent") {
      const state = this.message(reply.messageId).state;
      if (state && ["drafted", "alerted", "recorded", "failed"].includes(state.status) && reply.mode !== "auto") this.setState(reply.messageId, { status: "handled", replyId: reply.id });
    }
    if (reply.campaignId) {
      this.updateStep(reply.campaignId, reply.stepId, { status: ["sent", "awaiting_member", "unknown"].includes(outcome.status) ? outcome.status : "failed", sentAt: time, detail: outcome.detail || "" });
      if (!["sent", "awaiting_member"].includes(outcome.status)) {
        const c = this.campaign(reply.campaignId);
        this.createAlert({ patientId: c.patientId, level: "attention", key: `campaign:${c.id}:${reply.stepId}:send`, reason: `随访「${c.name}」消息${outcome.status === "unknown" ? "发送结果未知，请在企业微信核实" : `发送失败：${outcome.detail || ""}`}` });
      }
    }
    this.store.audit(patient.sessionId, outcome.status === "failed" ? "care.reply.failed" : "care.reply.sent", { replyId: reply.id, channel: reply.channel, mode: reply.mode, status: outcome.status, confirmed: !auto });
    return this.reply(id);
  }

  // ---------- alerts ----------
  // `key` dedupes alerts that are not about a single message (campaign steps).
  createAlert({ patientId, messageId = null, level, reason, flags = [], key = null }) {
    const existing = key
      ? this.db.prepare("SELECT id FROM care_alerts WHERE json_extract(data,'$.key')=? AND status<>'resolved'").get(key)
      : messageId && this.db.prepare("SELECT id FROM care_alerts WHERE message_id=? AND json_extract(data,'$.key') IS NULL AND status<>'resolved'").get(messageId);
    if (existing) return this.alert(existing.id);
    const id = randomUUID(), time = iso(this.now());
    this.db.prepare("INSERT INTO care_alerts(id,patient_id,message_id,level,reason,status,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, patientId, messageId, level, String(reason).slice(0, 500), "open", JSON.stringify({ flags, notified: [], ...(key ? { key } : {}) }), time, time);
    this.store.audit(patientId ? this.patients.row(patientId).sessionId : null, "care.alert.created", { alertId: id, level, messageId });
    this.track(this.notifyAlert(id));
    return this.alert(id);
  }
  alert(id) {
    const row = this.db.prepare("SELECT * FROM care_alerts WHERE id=?").get(String(id));
    check(row, "NOT_FOUND", "提醒不存在", 404);
    const text = row.message_id ? this.db.prepare("SELECT data FROM patient_messages WHERE id=?").get(row.message_id) : null;
    return { ...alertRow(row), patientName: this.patientName(row.patient_id), messageText: text ? JSON.parse(text.data).text : null };
  }
  async notifyAlert(id, escalation = false) {
    const alert = this.alert(id);
    const userIds = this.settings().alerts.notifyUserIds;
    const text = `${escalation ? "【仍未处理】" : ""}【${alert.level === "urgent" ? "紧急" : "需关注"}】患者 ${alert.patientName || "未关联"}：${alert.reason}${alert.messageText ? `\n消息：${alert.messageText.slice(0, 200)}` : ""}\n请在工作台「患者消息」查看处理。`;
    const result = await this.channels.notify(userIds, text);
    const entry = { at: iso(this.now()), ok: result.ok, detail: result.detail || "", escalation };
    this.db.prepare("UPDATE care_alerts SET data=json_set(data,'$.notified',json(?)) WHERE id=?").run(JSON.stringify([...alert.notified, entry].slice(-10)), id);
    return entry;
  }
  updateAlert(id, action, note = "") {
    check(["acknowledge", "resolve"].includes(action), "INVALID_INPUT", "操作须为 acknowledge/resolve");
    const alert = this.alert(id);
    const status = action === "acknowledge" ? "acknowledged" : "resolved";
    if (alert.status === "resolved") return alert;
    this.db.prepare("UPDATE care_alerts SET status=?, updated_at=?, data=json_set(data,'$.note',?) WHERE id=?").run(status, iso(this.now()), String(note || "").slice(0, 500), alert.id);
    if (status === "resolved" && alert.messageId) {
      const state = this.message(alert.messageId).state;
      if (state && ["alerted", "failed"].includes(state.status)) this.setState(alert.messageId, { status: "handled" });
    }
    this.store.audit(alert.patientId ? this.patients.row(alert.patientId).sessionId : null, "care.alert.updated", { alertId: alert.id, status });
    return this.alert(id);
  }
  async escalate() {
    const minutes = this.settings().alerts.escalateAfterMinutes;
    const cutoff = iso(this.now() - minutes * 60000);
    const rows = this.db.prepare("SELECT id, data FROM care_alerts WHERE status='open' AND created_at<=?").all(cutoff);
    for (const row of rows) {
      const data = JSON.parse(row.data);
      const escalations = (data.notified || []).filter((n) => n.escalation);
      if (escalations.length >= 3 || (escalations.length && Date.parse(escalations.at(-1).at) > this.now() - minutes * 60000)) continue;
      this.db.prepare("UPDATE care_alerts SET data=json_set(data,'$.escalatedAt',?) WHERE id=?").run(iso(this.now()), row.id);
      await this.notifyAlert(row.id, true);
    }
  }

  // ---------- campaigns ----------
  normalizeCampaign(input = {}) {
    const patientId = this.patients.row(identifier(input.patientId)).id;
    const name = string(input.name, "随访计划名称", 100);
    const startDate = input.startDate || localDate(this.now());
    check(/^\d{4}-\d{2}-\d{2}$/.test(startDate) && Number.isFinite(Date.parse(startDate)), "INVALID_INPUT", "开始日期须为 YYYY-MM-DD");
    check(startDate >= localDate(this.now()), "INVALID_INPUT", "开始日期不能早于今天");
    check(Array.isArray(input.steps) && input.steps.length >= 1 && input.steps.length <= 20, "INVALID_INPUT", "随访计划须包含 1–20 个步骤");
    const steps = input.steps.map((s, i) => {
      check(Number.isInteger(s?.dayOffset) && s.dayOffset >= 0 && s.dayOffset <= 3650, "INVALID_INPUT", "dayOffset 须为 0–3650 的整数");
      const time = s.time || "09:00";
      check(/^([01]\d|2[0-3]):[0-5]\d$/.test(time), "INVALID_INPUT", "发送时间须为 HH:MM");
      const questions = s.questions || [];
      check(Array.isArray(questions) && questions.length <= 10 && questions.every((q) => typeof q === "string" && q.trim() && q.length <= 200), "INVALID_INPUT", "随访问题最多 10 个，每个不超过 200 字");
      return { id: `s${i + 1}`, dayOffset: s.dayOffset, time, text: string(s.text, "随访消息", 1000), questions: questions.map((q) => q.trim()), status: "scheduled" };
    }).sort((a, b) => a.dayOffset - b.dayOffset || a.time.localeCompare(b.time));
    const replyWindowHours = input.replyWindowHours ?? 48;
    check(Number.isInteger(replyWindowHours) && replyWindowHours >= 1 && replyWindowHours <= 336, "INVALID_INPUT", "回复收集窗口须为 1–336 小时");
    check(input.channel === undefined || input.channel === null || ["wecom-kf", "wecom-contact", "manual"].includes(input.channel), "INVALID_INPUT", "渠道无效");
    return { patientId, name, startDate, steps, replyWindowHours, channel: input.channel || null, requireConfirm: input.requireConfirm === true };
  }
  createCampaign(input) {
    const c = this.normalizeCampaign(input);
    const id = randomUUID(), time = iso(this.now());
    const steps = c.steps.map((s) => ({ ...s, dueAt: iso(localDue(c.startDate, s.dayOffset, s.time)), messageIds: [] }));
    this.db.prepare("INSERT INTO care_campaigns(id,patient_id,name,status,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, c.patientId, c.name, "active", JSON.stringify({ startDate: c.startDate, channel: c.channel, replyWindowHours: c.replyWindowHours, requireConfirm: c.requireConfirm, steps }), time, time);
    this.store.audit(this.patients.row(c.patientId).sessionId, "care.campaign.created", { campaignId: id, steps: steps.length });
    this.kick();
    return this.campaign(id);
  }
  campaign(id) {
    const row = this.db.prepare("SELECT * FROM care_campaigns WHERE id=?").get(String(id));
    check(row, "NOT_FOUND", "随访计划不存在", 404);
    return { ...campaignRow(row), patientName: this.patientName(row.patient_id) };
  }
  saveCampaign(c, status = c.status) {
    const { id, patientId: _p, name: _n, status: _s, createdAt: _c, updatedAt: _u, patientName: _pn, ...data } = c;
    this.db.prepare("UPDATE care_campaigns SET status=?, data=?, updated_at=? WHERE id=?").run(status, JSON.stringify(data), iso(this.now()), id);
  }
  updateStep(campaignId, stepId, changes) {
    sqliteTransaction(this.db, () => {
      const c = this.campaign(campaignId);
      const step = c.steps.find((s) => s.id === stepId);
      if (!step) return;
      Object.assign(step, changes);
      this.saveCampaign(c, c.status === "active" && c.steps.every((s) => TERMINAL_STEPS.includes(s.status)) ? "completed" : c.status);
    });
  }
  campaignAction(id, action) {
    check(["pause", "resume", "cancel"].includes(action), "INVALID_INPUT", "操作须为 pause/resume/cancel");
    const c = this.campaign(id);
    check(!["completed", "cancelled"].includes(c.status), "CARE_CAMPAIGN_STATE", "随访计划已结束", 409);
    const status = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
    if (status === "cancelled") {
      for (const s of c.steps) {
        if (s.status === "scheduled") s.status = "cancelled";
        if (["draft", "sending"].includes(s.status) && s.replyId) {
          // Only unsent replies can be withdrawn; one already being sent keeps its outcome.
          const withdrawn = this.db.prepare("UPDATE care_replies SET status='discarded', updated_at=? WHERE id=? AND status IN ('draft','queued','failed')").run(iso(this.now()), s.replyId);
          if (withdrawn.changes) s.status = "cancelled";
        }
      }
    }
    this.saveCampaign(c, status);
    this.store.audit(this.patients.row(c.patientId).sessionId, "care.campaign.updated", { campaignId: id, status });
    return this.campaign(id);
  }
  // A reply belongs to the most recently sent step (across all of the
  // patient's plans) whose reply window covers it. Paused plans still collect
  // replies, and a reply after the step was recorded becomes a supplement.
  linkCampaignReply(msg) {
    const t = Date.parse(msg.time);
    let best = null;
    for (const row of this.db.prepare("SELECT id FROM care_campaigns WHERE patient_id=? AND status IN ('active','paused','completed')").all(msg.patientId)) {
      const c = this.campaign(row.id);
      for (const step of c.steps) {
        if (![...OPEN_STEPS, "recorded"].includes(step.status) || !step.sentAt) continue;
        const sent = Date.parse(step.sentAt);
        if (t < sent - 60000 || t > sent + c.replyWindowHours * 3600000) continue;
        if (!best || sent > Date.parse(best.step.sentAt)) best = { campaign: c, step };
      }
    }
    if (best && !best.step.messageIds.includes(msg.id))
      this.updateStep(best.campaign.id, best.step.id, { status: "replied", messageIds: [...best.step.messageIds, msg.id], lastReplyAt: msg.time });
    return best;
  }
  async runCampaigns() {
    const now = this.now();
    // Completed plans are revisited while a late reply could still arrive.
    const recent = iso(now - 15 * 86400000);
    for (const row of this.db.prepare("SELECT id FROM care_campaigns WHERE status IN ('active','paused') OR (status='completed' AND updated_at>=?)").all(recent)) {
      const c = this.campaign(row.id);
      if (c.status === "active" && this.patients.row(c.patientId).archived) {
        this.saveCampaign({ ...c, detail: "患者已归档，随访已自动暂停" }, "paused");
        this.store.audit(this.patients.row(c.patientId).sessionId, "care.campaign.updated", { campaignId: c.id, status: "paused", reason: "archived" });
        continue;
      }
      for (const step of c.steps) {
        try {
          if (step.status === "scheduled" && c.status === "active" && Date.parse(step.dueAt) <= now) {
            if (now - Date.parse(step.dueAt) > STALE_STEP_MS) this.updateStep(c.id, step.id, { status: "skipped", detail: "到期时计划暂停或工作台未运行，已过期未发送" });
            else await this.dispatchStep(c, step);
          } else if (step.status === "draft" && now >= Date.parse(step.dueAt) + c.replyWindowHours * 3600000) {
            const expired = this.db.prepare("UPDATE care_replies SET status='discarded', updated_at=? WHERE id=? AND status='draft'").run(iso(now), step.replyId);
            if (expired.changes) this.updateStep(c.id, step.id, { status: "skipped", detail: "草稿未在回复窗口内发送，已过期" });
          } else if (OPEN_STEPS.includes(step.status) && step.sentAt) {
            const windowEnd = Date.parse(step.sentAt) + c.replyWindowHours * 3600000;
            const fresh = step.messageIds.filter((id) => !(step.recordedMessageIds || []).includes(id));
            const settled = step.status === "replied" && Date.parse(step.lastReplyAt) + SETTLE_MS <= now;
            if (fresh.length && (settled || now >= windowEnd)) await this.recordStep(c, step, fresh);
            else if (!step.messageIds.length && now >= windowEnd) await this.recordNoReply(c, step);
          }
        } catch (error) {
          this.updateStep(c.id, step.id, { status: "failed", detail: error.message });
          this.createAlert({ patientId: c.patientId, level: "attention", key: `campaign:${c.id}:${step.id}:error`, reason: `随访「${c.name}」步骤执行失败：${error.message}` });
        }
      }
    }
  }
  async dispatchStep(c, step) {
    const ps = this.patientSettings(c.patientId);
    const channel = this.channels.choose(c.channel || ps.channel, this.targets(c.patientId));
    const text = step.questions.length ? `${step.text}\n${step.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}` : step.text;
    const unattended = ps.consent && !c.requireConfirm && channel !== "manual";
    const reply = this.createReply({ patientId: c.patientId, text, mode: "campaign", status: unattended ? "queued" : "draft", channel, reason: `随访计划「${c.name}」第 ${step.dayOffset} 天`, campaignId: c.id, stepId: step.id });
    this.updateStep(c.id, step.id, { status: unattended ? "sending" : "draft", replyId: reply.id });
    if (unattended) await this.sendReply(reply.id, { auto: true });
    this.store.audit(this.patients.row(c.patientId).sessionId, "care.campaign.step.dispatched", { campaignId: c.id, stepId: step.id, unattended });
  }
  async recordStep(c, step, messageIds) {
    const seq = (step.records || []).length + 1;
    const replies = messageIds.map((id) => this.message(id)).map((m) => ({ time: m.time, text: m.text }));
    // The extraction is kept on the step first so a retry after a failed save
    // writes the identical record instead of conflicting with itself.
    let result = step.pending?.seq === seq && JSON.stringify(step.pending.messageIds) === JSON.stringify(messageIds) ? step.pending.result : null;
    if (!result) {
      if (this.modelReady()) result = await extractFollowup(this.provider(), { questions: step.questions, text: step.text, replies });
      else result = { summary: `患者回复原文：${replies.map((r) => r.text).join(" / ").slice(0, 1100)}`, symptoms: "", medications: "", results: "", needsDoctor: false, reason: "未启用模型整理" };
      this.updateStep(c.id, step.id, { pending: { seq, messageIds, result } });
    }
    const clinical = Object.fromEntries(["symptoms", "medications", "results"].filter((k) => result[k]).map((k) => [k, result[k]]));
    const record = this.followups.recordContact(c.patientId, {
      requestId: seq === 1 ? `care-${c.id}-${step.id}` : `care-${c.id}-${step.id}-r${seq}`,
      title: `${c.name} · 第${step.dayOffset}天${seq > 1 ? "（补充回复）" : ""}`.slice(0, 100), status: "completed", contactMethod: "wecom",
      contactedAt: replies[0]?.time, note: `${result.summary}`.slice(0, 5000), clinical,
      source: { kind: "campaign", campaignId: c.id, stepId: step.id, messageIds },
    });
    const records = [...(step.records || []), { recordId: record.id, messageIds, recordedAt: iso(this.now()) }];
    this.updateStep(c.id, step.id, { status: "recorded", recordedAt: iso(this.now()), result: { ...result, recordId: record.id }, records, recordedMessageIds: [...(step.recordedMessageIds || []), ...messageIds], pending: null });
    for (const id of messageIds) {
      const state = this.message(id).state;
      if (state && ["recorded", "drafted"].includes(state.status)) this.setState(id, { status: "handled" });
    }
    if (result.needsDoctor) this.createAlert({ patientId: c.patientId, messageId: messageIds.at(-1), key: `campaign:${c.id}:${step.id}:review:${seq}`, level: "attention", reason: `随访回复需医生关注：${result.reason || result.summary.slice(0, 80)}` });
    this.store.audit(this.patients.row(c.patientId).sessionId, "care.campaign.step.recorded", { campaignId: c.id, stepId: step.id, recordId: record.id, seq });
  }
  async recordNoReply(c, step) {
    const uncertain = step.status === "unknown" ? "（发送结果未知）" : step.status === "awaiting_member" ? "（成员可能尚未确认发送）" : "";
    const record = this.followups.recordContact(c.patientId, {
      requestId: `care-${c.id}-${step.id}-noreply`, title: `${c.name} · 第${step.dayOffset}天`.slice(0, 100), status: "unreachable", contactMethod: "wecom",
      contactedAt: step.sentAt, note: `发送后 ${c.replyWindowHours} 小时内未收到回复${uncertain}。`,
      source: { kind: "campaign", campaignId: c.id, stepId: step.id, messageIds: [] },
    });
    this.updateStep(c.id, step.id, { status: "no_reply", recordedAt: iso(this.now()), result: { summary: `未回复${uncertain}`, needsDoctor: false, recordId: record.id } });
    this.createAlert({ patientId: c.patientId, level: "attention", key: `campaign:${c.id}:${step.id}:noreply`, reason: `随访「${c.name}」第 ${step.dayOffset} 天未收到回复${uncertain}，建议电话联系` });
  }

  // ---------- WeCom 微信客服 ----------
  async handleWecomEvent(event) {
    if (event?.Event !== "kf_msg_or_event" || !this.channels.kfReady()) return { synced: 0 };
    return this.syncKf(event.Token || "");
  }
  kfStatus() {
    const { running, ...status } = this.kf;
    return { ...status, syncing: Boolean(running), polling: this.channels.kfReady() && this.kfPollMs !== null, pollSeconds: this.kfPollMs === null ? null : Math.round(this.kfPollMs / 1000),
      nextAt: this.kf.nextAt ? iso(this.kf.nextAt) : null, lastSyncAt: this.kf.lastSyncAt };
  }
  // One sync at a time: the callback, the poller and the sync button share
  // the cursor, so overlapping pulls would skip or repeat pages.
  syncKf(token = "") {
    check(this.channels.kfReady(), "CARE_CHANNEL", "微信客服未配置", 503);
    const previous = this.kf.running || Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.pullKf(token));
    this.kf.running = run;
    const done = () => { if (this.kf.running === run) this.kf.running = null; };
    run.then((result) => {
      done();
      Object.assign(this.kf, { lastSyncAt: iso(this.now()), lastError: null, failures: 0, nextAt: this.now() + (this.kfPollMs ?? 0) });
      return result;
    }, (error) => {
      done();
      this.kf.failures += 1;
      // Back off on errors (rate limits, revoked secret) up to 15 minutes.
      Object.assign(this.kf, { lastError: error.message, nextAt: this.now() + Math.min((this.kfPollMs ?? 60000) * 2 ** this.kf.failures, 15 * 60000) });
    });
    return run;
  }
  async pullKf(token) {
    let cursor = this.internal().kfCursor || "", synced = 0;
    // Messages from before the first sync are kept as history, not triaged.
    if (!this.internal().kfSince) this.setInternal({ kfSince: iso(this.now()) });
    const historyBefore = Date.parse(this.internal().kfSince) - 10 * 60000;
    const openKfId = this.channels.config().openKfId;
    for (let page = 0; page < 20; page++) {
      const body = await this.channels.client("kf").syncKf({ cursor, token, openKfId });
      for (const m of body.msg_list || []) {
        if (![3, 5].includes(Number(m.origin)) || !m.external_userid) continue;
        const media = m[m.msgtype]?.media_id ? [{ type: m.msgtype, mediaId: m[m.msgtype].media_id, name: m.file?.file_name || "" }] : [];
        const text = m.msgtype === "text" ? m.text?.content : "";
        if (!text && !media.length) continue;
        const time = Number(m.send_time) * 1000;
        const r = this.ingest({ channel: "wecom-kf", kfExternalUserId: m.external_userid, direction: Number(m.origin) === 3 ? "in" : "out", text, attachments: media, time, externalId: `kf:${m.msgid}`, msgType: m.msgtype, historical: time < historyBefore });
        if (!r.duplicate) synced++;
      }
      cursor = body.next_cursor || cursor;
      this.setInternal({ kfCursor: cursor });
      if (!body.has_more) break;
    }
    return { synced };
  }
  pollKf() {
    if (this.kfPollMs === null || !this.channels.kfReady() || this.kf.running || this.now() < this.kf.nextAt) return null;
    return this.syncKf().catch(() => {});
  }
  // 客户联系 tasks wait for the member to press send in WeCom; the result is
  // polled so campaign steps and replies don't stay "awaiting" forever.
  async refreshMemberTasks() {
    const wecom = this.channels.wecom;
    if (!wecom?.client) return;
    const now = this.now();
    for (const row of this.db.prepare("SELECT id FROM care_replies WHERE status='awaiting_member' AND channel='wecom-contact' ORDER BY updated_at LIMIT 20").all()) {
      const reply = this.reply(row.id);
      const raw = JSON.parse(this.db.prepare("SELECT data FROM care_replies WHERE id=?").get(row.id).data);
      if (raw.checkedAt && now - Date.parse(raw.checkedAt) < MEMBER_REFRESH_MS) continue;
      const since = Date.parse(reply.sentAt || reply.updatedAt);
      let status = "awaiting_member", detail = reply.detail;
      if (reply.externalId) {
        try {
          const task = await wecom.refresh(reply.externalId);
          if (task.status === "sent") [status, detail] = ["sent", task.detail];
          else if (task.status === "delivery_failed") [status, detail] = ["failed", task.detail];
        } catch (error) { detail = `查询发送结果失败：${error.message}`; }
      }
      if (status === "awaiting_member" && now - since > MEMBER_REFRESH_LIMIT_MS) [status, detail] = ["unknown", "成员 7 天内未确认发送，请在企业微信核实"];
      this.db.prepare("UPDATE care_replies SET status=?, data=json_set(data,'$.detail',?,'$.checkedAt',?), updated_at=? WHERE id=?").run(status, detail || "", iso(now), iso(now), row.id);
      if (status === "awaiting_member" || !reply.campaignId) continue;
      const c = this.campaign(reply.campaignId), step = c.steps.find((x) => x.id === reply.stepId);
      if (step?.status !== "awaiting_member") continue;
      // The reply window starts when the member actually sent it.
      this.updateStep(c.id, step.id, { status, detail, ...(status === "sent" && !step.messageIds.length ? { sentAt: iso(now) } : {}) });
      if (status !== "sent") this.createAlert({ patientId: c.patientId, level: "attention", key: `campaign:${c.id}:${step.id}:send`, reason: `随访「${c.name}」企业微信任务未发出：${detail}` });
    }
  }
  testConnection() { return this.channels.test(); }

  // ---------- proposals (chat-initiated writes) ----------
  normalizeProposal(type, payload = {}) {
    if (type === "care-message") {
      const patientId = this.patients.row(identifier(payload.patientId)).id;
      const text = string(payload.text, "消息内容", 2000);
      check(payload.channel === undefined || ["wecom-kf", "wecom-contact", "manual"].includes(payload.channel), "INVALID_INPUT", "渠道无效");
      const channel = payload.channel || this.channels.choose(this.patientSettings(patientId).channel, this.targets(patientId));
      if (payload.messageId !== undefined && payload.messageId !== null) check(this.message(payload.messageId).patientId === patientId, "INVALID_INPUT", "消息不属于该患者");
      return { patientId, text, channel, messageId: payload.messageId ?? null, replyId: payload.replyId || null };
    }
    if (type === "care-campaign") {
      const c = this.normalizeCampaign(payload);
      return { ...c, steps: c.steps.map(({ dayOffset, time, text, questions }) => ({ dayOffset, time, text, questions })) };
    }
    if (type === "care-settings") {
      check(["global", "patient"].includes(payload.scope), "INVALID_INPUT", "scope 须为 global/patient");
      check(payload.changes && typeof payload.changes === "object", "INVALID_INPUT", "changes 必须是对象");
      check(!payload.changes.channels, "INVALID_INPUT", "渠道密钥只能在设置页面填写");
      if (payload.scope === "global") validateSettings(payload.changes, this.settings());
      else validatePatientSettings(payload.changes, this.patientSettings(payload.patientId));
      return { scope: payload.scope, patientId: payload.scope === "patient" ? payload.patientId : null, changes: payload.changes };
    }
    check(false, "INVALID_INPUT", "未知的患者管理提案");
  }
  // Runs inside the PendingActions confirm transaction: synchronous only.
  // Outbound delivery is queued and flushed by the next tick.
  applyProposal(action) {
    const p = action.payload;
    if (action.type === "care-message") {
      let reply;
      if (p.replyId) {
        reply = this.reply(p.replyId);
        check(reply.status === "draft" && reply.patientId === p.patientId, "CARE_REPLY_STATE", "草稿已变化，请重新生成", 409);
        this.db.prepare("UPDATE care_replies SET status='queued', text=?, channel=?, updated_at=? WHERE id=?").run(p.text, p.channel, iso(this.now()), reply.id);
      } else reply = this.createReply({ patientId: p.patientId, messageId: p.messageId, text: p.text, mode: "manual", status: "queued", channel: p.channel, reason: "医生在对话中确认发送" });
      this.kick();
      return this.reply(reply.id);
    }
    if (action.type === "care-campaign") return this.createCampaign(p);
    if (action.type === "care-settings") return p.scope === "global" ? this.saveSettings(p.changes) : this.savePatientSettings(p.patientId, p.changes);
  }
  static isProposal(type) { return CARE_PROPOSALS.includes(type); }

  // ---------- read models ----------
  overview() {
    const midnight = new Date(this.now()); midnight.setHours(0, 0, 0, 0);
    const today = midnight.toISOString();
    const one = (sql, ...args) => this.db.prepare(sql).get(...args).n;
    const channels = this.channels.public();
    const settings = this.settings();
    return {
      stats: {
        messagesToday: one("SELECT COUNT(*) n FROM patient_messages WHERE direction='in' AND time>=?", today),
        pending: one("SELECT COUNT(*) n FROM care_message_state WHERE status IN ('pending','unassigned','drafted','alerted','failed')"),
        unassigned: one("SELECT COUNT(*) n FROM care_message_state WHERE status='unassigned'"),
        openAlerts: one("SELECT COUNT(*) n FROM care_alerts WHERE status='open'"),
        urgentAlerts: one("SELECT COUNT(*) n FROM care_alerts WHERE status='open' AND level='urgent'"),
        autoRepliedToday: one("SELECT COUNT(*) n FROM care_replies WHERE mode='auto' AND status='sent' AND updated_at>=?", today),
        drafts: one("SELECT COUNT(*) n FROM care_replies WHERE status='draft'"),
        activeCampaigns: one("SELECT COUNT(*) n FROM care_campaigns WHERE status='active'"),
        pendingActions: one(`SELECT COUNT(*) n FROM pending_actions WHERE status='pending' AND type IN (${CARE_PROPOSALS.map(() => "?").join(",")})`, ...CARE_PROPOSALS),
      },
      channels: channels.channels,
      notifier: channels.notifier,
      kfSync: this.kfStatus(),
      settings: { autoReply: settings.autoReply },
      processing: { enabled: settings.processing.enabled, modelConsent: settings.processing.modelConsent, modelReady: this.modelReady(), modelConfigured: Boolean(this.provider()), lastTickAt: this.lastTickAt, lastError: this.lastError },
    };
  }
  inbox({ status, level, patientId, limit = 100 } = {}) {
    const where = ["1=1"], args = [];
    if (status) {
      const list = String(status).split(",");
      where.push(`s.status IN (${list.map(() => "?").join(",")})`); args.push(...list);
    }
    if (level) { where.push("s.level=?"); args.push(level); }
    if (patientId) { where.push("m.patient_id=?"); args.push(patientId); }
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = this.db.prepare(`SELECT m.*, s.status s_status, s.level, s.category, s.reasons, s.reply_id, s.alert_id FROM care_message_state s
      JOIN patient_messages m ON m.id=s.message_id WHERE ${where.join(" AND ")} ORDER BY m.time DESC, m.id DESC LIMIT ?`).all(...args, n);
    return { messages: rows.map((r) => this.messageView(r)) };
  }
  patientThread(patientId, limit = 50) {
    this.patients.row(identifier(patientId));
    const rows = this.db.prepare(`SELECT m.*, s.status s_status, s.level, s.category, s.reasons, s.reply_id, s.alert_id FROM patient_messages m
      LEFT JOIN care_message_state s ON s.message_id=m.id WHERE m.patient_id=? ORDER BY m.time DESC, m.id DESC LIMIT ?`).all(patientId, Math.min(Number(limit) || 50, 200));
    return { patientId, patientName: this.patientName(patientId), settings: this.patientSettings(patientId), messages: rows.reverse().map((r) => this.messageView(r)),
      replies: this.replies({ patientId }).replies.slice(0, 20), campaigns: this.campaigns({ patientId }).campaigns };
  }
  replies({ status, patientId } = {}) {
    const where = ["1=1"], args = [];
    if (status) { const list = String(status).split(","); where.push(`status IN (${list.map(() => "?").join(",")})`); args.push(...list); }
    if (patientId) { where.push("patient_id=?"); args.push(patientId); }
    return { replies: this.db.prepare(`SELECT * FROM care_replies WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 200`).all(...args).map((r) => ({ ...replyRow(r), patientName: this.patientName(r.patient_id) })) };
  }
  alerts({ status, patientId } = {}) {
    const where = ["1=1"], args = [];
    if (status) { const list = String(status).split(","); where.push(`status IN (${list.map(() => "?").join(",")})`); args.push(...list); }
    if (patientId) { where.push("patient_id=?"); args.push(patientId); }
    return { alerts: this.db.prepare(`SELECT id FROM care_alerts WHERE ${where.join(" AND ")} ORDER BY CASE level WHEN 'urgent' THEN 0 ELSE 1 END, created_at DESC LIMIT 200`).all(...args).map((r) => this.alert(r.id)) };
  }
  campaigns({ status, patientId } = {}) {
    const where = ["1=1"], args = [];
    if (status) { where.push("status=?"); args.push(status); }
    if (patientId) { where.push("patient_id=?"); args.push(patientId); }
    return { campaigns: this.db.prepare(`SELECT id FROM care_campaigns WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 200`).all(...args).map((r) => this.campaign(r.id)) };
  }

  // ---------- lifecycle ----------
  track(promise) {
    const p = Promise.resolve(promise).catch((error) => { this.lastError = error.message; }).finally(() => this.pendingWork.delete(p));
    this.pendingWork.add(p);
    return p;
  }
  kick() {
    if (!this.timer || this.stopped || this.kickScheduled) return;
    this.kickScheduled = true;
    setImmediate(() => { this.kickScheduled = false; if (!this.stopped) this.track(this.tick()); });
  }
  tick() {
    if (this.ticking) { this.again = true; return this.ticking; }
    this.ticking = (async () => {
      try {
        do { this.again = false; await this.runOnce(); } while (this.again && !this.stopped);
      } finally { this.ticking = null; }
    })();
    return this.ticking;
  }
  async runOnce() {
    const kfPull = this.pollKf();
    if (kfPull) await kfPull;
    this.discover();
    const processing = this.settings().processing.enabled;
    if (processing) {
      for (const row of this.db.prepare("SELECT message_id FROM care_message_state WHERE status='pending' ORDER BY message_id LIMIT 10").all()) {
        if (this.stopped) return;
        try { await this.processMessage(row.message_id); }
        catch (error) { this.lastError = error.message; this.setState(row.message_id, { status: "failed", reasons: [error.message] }); }
      }
      for (const row of this.db.prepare("SELECT id FROM care_replies WHERE status='queued' AND (json_extract(data,'$.campaignId') IS NULL OR json_extract(data,'$.campaignId') IN (SELECT id FROM care_campaigns WHERE status='active')) ORDER BY created_at LIMIT 20").all()) {
        if (this.stopped) return;
        await this.sendReply(row.id, { auto: true });
      }
      await this.refreshMemberTasks();
      await this.runCampaigns();
      await this.escalate();
    }
    this.lastTickAt = iso(this.now());
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.track(this.tick()), this.intervalMs);
    this.timer.unref?.();
    this.kick();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }
  async drain() { await Promise.allSettled([...this.pendingWork, this.ticking]); }
}

