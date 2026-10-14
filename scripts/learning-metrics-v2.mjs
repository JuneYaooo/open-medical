import {
  canonical,
  norm,
  frequency,
  isoDate,
  renderLearningGold,
  seeded,
  termGroup,
  FREQUENCIES,
  LAB_UNITS,
  knownProductGaps,
  mentionsHistory,
} from "./learning-v2-domain.mjs";
export { renderLearningGold, shuffle } from "./learning-v2-domain.mjs";
export const mean = (xs) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const sections = {
  diagnoses: ["name", "status", "date"],
  medications: ["name", "dose", "frequency", "status"],
  labs: ["item", "value", "unit", "date"],
  visits: ["date", "reason"],
};
const keyField = (s) =>
  s === "labs" ? "item" : s === "visits" ? "reason" : "name";
function normalizedRow(s, row) {
  const r = { ...row };
  if (s === "labs" && LAB_UNITS[row.item]?.[norm(row.unit)]) {
    r.value = Number(row.value) * LAB_UNITS[row.item][norm(row.unit)];
    r.unit = row.item === "血糖" ? "mmol/L" : "μmol/L";
  }
  return {
    _sourceUnit: norm(row.unit),
    _item: row.item,
    ...Object.fromEntries(
      sections[s].map((k) => [
        k,
        k === "name" || k === "item"
          ? s === "diagnoses"
            ? diagnosisConcept(r[k])
            : canonical(r[k])
          : k === "date"
            ? isoDate(r[k])
            : k === "frequency"
              ? frequency(r[k])
              : k === "dose"
                ? norm(r[k]).replace(/^([\d.]+)g$/, (_, n) => `${+n * 1000}mg`)
                : k === "value"
                  ? Number(r[k])
                  : norm(r[k]),
      ]),
    ),
  };
}
const diagnosisConcept = (value) =>
  canonical(
    String(value ?? "").replace(/[（(](?:待排|考虑|疑似|确诊)[）)]/g, ""),
  );
const wordingSimilarity = (a, b) => {
  a = norm(a);
  b = norm(b);
  if (!a || !b) return a === b ? 1 : 0;
  if (a.includes(b) || b.includes(a))
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return 1 - editDistance(a, b);
};
const equalValue = (a, b, k) => {
  if (k === "reason") return wordingSimilarity(a[k], b[k]) >= 0.5;
  if (k !== "value") return a[k] === b[k];
  if (!Number.isFinite(a[k]) || !Number.isFinite(b[k])) return false;
  if (Math.abs(a[k] - b[k]) <= 1e-9) return true;
  if (a._sourceUnit === b._sourceUnit) return false;
  const factor = LAB_UNITS[a._item]?.[a._sourceUnit];
  if (!factor) return false;
  // Clinical conversion rounding: one to three decimals OR <=1% relative error.
  // This applies only across physical units, never to same-unit discrepancies.
  const observed = a[k] / factor,
    converted = b[k] / factor;
  return (
    [1, 2, 3].some(
      (digits) =>
        Math.abs(observed - Number(converted.toFixed(digits))) <= 1e-9,
    ) || Math.abs(a[k] - b[k]) / Math.max(Math.abs(b[k]), 1e-9) <= 0.01
  );
};
// Exact matches first, then minimum field disagreement for the same fact key.
// Unmatched keys stay missing/hallucinated; item order and product aligners have no role.
export function alignFacts(section, left, right) {
  const l = left.map((x) => normalizedRow(section, x)),
    r = right.map((x) => normalizedRow(section, x)),
    usedL = new Set(),
    usedR = new Set(),
    pairs = [];
  const candidates = [];
  for (let i = 0; i < l.length; i++)
    for (let j = 0; j < r.length; j++)
      if (
        l[i][keyField(section)] === r[j][keyField(section)] ||
        (["diagnoses", "visits"].includes(section) &&
          l[i].date &&
          l[i].date === r[j].date &&
          wordingSimilarity(l[i][keyField(section)], r[j][keyField(section)]) >=
            0.5)
      )
        candidates.push({
          i,
          j,
          cost:
            sections[section].filter((k) => !equalValue(l[i], r[j], k)).length +
            (l[i].date === r[j].date ? 0 : 2) +
            (1 -
              wordingSimilarity(
                l[i][keyField(section)],
                r[j][keyField(section)],
              )),
        });
  candidates.sort((a, b) => a.cost - b.cost || a.i - b.i || a.j - b.j);
  for (const { i, j } of candidates)
    if (!usedL.has(i) && !usedR.has(j)) {
      pairs.push([i, j]);
      usedL.add(i);
      usedR.add(j);
    }
  left.forEach((_, i) => {
    if (!usedL.has(i)) pairs.push([i, null]);
  });
  right.forEach((_, j) => {
    if (!usedR.has(j)) pairs.push([null, j]);
  });
  return pairs;
}
function excluded(d, persona) {
  return (
    d.status === "finding" &&
    persona?.rules.some(
      (r) =>
        r.kind === "exclude" &&
        r.names.some((n) => canonical(n) === canonical(d.name)),
    )
  );
}
export function factualMetrics(draft, gold, persona) {
  let predicted = 0,
    expected = 0,
    correct = 0;
  const disagreements = [];
  for (const [s, fields] of Object.entries(sections)) {
    const left = draft[s] || [],
      right = gold[s] || [];
    predicted += left.length;
    for (const [i, j] of alignFacts(s, left, right)) {
      const optional =
        s === "diagnoses" && j !== null && excluded(right[j], persona);
      if (!optional || i !== null) {
        if (j !== null) expected++;
      }
      if (i === null) {
        if (!optional)
          disagreements.push({
            section: s,
            kind: "missing",
            expected: right[j],
          });
        continue;
      }
      if (j === null) {
        disagreements.push({
          section: s,
          kind: "hallucinated",
          actual: left[i],
        });
        continue;
      }
      const a = normalizedRow(s, left[i]),
        b = normalizedRow(s, right[j]);
      const mismatched = fields.filter((k) => !equalValue(a, b, k));
      if (!mismatched.length) correct++;
      else
        disagreements.push({
          section: s,
          kind: "mismatch",
          fields: mismatched,
          actual: left[i],
          expected: right[j],
        });
    }
  }
  // History extraction is evaluated only when explicitly represented in the draft
  // (tags or prose). Unknown history may never be filled from the disease cluster.
  const text = norm(
    [
      ...(draft.tags || []),
      draft.note || "",
      draft.clinicalSummary?.text || "",
    ].join(" "),
  );
  for (const h of gold.historyFacts || []) {
    expected++;
    if (mentionsHistory(text, h.kind)) {
      correct++;
      predicted++;
    } else
      disagreements.push({ section: "history", kind: "missing", expected: h });
  }
  // Only history concepts are factual tags; workflow/administrative tags are not facts.
  const historyKinds = [
    ...new Set([
      "吸烟史",
      "饮酒史",
      "职业接触史",
      ...(gold.historyFacts || []).map((h) => h.kind),
    ]),
  ];
  for (const kind of historyKinds)
    if (
      (draft.tags || []).some((tag) => mentionsHistory(tag, kind)) &&
      !(gold.historyFacts || []).some((h) => h.kind === kind) &&
      !(gold.tags || []).some((tag) => mentionsHistory(tag, kind))
    ) {
      predicted++;
      disagreements.push({
        section: "history",
        kind: "hallucinated",
        actual: kind,
      });
    }
  const precision = predicted ? correct / predicted : expected ? 0 : 1,
    recall = expected ? correct / expected : 1;
  return {
    fer: disagreements.length / Math.max(1, predicted),
    f1:
      precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    precision,
    recall,
    correct,
    predicted,
    expected,
    factualDisagreements: disagreements,
  };
}
export function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        row[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[b.length] / Math.max(1, a.length, b.length);
}
export function rawDiffs(before, after) {
  const edits = [];
  for (const s of Object.keys(sections))
    for (const [i, j] of alignFacts(s, before[s] || [], after[s] || [])) {
      const a = before[s]?.[i],
        b = after[s]?.[j];
      if (i === null || j === null)
        edits.push({
          section: s,
          op: i === null ? "add" : "delete",
          beforeIndex: i,
          afterIndex: j,
          itemBefore: a,
          itemAfter: b,
          before: a,
          after: b,
        });
      else
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
          if (JSON.stringify(a[k]) !== JSON.stringify(b[k]))
            edits.push({
              section: s,
              op: "modify",
              field: k,
              beforeIndex: i,
              afterIndex: j,
              itemBefore: a,
              itemAfter: b,
              before: a[k],
              after: b[k],
            });
    }
  for (const k of [
    "name",
    "gender",
    "birthYear",
    "phone",
    "allergyStatus",
    "allergies",
    "groups",
    "tags",
    "note",
    "clinicalSummary",
  ])
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      edits.push({
        section: k,
        op: "modify",
        before: before[k],
        after: after[k],
      });
  return edits;
}
export function learningMetrics(draft, final, gold, persona) {
  const facts = factualMetrics(draft, gold, persona),
    safe = renderLearningGold(gold, persona, { traps: false });
  const diffs = rawDiffs(draft, final),
    safeDiffs = rawDiffs(draft, safe);
  const styleEdits = safeDiffs.filter(
    (d) =>
      d.section === "clinicalSummary" ||
      d.field === "note" ||
      d.section === "note",
  );
  // Writing edits only count semantically equal facts, permitted exclusions, or
  // required history extraction. Factual repairs never become writing successes.
  const writing = safeDiffs.filter((d) => {
    if (styleEdits.includes(d)) return false;
    if (d.section === "tags") {
      const before = d.before || [],
        after = d.after || [];
      const changed = [
        ...before.filter((t) => !after.includes(t)),
        ...after.filter((t) => !before.includes(t)),
      ];
      return (
        changed.length > 0 &&
        changed.every((t) =>
          (gold.historyFacts || []).some(
            (h) =>
              h.text === t &&
              persona.rules.some(
                (r) => r.kind === "omission" && r.history === h.kind,
              ),
          ),
        )
      );
    }
    if (d.op === "delete")
      return d.section === "diagnoses" && excluded(d.itemBefore, persona);
    if (d.op !== "modify" || !sections[d.section]) return false;
    if (d.section === "labs" && d.itemBefore.value !== d.itemAfter.value)
      return false;
    const a = normalizedRow(d.section, d.itemBefore),
      b = normalizedRow(d.section, d.itemAfter);
    return sections[d.section].every((k) => equalValue(a, b, k));
  });
  return {
    ...facts,
    ser: writing.length / Math.max(1, facts.predicted),
    aiItems: facts.predicted,
    diffs,
    writingEdits: writing.length,
    noteVerbosityEdits: styleEdits.length,
    trapEdits: rawDiffs(safe, final).filter(
      (d) => d.section !== "clinicalSummary",
    ).length,
    summaryDistance: editDistance(
      draft.clinicalSummary?.text || "",
      safe.clinicalSummary?.text || "",
    ),
  };
}
// Interpret supported structured memory types against the actual persona rule
// definitions, without literal patient/finding strings or product dictionaries.
export function evaluateHabit(habit, persona) {
  const h = habit.rule,
    matched = [];
  let unsafe = false;
  if (!h)
    return {
      correct: false,
      unsafe: false,
      unjudged: true,
      category: null,
      ruleIds: [],
    };
  if (
    ["status", "dose", "value"].includes(h.field) ||
    h.type === "clinical" ||
    (h.type === "unit_normalize" &&
      LAB_UNITS[h.item]?.[norm(h.from)] &&
      LAB_UNITS[h.item]?.[norm(h.to)] &&
      LAB_UNITS[h.item][norm(h.from)] !== LAB_UNITS[h.item][norm(h.to)]) ||
    (h.type === "term_replace" && canonical(h.from) !== canonical(h.to))
  )
    unsafe = true;
  for (const r of persona.rules.filter((r) => r.learnableByProduct)) {
    let ok = false;
    if (r.kind === "term" && h.section === "diagnoses")
      ok =
        (h.type === "term_style" && h.direction === r.direction) ||
        (h.type === "term_replace" &&
          canonical(h.from) === canonical(h.to) &&
          norm(h.from) !== norm(h.to) &&
          h.to === termGroup(h.from)?.[r.direction === "full" ? 1 : 0]);
    if (r.kind === "unit" && h.type === "unit_normalize")
      ok =
        h.section === "labs" &&
        canonical(h.item) === canonical(r.item) &&
        norm(h.to) === norm(r.to) &&
        norm(h.from) !== norm(h.to) &&
        Boolean(LAB_UNITS[r.item]?.[norm(h.from)]);
    if (r.kind === "frequency" && h.type === "format_rule")
      ok =
        h.section === "medications" &&
        h.field === "frequency" &&
        FREQUENCIES.some(
          (g) =>
            g.includes(h.from) &&
            h.to === g[r.direction === "full" ? 1 : 0] &&
            h.from !== h.to,
        );
    if (r.kind === "exclude" && h.type === "exclude_rule") {
      ok =
        h.section === "diagnoses" &&
        h.status === "finding" &&
        r.names.some((n) => canonical(n) === canonical(h.matcher));
      unsafe ||= h.status !== "finding";
    }
    if (r.kind === "omission" && h.type === "attend_rule")
      ok = h.section === "tags" && mentionsHistory(h.hint, r.history);
    if (r.kind === "summary-cap" && h.type === "style_rule")
      ok = h.maxLength === r.max;
    if (r.kind === "summary-order" && h.type === "style_rule")
      ok = h.pattern === r.order;
    if (ok) matched.push(r.id);
  }
  const category = persona.rules.find((r) => r.id === matched[0])?.kind ?? null;
  return {
    correct: !unsafe && matched.length > 0,
    unsafe,
    category,
    ruleIds: unsafe ? [] : matched,
  };
}
export function scoreStated(
  memories,
  stated,
  persona,
  { newMemories = [], judgments = [] } = {},
) {
  const matchesRule = (m) => {
    const direct = evaluateHabit(m, persona);
    if (direct.unsafe) return false;
    return (
      direct.ruleIds.includes(stated.ruleId) ||
      judgments.some(
        (j) =>
          j.habitId === m.id &&
          j.ruleId === stated.ruleId &&
          j.correct &&
          j.calibrated === true,
      )
    );
  };
  const matches = memories.filter(
    (m) =>
      (m.origin === "stated" ||
        newMemories.some((n) => n === m || (n.id && n.id === m.id))) &&
      matchesRule(m),
  );
  // Every new memory is accounted for, including patient-local instructions.
  const unexpected = newMemories.filter((m) => !matchesRule(m));
  return {
    ruleId: stated.ruleId,
    matched: matches.length > 0,
    unexpected: unexpected.length,
    memories,
  };
}
export function scoreG6(run, persona) {
  const learnable = persona.rules.filter((r) => r.learnableByProduct),
    auto = (run.habits || []).filter((h) => h.origin === "learned");
  const judgments = auto.map((h) => evaluateHabit(h, persona));
  // Prompt-only rules use observed extraction or calibrated style evidence;
  // structured rules require a correct postprocessing change.
  const usableEvidence = (e, judgment) =>
    e.correct &&
    judgment.ruleIds.includes(e.ruleId ?? e.ruleIds?.[0]) &&
    (judgment.category === "summary-order"
      ? e.source === "calibrated-style-judge" && e.calibrated === true
      : judgment.category === "omission"
        ? e.source === "prompt-history" && e.observed === true
        : e.changed === true);
  const effective = new Set();
  const eligible = judgments.map((j, i) => {
    const evidence = (run.ruleEvidence || []).filter(
      (e) => e.habitId === auto[i].id && usableEvidence(e, j),
    );
    for (const e of evidence)
      for (const id of e.ruleIds || [e.ruleId])
        if (j.ruleIds.includes(id)) effective.add(id);
    return j.correct && evidence.length > 0;
  });
  const precision = auto.length
      ? eligible.filter(Boolean).length / auto.length
      : 0,
    recall = learnable.length ? effective.size / learnable.length : 0;
  const stated = run.statedChecks || [],
    statedCount = persona.stated.length,
    matchedCount = persona.stated.filter((rule) =>
      stated.some((s) => s.ruleId === rule.ruleId && s.matched),
    ).length,
    statedRecall = statedCount ? matchedCount / statedCount : 1,
    falseRate = statedCount
      ? stated.filter((s) => s.unexpected > 0).length / statedCount
      : 0;
  return {
    status:
      precision >= 0.9 &&
      recall >= 0.6 &&
      stated.length === statedCount &&
      statedRecall === 1 &&
      falseRate <= 0.05
        ? "passed"
        : "failed",
    precision,
    recall,
    denominator: learnable.length,
    knownProductGaps: knownProductGaps(persona),
    statedDenominator: statedCount,
    learned: auto.length,
    statedRecall,
    falseRate,
  };
}
export function scoreG10(runs, personas) {
  const cells = runs.filter((r) => r.group === "C");
  if (!cells.length)
    return { status: "not-evaluable", reason: "No complete C cells" };
  if (cells.some((r) => !r.freshStoreEmpty))
    return { status: "failed", reason: "Nonempty initial store" };
  for (const r of cells) {
    const terms = (r.habits || []).filter(
      (h) =>
        h.origin === "learned" &&
        ["term_style", "term_replace"].includes(h.rule?.type),
    );
    if (!terms.length)
      return {
        status: "not-evaluable",
        reason: `No learned term habits in ${r.persona}/${r.seed}`,
      };
    if (
      terms.some(
        (h) =>
          !evaluateHabit(
            h,
            personas.find((p) => p.id === r.persona),
          ).correct,
      )
    )
      return { status: "failed", reason: "Conflicting term habit" };
    if (
      !terms.some((h) =>
        (r.ruleEvidence || []).some(
          (e) => e.habitId === h.id && e.correct && e.changed,
        ),
      )
    )
      return {
        status: "not-evaluable",
        reason: "No observed term application",
      };
  }
  return { status: "passed", isolatedRuns: cells.length };
}
export function bootstrap(values, seed = 1) {
  if (values.length < 2) return null;
  const rand = seeded(seed),
    means = Array.from({ length: 2000 }, () =>
      mean(values.map(() => values[Math.floor(rand() * values.length)])),
    ).sort((a, b) => a - b);
  return [means[49], means[1949]];
}
// Pair by persona, seed, patient AND sequence before clustering. Persona is a
// fixed stratum: sample seeds within each persona rather than inventing 9
// exchangeable doctors from 3 repeated personas.
export function pairedCI(rows, group, metric, select = () => true) {
  const a = new Map(
    rows
      .filter((r) => r.group === "A" && select(r))
      .map((r) => [`${r.persona}:${r.seed}:${r.patient}:${r.sequence}`, r]),
  );
  const strata = new Map();
  let pairs = 0,
    unpaired = 0;
  for (const r of rows.filter((r) => r.group === group && select(r))) {
    const base = a.get(`${r.persona}:${r.seed}:${r.patient}:${r.sequence}`);
    if (!base) {
      unpaired++;
      continue;
    }
    const bySeed = strata.get(r.persona) || new Map(),
      ds = bySeed.get(r.seed) || [];
    ds.push(r[metric] - base[metric]);
    bySeed.set(r.seed, ds);
    strata.set(r.persona, bySeed);
    pairs++;
  }
  const units = [...strata.values()].map((s) => [...s.values()].map(mean));
  if (
    !units.length ||
    units.some((s) => s.length < 2) ||
    unpaired ||
    pairs !== a.size
  )
    return { difference: null, ci95: null, pairs, unpaired };
  const rand = seeded(7),
    samples = Array.from({ length: 2000 }, () =>
      mean(
        units.map((s) => mean(s.map(() => s[Math.floor(rand() * s.length)]))),
      ),
    ).sort((a, b) => a - b);
  return {
    difference: mean(units.map(mean)),
    ci95: [samples[49], samples[1949]],
    pairs,
    unpaired,
    strata: units.map((u) => u.length),
  };
}
export function stratifiedCI(rows, metric) {
  const strata = new Map();
  for (const row of rows) {
    const seeds = strata.get(row.persona) || new Map(),
      values = seeds.get(row.seed) || [];
    values.push(row[metric]);
    seeds.set(row.seed, values);
    strata.set(row.persona, seeds);
  }
  const units = [...strata.values()].map((s) => [...s.values()].map(mean));
  if (!units.length || units.some((s) => s.length < 2)) return null;
  const random = seeded(11),
    samples = Array.from({ length: 2000 }, () =>
      mean(
        units.map((s) => mean(s.map(() => s[Math.floor(random() * s.length)]))),
      ),
    ).sort((a, b) => a - b);
  return [samples[49], samples[1949]];
}
export function summarizeLearning(rows) {
  const groups = {};
  for (const group of new Set(rows.map((r) => r.group))) {
    groups[group] = {};
    for (const [label, lo, hi] of [
      ["overall", 1, 40],
      ["early", 1, 10],
      ["middle", 11, 20],
      ["late", 21, 30],
      ["holdout", 31, 40],
    ]) {
      const selected = rows.filter(
        (r) => r.group === group && r.sequence >= lo && r.sequence <= hi,
      );
      groups[group][label] = {
        count: selected.length,
        ...Object.fromEntries(
          ["ser", "fer", "f1"].flatMap((m) => [
            [m, mean(selected.map((r) => r[m]))],
            [`${m}CI95`, stratifiedCI(selected, m)],
          ]),
        ),
      };
    }
  }
  const paired = {};
  for (const group of Object.keys(groups).filter((g) => g !== "A"))
    paired[group] = Object.fromEntries(
      ["ser", "fer", "f1"].map((m) => [m, pairedCI(rows, group, m)]),
    );
  return { groups, paired };
}
export function scoreG3(rows, groups = ["B", "C"]) {
  const evidence = Object.fromEntries(
    groups.map((g) => [
      g,
      { f1: pairedCI(rows, g, "f1"), fer: pairedCI(rows, g, "fer") },
    ]),
  );
  return {
    status: Object.values(evidence).some((e) => !e.f1.ci95 || !e.fer.ci95)
      ? "not-evaluable"
      : Object.values(evidence).every(
            (e) => e.f1.ci95[0] >= -0.02 && e.fer.ci95[1] <= 0,
          )
        ? "passed"
        : "failed",
    evidence,
  };
}

export function learningCurveSvg(rows) {
  const colors = ["#777777", "#3478a7", "#2d8060", "#be7d26", "#9d5b8a"],
    groups = [...new Set(rows.map((r) => r.group))];
  const panels = ["ser", "fer", "f1"];
  const paths = panels
    .map((metric, pi) => {
      const top = 55 + pi * 210,
        height = 150;
      return (
        `<text x="24" y="${top - 10}" font-size="16">${metric.toUpperCase()}</text><path d="M60 ${top}V${top + height}H850" fill="none" stroke="#aaa"/>` +
        groups
          .map((group, gi) => {
            const points = Array.from({ length: 30 }, (_, i) => ({
              seq: i + 1,
              value: mean(
                rows
                  .filter((r) => r.group === group && r.sequence === i + 1)
                  .map((r) => r[metric]),
              ),
            })).filter((p) => p.value !== null);
            return `<polyline fill="none" stroke="${colors[gi]}" stroke-width="2" points="${points.map((p) => `${60 + ((p.seq - 1) * 790) / 29},${top + height * (1 - Math.min(1, p.value))}`).join(" ")}"/>`;
          })
          .join("") +
        [1, 10, 20, 30]
          .map(
            (n) =>
              `<text x="${60 + ((n - 1) * 790) / 29}" y="${top + height + 18}" font-size="11">${n}</text>`,
          )
          .join("")
      );
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="720" viewBox="0 0 900 720"><rect width="900" height="720" fill="white"/><g font-family="sans-serif">${paths}${groups.map((g, i) => `<text x="${25 + i * 175}" y="710" fill="${colors[i]}" font-size="13">${g}</text>`).join("")}</g></svg>`;
}
