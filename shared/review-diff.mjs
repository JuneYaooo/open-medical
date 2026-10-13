// Shared by the editor, persistence and evaluation. Item counts and field-level
// signals deliberately have different denominators.
export const REVIEW_LISTS = [
  "diagnoses",
  "medications",
  "labs",
  "visits",
  "allergies",
  "groups",
  "tags",
];
export const TERM_GROUPS = [
  ["HTN", "高血压"],
  ["DM", "糖尿病"],
  ["T2DM", "2型糖尿病", "2 型糖尿病"],
  ["CKD", "慢性肾脏病", "慢性肾病"],
];
export const normalizeReviewText = (v) =>
  String(v ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "");
export function equivalentTerm(a, b) {
  return TERM_GROUPS.some(
    (g) =>
      g.some((v) => normalizeReviewText(v) === normalizeReviewText(a)) &&
      g.some((v) => normalizeReviewText(v) === normalizeReviewText(b)),
  );
}
const norm = normalizeReviewText;
const canonical = (v) =>
  norm(TERM_GROUPS.find((g) => g.some((t) => norm(t) === norm(v)))?.[0] ?? v);
const equal = (a, b) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");
export function bigramSimilarity(a, b) {
  const grams = (v) => {
    const s = norm(v);
    return new Set(
      s.length < 2
        ? [s]
        : Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)),
    );
  };
  const x = grams(a),
    y = grams(b),
    union = new Set([...x, ...y]);
  return union.size ? [...x].filter((v) => y.has(v)).length / union.size : 1;
}
export function itemKey(section, item) {
  if (typeof item === "string") return norm(item);
  if (section === "labs") return `${norm(item.item)}|${item.date || ""}`;
  if (section === "visits")
    return `${item.date || ""}|${norm(item.reason).slice(0, 10)}`;
  return canonical(item.name);
}
export function alignReviewItems(section, before = [], after = []) {
  const pairs = [],
    remaining = new Set(after.map((_, i) => i)),
    unmatched = [];
  for (const [i, item] of before.entries()) {
    const candidates = [...remaining].filter(
      (j) => itemKey(section, item) === itemKey(section, after[j]),
    );
    const exact = candidates.find((j) => equal(item, after[j]));
    const j = exact ?? candidates[0];
    if (j !== undefined) {
      pairs.push([i, j]);
      remaining.delete(j);
    } else unmatched.push(i);
  }
  const scores = [];
  for (const i of unmatched)
    for (const j of remaining) {
      const score = bigramSimilarity(
        itemKey(section, before[i]),
        itemKey(section, after[j]),
      );
      if (score >= 0.6) scores.push({ i, j, score });
    }
  scores.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
  const matched = new Set();
  for (const { i, j } of scores)
    if (!matched.has(i) && remaining.has(j)) {
      pairs.push([i, j]);
      matched.add(i);
      remaining.delete(j);
    }
  for (const i of unmatched) if (!matched.has(i)) pairs.push([i, null]);
  for (const j of remaining) pairs.push([null, j]);
  return pairs.sort((a, b) => (a[0] ?? Infinity) - (b[0] ?? Infinity));
}
export function reviewDiff(before = {}, after = {}, { reasons = {} } = {}) {
  const diffs = [];
  const push = (d) =>
    diffs.push({
      ...d,
      reason: reasons[`${d.section}:${d.beforeIndex}`] || "",
    });
  for (const section of REVIEW_LISTS) {
    for (const [i, j] of alignReviewItems(
      section,
      before[section] || [],
      after[section] || [],
    )) {
      const a = i === null ? undefined : before[section][i],
        b = j === null ? undefined : after[section][j];
      const base = {
        section,
        beforeIndex: i,
        afterIndex: j,
        itemBefore: a,
        itemAfter: b,
      };
      if (i === null || j === null) {
        push({
          ...base,
          op: i === null ? "add" : "delete",
          field: "",
          before: a ?? null,
          after: b ?? null,
        });
        continue;
      }
      const fields =
        typeof a === "object"
          ? [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
              (f) => !["source", "sources", "habitIds"].includes(f),
            )
          : ["text"];
      for (const field of fields) {
        const x = field === "text" ? a : a[field],
          y = field === "text" ? b : b[field];
        if (!equal(x, y))
          push({
            ...base,
            op: "modify",
            field,
            before: x ?? "",
            after: y ?? "",
          });
      }
    }
  }
  for (const field of ["name", "gender", "birthYear", "phone", "patientNumber"])
    if (!equal(before[field], after[field]))
      push({
        section: "identity",
        op: "modify",
        field,
        before: before[field] ?? "",
        after: after[field] ?? "",
      });
  if (!equal(before.allergyStatus, after.allergyStatus))
    push({
      section: "allergy",
      op: "modify",
      field: "allergyStatus",
      before: before.allergyStatus ?? "",
      after: after.allergyStatus ?? "",
    });
  const a = before.clinicalSummary?.text || "",
    b = after.clinicalSummary?.text || "";
  if (a !== b)
    push({
      section: "clinicalSummary",
      op: "modify",
      field: "text",
      before: a,
      after: b,
      charDelta: b.length - a.length,
      lengthRatio: a.length ? b.length / a.length : null,
    });
  return diffs;
}
export function reviewCounts(before, diffs) {
  const unique = new Map(
    diffs.map((d) => [
      `${d.section}:${d.op}:${d.beforeIndex ?? d.afterIndex ?? d.field}`,
      d,
    ]),
  );
  const items = [...unique.values()];
  const aiItems =
    REVIEW_LISTS.reduce((n, s) => n + (before[s]?.length || 0), 0) +
    Number(Boolean(before.clinicalSummary?.text)) +
    Number(Boolean(before.allergyStatus)) +
    ["name", "gender", "birthYear", "phone", "patientNumber"].filter(
      (k) => before[k] !== undefined && before[k] !== null && before[k] !== "",
    ).length;
  return {
    aiItems,
    modified: items.filter((d) => d.op === "modify").length,
    added: items.filter((d) => d.op === "add").length,
    deleted: items.filter((d) => d.op === "delete").length,
    total: items.length,
    rate: aiItems ? items.length / aiItems : null,
  };
}
export function diffSummary(diffs) {
  return diffs
    .map(
      (d) =>
        `${d.section} ${d.op} ${d.field}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}${d.reason ? `（${d.reason}）` : ""}`,
    )
    .join("\n");
}
export function paragraphDiff(before = "", after = "") {
  const a = before.split(/\n\s*\n/).filter(Boolean),
    b = after.split(/\n\s*\n/).filter(Boolean);
  return alignReviewItems("tags", a, b)
    .filter(([i, j]) => i === null || j === null || a[i] !== b[j])
    .map(([i, j]) => ({
      section: "artifact",
      op: i === null ? "add" : j === null ? "delete" : "modify",
      field: "paragraph",
      beforeIndex: i,
      afterIndex: j,
      before: i === null ? "" : a[i],
      after: j === null ? "" : b[j],
      reason: "",
    }));
}

export function normalizedEditDistance(a = "", b = "") {
  if (a === b) return 0;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(
        Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])),
      );
    row = next;
  }
  return row[b.length] / Math.max(1, a.length, b.length);
}
