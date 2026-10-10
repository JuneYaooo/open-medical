import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { suggestGroups } from "../server/medical/patient-grouping.mjs";

test("group derivation matches ICD codes, names and falls back to medications", () => {
  const icd = suggestGroups({
    diagnoses: [
      { code: "I10", name: "原发性高血压" },
      { code: "E11.9", name: "2 型糖尿病" },
    ],
    medications: [],
  });
  assert.deepEqual(icd.addTags.sort(), ["糖尿病", "高血压"].sort());
  assert.equal(icd.matched.length, 2);
  // 名称关键词在没有编码时同样命中。
  const byName = suggestGroups({ diagnoses: [{ name: "肝细胞癌术后" }] });
  assert.deepEqual(byName.addTags, ["肝癌"]);
  // 已有同名分组/标签不再重复建议。
  const existing = suggestGroups({
    groups: ["高血压"],
    tags: ["糖尿病"],
    diagnoses: [{ code: "I10", name: "高血压" }, { code: "E11", name: "糖尿病" }],
  });
  assert.deepEqual(existing.addTags, []);
  // 无诊断命中时按在用药名兜底;停用药不参与。
  const byMed = suggestGroups({
    diagnoses: [],
    medications: [
      { name: "二甲双胍片", status: "active" },
      { name: "索拉非尼", status: "stopped" },
    ],
  });
  assert.deepEqual(byMed.addTags, ["糖尿病待核对"]);
  const nothing = suggestGroups({ diagnoses: [], medications: [{ name: "维生素 C", status: "active" }] });
  assert.deepEqual(nothing.addTags, []);
  // 字符串诊断(旧数据)也按名称匹配。
  const legacy = suggestGroups({ diagnoses: ["高血压复诊"] });
  assert.deepEqual(legacy.addTags, ["高血压"]);
});

test("scan returns per-patient suggestions with revision; propose-confirm applies groups", async (t) => {
  const f = await fixture(t);
  const a = (await f.json("/api/patients", "POST", { name: "高血压患者" })).data;
  const b = (await f.json("/api/patients", "POST", { name: "无依据患者" })).data;
  await f.json(`/api/patients/${a.id}`, "PATCH", {
    expectedRevision: 0,
    diagnoses: [{ code: "I10", name: "原发性高血压" }],
  });
  const scan = (await f.json("/api/patients/group-suggestions", "POST", {})).data.suggestions;
  const mine = scan.find((s) => s.patientId === a.id);
  assert.ok(mine, "有诊断依据的患者应有建议");
  assert.deepEqual(mine.addTags, ["高血压"]);
  assert.ok(Number.isInteger(mine.baseRevision));
  assert.ok(!scan.some((s) => s.patientId === b.id), "无依据患者不出现在建议里");
  // 提案 → 托盘 → 确认逐患者写入 groups。
  const proposed = await f.json("/api/patients/group-suggestions/propose", "POST", {
    assignments: [{ patientId: a.id, addTags: mine.addTags }],
  });
  assert.equal(proposed.status, 201);
  assert.equal(proposed.data.type, "patient-group-suggest");
  assert.equal(proposed.data.payload.assignments[0].baseRevision, mine.baseRevision);
  const confirmed = await f.json(`/api/pending-actions/${proposed.data.id}/confirm`, "POST", {});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.applied.assignments.length, 1);
  assert.deepEqual(confirmed.data.applied.assignments[0].groups, ["高血压"]);
  assert.equal(confirmed.data.applied.skipped.length, 0);
  const detail = (await f.json(`/api/patients/${a.id}`)).data;
  assert.deepEqual(detail.groups, ["高血压"]);
});

test("group proposal skips patients edited after the proposal instead of overwriting", async (t) => {
  const f = await fixture(t);
  const a = (await f.json("/api/patients", "POST", { name: "冲突患者" })).data;
  const c = (await f.json("/api/patients", "POST", { name: "正常患者" })).data;
  await f.json(`/api/patients/${a.id}`, "PATCH", { expectedRevision: 0, diagnoses: [{ code: "C22", name: "肝癌" }] });
  await f.json(`/api/patients/${c.id}`, "PATCH", { expectedRevision: 0, diagnoses: [{ code: "I48", name: "心房颤动" }] });
  const scan = (await f.json("/api/patients/group-suggestions", "POST", {})).data.suggestions;
  const proposed = await f.json("/api/patients/group-suggestions/propose", "POST", {
    assignments: [a, c].map((p) => {
      const row = scan.find((s) => s.patientId === p.id);
      return { patientId: p.id, addTags: row.addTags };
    }),
  });
  // 提案后 a 的档案又被编辑(revision 前进),确认时跳过并说明原因。
  const current = (await f.json(`/api/patients/${a.id}`)).data;
  await f.json(`/api/patients/${a.id}`, "PATCH", { expectedRevision: current.revision, phone: "13800000000" });
  const confirmed = await f.json(`/api/pending-actions/${proposed.data.id}/confirm`, "POST", {});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.applied.assignments.map((x) => x.name).join(","), "正常患者");
  assert.equal(confirmed.data.applied.skipped.length, 1);
  assert.match(confirmed.data.applied.skipped[0].reason, /变化/);
  const after = (await f.json(`/api/patients/${a.id}`)).data;
  assert.deepEqual(after.groups, [], "冲突患者分组未被覆盖");
  // 无效提案:空选择被拒绝。
  const empty = await f.json("/api/patients/group-suggestions/propose", "POST", { assignments: [] });
  assert.equal(empty.status, 400);
});
