import { check, string } from "../errors.mjs";
import { localCalendarDate } from "../../shared/calendar-date.mjs";

export const KNOWLEDGE_STATES = ["unreviewed", "reviewed", "retired"];
// Older installations used reviewed sources for external replies. Preserve only that
// existing scope; new documents remain private until explicitly enabled.
export function externalUseAllowed(doc) {
  return doc.reviewStatus !== "retired" && (doc.allowExternalUse ?? doc.reviewStatus === "reviewed");
}
// The doctor's raw per-document choice: true / false, or null when never set.
// knowledgeMetadata() replaces allowExternalUse with the computed value, so the
// raw choice travels separately as externalUseChoice.
export function externalUseChoice(doc) {
  if (doc && "externalUseChoice" in doc) return doc.externalUseChoice;
  return typeof doc?.allowExternalUse === "boolean" ? doc.allowExternalUse : null;
}
// Collection-level authorization (the Feishu avatar): every active document in
// a ticked collection is usable unless the doctor ticked "不让飞书分身使用".
// This is a separate flag: allowExternalUse is reset automatically on every
// source/text edit, so reusing it would silently drop documents from the avatar.
export function collectionUseAllowed(doc) {
  return doc.reviewStatus !== "retired" && doc.avatarExcluded !== true;
}
export function knowledgeMetadata(doc, now = Date.now()) {
  const status = doc.reviewStatus || "unreviewed";
  const due = Boolean(doc.reviewDueDate && doc.reviewDueDate < localCalendarDate(now));
  return { allowExternalUse: externalUseAllowed(doc), externalUseChoice: externalUseChoice(doc), avatarExcluded: doc.avatarExcluded === true, sourceUrl: doc.sourceUrl || "", edition: doc.edition || "", reviewStatus: status,
    reviewedAt: doc.reviewedAt || null, reviewDueDate: doc.reviewDueDate || "", reviewNote: doc.reviewNote || "",
    reviewDue: due, statusLabel: status === "retired" ? "已停用" : "使用中" };
}
export function optionalSourceUrl(value) {
  if (value === undefined || value === null || value === "") return "";
  const raw = string(value, "来源链接", 2000);
  let url;
  try { url = new URL(raw); } catch { /* validated below */ }
  check(url && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password, "INVALID_INPUT", "来源须为不含账号密码的 HTTP/HTTPS 链接");
  return url.href;
}
export function optionalReviewDate(value) {
  if (value === undefined || value === null || value === "") return "";
  check(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, "INVALID_INPUT", "复核日期须为有效的 YYYY-MM-DD");
  return value;
}
