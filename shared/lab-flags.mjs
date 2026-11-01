import { LAB_ENTRIES } from "./lab-reference.mjs";

// Abnormal-value hints for the chart views.
//
// The range printed on the original report always wins. Only when a record has
// no report range do we fall back to the built-in adult reference table, and
// the result says so (source: "generic") so the UI can label it. A hint is
// never produced when the value, unit or applicable range is ambiguous: a
// missing flag means "not judged", not "normal".

const DASH = /\s*(?:–|—|-|~|～|至|到)\s*/;
const NUMBER = "(-?\\d+(?:\\.\\d+)?)";

function stripNotes(text) {
  return String(text || "")
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/[%％]/g, "")
    .trim();
}

// One segment of a range: "3.5–5.3", "<10", "≥1.0", "≤ 0.5".
function parseSegment(segment) {
  const text = stripNotes(segment).replace(/^(?:男|女|男性|女性)\s*[:：]?\s*/, "");
  const bounded = text.match(new RegExp(`^${NUMBER}${DASH.source}${NUMBER}`));
  if (bounded) {
    const low = Number(bounded[1]), high = Number(bounded[2]);
    return low <= high ? { low, high } : null;
  }
  const upper = text.match(new RegExp(`^(?:<|＜|≤|<=)\\s*${NUMBER}`));
  if (upper) return { low: null, high: Number(upper[1]) };
  const lower = text.match(new RegExp(`^(?:>|＞|≥|>=)\\s*${NUMBER}`));
  if (lower) return { low: Number(lower[1]), high: null };
  return null;
}

function segmentGender(segment) {
  if (/女/.test(segment)) return "female";
  if (/男/.test(segment)) return "male";
  return "";
}

// Parse a printed range. Gender-specific ranges ("男 57–97 / 女 41–73",
// "9–50（男）/ 7–35（女）") resolve only when the patient's gender is known.
// Multi-part ranges without gender markers (e.g. "11–13 秒 / INR ≈1.0") are
// ambiguous and return null.
export function parseReferenceRange(text, gender = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const segments = raw.split(/\s*[/／;；]\s*/).filter(Boolean);
  if (segments.length === 1) return parseSegment(segments[0]);
  const gendered = segments.map((segment) => ({ segment, gender: segmentGender(segment) }));
  if (gendered.some((entry) => !entry.gender)) return null;
  const match = gendered.find((entry) => entry.gender === gender);
  return match ? parseSegment(match.segment) : null;
}

export function normalizeName(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[\s·・_-]/g, "");
}

export function normalizeUnit(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s/g, "")
    .replace(/[×x*]/g, "")
    .replace(/10\^?⁹|10\^9|10e9/g, "10^9")
    .replace(/10\^?¹²|10\^12|10e12/g, "10^12")
    .replace(/μ|µ|u(?=mol)/g, "u")
    .replace(/％/g, "%");
}

const ENTRY_INDEX = (() => {
  const index = new Map();
  for (const entry of LAB_ENTRIES) {
    const keys = [entry.name, ...entry.name.split(/\s+/), ...entry.aliases];
    for (const key of keys) {
      const normalized = normalizeName(key);
      if (normalized && !index.has(normalized)) index.set(normalized, entry);
    }
  }
  return index;
})();

// Exact alias/name match only: "血糖" must not lend the fasting range to
// "餐后2小时血糖".
export function genericLabEntry(item) {
  return ENTRY_INDEX.get(normalizeName(item)) || null;
}

function unitMatches(entryUnit, recordUnit) {
  const record = normalizeUnit(recordUnit);
  if (!record) return false;
  const options = String(entryUnit || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .split(/\s*或\s*|\s+\/\s+/)
    .map(normalizeUnit)
    .filter(Boolean);
  return options.some((unit) => unit === record);
}

function judge(value, range) {
  if (!range) return "";
  if (range.low !== null && value < range.low) return "low";
  if (range.high !== null && value > range.high) return "high";
  return "normal";
}

/**
 * @returns {{ flag: "high"|"low"|"normal"|"", range: string, source: "report"|"generic"|"" }}
 */
export function labFlag(record = {}, { gender = "" } = {}) {
  const value = typeof record.value === "number" ? record.value : Number.NaN;
  const reportRange = String(record.referenceRange || "").trim();
  if (reportRange) {
    const parsed = parseReferenceRange(reportRange, gender);
    return {
      flag: Number.isFinite(value) ? judge(value, parsed) : "",
      range: reportRange,
      source: "report",
    };
  }
  const entry = genericLabEntry(record.item);
  if (!entry || !unitMatches(entry.unit, record.unit)) return { flag: "", range: "", source: "" };
  const parsed = parseReferenceRange(entry.ref, gender);
  if (!parsed) return { flag: "", range: entry.ref, source: "generic" };
  return {
    flag: Number.isFinite(value) ? judge(value, parsed) : "",
    range: entry.ref,
    source: "generic",
  };
}

export const FLAG_LABEL = { high: "偏高", low: "偏低", normal: "范围内" };
export const FLAG_ARROW = { high: "↑", low: "↓", normal: "" };

// Latest dated record per item+unit, with its flag. Used by the overview,
// the labs table and the patient list so every view agrees on "abnormal".
export function latestFlaggedLabs(labs = [], { gender = "" } = {}) {
  const groups = new Map();
  for (const record of labs) {
    if (!record?.item) continue;
    const key = JSON.stringify([record.item, record.unit || ""]);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(record.date || "") ? record.date : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...record, date });
  }
  const rows = [];
  for (const [key, records] of groups) {
    const dated = records.filter((record) => record.date).sort((a, b) => a.date.localeCompare(b.date));
    const latestDate = dated.at(-1)?.date || "";
    const latest = latestDate ? dated.filter((record) => record.date === latestDate) : [];
    // Same-day conflicting values are left unjudged.
    const values = [...new Set(latest.map((record) => record.value))];
    const record = latest.length && values.length === 1 ? latest[0] : null;
    const result = record ? labFlag(record, { gender }) : { flag: "", range: "", source: "" };
    rows.push({ key, item: records[0].item, unit: records[0].unit || "", date: latestDate, value: record ? record.value : null, ...result });
  }
  return rows;
}

export function abnormalLabs(labs = [], options = {}) {
  return latestFlaggedLabs(labs, options)
    .filter((row) => row.flag === "high" || row.flag === "low")
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.item.localeCompare(b.item, "zh-CN"));
}
