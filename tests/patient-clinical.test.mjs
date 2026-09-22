import test from "node:test";
import assert from "node:assert/strict";
import { searchIcd10, ICD10_COMMON } from "../server/medical/icd10.mjs";
import { fixture } from "./helpers.mjs";

test("icd10 helper: code-first ranking and name substring search", () => {
  assert.ok(ICD10_COMMON.length >= 30);
  const byExactCode = searchIcd10("i10");
  assert.equal(byExactCode[0].code, "I10");
  const byPrefix = searchIcd10("E11");
  assert.equal(byPrefix[0].code, "E11");
  assert.match(byPrefix[0].name, /糖尿病/);
  const byName = searchIcd10("心房");
  assert.equal(byName[0].code, "I48");
  assert.equal(searchIcd10("不存在病名zzz").length, 0);
  assert.equal(searchIcd10("").length, 0);
});

test("patient clinical fields: create with structured data, revision-guarded update", async (t) => {
  const f = await fixture(t);
  const created = await f.json("/api/patients", "POST", {
    name: "临床测试患者",
    birthYear: 1962,
    gender: "male",
    diagnoses: [
      { code: "I10", name: "原发性高血压", date: "2023-05-11" },
      { name: "2 型糖尿病" },
    ],
    medications: [
      { name: "氨氯地平", dose: "5mg", frequency: "qd" },
      { name: "二甲双胍", dose: "0.5g", frequency: "tid" },
    ],
    allergies: ["青霉素"],
    labs: [
      { item: "血钾", value: 3.4, unit: "mmol/L", date: "2025-08-01" },
      { item: "肌酐", value: 88, unit: "μmol/L", date: "2025-08-01" },
    ],
    visits: [{ date: "2025-08-01", reason: "复诊开药" }],
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.diagnoses.length, 2);
  assert.equal(created.data.medications[0].dose, "5mg");
  assert.equal(created.data.allergies[0], "青霉素");
  assert.equal(created.data.labs[0].value, 3.4);

  const invalid = await f.json("/api/patients", "POST", {
    name: "坏数据患者",
    labs: [{ item: "血钾", value: "高", date: "2025-08-01" }],
  });
  assert.equal(invalid.status, 400);
  const badDate = await f.json("/api/patients", "POST", {
    name: "坏日期患者",
    visits: [{ date: "2025-13-01", reason: "x" }],
  });
  assert.equal(badDate.status, 400);

  const updated = await f.json(`/api/patients/${created.data.id}`, "PATCH", {
    expectedRevision: created.data.revision,
    diagnoses: [{ code: "I10", name: "原发性高血压", date: "2023-05-11" }],
    labs: [
      { item: "血钾", value: 3.4, unit: "mmol/L", date: "2025-08-01" },
      { item: "血钾", value: 2.6, unit: "mmol/L", date: "2025-09-10" },
    ],
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.labs.length, 2);
});

test("patient de-identified export removes identity and buckets age", async (t) => {
  const f = await fixture(t);
  const created = await f.json("/api/patients", "POST", {
    name: "张三丰",
    phone: "13800009999",
    birthYear: 1970,
    gender: "female",
    diagnoses: [{ code: "E11", name: "2 型糖尿病" }],
    labs: [{ item: "糖化血红蛋白", value: 8.2, unit: "%", date: "2025-07-02" }],
  });
  const exported = (await f.json(`/api/patients/${created.data.id}/export`)).data;
  assert.match(exported.pseudoId, /^P-[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(exported).includes("张三丰"));
  assert.ok(!JSON.stringify(exported).includes("13800009999"));
  assert.equal(exported.birthYear, undefined);
  assert.equal(exported.ageBand, "50–59");
  assert.equal(exported.diagnoses[0].code, "E11");
  assert.equal(exported.labs[0].value, 8.2);
  assert.match(exported.note, /脱敏/);
});

test("research export strips source identity and known identifiers embedded in clinical text", async (t) => {
  const f = await fixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "合成患者姓名", phone: "13899990000", patientNumber: "DEMO-IDENTITY",
    diagnoses: [{ name: "合成患者姓名的既往记录", source: "报告单编号 DEMO-IDENTITY" }],
    labs: [{ item: "合成指标", value: 1, date: "2026-09-20", source: "13899990000 患者上传" }],
  })).data;
  const result = (await f.json(`/api/patients/${p.id}/export`)).data;
  assert.equal(result.diagnoses[0].source, undefined);
  assert.equal(result.labs[0].source, undefined);
  assert.doesNotMatch(JSON.stringify(result), /合成患者姓名|13899990000|DEMO-IDENTITY/);
  assert.match(result.note, /需复核/);
});

test("icd10 endpoint search", async (t) => {
  const f = await fixture(t);
  const result = (await f.json("/api/icd10?q=%E8%82%BA%E7%82%8E")).data;
  assert.equal(result.codes[0].code, "J18");
  const byCode = (await f.json("/api/icd10?q=I50")).data;
  assert.equal(byCode.codes[0].code, "I50");
});
