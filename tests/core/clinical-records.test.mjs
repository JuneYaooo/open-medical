import test from "node:test";
import assert from "node:assert/strict";
import { validateClinicalInput } from "../../server/patients.mjs";
import { normalizeLabDate } from "../../server/medical/lab-import.mjs";

test("用药可记录开始日期、停药日期与停药原因", () => {
  const { medications } = validateClinicalInput({
    medications: [{ name: "二甲双胍", status: "stopped", startDate: "2024-01-02", stoppedAt: "2024-06-30", stopReason: "胃肠道不适" }],
  });
  assert.deepEqual(medications[0], { name: "二甲双胍", status: "stopped", startDate: "2024-01-02", stoppedAt: "2024-06-30", stopReason: "胃肠道不适" });
});

test("停药日期须为有效日期，停药原因不超过 200 字", () => {
  assert.throws(() => validateClinicalInput({ medications: [{ name: "a", stoppedAt: "2024/6/30" }] }), /停药日期/);
  assert.throws(() => validateClinicalInput({ medications: [{ name: "a", startDate: "2024-02-30" }] }), /开始用药日期/);
  assert.throws(() => validateClinicalInput({ medications: [{ name: "a", stopReason: "x".repeat(201) }] }), /停药原因/);
});

test("就诊备注上限放宽至 4000 字并保留换行", () => {
  const note = "主诉：头晕\n计划：" + "x".repeat(3900);
  const { visits } = validateClinicalInput({ visits: [{ date: "2024-05-01", reason: "复诊", note }] });
  assert.equal(visits[0].note, note.trim());
  assert.throws(() => validateClinicalInput({ visits: [{ date: "2024-05-01", reason: "复诊", note: "x".repeat(4001) }] }), /备注/);
});

test("检验导入日期接受 YYYY/M/D 与 YYYY.M.D 并补零", () => {
  assert.equal(normalizeLabDate("2024/3/5"), "2024-03-05");
  assert.equal(normalizeLabDate("2024.12.1"), "2024-12-01");
  assert.equal(normalizeLabDate(" 2024-03-05 "), "2024-03-05");
  assert.equal(normalizeLabDate("2024/2/30"), "2024/2/30");
  assert.equal(normalizeLabDate("2024/3.5"), "2024/3.5");
  assert.equal(normalizeLabDate("24/3/5"), "24/3/5");
});

test("检验表格导入预览把 2024/5/20 规范为 2024-05-20", async (t) => {
  const { createScriptedProvider } = await import("../helpers/scripted-provider.mjs");
  const { startTestServer } = await import("../helpers/server.mjs");
  const app = await startTestServer({ provider: createScriptedProvider([]) });
  t.after(() => app.close());
  const [patient] = await app.patients();
  const text = ["姓名,项目,数值,单位,日期", `${patient.name},前白蛋白,250,mg/L,2024/5/20`, `${patient.name},前白蛋白,240,mg/L,2024.13.1`].join("\n");
  const preview = await app.request("/api/patients/lab-import/preview", { method: "POST", body: { text } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.rows[0].status, "ready");
  assert.equal(preview.body.rows[0].labs[0].date, "2024-05-20");
  assert.equal(preview.body.rows[1].status, "invalid");
});

test("生命体征：148/86 拆分、固定名称单位、范围核对", async () => {
  const { parseBloodPressure, vitalLabs, serializeVisitSections, visitNoteSection } = await import("../../src/clinical-entry.js");
  assert.deepEqual(parseBloodPressure("148/86"), { sbp: "148", dbp: "86" });
  assert.deepEqual(parseBloodPressure(" 148／86 mmHg"), { sbp: "148", dbp: "86" });
  assert.equal(parseBloodPressure("148"), null);
  const { labs } = vitalLabs({ sbp: "148", dbp: "86", hr: "", weight: "70.5", fpg: "6.8" }, "2026-10-31", "门诊");
  assert.deepEqual(labs.map((l) => [l.item, l.value, l.unit, l.date]), [
    ["收缩压", 148, "mmHg", "2026-10-31"], ["舒张压", 86, "mmHg", "2026-10-31"],
    ["体重", 70.5, "kg", "2026-10-31"], ["空腹血糖", 6.8, "mmol/L", "2026-10-31"],
  ]);
  assert.match(vitalLabs({ sbp: "80", dbp: "90" }, "2026-10-31").error, /收缩压应高于舒张压/);
  assert.match(vitalLabs({ hr: "abc" }, "2026-10-31").error, /心率请输入数字/);
  assert.match(vitalLabs({ sbp: "1480" }, "2026-10-31").error, /超出/);
  const note = serializeVisitSections({ complaint: "头晕 3 天", history: "", exam: "BP 148/86", assessment: "血压控制欠佳", plan: "氨氯地平加量\n2 周复诊" });
  assert.equal(note, "主诉：头晕 3 天\n查体：BP 148/86\n评估：血压控制欠佳\n计划：氨氯地平加量\n2 周复诊");
  assert.equal(visitNoteSection(note, "计划"), "氨氯地平加量\n2 周复诊");
  assert.equal(visitNoteSection(note, "查体"), "BP 148/86");
});

test("用药过敏提示可在前端复用 med-safety（无 node 依赖）", async () => {
  const { evaluateMedicationSafety } = await import("../../server/medical/med-safety.mjs");
  const result = evaluateMedicationSafety({ medications: [{ name: "拜阿司匹灵" }], allergies: ["阿司匹林"] });
  assert.equal(result.allergyMatches.length, 1);
});

test("患者列表搜索：短查询不匹配内部 ID，8 位以上才按 ID 匹配", async (t) => {
  const { createScriptedProvider } = await import("../helpers/scripted-provider.mjs");
  const { startTestServer } = await import("../helpers/server.mjs");
  const app = await startTestServer({ provider: createScriptedProvider([]) });
  t.after(() => app.close());
  const patients = await app.patients();
  assert.ok(patients.length > 0);
  const list = (q) => app.request(`/api/patients?q=${encodeURIComponent(q)}`).then((r) => r.body.patients);
  const { id } = patients[0];
  const shortQ = id.slice(0, 3).toLowerCase();
  const textMatch = (p) => [p.name, p.patientNumber, p.phone, ...(p.tags || []), JSON.stringify(p.diagnoses || "")]
    .some((v) => String(v || "").toLowerCase().includes(shortQ));
  for (const p of await list(shortQ)) assert.ok(textMatch(p), "短查询不应只因内部 ID 命中");
  assert.ok((await list(id.slice(0, 8))).some((p) => p.id === id), "8 位以上可按 ID 匹配");
});

test("多项检验：忽略空值行、拆分血压、非数字报错、预填最近不同项目", async () => {
  const { batchLabs, labPanelRows } = await import("../../src/clinical-entry.js");
  const rows = [
    { item: "糖化血红蛋白", value: "7.2", unit: "%", referenceRange: "4–6" },
    { item: "血肌酐", value: "", unit: "umol/L", referenceRange: "" },
    { item: "血压", value: "148/86", unit: "", referenceRange: "" },
  ];
  const { labs } = batchLabs(rows, "2026-10-31", "门诊");
  assert.deepEqual(labs, [
    { item: "糖化血红蛋白", value: 7.2, unit: "%", date: "2026-10-31", source: "门诊", referenceRange: "4–6" },
    { item: "收缩压", value: 148, unit: "mmHg", date: "2026-10-31", source: "门诊" },
    { item: "舒张压", value: 86, unit: "mmHg", date: "2026-10-31", source: "门诊" },
  ]);
  assert.match(batchLabs([{ item: "尿蛋白", value: "阴性" }], "2026-10-31").error, /尿蛋白：请输入数字/);
  assert.match(batchLabs([{ item: "", value: "5" }], "2026-10-31").error, /缺少项目名称/);
  assert.match(batchLabs([{ item: "血糖", value: "" }], "2026-10-31").error, /至少填写一项/);
  assert.match(batchLabs([{ item: "血糖", value: "6" }], "").error, /检验日期/);
  assert.match(batchLabs([{ item: "血压", value: "80/90" }], "2026-10-31").error, /收缩压应高于舒张压/);
  // 已保存的检验能通过服务端校验
  assert.equal(validateClinicalInput({ labs }).labs.length, 3);
  const prefill = labPanelRows([
    { item: "血肌酐", value: 80, unit: "umol/L", date: "2025-01-01" },
    { item: "血肌酐", value: 90, unit: "μmol/L", date: "2026-09-01" },
    { item: "收缩压", value: 148, unit: "mmHg", date: "2026-10-01" },
  ]);
  assert.deepEqual(prefill.map((r) => [r.item, r.unit, r.value]), [["收缩压", "mmHg", ""], ["血肌酐", "μmol/L", ""]]);
  assert.equal(labPanelRows(Array.from({ length: 12 }, (_, i) => ({ item: `项目${i}`, value: 1, date: "2026-01-01" }))).length, 8);
  assert.equal(labPanelRows([]).length, 1);
});

test("过敏史可记录反应，兼容纯字符串；无反应的对象收敛为字符串", () => {
  const { allergies } = validateClinicalInput({ allergies: ["阿司匹林", { substance: " 青霉素 ", reaction: " 皮疹 " }, { substance: "磺胺", reaction: "" }] });
  assert.deepEqual(allergies, ["阿司匹林", { substance: "青霉素", reaction: "皮疹" }, "磺胺"]);
  assert.throws(() => validateClinicalInput({ allergies: ["青霉素", { substance: "青霉素", reaction: "皮疹" }] }), /不能重复/);
  assert.throws(() => validateClinicalInput({ allergies: [{ reaction: "皮疹" }] }), /过敏原/);
  assert.throws(() => validateClinicalInput({ allergies: [{ substance: "青霉素", reaction: "x".repeat(121) }] }), /过敏反应/);
  assert.throws(() => validateClinicalInput({ allergies: [42] }), /过敏史格式无效/);
});

test("ICD-10 检索：编码精确/前缀与中文名称匹配，编码不重复", async () => {
  const { ICD10_COMMON, searchIcd10 } = await import("../../server/medical/icd10.mjs");
  const codes = ICD10_COMMON.map(([code]) => code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.length >= 250 && codes.length <= 400);
  for (const code of codes) assert.match(code, /^[A-Z]\d{2}(\.\d)?$/);
  assert.deepEqual(searchIcd10("e11.9")[0], { code: "E11.9", name: "2型糖尿病不伴有并发症" });
  assert.ok(searchIcd10("N18").every((item) => item.code.startsWith("N18")));
  assert.ok(searchIcd10("心房颤动").some((item) => item.code === "I48.0"));
});
