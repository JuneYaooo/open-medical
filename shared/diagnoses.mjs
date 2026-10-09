// Problem-list structure for diagnoses, shared by storage validation, agent
// proposals and the chart UI. New records carry an explicit status; records
// saved before statuses existed fall back to name-based inference so old
// charts group the same way without rewriting stored data.

export const DIAGNOSIS_STATUS = ["confirmed", "suspected", "finding", "needs_review"];

export const DIAGNOSIS_STATUS_LABELS = {
  confirmed: "确诊与明确问题",
  suspected: "疑似与待排",
  finding: "影像与检验发现",
  needs_review: "待核对",
};

export const DIAGNOSIS_STATUS_SHORT = {
  confirmed: "确诊",
  suspected: "疑似待排",
  finding: "影像/检验发现",
  needs_review: "待核对",
};

// Order matters: needs_review phrases (待核对/不一致) beat hedging words
// (考虑/可能), so "低级别滤泡性淋巴瘤（待核对：与病理不一致）" stays a
// review item even though the core name looks confirmed. OCR/歧义 mentions
// only count outside parentheses — "滤泡性淋巴瘤（…确诊年份OCR不可读）" is
// still the confirmed diagnosis with a reading caveat, while "脾脏大小…OCR
// 歧义，待核对" questions the entry itself.
const NEEDS_REVIEW_CORE = /待核对|待复核|待确认|待病理|待明确|OCR|歧义|进行中|见清单页/;
const NEEDS_REVIEW_PAREN = /待核对|待复核|待确认|不一致/;
const SUSPECTED_PATTERN = /考虑|疑似|待排|不能除外|可能|倾向|暂拟/;
const FINDING_PATTERN = /囊肿|结石|钙化|退行|脂肪浸润|许莫|血管瘤|条索|索条|条影|斑片|斑点|斑影|斑结索灶|磨玻璃|结节(?!病)|密度欠|增大|肥大|扩大|扩张|隆起|增生|随诊/;

const stripParens = (name) => name.replace(/[（(][^（）()]*[）)]/g, "");
const parenContents = (name) =>
  [...name.matchAll(/[（(]([^（）()]*)[）)]/g)].map((match) => match[1]).join("；");

export function diagnosisStatus(item) {
  if (item && typeof item === "object" && DIAGNOSIS_STATUS.includes(item.status)) return item.status;
  const name = typeof item === "string" ? item : `${item?.name || ""}`;
  const core = stripParens(name);
  if (NEEDS_REVIEW_CORE.test(core) || NEEDS_REVIEW_PAREN.test(parenContents(name))) return "needs_review";
  if (SUSPECTED_PATTERN.test(core)) return "suspected";
  if (FINDING_PATTERN.test(core)) return "finding";
  return "confirmed";
}

// Legacy entries hold a single `source`; newer ones carry `sources`. Both
// shapes stay valid on disk, and readers always get one deduplicated list.
export function diagnosisSources(item) {
  if (!item || typeof item === "string") return [];
  const list = [
    ...(Array.isArray(item.sources) ? item.sources : []),
    ...(item.source ? [item.source] : []),
  ].map((value) => String(value).trim()).filter(Boolean);
  return [...new Set(list)];
}

const nameKey = (name) => String(name || "").toLowerCase().replace(/\s+/g, "");
const UNSET = (value) => value === undefined || value === null || value === "";

// Merge same-named entries into one problem with all of its sources ("重复
// 记录合并但保留来源"). The first entry wins for fields it already states —
// problem lists keep the original diagnosis date, later documents only fill
// gaps — so append never rewrites what the doctor already confirmed. Changing
// a stated field goes through the replace mode or the edit panel.
export function mergeDiagnoses(...groups) {
  const merged = new Map();
  for (const item of groups.flat()) {
    if (!item || typeof item === "string" || UNSET(item.name)) continue;
    const key = nameKey(item.name);
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, { ...item, name: String(item.name).trim(), __sources: diagnosisSources(item) });
      continue;
    }
    for (const [field, value] of Object.entries(item)) {
      if (field === "source" || field === "sources") continue;
      if (UNSET(value)) continue;
      if (UNSET(previous[field])) previous[field] = value;
    }
    for (const source of diagnosisSources(item)) {
      if (!previous.__sources.includes(source)) previous.__sources.push(source);
    }
  }
  return [...merged.values()].map(({ __sources, ...item }) => {
    delete item.source;
    delete item.sources;
    if (!__sources.length) return item;
    return { ...item, source: __sources[0], sources: __sources };
  });
}

const STATUS_ORDER = ["confirmed", "suspected", "finding", "needs_review"];

// Confirmed problems first, then hedges and incidental findings — the order
// used wherever only the first few diagnoses fit (overview, model brief,
// case-library primary diagnosis).
export function sortDiagnoses(list) {
  const rank = (item) => STATUS_ORDER.indexOf(diagnosisStatus(item));
  return [...(list || [])].sort((a, b) =>
    rank(a) - rank(b) ||
    String(typeof a === "string" ? "" : a?.date || "9999").localeCompare(String(typeof b === "string" ? "" : b?.date || "9999")) ||
    (typeof a === "string" ? a : a?.name || "").localeCompare(typeof b === "string" ? b : b?.name || ""));
}

const UNDATED = "9999";

// Grouped, date-sorted sections for the chart problem list.
export function groupDiagnoses(list) {
  const groups = STATUS_ORDER.map((status) => ({
    status,
    label: DIAGNOSIS_STATUS_LABELS[status],
    items: [],
  }));
  const byStatus = new Map(groups.map((group) => [group.status, group]));
  for (const item of list || []) {
    const entry = typeof item === "string" ? { name: item } : item;
    if (!entry?.name) continue;
    byStatus.get(diagnosisStatus(entry)).items.push(entry);
  }
  for (const group of groups) {
    group.items.sort((a, b) =>
      String(a.date || UNDATED).localeCompare(String(b.date || UNDATED)) ||
      String(a.name || "").localeCompare(String(b.name || "")));
  }
  return groups.filter((group) => group.items.length);
}
