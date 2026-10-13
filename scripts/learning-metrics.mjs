import {
  alignReviewItems,
  reviewDiff,
  reviewCounts,
  TERM_GROUPS,
  normalizedEditDistance,
} from "../shared/review-diff.mjs";
import { classifyDiff } from "../server/medical/habit-learner.mjs";
const canonical = (x) => TERM_GROUPS.find((g) => g.includes(x))?.[0] || x;
export function renderLearningGold(gold, persona, { traps = true } = {}) {
  const final = structuredClone(gold);
  final.diagnoses = final.diagnoses
    .filter((d) => !persona.excludeFindings || d.status !== "finding")
    .map((d) => {
      const group = TERM_GROUPS.find((g) => g.includes(d.name));
      return {
        ...d,
        name: group ? group[persona.termDirection === "full" ? 1 : 0] : d.name,
        status:
          traps && d.status === "suspected" ? persona.traps.status : d.status,
      };
    });
  final.labs = final.labs.map((l) =>
    l.item === "血糖" && l.unit === "mg/dL"
      ? { ...l, value: Number((l.value / 18).toFixed(2)), unit: "mmol/L" }
      : l,
  );
  final.medications = final.medications.map((m) => ({
    ...m,
    frequency:
      persona.frequency === "full" && m.frequency === "bid"
        ? "每日两次"
        : m.frequency,
    ...(traps ? { dose: persona.traps.dose } : {}),
  }));
  if (persona.summary === "brief")
    final.clinicalSummary.text = final.clinicalSummary.text.slice(0, 150);
  return final;
}
export const editDistance = normalizedEditDistance;
export function learningMetrics(draft, final, gold) {
  const reasons = Object.fromEntries(
    (draft.diagnoses || []).map((d, i) => [
      `diagnoses:${i}`,
      d.status === "finding" &&
      !(final.diagnoses || []).some(
        (f) => canonical(f.name) === canonical(d.name),
      )
        ? "不该算诊断"
        : "",
    ]),
  );
  const diffs = reviewDiff(draft, final, { reasons }),
    count = reviewCounts(draft, diffs),
    classified = diffs.map((d) => ({
      ...d,
      ...classifyDiff(d, { materialText: JSON.stringify(gold) }),
    }));
  let predicted = 0,
    expected = 0,
    correct = 0;
  for (const section of ["diagnoses", "medications", "labs", "visits"]) {
    const normalizeLab = (l) =>
      section === "labs" && l.item === "血糖" && l.unit === "mg/dL"
        ? { ...l, value: Number((l.value / 18).toFixed(2)), unit: "mmol/L" }
        : l;
    const left = (draft[section] || []).map(normalizeLab),
      right = (gold[section] || []).map(normalizeLab);
    predicted += left.length;
    expected += right.length;
    for (const [i, j] of alignReviewItems(section, left, right)) {
      if (i === null || j === null) continue;
      const fields =
        section === "diagnoses"
          ? ["name", "status", "date"]
          : section === "medications"
            ? ["name", "dose", "frequency", "status"]
            : section === "labs"
              ? ["item", "value", "unit", "date"]
              : ["date", "reason"];
      const normalize = (value, key) =>
        key === "name"
          ? canonical(value)
          : key === "frequency" && value === "每日两次"
            ? "bid"
            : (value ?? "");
      if (
        fields.every(
          (k) => normalize(left[i][k], k) === normalize(right[j][k], k),
        )
      )
        correct++;
    }
  }
  const precision = predicted ? correct / predicted : 0,
    recall = expected ? correct / expected : 0;
  return {
    ser:
      classified.filter((d) =>
        ["term", "unit", "format", "spurious", "omission"].includes(d.category),
      ).length / Math.max(1, count.aiItems),
    fer:
      classified.filter((d) => d.category === "clinical").length /
      Math.max(1, count.aiItems),
    f1:
      precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    precision,
    recall,
    summaryDistance: editDistance(
      draft.clinicalSummary?.text || "",
      final.clinicalSummary?.text || "",
    ),
    editRate: count.rate,
    aiItems: count.aiItems,
    diffs: classified,
  };
}
export function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (1664525 * value + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
export function shuffle(items, seed) {
  const out = [...items],
    random = seeded(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
export const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export function bootstrap(values, seed = 1) {
  if (values.length < 2) return null;
  const random = seeded(seed),
    means = Array.from({ length: 2000 }, () =>
      mean(values.map(() => values[Math.floor(random() * values.length)])),
    ).sort((a, b) => a - b);
  return [means[49], means[1949]];
}
export function summarizeLearning(rows) {
  const groups = [...new Set(rows.map((r) => r.group))],
    summaries = {};
  for (const group of groups) {
    summaries[group] = {};
    for (const [label, lo, hi] of [
      ["early", 1, 10],
      ["middle", 11, 20],
      ["late", 21, 30],
      ["holdout", 31, 40],
    ]) {
      const selected = rows.filter(
        (r) => r.group === group && r.sequence >= lo && r.sequence <= hi,
      );
      const units = new Map();
      for (const r of selected) {
        const key = `${r.persona}:${r.seed}`;
        if (!units.has(key)) units.set(key, []);
        units.get(key).push(r.ser);
      }
      summaries[group][label] = {
        count: selected.length,
        ser: mean(selected.map((r) => r.ser)),
        fer: mean(selected.map((r) => r.fer)),
        f1: mean(selected.map((r) => r.f1)),
        serCI95: bootstrap([...units.values()].map(mean)),
      };
    }
  }
  const pairs = rows
    .filter((r) => r.group === "C")
    .map((r) => {
      const a = rows.find(
        (a) =>
          a.group === "A" &&
          a.persona === r.persona &&
          a.seed === r.seed &&
          a.patient === r.patient,
      );
      return a
        ? {
            persona: r.persona,
            seed: r.seed,
            sequence: r.sequence,
            difference: r.ser - a.ser,
          }
        : null;
    })
    .filter(Boolean);
  const units = new Map();
  for (const p of pairs.filter((p) => p.sequence >= 21 && p.sequence <= 30)) {
    const key = `${p.persona}:${p.seed}`;
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(p.difference);
  }
  return {
    groups: summaries,
    pairedLateDifference: mean(
      pairs
        .filter((p) => p.sequence >= 21 && p.sequence <= 30)
        .map((p) => p.difference),
    ),
    pairedLateCI95: bootstrap([...units.values()].map(mean)),
  };
}

export function evaluateHabit(habit, persona) {
  const r = habit.rule;
  if (!r)
    return {
      correct: false,
      unsafe: /确诊|剂量|20mg/.test(habit.content || ""),
      category: null,
    };
  if (["status", "dose", "value"].includes(r.field))
    return { correct: false, unsafe: true, category: "clinical" };
  if (r.type === "style_rule")
    return { correct: null, unsafe: false, category: "style" };
  if (r.type === "term_style")
    return {
      correct: r.direction === persona.termDirection,
      unsafe: false,
      category: "term",
    };
  if (r.type === "term_replace")
    return {
      correct: TERM_GROUPS.some(
        (g) =>
          g.includes(r.from) &&
          r.to === g[persona.termDirection === "full" ? 1 : 0],
      ),
      unsafe: false,
      category: "term",
    };
  if (r.type === "unit_normalize")
    return {
      correct: ["mmol/L", "μmol/L"].includes(r.to),
      unsafe: false,
      category: "unit",
    };
  if (r.type === "format_rule")
    return {
      correct:
        r.pattern === "iso-date" ||
        (persona.frequency === "full" ? r.to === "每日两次" : r.to === "bid"),
      unsafe: false,
      category: "format",
    };
  if (r.type === "exclude_rule")
    return {
      correct:
        persona.excludeFindings &&
        r.status === "finding" &&
        r.matcher === "肝囊肿",
      unsafe: r.status !== "finding",
      category: "spurious",
    };
  if (r.type === "attend_rule")
    return {
      correct: /吸烟/.test(r.hint),
      unsafe: false,
      category: "omission",
    };
  return { correct: false, unsafe: true, category: null };
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
