import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  ruleCoverage,
  DRUG_REGIMENS,
  frequency,
  knownProductGaps,
} from "./learning-v2-domain.mjs";
export function skeleton(text) {
  return text
    .normalize("NFKC")
    .replace(/SYNTH_V2_P\d+_[a-f0-9]+/g, "患者")
    .replace(/P\d{3}/g, "患者")
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, "")
    .toLowerCase();
}
export function shingles(text) {
  const s = [...skeleton(text)];
  return new Set(s.slice(0, -4).map((_, i) => s.slice(i, i + 5).join("")));
}
export function assertDiversity(corpus, threshold = 0.7) {
  let maxJaccard = 0,
    closest = [];
  const sets = corpus.map((p) => shingles(p.text));
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++) {
      const intersection = [...sets[i]].filter((x) => sets[j].has(x)).length;
      const score = intersection / (sets[i].size + sets[j].size - intersection);
      assert.ok(
        Number.isFinite(score) && score < threshold,
        `${corpus[i].id}/${corpus[j].id} masked shingle Jaccard ${score} >= ${threshold}`,
      );
      if (score > maxJaccard) {
        maxJaccard = score;
        closest = [corpus[i].id, corpus[j].id];
      }
    }
  return {
    maxJaccard,
    closest,
    threshold,
    method: "digit/identity-masked Unicode 5-character shingles",
  };
}
export async function checkFixtures(
  root = new URL("../evals/learning-loop-v2/", import.meta.url),
) {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root))),
    corpus = [],
    golds = [],
    labFormats = new Set();
  assert.equal(manifest.patients.length, 40);
  assert.equal(
    manifest.patients.filter((p) => p.split === "learning").length,
    30,
  );
  for (let c = 0; c < 4; c++)
    assert.equal(manifest.patients.filter((p) => p.cluster === c).length, 10);
  assert.equal(
    manifest.patients.filter((p) => p.degradation.difficulty === "hard").length,
    Math.floor(manifest.patients.length / 3),
  );
  for (const p of manifest.patients) {
    if (p.degradation.difficulty === "hard") {
      assert.ok(
        Math.abs(p.degradation.rotation) >= 2 &&
          Math.abs(p.degradation.rotation) <= 5,
      );
      assert.ok(p.degradation.blur >= 0.8 && p.degradation.jpegQuality <= 0.5);
    }
    const base = new URL(`patients/${p.id}/`, root),
      sources = JSON.parse(await readFile(new URL("sources.json", base)));
    const gold = JSON.parse(await readFile(new URL("gold.json", base)));
    for (const m of gold.medications)
      assert.ok(
        DRUG_REGIMENS[m.name]?.some(
          (r) => r.dose === m.dose && r.frequency === frequency(m.frequency),
        ),
        `${p.id}: implausible regimen`,
      );
    for (const [name, text] of Object.entries(sources)) {
      assert.doesNotMatch(
        text,
        /\b(?:confirmed|suspected|finding|active|stopped)\b/,
      );
      if (
        !name.endsWith(".png") &&
        /(?:血糖|肌酐)\s*[\d.]+\s*(?:mg|mmol|μmol)/.test(text)
      )
        labFormats.add(name.split(".").at(-1));
    }
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      hash(await readFile(new URL("gold.json", base))),
      p.goldHash,
      `${p.id} gold hash`,
    );
    assert.equal(
      hash(await readFile(new URL("sources.json", base))),
      p.sourceHash,
      `${p.id} source hash`,
    );
    assert.ok(p.materials.length >= 2 && p.materials.length <= 4);
    for (const file of p.materials)
      assert.equal(
        hash(await readFile(new URL(`materials/${file}`, base))),
        p.materialHashes[file],
        `${p.id}/${file} hash`,
      );
    corpus.push({ id: p.id, text: Object.values(sources).join("\n") });
    if (p.split === "learning")
      golds.push(JSON.parse(await readFile(new URL("gold.json", base))));
  }
  assert.deepEqual([...labFormats].sort(), ["docx", "pdf", "txt"]);
  const diversity = assertDiversity(corpus),
    coverage = {},
    gaps = {};
  for (const id of ["D1", "D2", "D3"]) {
    const persona = JSON.parse(
      await readFile(new URL(`personas/${id}.json`, root)),
    );
    for (const rule of persona.rules) {
      assert.equal(
        typeof rule.learnableByProduct,
        "boolean",
        `${id}/${rule.id}: missing product classification`,
      );
      assert.ok(rule.reason?.trim(), `${id}/${rule.id}: missing reason`);
      if (
        [
          "unit",
          "style-date",
          "summary-cap",
          "trap-status",
          "trap-dose",
        ].includes(rule.kind) ||
        rule.order === "therapy-first"
      )
        assert.equal(rule.learnableByProduct, false);
      assert.notEqual(
        rule.kind,
        "date",
        "Structured date preferences are not persona rules",
      );
    }
    gaps[id] = knownProductGaps(persona);
    coverage[id] = ruleCoverage(golds, persona);
    for (const [rule, n] of Object.entries(coverage[id]))
      assert.ok(n >= 5, `${id}/${rule} changes ${n}, expected >=5`);
  }
  return { diversity, coverage, knownProductGaps: gaps };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(await checkFixtures(), null, 2));
