import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadPacks } from "../server/service.mjs";
import { diagnosisMatchesPack, suggestPacks } from "../match.mjs";

const packs = loadPacks(fileURLToPath(new URL("../packs", import.meta.url))).map((pack) => ({ ...pack, planName: pack.plan.name }));
const htn = packs.find((pack) => pack.id === "hypertension");
const dm = packs.find((pack) => pack.id === "diabetes");

test("管理包推荐：按编码或病名匹配已确诊诊断", () => {
  assert.ok(diagnosisMatchesPack(htn.match, { name: "原发性高血压", code: "I10" }));
  assert.ok(diagnosisMatchesPack(htn.match, { name: "高血压 3 级（很高危）" }));
  assert.ok(diagnosisMatchesPack(htn.match, "高血压病"));
  assert.ok(diagnosisMatchesPack(dm.match, { name: "2 型糖尿病" }));
  assert.ok(diagnosisMatchesPack(dm.match, { name: "糖尿病", code: "E11.900" }));
});

test("管理包推荐：排除继发/妊娠等不适用病种和未确诊诊断", () => {
  assert.equal(diagnosisMatchesPack(htn.match, { name: "妊娠期高血压" }), false);
  assert.equal(diagnosisMatchesPack(htn.match, { name: "继发性高血压" }), false);
  assert.equal(diagnosisMatchesPack(htn.match, { name: "疑似高血压" }), false);
  assert.equal(diagnosisMatchesPack(dm.match, { name: "1 型糖尿病" }), false);
  assert.equal(diagnosisMatchesPack(dm.match, { name: "妊娠期糖尿病" }), false);
});

test("管理包推荐：已有未到期节点不推荐；上一轮全部到期后提示续期", () => {
  const diagnoses = [{ name: "原发性高血压", code: "I10" }];
  assert.deepEqual(suggestPacks(packs, diagnoses, []).map((s) => [s.pack.id, s.renewal]), [["hypertension", false]]);
  const job = (status) => ({ name: `${htn.plan.name} · ${htn.plan.nodes[0].title}`, status });
  assert.equal(suggestPacks(packs, diagnoses, [job("active"), job("completed")]).length, 0);
  assert.deepEqual(suggestPacks(packs, diagnoses, [job("completed")]).map((s) => s.renewal), [true]);
  assert.equal(suggestPacks(packs, [{ name: "胆囊切除术后状态" }], []).length, 0);
  assert.equal(suggestPacks(null, diagnoses, []).length, 0);
});

test("诊前问卷补充题：只取患者正在管理的病种，题目 id 带包名前缀", async () => {
  const { createCarePackService } = await import("../server/service.mjs");
  let jobs = [];
  const service = createCarePackService({ packs, followups: () => ({ list: () => jobs, listPlans: () => [] }), riskRules: () => null, guidelines: null });
  assert.deepEqual(service.previsitQuestions("p1"), []);
  jobs = [{ name: `${htn.plan.name} · ${htn.plan.nodes[0].title}`, status: "active" }];
  const questions = service.previsitQuestions("p1");
  assert.equal(questions.length, htn.previsitQuestions.length);
  assert.ok(questions.every((q) => q.id.startsWith("hypertension_")));
  jobs = [{ name: `${htn.plan.name} · ${htn.plan.nodes[0].title}`, status: "completed" }];
  assert.deepEqual(service.previsitQuestions("p1"), [], "上一轮已全部到期的不再追加");
});
