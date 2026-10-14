// Evaluation-owned vocabulary and physical conversions. Never import product rule lists.
export const TERMS = [
  ["HTN", "高血压"],
  ["T2DM", "2型糖尿病", "DM2", "糖尿病2型", "DM"],
  ["CKD", "慢性肾脏病"],
  ["COPD", "慢性阻塞性肺疾病"],
  ["AF", "心房颤动", "房颤"],
  ["CHD", "冠心病"],
  ["NAFLD", "非酒精性脂肪性肝病", "脂肪肝"],
];
export const FREQUENCIES = [
  ["qd", "每日一次"],
  ["bid", "每日两次"],
  ["tid", "每日三次"],
  ["qod", "隔日一次"],
  ["qw", "每周一次"],
];
export const norm = (x) =>
  String(x ?? "")
    .normalize("NFKC")
    .replace(/\s/g, "")
    .toLowerCase();
export const termGroup = (x) =>
  TERMS.find((g) => g.some((t) => norm(t) === norm(x)));
export const canonical = (x) => norm(termGroup(x)?.[1] ?? x);
export const frequency = (x) =>
  norm(FREQUENCIES.find((g) => g.some((t) => norm(t) === norm(x)))?.[0] ?? x);
export function isoDate(value) {
  const s = String(value ?? "");
  let m = s.match(/^(\d{2,4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/);
  if (!m) {
    const short = s.match(/^(\d{1,2})月(\d{1,2})日$/);
    if (short) m = [s, "2026", ...short.slice(1)];
  }
  if (!m) return s;
  return `${m[1].length === 2 ? "20" : ""}${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}
export function dateText(value, format) {
  const s = isoDate(value),
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return value;
  const [, y, mo, d] = m;
  return format === "zh"
    ? `${y}年${+mo}月${+d}日`
    : format === "slash"
      ? `${y}/${+mo}/${+d}`
      : s;
}
export const LAB_UNITS = {
  血糖: { "mmol/l": 1, "mg/dl": 1 / 18 },
  肌酐: { "μmol/l": 1, "mg/dl": 88.4 },
};
export function convertLab(lab, unit) {
  const units = LAB_UNITS[lab.item],
    from = units?.[norm(lab.unit)],
    to = units?.[norm(unit)];
  if (!from || !to) return { ...lab };
  return {
    ...lab,
    unit,
    value: Number(((Number(lab.value) * from) / to).toFixed(3)),
  };
}
export function renderLearningGold(
  gold,
  persona,
  { traps = true, omitRules = [] } = {},
) {
  const out = structuredClone(gold);
  delete out.historyFacts;
  out.tags = [...(gold.tags || [])];
  out.note = (gold.historyFacts || []).map((h) => h.text).join("；");
  // A fact-only source has no canonical prose style. The neutral rendering is
  // reverse chronological; ablation checks each preference against that baseline.
  let cap = Infinity,
    order = "reverse",
    proseFormat = null;
  // The patient API requires ISO structural dates. Date preferences apply to
  // dated prose; the transport never submits invalid schema values.
  const sourceDates = new Map(
    ["diagnoses", "labs", "visits"].flatMap((s) =>
      (gold[s] || []).map((v) => [isoDate(v.date), v.date]),
    ),
  );
  for (const s of ["diagnoses", "labs", "visits"])
    out[s] = (out[s] || []).map((v) => ({ ...v, date: isoDate(v.date) }));
  const displayDate = (value) =>
    proseFormat
      ? dateText(value, proseFormat)
      : (sourceDates.get(value) ?? value);
  for (const r of persona.rules) {
    if (omitRules.includes(r.id) || (!r.learnable && !traps)) continue;
    if (r.kind === "term")
      out.diagnoses = out.diagnoses.map((d) => ({
        ...d,
        name: termGroup(d.name)?.[r.direction === "full" ? 1 : 0] ?? d.name,
      }));
    if (r.kind === "unit")
      out.labs = out.labs.map((l) =>
        l.item === r.item ? convertLab(l, r.to) : l,
      );
    if (r.kind === "date") proseFormat = r.format;
    if (r.kind === "frequency")
      out.medications = out.medications.map((m) => ({
        ...m,
        frequency:
          FREQUENCIES.find((g) =>
            g.some((v) => norm(v) === norm(m.frequency)),
          )?.[r.direction === "full" ? 1 : 0] ?? m.frequency,
      }));
    if (r.kind === "exclude")
      out.diagnoses = out.diagnoses.filter(
        (d) =>
          !(
            d.status === "finding" &&
            r.names.some((n) => canonical(n) === canonical(d.name))
          ),
      );
    if (r.kind === "omission")
      out.tags.push(
        ...(gold.historyFacts || [])
          .filter((h) => h.kind === r.history)
          .map((h) => h.text),
      );
    if (r.kind === "summary-cap") cap = r.max;
    if (r.kind === "summary-order") order = r.order;
    if (r.kind === "trap-status")
      out.diagnoses = out.diagnoses.map((d) =>
        d.status === r.from ? { ...d, status: r.to } : d,
      );
    if (r.kind === "trap-dose")
      out.medications = out.medications.map((m) => ({ ...m, dose: r.to }));
  }
  const visits = [...out.visits].sort(
    (a, b) =>
      isoDate(a.date).localeCompare(isoDate(b.date)) *
      (order === "reverse" ? -1 : 1),
  );
  const diagnosis = `主要问题：${out.diagnoses.map((d) => `${d.name}（${d.status}）`).join("、")}。`;
  const events = visits
    .map((v) => `${displayDate(v.date)} ${v.reason}：${v.note}。`)
    .join("");
  const therapy = `用药：${out.medications.map((m) => `${m.name}${m.dose} ${m.frequency}`).join("；")}。`;
  const results = `检验：${out.labs.map((l) => `${displayDate(l.date)} ${l.item}${l.value}${l.unit}`).join("；")}。${(gold.historyFacts || []).map((h) => h.text).join("；")}。`;
  const text =
    (order === "diagnosis-first"
      ? diagnosis + events + therapy
      : order === "therapy-first"
        ? therapy + events + diagnosis
        : events + diagnosis + therapy) + results;
  out.clinicalSummary = {
    text: [...text].slice(0, cap).join(""),
    source: "本次合成资料",
  };
  return out;
}
export function ruleCoverage(golds, persona) {
  const result = {};
  for (const r of persona.rules)
    result[r.id] = golds.filter(
      (g) =>
        JSON.stringify(renderLearningGold(g, persona)) !==
        JSON.stringify(renderLearningGold(g, persona, { omitRules: [r.id] })),
    ).length;
  return result;
}
export function seeded(seed) {
  let v = seed >>> 0;
  return () => (v = (1664525 * v + 1013904223) >>> 0) / 4294967296;
}
export function shuffle(items, seed) {
  const out = [...items],
    rand = seeded(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
