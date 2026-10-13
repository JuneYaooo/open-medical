import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { PermissionEngine } from "../server/core/permissions.mjs";

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
  assert.match(similar.note, /提出假设/);

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

test("case curation: lessons/tags/starred, patch and featured weighting", async (t) => {
  const f = await fixture(t);
  const created = (await f.json("/api/cases", "POST", sampleCase({
    lessons: "蛋白尿升高的糖尿病患者要尽早加 SGLT2 抑制剂，同时盯尿蛋白趋势",
    tags: ["糖尿病", "SGLT2"],
    starred: true,
  }))).data;
  assert.equal(created.starred, true);
  assert.match(created.lessons, /SGLT2/);
  assert.deepEqual(created.tags, ["糖尿病", "SGLT2"]);

  const featured = (await f.json("/api/cases?starred=1")).data;
  assert.equal(featured.count, 1);
  assert.equal((await f.json("/api/cases")).data.count, 1);

  // 精选加权：两份病例同诊断时，精选的排在前面且带可读理由。
  await f.json("/api/cases", "POST", sampleCase({
    summary: "另一位 2 型糖尿病患者的降糖方案调整记录",
  }));
  const similar = (await f.json("/api/cases/similar", "POST", {
    caseText: "2 型糖尿病 蛋白尿 降糖方案调整",
    diagnosis: "糖尿病",
  })).data;
  assert.ok(similar.count >= 2);
  assert.equal(similar.matches[0].starred, true);
  assert.ok(similar.matches[0].reasons.some((reason) => reason.includes("精选")));
  assert.ok(similar.matches.some((match) => match.starred === false));

  // 精选不凭空入场：与检索毫无交集的病例不因星标出现。
  await f.json("/api/cases", "POST", sampleCase({
    diagnosis: "社区获得性肺炎",
    summary: "老年肺炎抗感染治疗",
    lessons: "肺炎经验",
    tags: ["肺炎"],
    starred: true,
    keyLabs: [{ item: "白细胞", value: 12.1, unit: "10^9/L", date: "2025-05-01" }],
    treatments: ["莫西沙星"],
  }));
  const noOverlap = (await f.json("/api/cases/similar", "POST", {
    caseText: "2 型糖尿病 蛋白尿 降糖方案调整",
    diagnosis: "糖尿病",
  })).data;
  assert.ok(noOverlap.matches.every((match) => !/肺炎/.test(match.diagnosis)));

  // PATCH：编辑经验教训与标签、取消精选。
  const patched = (await f.json(`/api/cases/${created.id}`, "PATCH", {
    lessons: "改成：先查尿微量白蛋白再调方案",
    tags: ["糖尿病"],
    starred: false,
  })).data;
  assert.equal(patched.starred, false);
  assert.match(patched.lessons, /尿微量白蛋白/);
  assert.deepEqual(patched.tags, ["糖尿病"]);
  assert.equal((await f.json("/api/cases?starred=1")).data.count, 1);
  assert.match((await f.json(`/api/cases/${created.id}`)).data.text, /尿微量白蛋白/);

  const invalid = await f.json(`/api/cases/${created.id}`, "PATCH", { tags: "不是数组" });
  assert.equal(invalid.status, 400);
});

test("case_save_propose carries lessons/tags into the library on confirm", async (t) => {
  const f = await fixture(t);
  const session = await f.session("精选案例");
  const registry = f.server.workspaces.registry(session.id);
  const permissions = new PermissionEngine({ profile: "standard" });
  const patient = (await f.json("/api/patients", "POST", {
    name: "精选提案患者",
    diagnoses: [{ code: "I10", name: "原发性高血压" }],
  })).data;
  const proposal = await registry.execute("case_save_propose", {
    patientId: patient.id,
    summary: "难治性高血压，加用螺内酯后达标",
    lessons: "三药达标无效时先查继发性原因，再考虑螺内酯",
    tags: ["高血压", "螺内酯"],
  }, {}, permissions);
  assert.ok(proposal.id, "应生成待确认提案");
  assert.equal((await f.json("/api/cases")).data.count, 0);
  assert.equal((await f.json(`/api/pending-actions/${proposal.id}/confirm`, "POST", {})).status, 200);
  const all = (await f.json("/api/cases")).data;
  const saved = all.cases.find((item) => item.patientId === patient.id);
  assert.ok(saved, "提案确认后病例应入库");
  assert.match(saved.lessons, /螺内酯/);
  assert.deepEqual(saved.tags, ["高血压", "螺内酯"]);
  // 提案入库不自动加星：精选与否由医生在案例库里决定。
  assert.equal(saved.starred, false);
});
