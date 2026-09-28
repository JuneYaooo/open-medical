import { check } from "../errors.mjs";
import { AUTO_CATEGORIES } from "./triage.mjs";

export const DEFAULT_SETTINGS = Object.freeze({
  autoReply: { mode: "draft", categories: ["education", "admin"], disclaimer: true },
  alerts: { notifyUserIds: [], escalateAfterMinutes: 30 },
  redFlags: { extra: [] },
  processing: { enabled: true, modelConsent: false },
});
export const REPLY_STATUSES = Object.freeze(["draft", "queued", "sending", "sent", "awaiting_member", "failed", "unknown", "discarded"]);
export const MESSAGE_STATUSES = Object.freeze(["pending", "unassigned", "auto_replied", "drafted", "alerted", "recorded", "handled", "skipped", "failed"]);
const MODES = ["off", "draft", "auto"];

export function createCareSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS care_settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS care_patient_settings (patient_id TEXT PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS care_message_state (message_id INTEGER PRIMARY KEY REFERENCES patient_messages(id) ON DELETE CASCADE, patient_id TEXT, status TEXT NOT NULL, level TEXT NOT NULL, category TEXT, reasons TEXT NOT NULL, reply_id TEXT, alert_id TEXT, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS care_message_state_status ON care_message_state(status, message_id);
    CREATE TABLE IF NOT EXISTS care_replies (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, message_id INTEGER, channel TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS care_replies_status ON care_replies(status, created_at);
    CREATE TABLE IF NOT EXISTS care_alerts (id TEXT PRIMARY KEY, patient_id TEXT REFERENCES patients(id) ON DELETE CASCADE, message_id INTEGER, level TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS care_alerts_status ON care_alerts(status, created_at);
    CREATE TABLE IF NOT EXISTS care_campaigns (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, name TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
}

export function validateSettings(input, current) {
  const next = structuredClone(current);
  if (input.autoReply) {
    const a = input.autoReply;
    if (a.mode !== undefined) { check(MODES.includes(a.mode), "INVALID_INPUT", "自动回复模式须为 off/draft/auto"); next.autoReply.mode = a.mode; }
    if (a.categories !== undefined) {
      check(Array.isArray(a.categories) && a.categories.every((c) => AUTO_CATEGORIES.includes(c)), "INVALID_INPUT", `自动回复类别只能是：${AUTO_CATEGORIES.join("/")}`);
      next.autoReply.categories = [...new Set(a.categories)];
    }
    if (a.disclaimer !== undefined) { check(typeof a.disclaimer === "boolean", "INVALID_INPUT", "disclaimer 须为布尔值"); next.autoReply.disclaimer = a.disclaimer; }
  }
  if (input.alerts) {
    const a = input.alerts;
    if (a.notifyUserIds !== undefined) {
      check(Array.isArray(a.notifyUserIds) && a.notifyUserIds.length <= 20 && a.notifyUserIds.every((u) => typeof u === "string" && /^[A-Za-z0-9_\-.@]{1,64}$/.test(u)), "INVALID_INPUT", "提醒对象须为企业微信 UserID 列表");
      next.alerts.notifyUserIds = [...new Set(a.notifyUserIds)];
    }
    if (a.escalateAfterMinutes !== undefined) {
      check(Number.isInteger(a.escalateAfterMinutes) && a.escalateAfterMinutes >= 5 && a.escalateAfterMinutes <= 1440, "INVALID_INPUT", "升级间隔须为 5–1440 分钟");
      next.alerts.escalateAfterMinutes = a.escalateAfterMinutes;
    }
  }
  if (input.redFlags?.extra !== undefined) {
    const extra = input.redFlags.extra;
    check(Array.isArray(extra) && extra.length <= 50 && extra.every((w) => typeof w === "string" && w.trim().length >= 2 && w.length <= 20), "INVALID_INPUT", "自定义关注词须为 2–20 字，最多 50 个");
    next.redFlags.extra = [...new Set(extra.map((w) => w.trim()))];
  }
  if (input.processing) {
    for (const key of ["enabled", "modelConsent"]) {
      if (input.processing[key] !== undefined) {
        check(typeof input.processing[key] === "boolean", "INVALID_INPUT", `${key} 须为布尔值`);
        next.processing[key] = input.processing[key];
      }
    }
  }
  return next;
}

export function validatePatientSettings(input, current) {
  const next = { ...current };
  if (input.consent !== undefined) {
    check(typeof input.consent === "boolean", "INVALID_INPUT", "consent 须为布尔值");
    if (input.consent !== Boolean(current.consent)) next.consentAt = new Date().toISOString();
    next.consent = input.consent;
  }
  if (input.autoReplyMode !== undefined) {
    check(["inherit", ...MODES].includes(input.autoReplyMode), "INVALID_INPUT", "患者自动回复模式须为 inherit/off/draft/auto");
    next.autoReplyMode = input.autoReplyMode;
  }
  if (input.channel !== undefined) {
    check(input.channel === null || ["wecom-kf", "wecom-contact", "manual"].includes(input.channel), "INVALID_INPUT", "渠道无效");
    next.channel = input.channel;
  }
  if (input.kfExternalUserId !== undefined) {
    check(input.kfExternalUserId === null || (typeof input.kfExternalUserId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.kfExternalUserId)), "INVALID_INPUT", "微信客服客户 ID 无效");
    next.kfExternalUserId = input.kfExternalUserId;
  }
  return next;
}

export const replyRow = (row) => row && (() => {
  const data = JSON.parse(row.data);
  return { id: row.id, patientId: row.patient_id, messageId: row.message_id, channel: row.channel, mode: row.mode, status: row.status, text: row.text,
    sources: data.sources || [], reason: data.reason || "", detail: data.detail || "", model: data.model || null, externalId: data.externalId || null,
    campaignId: data.campaignId || null, stepId: data.stepId || null, screen: data.screen || null, createdAt: row.created_at, updatedAt: row.updated_at, sentAt: data.sentAt || null };
})();

export const alertRow = (row) => row && (() => {
  const data = JSON.parse(row.data);
  return { id: row.id, patientId: row.patient_id, messageId: row.message_id, level: row.level, reason: row.reason, status: row.status,
    flags: data.flags || [], notified: data.notified || [], escalatedAt: data.escalatedAt || null, note: data.note || "", createdAt: row.created_at, updatedAt: row.updated_at };
})();

export const campaignRow = (row) => row && (() => {
  const data = JSON.parse(row.data);
  return { id: row.id, patientId: row.patient_id, name: row.name, status: row.status, ...data, createdAt: row.created_at, updatedAt: row.updated_at };
})();
