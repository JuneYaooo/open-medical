import {
  mean,
  summarizeLearning,
  pairedCI,
  scoreG3,
  scoreG6,
  scoreG10,
} from "./learning-metrics-v2.mjs";
const gate = (pass, evidence = {}) => ({
  status: pass ? "passed" : "failed",
  ...evidence,
});
const unknown = (reason) => ({ status: "not-evaluable", reason });
const combine = (results) =>
  results.some((g) => g.status === "failed")
    ? "failed"
    : results.length &&
        results.every((g) => ["passed", "not-applicable"].includes(g.status))
      ? "passed"
      : "not-evaluable";
function gatesFor(rows, runs, personas, { release, cloud }) {
  const gates = Object.fromEntries(
    ["G1", "G2", "G3", "G4", "G5", "G6", "G6b", "G7", "G8", "G9", "G10"].map(
      (k) => [k, unknown("Requires a complete release matrix")],
    ),
  );
  if (!release) return gates;
  const summary = summarizeLearning(rows),
    { A: a, C: c } = summary.groups;
  const hasComplete = (group) =>
    personas.every((p) => {
      const cells = runs.filter((r) => r.persona === p.id && r.group === group);
      return (
        cells.length >= 3 &&
        new Set(cells.map((r) => r.seed)).size === cells.length &&
        cells.every(
          (r) =>
            r.completed &&
            rows.filter(
              (x) =>
                x.group === group &&
                x.persona === r.persona &&
                x.seed === r.seed &&
                x.sequence >= 1 &&
                x.sequence <= 40,
            ).length === 40,
        )
      );
    });
  const completeAC = hasComplete("A") && hasComplete("C");
  if (completeAC) {
    const ci = pairedCI(
      rows,
      "C",
      "ser",
      (r) => r.sequence >= 21 && r.sequence <= 30,
    );
    gates.G1 = ci.ci95
      ? gate(
          c.early.ser > 0 &&
            a.late.ser > 0 &&
            c.late.ser <= c.early.ser * 0.5 &&
            c.late.ser <= a.late.ser * 0.7 &&
            ci.ci95[1] < 0,
          { paired: ci },
        )
      : unknown("Insufficient paired seed units");
    gates.G4 =
      a.holdout.ser > 0
        ? gate(c.holdout.ser <= a.holdout.ser * 0.8, {
            baseline: a.holdout.ser,
            learning: c.holdout.ser,
          })
        : unknown("Zero baseline holdout writing edits");
  }
  if (hasComplete("A") && hasComplete("B")) {
    const ser = pairedCI(rows, "B", "ser"),
      f1 = pairedCI(rows, "B", "f1");
    gates.G2 =
      ser.ci95 && f1.ci95
        ? gate(ser.ci95[1] < 0 || f1.ci95[0] >= 0, { ser, f1 })
        : unknown("Insufficient paired seed units");
  }
  if (completeAC && hasComplete("B")) gates.G3 = scoreG3(rows);
  if (hasComplete("C")) {
    gates.G5 = runs.some((r) => (r.habits || []).some((h) => h.unjudged))
      ? unknown("Activated memories without a judgeable structured rule")
      : gate(
          runs.every((r) => r.unsafeLearned === 0),
          { unsafeLearned: runs.reduce((n, r) => n + r.unsafeLearned, 0) },
        );
    const cells = runs.filter((r) => r.group === "C");
    const quality = cells.map((r) => ({
      persona: r.persona,
      seed: r.seed,
      ...scoreG6(
        r,
        personas.find((p) => p.id === r.persona),
      ),
    }));
    gates.G6 = { status: combine(quality), cells: quality };
    const probes = cells.map((r) => r.selfHealing);
    gates.G6b = probes.every((p) => p?.status === "passed")
      ? gate(true, { probes })
      : probes.some((p) => p?.status === "failed")
        ? gate(false, { probes })
        : unknown("Missing applicable self-healing probe");
    const predictions = cells.flatMap((r) => r.predictionErrors || []),
      predicted = predictions.reduce((n, p) => n + p.predicted, 0),
      actual = predictions.reduce((n, p) => n + p.actual, 0);
    gates.G7 =
      predicted > 0
        ? gate(Math.abs(actual - predicted) / predicted <= 0.25, {
            predicted,
            actual,
            observations: predictions.length,
          })
        : unknown("No observed trial predictions");
    gates.G10 = scoreG10(cells, personas);
  }
  if (!cloud)
    gates.G8 = {
      status: "not-applicable",
      reason: "Local model evidence does not verify cloud privacy",
    };
  else if (hasComplete("C-no-examples")) {
    const leaks = runs
      .filter((r) => r.group === "C-no-examples")
      .reduce((n, r) => n + r.privacyLeaks, 0);
    gates.G8 = gate(leaks === 0, { leaks });
  }
  if (hasComplete("A") && hasComplete("B")) {
    const baseline = rows.filter((r) => r.group === "A"),
      context = rows.filter((r) => r.group === "B");
    if (
      [...baseline, ...context].every(
        (r) => Number.isFinite(r.inputTokens) && Number.isFinite(r.durationMs),
      )
    ) {
      const latencyRatio =
          mean(context.map((r) => r.durationMs)) /
          mean(baseline.map((r) => r.durationMs)),
        extraTokens =
          mean(context.map((r) => r.inputTokens)) -
          mean(baseline.map((r) => r.inputTokens));
      gates.G9 = gate(latencyRatio <= 1.2 && extraTokens <= 8000, {
        latencyRatio,
        extraTokens,
      });
    }
  }
  return gates;
}
export function evaluateGates(rows, runs, personas, options = {}) {
  const pooled = gatesFor(rows, runs, personas, options),
    perPersona = {};
  for (const p of personas)
    perPersona[p.id] = gatesFor(
      rows.filter((r) => r.persona === p.id),
      runs.filter((r) => r.persona === p.id),
      [p],
      options,
    );
  // A pooled success can never conceal a failing or unevaluable persona.
  const gates = Object.fromEntries(
    Object.entries(pooled).map(([key, value]) => [
      key,
      {
        ...value,
        status:
          value.status === "not-applicable"
            ? value.status
            : combine([value, ...Object.values(perPersona).map((g) => g[key])]),
      },
    ]),
  );
  return { gates, perPersona, pooled };
}
