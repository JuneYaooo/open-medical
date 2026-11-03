import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQuestionnaire, scoreSurvey } from "../core/surveys.mjs";

const questionnaire = () =>
  normalizeQuestionnaire({
    title: "血压自测",
    questions: [
      { id: "sbp", text: "收缩压", type: "number", unit: "mmHg", required: true, alertIf: { op: "gte", value: 180 } },
      { id: "dbp", text: "舒张压", type: "number", unit: "mmHg", alertIf: { op: "gt", value: 110 } },
      { id: "fpg", text: "空腹血糖", type: "number", unit: "mmol/L", alertIf: { op: "lt", value: 3.9 } },
      { id: "hr", text: "心率", type: "number", unit: "次/分", alertIf: { op: "lte", value: 50 } },
    ],
  });

test("单题数值预警：gte/lte 含阈值本身，gt/lt 不含", () => {
  const q = questionnaire();
  const flagged = (answers) =>
    scoreSurvey(q, answers.map(([questionId, value]) => ({ questionId, value }))).flags.map((f) => f.questionId);
  assert.deepEqual(flagged([["sbp", 180]]), ["sbp"], "收缩压恰好 180 必须预警");
  assert.deepEqual(flagged([["sbp", 179]]), []);
  assert.deepEqual(flagged([["dbp", 110]]), [], "gt 不含阈值本身");
  assert.deepEqual(flagged([["dbp", 111]]), ["dbp"]);
  assert.deepEqual(flagged([["fpg", 3.9]]), [], "lt 不含阈值本身");
  assert.deepEqual(flagged([["fpg", 3.8]]), ["fpg"]);
  assert.deepEqual(flagged([["hr", 50]]), ["hr"], "lte 含阈值本身");
  assert.deepEqual(flagged([["hr", 51]]), []);
});

test("单题预警只接受 gt/gte/lt/lte", () => {
  assert.throws(
    () => normalizeQuestionnaire({ title: "x", questions: [{ id: "a", text: "a", type: "number", alertIf: { op: "eq", value: 1 } }] }),
    /预警条件无效/,
  );
});
