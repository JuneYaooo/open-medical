import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewDiff,
  reviewCounts,
  alignReviewItems,
  bigramSimilarity,
} from "../shared/review-diff.mjs";
const fixtures = [
  [
    "renamed abbreviation",
    { diagnoses: [{ name: "HTN" }] },
    { diagnoses: [{ name: "高血压" }] },
    ["modify:name"],
  ],
  [
    "same-day multiple labs reordered",
    {
      labs: [
        { item: "血糖", date: "2026-01-01", value: 5 },
        { item: "血糖", date: "2026-01-01", value: 7 },
      ],
    },
    {
      labs: [
        { item: "血糖", date: "2026-01-01", value: 7 },
        { item: "血糖", date: "2026-01-01", value: 5 },
      ],
    },
    [],
  ],
  [
    "two field edits one item",
    { labs: [{ item: "血糖", date: "2026-01-01", value: 5, unit: "mmol/l" }] },
    { labs: [{ item: "血糖", date: "2026-01-01", value: 6, unit: "mmol/L" }] },
    ["modify:value", "modify:unit"],
  ],
  [
    "unrelated replacement",
    { diagnoses: [{ name: "贫血" }] },
    { diagnoses: [{ name: "心包炎" }] },
    ["delete:", "add:"],
  ],
  [
    "summary",
    { clinicalSummary: { text: "一段摘要" } },
    { clinicalSummary: { text: "摘要" } },
    ["modify:text"],
  ],
  [
    "identity",
    { name: "甲", birthYear: 1970 },
    { name: "乙", birthYear: 1980 },
    ["modify:name", "modify:birthYear"],
  ],
  [
    "provenance ignored",
    { diagnoses: [{ name: "高血压", source: "一" }] },
    { diagnoses: [{ name: "高血压", source: "二" }] },
    [],
  ],
  [
    "reason-only visit edit",
    { visits: [{ date: "2026-01-01", reason: "门诊复查血常规" }] },
    { visits: [{ date: "2026-01-01", reason: "门诊复查肝功能" }] },
    ["modify:reason"],
  ],
];
for (const section of [
  "diagnoses",
  "medications",
  "labs",
  "visits",
  "tags",
  "groups",
  "allergies",
]) {
  const primitive = ["tags", "groups", "allergies"].includes(section);
  const a = primitive
    ? "甲标签"
    : section === "labs"
      ? { item: "血钾", date: "2026-01-01", value: 4 }
      : section === "visits"
        ? { date: "2026-01-01", reason: "复查" }
        : { name: "甲条目" };
  const b = primitive
    ? "乙标签"
    : section === "labs"
      ? { item: "血钠", date: "2026-01-02", value: 140 }
      : section === "visits"
        ? { date: "2026-02-02", reason: "出院" }
        : { name: "乙项目" };
  fixtures.push(
    [`${section} unchanged`, { [section]: [a] }, { [section]: [a] }, []],
    [`${section} add`, { [section]: [a] }, { [section]: [a, b] }, ["add:"]],
    [
      `${section} delete`,
      { [section]: [a, b] },
      { [section]: [a] },
      ["delete:"],
    ],
    [`${section} reorder`, { [section]: [a, b] }, { [section]: [b, a] }, []],
    [`${section} absent empty`, {}, { [section]: [] }, []],
  );
}
for (const [label, before, after, expected] of fixtures)
  test(`review diff: ${label}`, () => {
    const diffs = reviewDiff(before, after);
    assert.deepEqual(
      diffs.map((d) => `${d.op}:${d.field}`),
      expected,
    );
    assert.deepEqual(
      reviewDiff(structuredClone(before), structuredClone(after)),
      diffs,
    );
  });
test("counts are item-level, reasons survive and matching is one-to-one", () => {
  const before = {
      labs: [{ item: "血糖", date: "2026-01-01", value: 5, unit: "mmol/l" }],
    },
    after = { labs: [{ ...before.labs[0], value: 6, unit: "mmol/L" }] };
  assert.equal(reviewCounts(before, reviewDiff(before, after)).modified, 1);
  assert.equal(
    reviewDiff(before, {}, { reasons: { "labs:0": "资料里没有" } })[0].reason,
    "资料里没有",
  );
  assert.equal(
    new Set(
      alignReviewItems("labs", before.labs, [...after.labs, ...after.labs])
        .filter((p) => p[1] !== null)
        .map((p) => p[1]),
    ).size,
    2,
  );
  assert.equal(bigramSimilarity("HTN", "htn"), 1);
});
