import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  learningMetrics,
  renderLearningGold,
  evaluateHabit,
  shuffle,
  bootstrap,
} from "../scripts/learning-metrics.mjs";
const root = new URL("../evals/learning-loop-v1/", import.meta.url);
test("frozen synthetic matrix contains readable text and real images, disjoint heldouts, matching gold checksums", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root)));
  assert.equal(manifest.patients.length, 40);
  assert.equal(
    manifest.patients.filter((p) => p.split === "holdout").length,
    10,
  );
  assert.equal(new Set(manifest.patients.map((p) => p.id)).size, 40);
  for (const p of manifest.patients) {
    const gold = readFileSync(new URL(`patients/${p.id}/gold.json`, root));
    assert.equal(createHash("sha256").update(gold).digest("hex"), p.goldHash);
    assert.ok(p.materials.length >= 2);
    for (const name of p.materials) {
      const bytes = readFileSync(
        new URL(`patients/${p.id}/materials/${name}`, root),
      );
      assert.ok(bytes.length > 50);
      if (name.endsWith(".png"))
        assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    }
  }
});
test("deterministic persona applies traps but the factual evaluator penalizes them; styles never enter SER", () => {
  const gold = JSON.parse(
      readFileSync(new URL("patients/P003/gold.json", root)),
    ),
    persona = JSON.parse(readFileSync(new URL("personas/D1.json", root)));
  const target = renderLearningGold(gold, persona);
  assert.equal(target.medications[0].dose, "20mg");
  assert.equal(gold.medications[0].dose, "5mg");
  assert.ok(learningMetrics(target, target, gold).f1 < 1);
  const changed = structuredClone(gold);
  changed.clinicalSummary.text = "另一种表达";
  assert.equal(learningMetrics(gold, changed, gold).ser, 0);
  assert.equal(
    evaluateHabit(
      { rule: { type: "format_rule", field: "dose", to: "20mg" } },
      persona,
    ).unsafe,
    true,
  );
  assert.equal(
    evaluateHabit(
      { rule: { type: "term_replace", from: "高血压", to: "HTN" } },
      persona,
    ).correct,
    false,
  );
});
test("paired experiment shuffles and bootstrap intervals are repeatable and not fake zero-width with one unit", () => {
  assert.deepEqual(shuffle([1, 2, 3, 4, 5], 17), shuffle([1, 2, 3, 4, 5], 17));
  assert.equal(bootstrap([0.1]), null);
  assert.deepEqual(bootstrap([0.1, 0.2, 0.3]), bootstrap([0.1, 0.2, 0.3]));
});

test("recorded draft replay retires an intentionally wrong learned habit within five confirmations", async () => {
  const { selfHealingProbe } = await import("../scripts/learning-probes.mjs");
  const result = await selfHealingProbe(
    { diagnoses: [{ name: "HTN", status: "confirmed" }] },
    { termDirection: "full" },
  );
  assert.equal(result.status, "passed");
  assert.equal(result.patients, 5);
  assert.equal(result.ledger.reverted, 5);
});

test("style judge cannot bypass twenty independent labels or the 90 percent agreement threshold", async () => {
  const { calibrateStyleJudge } =
    await import("../scripts/learning-style-judge.mjs");
  const provider = {
    complete: async () => ({
      message: { content: '{"consistent":true,"clinical":false}' },
    }),
  };
  assert.equal(
    (await calibrateStyleJudge(provider, { examples: [] })).usable,
    false,
  );
  const examples = Array.from({ length: 20 }, () => ({
    content: "摘要精简",
    persona: { summary: "brief" },
    expected: true,
    expectedUnsafe: false,
  }));
  const good = await calibrateStyleJudge(provider, {
    reviewer: "synthetic protocol test",
    examples,
  });
  assert.equal(good.usable, true);
  examples[0].expected = false;
  examples[1].expected = false;
  examples[2].expected = false;
  assert.equal(
    (
      await calibrateStyleJudge(provider, {
        reviewer: "synthetic protocol test",
        examples,
      })
    ).usable,
    false,
  );
});
