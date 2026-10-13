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

test("matrix concurrency is bounded and awaits successful cells after another cell fails", async () => {
  const { runLearningCells } = await import("../scripts/learning-workers.mjs");
  let active = 0,
    peak = 0;
  const finished = [];
  const results = await runLearningCells([0, 1, 2, 3, 4], 2, async (id) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, id === 0 ? 20 : 5));
    active--;
    finished.push(id);
    if (id === 1) throw new Error("isolated failure");
    return id;
  });
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(finished.slice().sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"],
  );
  assert.deepEqual(
    results.filter((r) => r.status === "fulfilled").map((r) => r.value),
    [0, 2, 3, 4],
  );
  await assert.rejects(
    runLearningCells([1], 0, async () => {}),
    /concurrency/,
  );
});

test("learning summaries include field and fact uncertainty and pair the context baseline by persona and seed", async () => {
  const { summarizeLearning } = await import("../scripts/learning-metrics.mjs");
  const rows = [];
  for (const [persona, seed, ser] of [
    ["D1", 17, 0.4],
    ["D1", 41, 0.5],
    ["D2", 17, 0.6],
  ]) {
    for (const sequence of [1, 21]) {
      rows.push({
        group: "A",
        persona,
        seed,
        patient: `P${sequence}`,
        sequence,
        ser,
        fer: 0.2,
        f1: 0.8,
      });
      rows.push({
        group: "B",
        persona,
        seed,
        patient: `P${sequence}`,
        sequence,
        ser: ser - 0.2,
        fer: 0.1,
        f1: 0.9,
      });
    }
  }
  const summary = summarizeLearning(rows);
  assert.equal(summary.groups.B.overall.count, 6);
  assert.ok(
    summary.groups.B.early.ferCI95.every((n) => Math.abs(n - 0.1) < 1e-12),
  );
  assert.ok(
    summary.groups.B.late.f1CI95.every((n) => Math.abs(n - 0.9) < 1e-12),
  );
  assert.equal(summary.paired.B.overall.pairs, 6);
  assert.ok(summary.paired.B.overall.ci95[1] < 0);
  assert.equal(summary.pairedLateCI95, null);
});

test("completed matrix cells resume only from complete ordered patient evidence", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { completedLearningCell } =
    await import("../scripts/learning-checkpoints.mjs");
  const dir = await mkdtemp(join(tmpdir(), "learning-checkpoint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cell = { group: "C", personaId: "D1", seed: 17 };
  assert.equal(await completedLearningCell(dir, cell, 2), null);
  const run = {
    group: "C",
    persona: "D1",
    seed: 17,
    completed: false,
    files: ["C-D1-17-P001.json", "C-D1-17-P002.json"],
  };
  await writeFile(join(dir, "C-D1-17-run.json"), JSON.stringify(run));
  assert.equal(await completedLearningCell(dir, cell, 2), null);
  for (const [i, file] of run.files.entries())
    await writeFile(
      join(dir, file),
      JSON.stringify({
        row: {
          group: "C",
          persona: "D1",
          seed: 17,
          sequence: i + 1,
          patient: `P00${i + 1}`,
          ser: 0.1,
        },
      }),
    );
  run.completed = true;
  await writeFile(join(dir, "C-D1-17-run.json"), JSON.stringify(run));
  assert.equal((await completedLearningCell(dir, cell, 2)).rows.length, 2);
  await assert.rejects(completedLearningCell(dir, cell, 3), /矩阵不一致/);
  run.files.reverse();
  await writeFile(join(dir, "C-D1-17-run.json"), JSON.stringify(run));
  await assert.rejects(completedLearningCell(dir, cell, 2), /顺序不一致/);
});
