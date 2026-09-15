import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMedicationSafety,
  INTERACTION_PAIRS,
} from "../server/medical/med-safety.mjs";
import { fixture } from "./helpers.mjs";

test("medication safety: allergy match, interactions and duplicates", () => {
  const result = evaluateMedicationSafety({
    medications: [
      "华法林钠片",
      "阿司匹林肠溶片",
      "阿司匹林",
      "美托洛尔",
      "美托洛尔缓释片",
      "美托洛尔缓释片",
    ],
    allergies: ["阿司匹林"],
  });
  assert.equal(result.checked, 6);
  assert.equal(result.allergyMatches.length, 2); // both aspirin-containing meds match
  assert.ok(result.allergyMatches.every((m) => m.severity === "critical"));
  const keys = result.interactions.map((i) => i.ruleKey);
  assert.ok(keys.includes("int_aspirin_warfarin"));
  // Cross-form duplicates: aspirin (tablet + plain) and metoprolol (three
  // spellings) both collapse to one substance each.
  assert.equal(result.duplicates.length, 2);
  const dupNames = result.duplicates.map((d) => d.medication).sort();
  assert.deepEqual(dupNames, ["美托洛尔", "阿司匹林"].sort());
  assert.equal(result.duplicates.find((d) => d.medication === "美托洛尔").count, 3);
  assert.ok(result.total >= 5);
  assert.match(result.note, /非穷尽/);
});

test("medication safety: clean list stays silent, object entries accepted", () => {
  const result = evaluateMedicationSafety({
    medications: [
      { name: "氨氯地平", dose: "5mg", frequency: "qd" },
      { name: "阿托伐他汀", dose: "20mg" },
    ],
    allergies: ["青霉素"],
  });
  assert.equal(result.total, 0);
  assert.equal(result.checked, 2);
  assert.throws(
    () => evaluateMedicationSafety({ medications: "不是数组" }),
    /最多 60 条|必须为/,
  );
});

test("medication safety: MAOI+SSRI flagged critical", () => {
  const result = evaluateMedicationSafety({
    medications: ["苯乙肼", "氟西汀"],
  });
  assert.equal(result.interactions[0].severity, "critical");
  assert.ok(INTERACTION_PAIRS.length >= 5);
});

test("drug alias canonicalization: brand names hit interactions and duplicates", () => {
  // 拜阿司匹灵 is brand aspirin: interaction fires without the literal word.
  const brand = evaluateMedicationSafety({
    medications: ["拜阿司匹灵", "华法林钠片"],
  });
  assert.ok(brand.interactions.some((i) => i.ruleKey === "int_aspirin_warfarin"));
  assert.equal(brand.normalized.includes("阿司匹林"), true);
  // Brand + generic of the same substance is a duplicate.
  const dup = evaluateMedicationSafety({
    medications: ["拜阿司匹灵", "阿司匹林肠溶片"],
  });
  assert.equal(dup.duplicates.length, 1);
  assert.equal(dup.duplicates[0].medication, "阿司匹林");
  assert.equal(dup.duplicates[0].count, 2);
  // Brand aspirin matches an aspirin allergy.
  const allergy = evaluateMedicationSafety({
    medications: ["拜阿司匹灵"],
    allergies: ["阿司匹林"],
  });
  assert.equal(allergy.allergyMatches.length, 1);
  assert.equal(allergy.allergyMatches[0].matchedGeneric, "阿司匹林");
});

test("med-safety REST endpoint and agent tool registration", async (t) => {
  const f = await fixture(t);
  const boot = (await f.json("/api/bootstrap")).data;
  assert.ok(boot.tools.includes("medication_safety_check"));

  const result = await f.json("/api/med-safety", "POST", {
    medications: ["地高辛", "呋塞米"],
    allergies: [],
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.interactions[0].ruleKey, "int_digoxin_furosemide");
});
