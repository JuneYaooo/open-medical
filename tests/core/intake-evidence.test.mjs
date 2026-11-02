import test from "node:test";
import assert from "node:assert/strict";
import { intakeAudit } from "../../server/medical/intake-evidence.mjs";

test("建档核对：没识别出文字的图片单独列出根因，医生核对原图后可放行", () => {
  const sources = [{ id: "f1", name: "出院记录.jpg", text: "[图片材料：出院记录.jpg]", unrecognized: "未识别出文字" }];
  const payload = { name: "萝卜", labs: [{ item: "AFP", value: 5134, unit: "ng/ml", date: "2025-08-05", source: "出院记录.jpg" }] };
  const audit = intakeAudit(payload, sources);
  const root = audit.issues.find((item) => item.kind === "source-unrecognized");
  assert.ok(root, JSON.stringify(audit.issues));
  assert.equal(audit.issues[0], root, "根因排在最前");
  assert.match(root.message, /重新识别/);
  const reviews = Object.fromEntries(audit.issues.map((item) => [item.id, { decision: "verified", reason: "已对照原图逐项核对" }]));
  assert.equal(intakeAudit(payload, sources, reviews).unresolved.length, 0);
});

test("建档核对：已识别的资料不产生识别类问题", () => {
  const audit = intakeAudit({ name: "甲", labs: [] }, [{ id: "f1", name: "a.txt", text: "主诉：头痛" }]);
  assert.ok(!audit.issues.some((item) => item.kind === "source-unrecognized"));
});
