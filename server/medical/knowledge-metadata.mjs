import { check, string } from "../errors.mjs";
import { localCalendarDate } from "../../shared/calendar-date.mjs";

export const KNOWLEDGE_STATES = ["unreviewed", "reviewed", "retired"];
export function knowledgeMetadata(doc, now = Date.now()) {
  const status = doc.reviewStatus || "unreviewed";
  const due = Boolean(doc.reviewDueDate && doc.reviewDueDate < localCalendarDate(now));
  return { sourceUrl: doc.sourceUrl || "", edition: doc.edition || "", reviewStatus: status,
    reviewedAt: doc.reviewedAt || null, reviewDueDate: doc.reviewDueDate || "", reviewNote: doc.reviewNote || "",
    reviewDue: due, statusLabel: status === "retired" ? "已停用" : status === "reviewed" ? due ? "来源已核对 · 到期需复核" : "来源已核对" : "来源待核对" };
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
