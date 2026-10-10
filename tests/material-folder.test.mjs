import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { classifyMaterial, suggestDocumentDate, MATERIAL_CATEGORIES } from "../shared/material-classify.mjs";
import { groupMaterials } from "../shared/material-folder.mjs";

test("material classifier is deterministic and explains its keyword hit", () => {
  assert.deepEqual(MATERIAL_CATEGORIES, ["检验报告", "影像报告", "门诊病历", "住院记录", "用药记录", "其他"]);
  assert.equal(classifyMaterial({ name: "生化检验报告单.pdf" }).category, "检验报告");
  assert.equal(classifyMaterial({ name: "胸部CT平扫报告.docx" }).category, "影像报告");
  assert.equal(classifyMaterial({ name: "IMG_2233.jpg", text: "出院记录：患者于 2026-09-01 出院" }).category, "住院记录");
  assert.equal(classifyMaterial({ name: "a.txt", text: "门诊病历 主诉：腹痛" }).category, "门诊病历");
  assert.equal(classifyMaterial({ name: "处方笺.png" }).category, "用药记录");
  // 文件名优先于正文;命中规则带原因。
  const hit = classifyMaterial({ name: "MRI 报告", text: "血常规结果" });
  assert.equal(hit.category, "影像报告");
  assert.match(hit.reason, /文件名/);
  assert.equal(classifyMaterial({ name: "随手记.txt", text: "今天天气不错" }), null);
  // 日期建议:文件名优先,合法化校验。
  assert.equal(suggestDocumentDate({ name: "报告 2026-09-05.pdf" }), "2026-09-05");
  assert.equal(suggestDocumentDate({ name: "IMG.jpg", text: "检验日期：2026年9月8日" }), "2026-09-08");
  assert.equal(suggestDocumentDate({ name: "报告 2026-13-99.pdf" }), null);
  assert.equal(suggestDocumentDate({ name: "no-date.txt" }), null);
});

test("folder grouping buckets by confirmed category and sorts newest first", () => {
  const groups = groupMaterials([
    { id: "a", name: "旧", category: "检验报告", createdAt: "2026-01-01T00:00:00Z", documentDate: "2026-01-05" },
    { id: "b", name: "新", category: "检验报告", createdAt: "2026-02-01T00:00:00Z", documentDate: "2026-02-05" },
    { id: "c", name: "未分类", createdAt: "2026-03-01T00:00:00Z" },
    { id: "d", name: "无日期", category: "影像报告", createdAt: "2026-03-03T00:00:00Z" },
  ]);
  assert.deepEqual(groups.map((g) => g.category), ["检验报告", "影像报告", "其他"]);
  assert.deepEqual(groups[0].files.map((f) => f.id), ["b", "a"]);
  assert.equal(groups[0].dateRange, "2026-01-05 ~ 2026-02-05");
  // 未确认分类落「其他」,但保留推测字段由视图展示。
  assert.equal(groups[2].files[0].id, "c");
  assert.equal(groupMaterials([]).length, 0);
});

test("file meta API accepts confirmed category and date, rejects invalid values", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "资料库患者" })).data;
  const added = await f.json(`/api/sessions/${patient.sessionId}/files`, "POST", {
    name: "生化检验报告单.txt",
    text: "检验报告单\n血常规、生化\n检验日期：2026-09-01\n血红蛋白 130 g/L",
  });
  assert.equal(added.status, 201);
  const file = added.data;
  // 上传即有确定性建议(OCR 前也基于文件名与文本)。
  assert.ok(file.categorySuggestion);
  assert.equal(file.categorySuggestion.category, "检验报告");
  assert.equal(file.dateSuggestion, "2026-09-01");
  // 确认分类与日期。
  const confirmed = await f.json(`/api/sessions/${patient.sessionId}/files/${file.id}/meta`, "PATCH", {
    category: "检验报告",
    documentDate: "2026-09-01",
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.category, "检验报告");
  assert.equal(confirmed.data.documentDate, "2026-09-01");
  // 非法值拒绝。
  const badCategory = await f.json(`/api/sessions/${patient.sessionId}/files/${file.id}/meta`, "PATCH", { category: "随手写" });
  assert.equal(badCategory.status, 400);
  const badDate = await f.json(`/api/sessions/${patient.sessionId}/files/${file.id}/meta`, "PATCH", { documentDate: "09-01" });
  assert.equal(badDate.status, 400);
  const missing = await f.json(`/api/sessions/${patient.sessionId}/files/nope/meta`, "PATCH", { category: "检验报告" });
  assert.equal(missing.status, 404);
  // 清空日期允许(留空回到上传时间排序)。
  const cleared = await f.json(`/api/sessions/${patient.sessionId}/files/${file.id}/meta`, "PATCH", { documentDate: "" });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.documentDate, "");
});
