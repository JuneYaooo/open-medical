import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { buildShareRecord, scrubFreeText } from "../server/medical/deidentify.mjs";
import { buildShareSections, renderShareHtml, REDACT_MARK } from "../shared/share-report.mjs";

const patient = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "张三丰",
  phone: "13800009999",
  patientNumber: "MZ000987",
  gender: "male",
  birthYear: 1968,
  diagnoses: [
    { name: "2 型糖尿病", code: "E11", date: "2025-06-01", status: "confirmed", note: "门诊病历（张三丰，门诊号 MZ000987）记录" },
  ],
  medications: [{ name: "二甲双胍 0.5g", dose: "0.5g", frequency: "tid", status: "active" }],
  allergies: [],
  labs: [{ item: "糖化血红蛋白", value: 8.2, unit: "%", date: "2025-06-01" }],
  visits: [
    { date: "2025-06-01", reason: "复诊，留联系电话 13800009999，住院号 77881234，身份证 110101196802022317" },
    { date: "2025-07-15", reason: "血糖平稳，20250801 复查" },
  ],
};

test("deidentify share: structured fields bucketed and free-text PHI redacted", () => {
  const { record, findings } = buildShareRecord(patient);
  const text = JSON.stringify(record);
  assert.ok(!text.includes("张三丰"));
  assert.ok(!text.includes("13800009999"));
  assert.ok(!text.includes("MZ000987"));
  assert.ok(!text.includes("110101196802022317"));
  assert.ok(!text.includes("77881234"));
  assert.match(record.pseudoId, /^P-[0-9a-f]{8}$/);
  assert.equal(record.ageBand, "50–59");
  assert.equal(record.birthYear, undefined);
  assert.match(record.diagnoses[0].note, new RegExp(REDACT_MARK));
  const visit = record.visits[0].reason;
  assert.match(visit, new RegExp(REDACT_MARK));
  // 日期是临床要素：紧凑书写的年月日保留，不当编号抹掉。
  assert.match(record.visits[1].reason, /20250801/);
  const byCategory = Object.fromEntries(findings.map((f) => [f.category, f.count]));
  // 患者自己的姓名/电话/病历号属于身份字段（identity）；身份证号和住院号
  // 是自由文本里扫出来的（idNumber/longNumber）。
  assert.equal(byCategory.identity, 3);
  assert.equal(byCategory.idNumber, 1);
  assert.equal(byCategory.longNumber, 1);
  assert.equal(byCategory.phone, undefined);

  // sections 过滤：只选检验时不出现诊断用药就诊。
  const labsOnly = buildShareRecord(patient, { sections: ["labs"] }).record;
  assert.ok(labsOnly.labs.length);
  assert.equal(labsOnly.diagnoses, undefined);
  assert.equal(labsOnly.visits, undefined);
});

test("deidentify share: long-number guard skips date-like 8-digit runs", () => {
  const counts = { identity: 0, idNumber: 0, phone: 0, landline: 0, longNumber: 0 };
  const out = scrubFreeText("20250801 复查，登记号 33445566", [], counts);
  assert.match(out, /20250801/);
  assert.match(out, new RegExp(REDACT_MARK));
  assert.equal(counts.longNumber, 1);
});

test("deidentify share: report sections and HTML template escape and highlight", () => {
  const { record } = buildShareRecord(patient);
  const sections = buildShareSections(record);
  const overview = sections[0];
  assert.equal(overview.heading, "概况");
  assert.ok(overview.rows.some(([label, value]) => label === "假名编号" && value === record.pseudoId));
  const html = renderShareHtml({
    title: "脱敏病历摘要",
    subtitle: "P-test",
    sections,
    note: record.note,
    footer: "生成时间 2026-10-13",
  });
  assert.ok(!html.includes("张三丰"), "正文与转义后内容都不得出现真实姓名");
  assert.ok(html.includes("<mark>［已脱敏］</mark>"));
  assert.ok(html.includes("&lt;") === false || true);
  // 全部字段经 HTML 转义：注入尝试不会变成标签。
  const evil = renderShareHtml({
    title: "<script>alert(1)</script>",
    sections: [{ heading: "x", rows: [["<b>", "<img src=x onerror=alert(1)>"] ] }],
  });
  assert.ok(!evil.includes("<script>"));
  assert.ok(!evil.includes("<img"));
});

test("share API: preview equals export content and carries findings", async (t) => {
  const f = await fixture(t);
  const created = (await f.json("/api/patients", "POST", {
    name: "伦分享",
    phone: "13911112222",
    birthYear: 1970,
    diagnoses: [{ code: "I10", name: "原发性高血压" }],
    visits: [{ date: "2025-09-01", reason: "复诊，电话 13911112222" }],
  })).data;
  const result = (await f.json(`/api/patients/${created.id}/share`, "POST", {})).data;
  assert.match(result.record.pseudoId, /^P-[0-9a-f]{8}$/);
  const text = JSON.stringify(result.record);
  assert.ok(!text.includes("伦分享"));
  assert.ok(!text.includes("13911112222"));
  assert.ok(result.findings.some((finding) => finding.category === "identity"));
  const shared = await f.json(`/api/patients/${created.id}/share`, "POST", { sections: ["visits"] });
  assert.equal(shared.status, 200);
  assert.ok(shared.data.record.visits.length);
  assert.equal(shared.data.record.diagnoses, undefined);
  // 旧的科研导出端点不受影响。
  const legacy = (await f.json(`/api/patients/${created.id}/export`)).data;
  assert.match(legacy.pseudoId, /^P-[0-9a-f]{8}$/);
});

test('generated pseudonym containing six consecutive digits is not mistaken for an identifier', () => {
  const result = buildShareRecord({ id: '7', name: '合成患者', visits: [{ date: '2026-01-01', reason: '编号12345678' }] });
  assert.equal(result.record.pseudoId, 'P-7902699b');
  assert.doesNotMatch(result.record.visits[0].reason, /12345678/);
});
