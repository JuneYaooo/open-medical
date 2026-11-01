import { check } from "../errors.mjs";
import {
  CROSS_REACTIVITY,
  DRUG_ALIASES,
  DRUG_CLASSES,
  INTERACTION_RULES,
  MISSED_ALERT_NOTE,
  POPULATION_LABELS,
  REMINDER_NAME,
  SPECIAL_POPULATION_RULES,
} from "./med-safety-rules.mjs";

// Deterministic medication reminders shared by the patient risk engine, the
// patient page allergy hint and the medication_safety_check tool. Rules live
// in med-safety-rules.mjs. Results are advisory and may miss risks; every
// result carries MISSED_ALERT_NOTE and lists unrecognised drugs.
export { DRUG_ALIASES, INTERACTION_RULES, MISSED_ALERT_NOTE, REMINDER_NAME, SPECIAL_POPULATION_RULES };

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const normalizeName = (value) => String(value || "").trim().toLowerCase();

const ALIASES = DRUG_ALIASES
  .map(([alias, generic]) => [normalizeName(alias), generic])
  .sort((a, b) => b[0].length - a[0].length);
const GENERICS = [
  ...new Set([
    ...Object.values(DRUG_CLASSES).flatMap((cls) => cls.members || []),
    ...DRUG_ALIASES.map(([, generic]) => generic),
  ]),
].sort((a, b) => b.length - a.length);
const CLASS_ENTRIES = Object.entries(DRUG_CLASSES);

// Every generic named in a raw medication string. Brand names map to their
// generic; a generic found only inside a longer one ("氨氯地平" inside
// "左氨氯地平") is dropped. Combination products yield several generics.
function findGenerics(raw) {
  let text = normalizeName(raw);
  const found = [];
  for (const [alias, generic] of ALIASES)
    if (text.includes(alias)) {
      found.push(generic);
      text = text.replaceAll(alias, " ");
    }
  for (const generic of GENERICS) {
    const needle = generic.toLowerCase();
    if (text.includes(needle)) {
      found.push(generic);
      text = text.replaceAll(needle, " ");
    }
  }
  return [...new Set(found)];
}

function classesFor(raw, generics) {
  const text = normalizeName(raw);
  const keys = new Set();
  for (const [key, cls] of CLASS_ENTRIES) {
    if (generics.some((generic) => cls.members?.includes(generic))) keys.add(key);
    else if (cls.patterns?.some((pattern) => text.includes(pattern) || generics.some((g) => g.includes(pattern))))
      keys.add(key);
  }
  return keys;
}

function toEntries(medications) {
  return medications
    .map((med) => (typeof med === "string" ? med : med?.name))
    .filter((name) => typeof name === "string" && name.trim())
    .map((raw) => {
      const generics = findGenerics(raw);
      const classes = classesFor(raw, generics);
      return { raw, generics, canonical: generics[0] || raw.trim(), classes };
    });
}

// Canonical substance for one raw medication string (first generic found).
export function canonicalDrugName(name) {
  return findGenerics(name)[0] || String(name || "").trim();
}

// Does an entry match a rule ref ("class:<key>" or a generic name)? Returns
// the generics that matched, so a pair can require two different drugs.
function refMatches(entry, ref) {
  if (ref.startsWith("class:")) {
    const key = ref.slice(6);
    if (!entry.classes.has(key)) return [];
    const members = DRUG_CLASSES[key]?.members || [];
    const hits = entry.generics.filter((g) => members.includes(g));
    return hits.length ? hits : [entry.canonical];
  }
  return entry.generics.includes(ref) ? [ref] : [];
}

function sideMatches(entries, refs) {
  const hits = [];
  for (const entry of entries)
    for (const ref of refs)
      for (const generic of refMatches(entry, ref)) hits.push({ entry, generic });
  return hits;
}

function interactionsFor(entries) {
  const out = [];
  for (const rule of INTERACTION_RULES) {
    const left = sideMatches(entries, rule.a);
    if (!left.length) continue;
    const right = sideMatches(entries, rule.b);
    const pairs = [];
    for (const a of left)
      for (const b of right)
        if (a.generic !== b.generic) pairs.push([a, b]);
    if (!pairs.length) continue;
    const medications = [...new Set(pairs.flat().map((hit) => hit.entry.raw))];
    out.push({
      ruleKey: rule.key,
      severity: rule.severity,
      title: rule.title,
      message: rule.message,
      medications,
    });
  }
  return out;
}

function allergyMatchesFor(entries, allergies) {
  const best = new Map();
  const add = (match) => {
    const id = `${match.allergy}\u0000${match.medication}`;
    const current = best.get(id);
    if (!current || SEVERITY_RANK[match.severity] < SEVERITY_RANK[current.severity]) best.set(id, match);
  };
  for (const item of allergies) {
    // 过敏可为字符串或 { substance, reaction }；只用过敏原名称匹配。
    const allergy = typeof item === "string" ? item : item?.substance || "";
    const needle = normalizeName(allergy);
    if (!needle) continue;
    const allergyGenerics = findGenerics(allergy);
    // Allergy groups the recorded allergy belongs to. A named drug brings its
    // own groups; a class term ("青霉素类", "头孢") names the group directly.
    const namedClasses = new Set();
    const memberClasses = new Set();
    for (const [key, cls] of CLASS_ENTRIES) {
      if (!cls.allergy && !CROSS_REACTIVITY.some((rule) => rule.from === key)) continue;
      if (allergyGenerics.some((g) => cls.members?.includes(g))) memberClasses.add(key);
      else if (!allergyGenerics.length && cls.allergyTerms?.some((term) => needle.includes(term.toLowerCase())))
        namedClasses.add(key);
    }
    for (const entry of entries) {
      const direct =
        entry.generics.some((g) => allergyGenerics.includes(g)) ||
        normalizeName(entry.canonical).includes(needle) ||
        normalizeName(entry.raw).includes(needle);
      if (direct) {
        add({
          allergy,
          medication: entry.raw,
          matchedGeneric: entry.canonical,
          kind: "direct",
          severity: "critical",
          message: `用药「${entry.raw}」（${entry.canonical}）与过敏史「${allergy}」匹配，请立即核对。`,
        });
        continue;
      }
      for (const key of namedClasses)
        if (entry.classes.has(key))
          add({
            allergy,
            medication: entry.raw,
            matchedGeneric: entry.canonical,
            kind: "class",
            severity: "critical",
            message: `用药「${entry.raw}」属于${DRUG_CLASSES[key].label}，与过敏史「${allergy}」匹配，请立即核对。`,
          });
      for (const key of memberClasses)
        if (DRUG_CLASSES[key].allergy && entry.classes.has(key))
          add({
            allergy,
            medication: entry.raw,
            matchedGeneric: entry.canonical,
            kind: "class",
            severity: DRUG_CLASSES[key].allergy,
            message: `用药「${entry.raw}」与过敏药物「${allergy}」同属${DRUG_CLASSES[key].label}，可能交叉过敏，请核对既往过敏反应。`,
          });
      for (const rule of CROSS_REACTIVITY)
        if ((namedClasses.has(rule.from) || memberClasses.has(rule.from)) && entry.classes.has(rule.to))
          add({
            allergy,
            medication: entry.raw,
            matchedGeneric: entry.canonical,
            kind: "cross",
            severity: rule.severity,
            message: `用药「${entry.raw}」与过敏史「${allergy}」：${rule.message}`,
          });
    }
  }
  return [...best.values()].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function duplicatesFor(entries) {
  const out = [];
  const byGeneric = new Map();
  for (const entry of entries)
    for (const generic of entry.generics.length ? entry.generics : [entry.canonical]) {
      const key = normalizeName(generic);
      byGeneric.set(key, [...(byGeneric.get(key) || []), entry.raw]);
    }
  for (const [name, raws] of byGeneric)
    if (raws.length > 1)
      out.push({
        key: name,
        kind: "same",
        medication: name,
        medications: raws,
        count: raws.length,
        severity: "warning",
        message: `「${name}」的不同写法/规格共出现 ${raws.length} 次，请核对是否重复开具。`,
      });
  for (const [key, cls] of CLASS_ENTRIES) {
    if (!cls.duplicate) continue;
    const members = entries.filter((entry) => entry.classes.has(key));
    const generics = new Set(members.flatMap((entry) => entry.generics.filter((g) => cls.members?.includes(g) || cls.patterns?.some((p) => g.includes(p)))));
    if (generics.size < 2) continue;
    out.push({
      key: `class_${key}`,
      kind: "class",
      medication: cls.label,
      medications: members.map((entry) => entry.raw),
      count: generics.size,
      severity: cls.duplicate,
      message: `同时使用 ${generics.size} 种${cls.label}（${[...generics].join("、")}），请核对是否为同类重复用药。`,
    });
  }
  return out;
}

export function evaluateMedicationSafety({ medications = [], allergies = [] } = {}) {
  check(
    Array.isArray(medications) && medications.length <= 60,
    "INVALID_INPUT",
    "用药清单最多 60 条",
  );
  check(
    Array.isArray(allergies) && allergies.length <= 20,
    "INVALID_INPUT",
    "过敏史最多 20 条",
  );
  const entries = toEntries(medications);
  const allergyMatches = allergyMatchesFor(entries, allergies);
  const interactions = interactionsFor(entries);
  const duplicates = duplicatesFor(entries);
  const unrecognized = entries
    .filter((entry) => !entry.generics.length && !entry.classes.size)
    .map((entry) => entry.raw);
  return {
    name: REMINDER_NAME,
    checked: entries.length,
    normalized: entries.map((entry) => entry.canonical),
    allergyMatches,
    interactions,
    duplicates,
    unrecognized,
    total: allergyMatches.length + interactions.length + duplicates.length,
    note: MISSED_ALERT_NOTE,
  };
}

// Special-population cautions for the current medication list.
export function specialPopulationCautions({ medications = [], populations = [] } = {}) {
  const validPopulations = Object.keys(POPULATION_LABELS);
  check(
    Array.isArray(populations) &&
      populations.length >= 1 &&
      populations.length <= validPopulations.length &&
      populations.every((p) => validPopulations.includes(p)),
    "INVALID_INPUT",
    `populations 须为以下之一或组合：${validPopulations.join("/")}`,
  );
  const entries = toEntries(medications);
  const cautions = [];
  for (const entry of entries)
    for (const rule of SPECIAL_POPULATION_RULES) {
      if (!populations.includes(rule.population)) continue;
      if (!rule.match.some((ref) => refMatches(entry, ref).length)) continue;
      if (cautions.some((c) => c.medication === entry.raw && c.population === rule.population && c.caution === rule.caution)) continue;
      cautions.push({
        medication: entry.raw,
        population: rule.population,
        populationLabel: POPULATION_LABELS[rule.population],
        caution: rule.caution,
      });
    }
  return {
    populations: populations.map((p) => POPULATION_LABELS[p]),
    cautions,
    total: cautions.length,
    note: MISSED_ALERT_NOTE,
  };
}
