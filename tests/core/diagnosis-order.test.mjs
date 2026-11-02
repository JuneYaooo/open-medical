import test from "node:test";
import assert from "node:assert/strict";
import { mainDiagnoses, sortDiagnoses } from "../../shared/diagnoses.mjs";

const names = (list) => list.map((d) => d.name);

test("primary diagnoses lead; the rest keep their saved order", () => {
  const list = [
    { name: "滤泡性淋巴瘤", date: "2020-12-01", status: "confirmed" },
    { name: "陈旧性甲型肝炎", date: "2024-08-06", status: "confirmed" },
    { name: "肝小囊肿", date: "2025-02-12", status: "finding" },
    { name: "弥漫大B细胞淋巴瘤（滤泡性淋巴瘤转化）", date: "2024-08-20", status: "confirmed", primary: true },
    { name: "慢性非萎缩性胃炎", date: "2024-08-06", status: "confirmed" },
  ];
  assert.deepEqual(names(mainDiagnoses(list)), [
    "弥漫大B细胞淋巴瘤（滤泡性淋巴瘤转化）",
    "滤泡性淋巴瘤",
    "陈旧性甲型肝炎",
    "慢性非萎缩性胃炎",
  ]);
});

test("status groups still come first, primary only reorders within a status", () => {
  const list = [
    { name: "考虑肺炎", status: "suspected", primary: true },
    { name: "肺腺癌", status: "confirmed" },
    { name: "2型糖尿病", status: "confirmed", primary: true },
  ];
  assert.deepEqual(names(sortDiagnoses(list)), ["2型糖尿病", "肺腺癌", "考虑肺炎"]);
});
