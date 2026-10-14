import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  assertDiversity,
  checkFixtures,
} from "../scripts/check-learning-fixtures-v2.mjs";
import {
  renderLearningGold,
  ruleCoverage,
  isoDate,
  canonical,
} from "../scripts/learning-v2-domain.mjs";
import {
  factualMetrics,
  learningMetrics,
  evaluateHabit,
  scoreStated,
  scoreG6,
  scoreG10,
  scoreG3,
  pairedCI,
} from "../scripts/learning-metrics-v2.mjs";
import {
  materialUpload,
  submitReviewEdits,
  habitEvidence,
} from "../scripts/learning-review-v2.mjs";
import { evaluateGates } from "../scripts/learning-gates-v2.mjs";
const root = new URL("../evals/learning-loop-v2/", import.meta.url);
const readJSON = async (name) =>
  JSON.parse(await readFile(new URL(name, root)));
const manifest = await readJSON("manifest.json");
const personas = await Promise.all(
  ["D1", "D2", "D3"].map((id) => readJSON(`personas/${id}.json`)),
);
const golds = await Promise.all(
  manifest.patients.map((p) => readJSON(`patients/${p.id}/gold.json`)),
);
const digest = (x) => createHash("sha256").update(x).digest("hex");

test("v2 has 40 synthetic patients, four clusters, disjoint 30/10 split and 2–4 mixed-format materials", async () => {
  assert.equal(manifest.version, 2);
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.patients.length, 40);
  assert.equal(new Set(manifest.patients.map((p) => p.id)).size, 40);
  assert.equal(
    manifest.patients.filter((p) => p.split === "learning").length,
    30,
  );
  assert.equal(
    manifest.patients.filter((p) => p.split === "holdout").length,
    10,
  );
  for (let c = 0; c < 4; c++)
    assert.equal(manifest.patients.filter((p) => p.cluster === c).length, 10);
  assert.deepEqual(
    new Set(manifest.patients.map((p) => p.materials.length)),
    new Set([2, 3, 4]),
  );
  assert.deepEqual(
    new Set(
      manifest.patients.flatMap((p) =>
        p.materials.map((m) => m.split(".").at(-1)),
      ),
    ),
    new Set(["txt", "docx", "pdf", "png"]),
  );
  for (const p of manifest.patients) {
    assert.equal(
      digest(await readFile(new URL(`patients/${p.id}/gold.json`, root))),
      p.goldHash,
    );
    assert.equal(
      digest(await readFile(new URL(`patients/${p.id}/sources.json`, root))),
      p.sourceHash,
    );
    for (const m of p.materials)
      assert.equal(
        digest(
          await readFile(new URL(`patients/${p.id}/materials/${m}`, root)),
        ),
        p.materialHashes[m],
      );
    assert.ok(
      p.degradation.rotation !== 0 &&
        p.degradation.blur > 0 &&
        p.degradation.noise > 0 &&
        p.degradation.contrast < 1,
    );
  }
});

test("digit and identity masked diversity rejects clones and every rule changes at least five learning targets", async () => {
  const result = await checkFixtures();
  assert.ok(result.diversity.maxJaccard < 0.7);
  assert.deepEqual(result.diversity, manifest.diversity);
  assert.throws(
    () =>
      assertDiversity([
        { id: "a", text: "患者2026年9月3日高血压服用药物5mg" },
        { id: "b", text: "患者2026年9月8日高血压服用药物10mg" },
      ]),
    /Jaccard/,
  );
  for (const p of personas) {
    assert.equal(p.rules.filter((r) => !r.learnable).length, 2);
    const coverage = ruleCoverage(
      golds.filter((_, i) => manifest.patients[i].split === "learning"),
      p,
    );
    for (const [id, n] of Object.entries(coverage))
      assert.ok(n >= 5, `${p.id}/${id}`);
  }
});

test("canaries occur in name and all source bodies; DOCX and text PDF bytes extract matching source text", async () => {
  for (const p of manifest.patients) {
    const canary = (
      await readFile(new URL(`patients/${p.id}/canary.txt`, root), "utf8")
    ).trim();
    const gold = await readJSON(`patients/${p.id}/gold.json`),
      sources = await readJSON(`patients/${p.id}/sources.json`);
    assert.equal(gold.name, canary);
    for (const m of p.materials) {
      assert.ok(sources[m].includes(canary), `${p.id}/${m}`);
      const upload = await materialUpload(
        fileURLToPath(new URL(`patients/${p.id}/materials/${m}`, root)),
        m,
      );
      if (m.endsWith(".png")) {
        assert.equal(
          Buffer.from(upload.image, "base64").subarray(1, 4).toString(),
          "PNG",
        );
        continue;
      }
      assert.ok(upload.text.includes(canary));
      assert.equal(
        upload.text.normalize("NFKC").replace(/\s/g, ""),
        sources[m].normalize("NFKC").replace(/\s/g, ""),
        `${p.id}/${m}`,
      );
      if (m.endsWith(".pdf")) assert.equal(upload.extraction.type, "pdf_text");
    }
  }
});

test("all persona renderers preserve facts without traps and render genuinely conflicting outputs", () => {
  for (const gold of golds) {
    const outputs = personas.map((p) =>
      renderLearningGold(gold, p, { traps: false }),
    );
    assert.equal(new Set(outputs.map((x) => JSON.stringify(x))).size, 3);
    for (const [i, out] of outputs.entries()) {
      const p = personas[i],
        rules = p.rules;
      assert.ok(
        [...out.clinicalSummary.text].length <=
          rules.find((r) => r.kind === "summary-cap").max,
      );
      assert.equal(factualMetrics(out, gold, p).fer, 0);
      assert.equal(factualMetrics(out, gold, p).f1, 1);
      for (const r of rules.filter((r) => r.kind === "unit"))
        assert.ok(
          out.labs
            .filter((l) => l.item === r.item)
            .every((l) => l.unit === r.to),
        );
      for (const r of rules.filter((r) => r.kind === "omission"))
        for (const h of gold.historyFacts.filter((h) => h.kind === r.history))
          assert.ok(out.tags.includes(h.text));
      for (const d of out.diagnoses)
        assert.ok(
          gold.diagnoses.some(
            (g) =>
              canonical(g.name) === canonical(d.name) &&
              isoDate(g.date) === isoDate(d.date) &&
              g.status === d.status,
          ),
        );
    }
  }
  assert.match(
    renderLearningGold(golds[0], personas[0]).clinicalSummary.text,
    /^主要问题/,
  );
  assert.match(
    renderLearningGold(golds[0], personas[2]).clinicalSummary.text,
    /^用药/,
  );
  assert.equal(personas[1].stated[1].ruleId, "summary-order");
  assert.match(personas[1].stated[1].text, /时间先后/);
});

const simple = {
  diagnoses: [{ name: "AF", status: "suspected", date: "2026/9/3" }],
  medications: [
    { name: "试剂甲", dose: "5mg", frequency: "bid", status: "active" },
  ],
  labs: [
    { item: "血糖", value: 180, unit: "mg/dL", date: "26-09-03" },
    { item: "肌酐", value: 1, unit: "mg/dL", date: "9月3日" },
  ],
  visits: [{ date: "2026年9月3日", reason: "随访", note: "文书备注" }],
};
test("FER ignores note/style and trap edits; correct conversions, aliases, equivalent dates/frequencies remain factual", () => {
  const p = personas[0],
    draft = renderLearningGold(simple, p, { traps: false }),
    final = renderLearningGold(simple, p);
  assert.equal(draft.labs[0].value, 10);
  assert.equal(draft.labs[1].value, 88.4);
  draft.note = "较长的文书说明";
  draft.visits[0].note = "不同表述";
  draft.clinicalSummary.text = "另一种摘要";
  const result = learningMetrics(draft, final, simple, p);
  assert.equal(result.fer, 0);
  assert.equal(result.f1, 1);
  assert.ok(result.trapEdits >= 2);
  assert.ok(result.noteVerbosityEdits > 0);
  assert.ok(factualMetrics(final, simple, p).fer > 0);
});

test("FER catches values, units, dates, status, dose, frequency, missing and hallucinated facts independently", () => {
  const baseline = structuredClone(simple);
  assert.equal(factualMetrics(baseline, simple).fer, 0);
  for (const [section, field, value] of [
    ["labs", "value", 181],
    ["labs", "unit", "g/L"],
    ["diagnoses", "date", "2026-09-04"],
    ["diagnoses", "status", "confirmed"],
    ["medications", "dose", "10mg"],
    ["medications", "frequency", "qd"],
  ]) {
    const d = structuredClone(simple);
    d[section][0][field] = value;
    const m = factualMetrics(d, simple);
    assert.equal(m.factualDisagreements.length, 1, `${section}.${field}`);
    assert.equal(m.fer, 1 / 5);
    assert.ok(m.f1 < 1);
  }
  const missing = structuredClone(simple);
  missing.labs.pop();
  assert.equal(
    factualMetrics(missing, simple).factualDisagreements[0].kind,
    "missing",
  );
  const extra = structuredClone(simple);
  extra.labs.push({ item: "未知化验", value: 3, unit: "g/L" });
  assert.equal(
    factualMetrics(extra, simple).factualDisagreements[0].kind,
    "hallucinated",
  );
});

test("fact alignment is order-independent and does not collapse duplicate/date-distinct measurements", () => {
  const g = {
    labs: [
      { item: "血糖", value: 100, unit: "mg/dL", date: "2026-09-01" },
      { item: "血糖", value: 120, unit: "mg/dL", date: "2026-09-02" },
    ],
  };
  assert.equal(factualMetrics({ labs: g.labs.toReversed() }, g).f1, 1);
  assert.ok(factualMetrics({ labs: [g.labs[0], g.labs[0]] }, g).fer > 0);
});

test("habit correctness follows arbitrary persona definitions, with no special finding/history literals", () => {
  const custom = {
    rules: [
      { id: "x", kind: "exclude", learnable: true, names: ["视网膜色素斑"] },
      { id: "y", kind: "omission", learnable: true, history: "动物接触史" },
    ],
  };
  assert.equal(
    evaluateHabit(
      {
        rule: {
          type: "exclude_rule",
          section: "diagnoses",
          matcher: "视网膜色素斑",
          status: "finding",
        },
      },
      custom,
    ).correct,
    true,
  );
  assert.equal(
    evaluateHabit(
      {
        rule: {
          type: "exclude_rule",
          section: "diagnoses",
          matcher: "肝囊肿",
          status: "finding",
        },
      },
      custom,
    ).correct,
    false,
  );
  assert.equal(
    evaluateHabit(
      { rule: { type: "attend_rule", section: "tags", hint: "动物接触史" } },
      custom,
    ).correct,
    true,
  );
  assert.equal(
    evaluateHabit(
      { rule: { type: "format_rule", field: "dose", to: "20mg" } },
      custom,
    ).unsafe,
    true,
  );
  assert.equal(
    evaluateHabit(
      {
        rule: {
          type: "term_replace",
          section: "diagnoses",
          from: "COPD",
          to: "慢性阻塞性肺疾病",
        },
      },
      personas[0],
    ).correct,
    true,
  );
  assert.equal(
    evaluateHabit(
      {
        rule: {
          type: "term_replace",
          section: "diagnoses",
          from: "COPD",
          to: "慢性阻塞性肺疾病",
        },
      },
      personas[1],
    ).correct,
    false,
  );
});

test("stated recall requires matching rule content; unrelated/paraphrased local instructions count as false memories", () => {
  const p = personas[0],
    stated = p.stated[0];
  const right = {
      rule: { type: "term_style", section: "diagnoses", direction: "full" },
    },
    wrong = {
      rule: { type: "term_style", section: "diagnoses", direction: "short" },
    },
    local = { content: "将这次手术之前的那张报告优先处理" };
  assert.equal(scoreStated([wrong], stated, p).matched, false);
  assert.deepEqual(
    [
      scoreStated([right, local], stated, p).matched,
      scoreStated([right, local], stated, p).unexpected,
    ],
    [true, 1],
  );
  assert.equal(scoreStated([], stated, p).matched, false);
});

test("G6 uses persona rule count, excludes stated origin and rejects stored rules with no applicable effect", () => {
  const p = personas[0],
    term = {
      id: "t",
      origin: "learned",
      rule: { type: "term_style", section: "diagnoses", direction: "full" },
    },
    attend = {
      id: "a",
      origin: "learned",
      rule: { type: "attend_rule", section: "tags", hint: "吸烟史" },
    };
  const stated = {
    id: "s",
    origin: "stated",
    rule: {
      type: "exclude_rule",
      section: "diagnoses",
      status: "finding",
      matcher: "肝囊肿",
    },
  };
  const base = {
    habits: [term, attend, stated],
    statedChecks: [
      { matched: true, unexpected: 0 },
      { matched: true, unexpected: 0 },
    ],
    ruleEvidence: [
      { habitId: "t", ruleIds: ["terms"], correct: true, changed: true },
      {
        habitId: "s",
        ruleIds: ["incidental-findings"],
        correct: true,
        changed: true,
      },
    ],
  };
  const r = scoreG6(base, p);
  assert.equal(r.denominator, 9);
  assert.equal(r.recall, 1 / 9);
  assert.equal(r.precision, 0.5);
  assert.equal(r.learned, 2);
  assert.equal(r.status, "failed");
  assert.equal(scoreG6({ habits: [stated] }, p).recall, 0);
  assert.equal(scoreG6({ habits: [] }, p).precision, 0);
});

test("G10 is not evaluable on empty term sets and fails conflicting learned rules", () => {
  const base = {
    group: "C",
    persona: "D1",
    seed: 17,
    freshStoreEmpty: true,
    habits: [],
    ruleEvidence: [],
  };
  assert.equal(scoreG10([], personas).status, "not-evaluable");
  assert.equal(scoreG10([base], personas).status, "not-evaluable");
  base.habits = [
    {
      id: "x",
      origin: "learned",
      rule: { type: "term_style", section: "diagnoses", direction: "short" },
    },
  ];
  assert.equal(scoreG10([base], personas).status, "failed");
  base.habits[0].rule.direction = "full";
  assert.equal(scoreG10([base], personas).status, "not-evaluable");
  base.ruleEvidence = [{ habitId: "x", changed: true, correct: true }];
  assert.equal(scoreG10([base], personas).status, "passed");
});

function pairedRows(deltas = [-0.01, -0.01, 0.01]) {
  return deltas.flatMap((delta, i) =>
    ["A", "B", "C"].map((group) => ({
      group,
      persona: "D1",
      seed: i + 1,
      patient: "P1",
      sequence: 1,
      ser: 0.5,
      fer: 0.1,
      f1: 0.8 + (group === "A" ? 0 : delta),
    })),
  );
}
test("G3 uses paired uncertainty rather than passing noninferiority on point means", () => {
  const rows = pairedRows([-0.06, 0.02, 0.02]);
  assert.ok(
    rows.filter((r) => r.group === "C").reduce((n, r) => n + r.f1 - 0.8, 0) /
      3 >
      -0.02,
  );
  assert.equal(scoreG3(rows).status, "failed");
  assert.ok(scoreG3(rows).evidence.C.f1.ci95[0] < -0.02);
  assert.equal(scoreG3(pairedRows([0, 0, 0])).status, "passed");
  assert.equal(scoreG3(pairedRows([0])).status, "not-evaluable");
  const unmatched = pairedRows();
  unmatched.find((r) => r.group === "C").patient = "other";
  assert.equal(pairedCI(unmatched, "C", "f1").ci95, null);
  assert.deepEqual(pairedCI(rows, "C", "f1"), pairedCI(rows, "C", "f1"));
});

test("report includes every persona and cannot pass incomplete release evidence", () => {
  const result = evaluateGates(pairedRows(), [], personas, {
    release: true,
    cloud: true,
  });
  assert.deepEqual(Object.keys(result.perPersona), ["D1", "D2", "D3"]);
  assert.equal(result.gates.G3.status, "not-evaluable");
  assert.equal(result.gates.G10.status, "not-evaluable");
});

test("simulated doctor submits one edit per PATCH with sequential revision and completes before confirm", async () => {
  const draft = structuredClone(simple),
    final = renderLearningGold(simple, personas[0]);
  let revision = 0,
    previous = draft;
  const calls = [];
  const saved = await submitReviewEdits(
    async (path, method, body) => {
      assert.match(path, /review-draft$/);
      assert.equal(method, "PATCH");
      assert.equal(body.expectedRevision, revision);
      assert.notDeepEqual(body.payload, previous);
      previous = structuredClone(body.payload);
      calls.push(body);
      return { reviewRevision: ++revision };
    },
    { id: "review", payload: draft },
    final,
    personas[0],
  );
  assert.ok(calls.length > 5);
  assert.notDeepEqual(calls[0].payload, final);
  assert.equal(saved.reviewRevision, calls.length);
  assert.equal(factualMetrics(saved.payload, final).fer, 0);
  assert.equal(saved.payload.clinicalSummary.text, final.clinicalSummary.text);
  assert.equal(saved.edits.length, calls.length);
});

test("v2 judgment modules have no dependency on product clinical classifier or term dictionary", async () => {
  for (const f of [
    "learning-v2-domain.mjs",
    "learning-metrics-v2.mjs",
    "learning-gates-v2.mjs",
  ]) {
    const source = await readFile(
      new URL(`../scripts/${f}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /from\s+['"].*(?:shared\/review-diff|server\/medical)/,
    );
    assert.doesNotMatch(source, /classifyDiff/);
  }
});

test("v2 targets and per-edit revisions are accepted by the actual pending-action transaction", async () => {
  const { createServer } = await import("../server/agent.mjs");
  const server = createServer({ database: ":memory:", apiKey: "" });
  try {
    for (const p of personas) {
      const gold = { ...golds[2], name: `${golds[2].name}_${p.id}` },
        draft = renderLearningGold(gold, p, { traps: false }),
        final = renderLearningGold(gold, p);
      const action = server.pending.propose({
        type: "patient-create",
        summary: "synthetic local review test",
        payload: draft,
      });
      const saved = await submitReviewEdits(
        async (_path, _method, body) =>
          server.pending.saveReview(action.id, body),
        action,
        final,
        p,
      );
      assert.ok(saved.edits.length >= 3);
      const result = server.pending.confirm(action.id, {
        payload: final,
        expectedRevision: saved.reviewRevision,
      });
      assert.ok(result);
    }
  } finally {
    await server.shutdown();
  }
});

test("one habits application cannot take credit for another habits changes", () => {
  const p = personas[0],
    before = structuredClone(simple);
  const draft = structuredClone(before);
  draft.diagnoses[0].name = "心房颤动";
  draft.preHabitPayload = before;
  draft.habitChanges = [
    {
      habitId: "t",
      section: "diagnoses",
      index: 0,
      before: before.diagnoses[0],
      after: draft.diagnoses[0],
    },
  ];
  const good = {
    id: "t",
    origin: "learned",
    rule: { type: "term_style", section: "diagnoses", direction: "full" },
  };
  assert.equal(habitEvidence(good, draft, simple, p)[0].correct, true);
  assert.deepEqual(
    habitEvidence({ ...good, id: "another" }, draft, simple, p),
    [],
  );
  draft.habitChanges[0].after.status = "confirmed";
  assert.equal(habitEvidence(good, draft, simple, p)[0].correct, false);
});

test("history presence varies inside both learning and holdout splits and list-only materials contain no result values", async () => {
  for (const split of ["learning", "holdout"]) {
    const selected = golds.filter(
      (_, i) => manifest.patients[i].split === split,
    );
    for (const kind of ["吸烟史", "饮酒史", "职业接触史"]) {
      assert.ok(
        selected.some((g) => g.historyFacts.some((h) => h.kind === kind)),
      );
      assert.ok(
        selected.some((g) => !g.historyFacts.some((h) => h.kind === kind)),
      );
    }
  }
  let lists = 0;
  for (const p of manifest.patients.filter((p) => p.materials.length === 4)) {
    const sources = await readJSON(`patients/${p.id}/sources.json`);
    const text = Object.entries(sources).find(([name]) =>
      name.startsWith("随访补充"),
    )[1];
    assert.match(text, /预约项目/);
    assert.doesNotMatch(text, /mg|mmol|确诊|confirmed|suspected/);
    lists++;
  }
  assert.ok(lists >= 5);
});

test("same-unit small numeric discrepancies are not hidden by conversion rounding tolerance", () => {
  const changed = structuredClone(simple);
  changed.labs[0].value += 0.01;
  assert.equal(factualMetrics(changed, simple).factualDisagreements.length, 1);
});

test("conversion rounding is directional and hallucinated tags never inflate writing edits", () => {
  const p = personas[0],
    draft = renderLearningGold(simple, p, { traps: false });
  draft.labs[1].value = 88.41;
  assert.equal(factualMetrics(draft, simple, p).factualDisagreements.length, 1);
  draft.labs[1].value = 88.4;
  draft.tags = ["凭空编造的病史"];
  const m = learningMetrics(draft, renderLearningGold(simple, p), simple, p);
  assert.equal(m.ser, 0);
  assert.ok(m.fer > 0);
});
