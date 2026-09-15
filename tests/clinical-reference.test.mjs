import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateScale,
  listScales,
} from "../server/medical/scales.mjs";
import { searchLabKnowledge } from "../server/medical/lab-knowledge.mjs";
import { searchIcd9 } from "../server/medical/icd9.mjs";
import {
  assessAdverseReaction,
  specialPopulationCautions,
} from "../server/medical/med-safety.mjs";
import { fixture } from "./helpers.mjs";

test("scales: CHA2DS2-VASc classic 4-point example", () => {
  const result = calculateScale("cha2ds2-vasc", {
    chf: "是", htn: "是", age: "≥75 岁", dm: "否",
    stroke: "否", vascular: "否", sex: "男",
  });
  assert.equal(result.score, 4);
  assert.match(result.level, /高风险/);
});

test("scales: eGFR CKD-EPI 2021 reference values", () => {
  // 40-year-old female, creatinine 70 µmol/L → CKD-EPI 2021 ≈ 96.6.
  const young = calculateScale("egfr", { creatinine: 70, age: 40, sex: "女" });
  assert.ok(young.score > 90 && young.score < 105, `eGFR=${young.score}`);
  // 80-year-old male, creatinine 150 µmol/L → eGFR ~35 (G3b).
  const old = calculateScale("egfr", { creatinine: 150, age: 80, sex: "男" });
  assert.ok(old.score > 25 && old.score < 45, `eGFR=${old.score}`);
  assert.match(old.level, /G3b/);
});

test("scales: Naranjo definite/probable bands and validation errors", () => {
  const definite = calculateScale("naranjo", {
    q1: "是", q2: "是", q3: "是", q4: "是", q5: "否",
    q6: "否", q7: "是", q8: "是", q9: "是", q10: "是",
  });
  assert.equal(definite.score, 13);
  assert.match(definite.level, /肯定/);
  assert.throws(
    () => calculateScale("naranjo", { q1: "是" }),
    (err) => err.code === "INVALID_INPUT",
  );
  assert.throws(
    () => calculateScale("no-such-scale", {}),
    (err) => err.code === "NOT_FOUND",
  );
});

test("scales: CrCl Cockcroft-Gault and list completeness", () => {
  const crcl = calculateScale("crcl", {
    age: 70, weight: 60, creatinine: 176, sex: "女",
  });
  // ((140-70)*60)/(72*1.99)*0.85 ≈ 24.9
  assert.ok(crcl.score >= 20 && crcl.score <= 30, `CrCl=${crcl.score}`);
  const ids = listScales().map((s) => s.id);
  assert.ok(ids.length >= 11);
  for (const id of [
    "cha2ds2-vasc", "has-bled", "wells-dvt", "child-pugh", "curb-65",
    "gcs", "naranjo", "egfr", "crcl", "bmi", "bsa",
  ])
    assert.ok(ids.includes(id), id);
});

test("scales: ADR five-point causality follows dechallenge/rechallenge evidence", () => {
  const base = { time: "是", known: "是", dechallenge: "阳性（好转）", otherCause: "否" };
  const definite = calculateScale("adr-five-point", {
    ...base, rechallenge: "阳性（再现）",
  });
  assert.equal(definite.level, "肯定有关");
  assert.equal(definite.interpretation.includes("相关"), true);
  const probable = calculateScale("adr-five-point", {
    ...base, rechallenge: "未做/不确定",
  });
  assert.equal(probable.level, "很可能有关");
  const possible = calculateScale("adr-five-point", {
    time: "是", known: "否", dechallenge: "未做/不确定", rechallenge: "未做/不确定", otherCause: "否",
  });
  assert.equal(possible.level, "可能有关");
  const unrelated = calculateScale("adr-five-point", {
    time: "否", known: "是", dechallenge: "阳性（好转）", rechallenge: "未做/不确定", otherCause: "否",
  });
  assert.equal(unrelated.level, "无关");
  assert.equal(unrelated.interpretation.includes("不相关"), true);
  const otherExplanation = calculateScale("adr-five-point", {
    time: "是", known: "是", dechallenge: "未做/不确定", rechallenge: "未做/不确定", otherCause: "是",
  });
  assert.equal(otherExplanation.level, "可能无关");
  assert.throws(() => calculateScale("adr-five-point", { time: "是" }), (err) => err.code === "INVALID_INPUT");
  // 12 scales now.
  assert.ok(listScales().length >= 12);
});

test("lab knowledge: alias search and disclaimer", () => {
  const byAlias = searchLabKnowledge({ query: "wbc" });
  assert.equal(byAlias.entries[0].name, "白细胞计数 WBC");
  const byChinese = searchLabKnowledge({ query: "血钾" });
  assert.match(byChinese.entries[0].high, /急症|药物/);
  assert.match(byChinese.note, /以报告单打印范围为准/);
  assert.equal(searchLabKnowledge({ query: "不存在的指标zzz" }).count, 0);
});

test("icd9 helper: code and name search", () => {
  assert.equal(searchIcd9("51.23")[0].name, "腹腔镜胆囊切除术");
  assert.ok(searchIcd9("胆囊").some((c) => c.name.includes("胆囊切除")));
  assert.equal(searchIcd9("").length, 0);
});

test("adverse reaction assessment: ACEI dry cough and potassium finding", () => {
  const result = assessAdverseReaction({
    medications: ["依那普利", "氨氯地平"],
    findings: "患者出现干咳两周，复查血钾升高（5.8）",
  });
  assert.ok(result.total >= 2);
  const cough = result.suspected.find((s) => s.reaction === "干咳");
  assert.equal(cough.drugClass, "ACEI");
  assert.ok(result.suspected.some((s) => ["高钾血症", "血钾升高", "血钾偏高"].includes(s.reaction)));
  assert.ok(result.drugProfiles.some((p) => p.drugClass === "ACEI"));
  // Brand-name normalization: 拜阿司匹灵 maps to aspirin profile.
  const brand = assessAdverseReaction({
    medications: ["拜阿司匹灵"],
    findings: "黑便，考虑消化道出血",
  });
  assert.ok(brand.suspected.some((s) => s.reaction === "消化道出血"));
  assert.throws(
    () => assessAdverseReaction({ medications: [], findings: "x" }),
    /至少 1 种/,
  );
});

test("special population cautions: pregnancy and renal", () => {
  const result = specialPopulationCautions({
    medications: ["华法林", "格华止"],
    populations: ["pregnancy", "renal"],
  });
  assert.ok(result.cautions.some((c) => c.medication === "华法林" && c.populationLabel === "妊娠"));
  assert.ok(result.cautions.some((c) => c.medication === "格华止" && c.population === "renal"));
  assert.throws(
    () => specialPopulationCautions({ medications: ["x"], populations: ["space"] }),
    /populations/,
  );
});

test("clinical query REST endpoints end-to-end", async (t) => {
  const f = await fixture(t);
  const boot = (await f.json("/api/bootstrap")).data;
  for (const tool of [
    "medical_scale_list", "medical_scale_calculate",
    "lab_knowledge_search", "assess_adverse_reaction",
    "medication_safety_check",
  ])
    assert.ok(boot.tools.includes(tool), tool);

  const scale = await f.json("/api/scales/cha2ds2-vasc/calculate", "POST", {
    answers: { chf: "是", htn: "是", age: "≥75 岁", dm: "否", stroke: "否", vascular: "否", sex: "男" },
  });
  assert.equal(scale.data.score, 4);
  const list = (await f.json("/api/scales")).data.scales;
  assert.ok(list.length >= 11);

  const lab = (await f.json("/api/lab-knowledge?q=肌钙蛋白")).data;
  assert.ok(lab.count >= 1);

  const icd9 = (await f.json("/api/icd9?q=胆囊")).data;
  assert.ok(icd9.codes.length >= 1);

  const adr = await f.json("/api/adr-assess", "POST", {
    medications: ["左氧氟沙星"],
    findings: "跟腱疼痛",
  });
  assert.ok(adr.data.suspected.some((s) => ["肌腱炎", "跟腱疼痛"].includes(s.reaction)));

  const cautions = await f.json("/api/med-cautions", "POST", {
    medications: ["二甲双胍"],
    populations: ["renal"],
  });
  assert.equal(cautions.data.total, 1);

  const safety = await f.json("/api/med-safety", "POST", {
    medications: ["二甲双胍"],
    populations: ["renal"],
  });
  assert.equal(safety.data.populationCautions.total, 1);
});
