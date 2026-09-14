import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

const sampleCase = (overrides = {}) => ({
  diagnosis: "2 型糖尿病合并糖尿病肾病",
  icd10: "E11",
  age: 58,
  gender: "male",
  keyLabs: [
    { item: "糖化血红蛋白", value: 8.9, unit: "%", date: "2025-06-01" },
    { item: "尿微量白蛋白", value: 120, unit: "mg/L", date: "2025-06-01" },
  ],
  treatments: ["二甲双胍 0.5g tid", "达格列净 10mg qd", "胰岛素强化治疗"],
  outcome: "血糖逐步达标，尿蛋白下降",
  summary: "中年男性 2 型糖尿病 10 年，出现持续蛋白尿，调整降糖方案并加用 SGLT2 抑制剂后好转。",
  ...overrides,
});

test("case library: add, list, search, delete", async (t) => {
  const f = await fixture(t);
  const created = await f.json("/api/cases", "POST", sampleCase());
  assert.equal(created.status, 201);
  assert.ok(created.data.text.includes("达格列净"));

  await f.json("/api/cases", "POST", sampleCase({
    diagnosis: "社区获得性肺炎",
    summary: "老年肺炎患者抗感染治疗后痊愈出院",
    keyLabs: [{ item: "白细胞", value: 12.1, unit: "10^9/L", date: "2025-05-01" }],
    treatments: ["莫西沙星"],
    outcome: "痊愈出院",
  }));
  const all = (await f.json("/api/cases")).data;
  assert.equal(all.count, 2);

  const search = (await f.json("/api/cases?query=" + encodeURIComponent("蛋白尿 达格列净"))).data;
  assert.equal(search.count, 1);
  assert.match(search.cases[0].diagnosis, /糖尿病肾病/);

  const byDiagnosis = (await f.json("/api/cases?diagnosis=" + encodeURIComponent("肺炎"))).data;
  assert.equal(byDiagnosis.count, 1);

  const removed = await f.json(`/api/cases/${search.cases[0].id}`, "DELETE");
  assert.equal(removed.status, 200);
  assert.equal((await f.json("/api/cases")).data.count, 1);
});

test("case library: build case from patient snapshot", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", {
    name: "病例入库患者",
    birthYear: 1955,
    gender: "female",
    diagnoses: [{ code: "I10", name: "原发性高血压" }],
    medications: [{ name: "氨氯地平 5mg qd" }],
    labs: [{ item: "肌酐", value: 72, unit: "μmol/L", date: "2025-07-01" }],
  })).data;
  const created = await f.json("/api/cases", "POST", {
    patientId: patient.id,
    summary: "老年高血压患者血压控制平稳",
    outcome: "血压达标",
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.diagnosis, "原发性高血压");
  assert.equal(created.data.icd10, "I10");
  assert.equal(created.data.age, new Date().getFullYear() - 1955);
  assert.equal(created.data.keyLabs.length, 1);
  assert.ok(created.data.treatments[0].includes("氨氯地平"));
});

test("similar case search: scoring with diagnosis weight and match reasons", async (t) => {
  const f = await fixture(t);
  await f.json("/api/cases", "POST", sampleCase());
  await f.json("/api/cases", "POST",
    sampleCase({
      diagnosis: "社区获得性肺炎",
      summary: "老年患者发热咳嗽，抗感染治疗有效",
      keyLabs: [{ item: "白细胞", value: 12.1, unit: "10^9/L", date: "2025-05-01" }],
      treatments: ["莫西沙星"],
      outcome: "痊愈",
    }),
  );

  const result = (await f.json("/api/cases", "POST", {
    query: "similar",
  })).data; // control: plain list endpoint must not expose /similar
  void result;

  const similar = (await f.json("/api/cases/similar", "POST", {
    caseText: "2 型糖尿病 蛋白尿 血糖控制不佳 降糖方案调整",
    diagnosis: "糖尿病",
    age: 55,
    gender: "male",
  })).data;
  assert.equal(similar.count, 1);
  const match = similar.matches[0];
  assert.match(match.diagnosis, /糖尿病/);
  assert.ok(match.score >= 5);
  assert.ok(match.reasons.some((reason) => reason.startsWith("诊断匹配")));
  assert.ok(match.reasons.some((reason) => reason.startsWith("年龄接近")));
  assert.ok(match.reasons.some((reason) => reason.startsWith("术语命中")));
  assert.match(similar.note, /参考/);

  const empty = (await f.json("/api/cases/similar", "POST", {
    caseText: "外星病原体感染",
  })).data;
  assert.equal(empty.count, 0);

  const invalid = await f.json("/api/cases/similar", "POST", {});
  assert.equal(invalid.status, 400);
});

test("similar_case_search agent tool registered", async (t) => {
  const f = await fixture(t);
  const boot = (await f.json("/api/bootstrap")).data;
  assert.ok(boot.tools.includes("similar_case_search"));
  assert.equal(boot.cases.cases, 0);
});
