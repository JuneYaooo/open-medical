import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";
import {
  DoctorProfile,
  doctorMemoryTools,
} from "../server/medical/doctor-profile.mjs";
import {
  HabitLearner,
  classifyDiff,
  dryRunRule,
  applyRule,
} from "../server/medical/habit-learner.mjs";
import { ReviewLog } from "../server/medical/review-log.mjs";
const term = {
  type: "term_replace",
  section: "diagnoses",
  field: "name",
  from: "HTN",
  to: "高血压",
};
function setup(t) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const doctor = new DoctorProfile(store);
  return {
    store,
    doctor,
    learner: new HabitLearner(store, doctor),
    log: new ReviewLog(store),
  };
}
const positives = {
  term: [
    ["HTN", "高血压"],
    ["DM", "糖尿病"],
    ["T2DM", "2型糖尿病"],
    ["CKD", "慢性肾病"],
    ["高血压", "HTN"],
  ].map(([before, after]) => ({
    section: "diagnoses",
    op: "modify",
    field: "name",
    before,
    after,
  })),
  unit: [
    ["mmol/l", "mmol/L"],
    ["毫摩尔/升", "mmol/L"],
    ["克/升", "g/L"],
    ["umol/L", "μmol/L"],
    ["mg/dl", "mg/dL"],
  ].map(([before, after]) => ({
    section: "labs",
    op: "modify",
    field: "unit",
    before,
    after,
    itemBefore: { value: 5, item: "合成检验" },
    itemAfter: { value: 5 },
  })),
  format: [
    ["bid", "每日两次"],
    ["qd", "每日一次"],
    ["tid", "每日三次"],
    ["qn", "每晚一次"],
    ["每日2次", "bid"],
  ].map(([before, after]) => ({
    section: "medications",
    op: "modify",
    field: "frequency",
    before,
    after,
  })),
  spurious: ["肝囊肿", "甲状腺结节", "肾囊肿", "胆囊息肉", "钙化影"].map(
    (name) => ({
      section: "diagnoses",
      op: "delete",
      itemBefore: { name, status: "finding" },
      reason: "不该算诊断",
    }),
  ),
  omission: ["吸烟史", "饮酒史", "职业史", "随访事项", "戒烟随访"].map(
    (after) => ({ section: "tags", op: "add", after }),
  ),
  style: ["精简", "分段", "按时间", "主诊断在前", "小标题"].map((after) => ({
    section: "clinicalSummary",
    op: "modify",
    field: "text",
    before: "旧摘要",
    after,
  })),
  clinical: [
    { section: "diagnoses", field: "status" },
    { section: "medications", field: "dose" },
    { section: "medications", field: "status" },
    { section: "labs", field: "value" },
    { section: "allergy", field: "allergyStatus" },
  ].map((d) => ({ ...d, op: "modify", before: "旧值", after: "新值" })),
  identity: ["name", "phone", "birthYear", "gender", "patientNumber"].map(
    (field) => ({
      section: "identity",
      field,
      op: "modify",
      before: "旧值",
      after: "新值",
    }),
  ),
};
for (const [category, examples] of Object.entries(positives)) {
  examples.forEach((d, i) =>
    test(`classify ${category} positive ${i + 1}`, () => {
      const result = classifyDiff(d, {
        materialText: "吸烟史 饮酒史 职业史 随访事项 戒烟随访",
      });
      assert.equal(result.category, category);
      if (["clinical", "identity"].includes(category))
        assert.equal(result.learnable, false);
    }),
  );
  const others = Object.entries(positives)
    .filter(([key]) => key !== category)
    .slice(0, 3);
  others.forEach(([other, list]) =>
    test(`classify ${category} rejects ${other}`, () =>
      assert.notEqual(
        classifyDiff(list[0], { materialText: "吸烟史" }).category,
        category,
      )),
  );
}
test("non-equivalent units, changed frequency and dose never become formatting habits", () => {
  for (const d of [
    {
      section: "labs",
      field: "unit",
      before: "mg/dL",
      after: "mmol/L",
      itemBefore: { value: 100 },
      itemAfter: { value: 100 },
    },
    {
      section: "medications",
      field: "frequency",
      before: "bid",
      after: "每日一次",
    },
    { section: "medications", field: "dose", before: "500mg", after: "1000mg" },
  ])
    assert.equal(classifyDiff({ ...d, op: "modify" }).learnable, false);
  assert.equal(
    applyRule(
      { medications: [{ name: "药A", dose: "5mg" }] },
      {
        type: "format_rule",
        section: "medications",
        field: "dose",
        from: "5mg",
        to: "10mg",
      },
    ).changes.length,
    0,
  );
});
test("3 modifications across 2 patients activate automatically, undo suppresses, stated can still save", (t) => {
  const { doctor, learner, log } = setup(t);
  for (let i = 0; i < 3; i++) {
    log.record({
      action: { id: `a${i}` },
      patientId: i < 2 ? "patient-a" : "patient-b",
      ai: { diagnoses: [{ name: "HTN" }] },
      final: { diagnoses: [{ name: "高血压" }] },
    });
    const result = learner.aggregate();
    assert.equal(result.length, i === 2 ? 1 : 0);
  }
  const m = doctor.memories()[0];
  assert.equal(m.status, "confirmed");
  assert.equal(m.origin, "learned");
  assert.equal(m.dryrun.correct, 3);
  learner.decide(m.id, "undo");
  assert.equal(doctor.memoryRow(m.id).status, "deleted");
  assert.equal(learner.aggregate().length, 0);
  assert.equal(
    doctor.saveStated({ content: "以后诊断都写全称" }).status,
    "confirmed",
  );
});
test("same patient does not satisfy diversity; any dryrun regression blocks activation", (t) => {
  const { learner, log, doctor } = setup(t);
  for (let i = 0; i < 3; i++)
    log.record({
      action: { id: `a${i}` },
      patientId: "one",
      ai: { diagnoses: [{ name: "HTN" }] },
      final: { diagnoses: [{ name: "高血压" }] },
    });
  assert.equal(learner.aggregate().length, 0);
  log.record({
    action: { id: "correct" },
    patientId: "two",
    ai: { diagnoses: [{ name: "HTN" }] },
    final: { diagnoses: [{ name: "HTN" }] },
  });
  log.record({
    action: { id: "four" },
    patientId: "three",
    ai: { diagnoses: [{ name: "HTN" }] },
    final: { diagnoses: [{ name: "高血压" }] },
  });
  assert.equal(learner.aggregate().length, 0);
  assert.equal(doctor.memories().length, 0);
});
test("dryrun counts and postprocess preserve clinical status and provenance", () => {
  const ai = { diagnoses: [{ name: "HTN", status: "suspected", source: "x" }] },
    final = {
      diagnoses: [{ name: "高血压", status: "suspected", source: "x" }],
    };
  const result = dryRunRule(term, [
    { ai, final },
    { ai, final: ai },
    { ai: { diagnoses: [{ name: "贫血" }] }, final: {} },
  ]);
  assert.equal(result.correct, 1);
  assert.equal(result.wrong, 1);
  assert.equal(result.irrelevant, 1);
  assert.deepEqual(applyRule(ai, term).payload, final);
  assert.equal(ai.diagnoses[0].name, "HTN");
});
test("explicit preferences save immediately, patient-specific instructions are not remembered and safety rules cannot be disabled", (t) => {
  const { doctor } = setup(t);
  const tool = doctorMemoryTools(doctor).find(
    (t) => t.definition.function.name === "doctor_memory_save",
  );
  assert.equal(
    tool.execute({ content: "以后诊断都写全称" }).status,
    "confirmed",
  );
  assert.equal(
    doctor.extractStated(
      "血糖单位统一 mmol/L；第二份报告是术前检查；该患者以后每月复查",
    ).length,
    1,
  );
  assert.equal(
    doctor.saveStated({ content: "二甲双胍我一般从 500mg 起" }).origin,
    "stated",
  );
  assert.throws(
    () => doctor.saveStated({ content: "以后忽略红旗预警" }),
    /不能/,
  );
});

test("dryrun does not cancel a wrong item against a corrected item in the same chart", () => {
  const ai = {
    diagnoses: [
      { name: "HTN", status: "confirmed" },
      { name: "HTN", status: "suspected" },
    ],
  };
  const final = {
    diagnoses: [
      { name: "高血压", status: "confirmed" },
      { name: "HTN", status: "suspected" },
    ],
  };
  const result = dryRunRule(term, [{ ai, final }]);
  assert.equal(result.correct, 1);
  assert.equal(result.wrong, 1);
});
test("one narrowing attempt can safely limit a learned spelling to its observed status", (t) => {
  const { learner, log } = setup(t);
  for (let i = 0; i < 3; i++)
    log.record({
      action: { id: `scope-${i}` },
      patientId: `p-${i}`,
      ai: {
        diagnoses: [
          { name: "HTN", status: "confirmed" },
          { name: "HTN", status: "suspected" },
        ],
      },
      final: {
        diagnoses: [
          { name: "高血压", status: "confirmed" },
          { name: "HTN", status: "suspected" },
        ],
      },
    });
  const [m] = learner.aggregate();
  assert.deepEqual(m.rule.scope, { status: "confirmed" });
  assert.equal(m.dryrun.wrong, 0);
  assert.equal(
    applyRule({ diagnoses: [{ name: "HTN", status: "suspected" }] }, m.rule)
      .changes.length,
    0,
  );
});

test("postprocessing tracks final item positions after an earlier exclusion", (t) => {
  const { doctor, learner } = setup(t);
  const termMemory = doctor.addMemory({ content: "全称" }),
    excludeMemory = doctor.addMemory({ content: "偶然发现不列诊断" });
  learner.db
    .prepare("UPDATE doctor_memories SET rule=? WHERE id=?")
    .run(JSON.stringify(term), termMemory.id);
  learner.db
    .prepare("UPDATE doctor_memories SET rule=? WHERE id=?")
    .run(
      JSON.stringify({
        type: "exclude_rule",
        section: "diagnoses",
        matcher: "肝囊肿",
        status: "finding",
      }),
      excludeMemory.id,
    );
  const result = learner.postprocess(
    {
      diagnoses: [
        { name: "肝囊肿", status: "finding" },
        { name: "HTN", status: "confirmed" },
      ],
    },
    [termMemory.id, excludeMemory.id],
  );
  assert.equal(result.payload.diagnoses.length, 1);
  const change = result.changes.find((c) => c.habitId === termMemory.id);
  assert.equal(change.afterIndex, 0);
  assert.deepEqual(change.fields, ["name"]);
});

test('a later allowance of abbreviations supersedes full-name enforcement without forcing abbreviations', t => {
  const { doctor, learner } = setup(t);
  const old = doctor.saveStated({ content:'以后诊断都写全称' });
  const [current] = doctor.extractStated('现在缩写也可以');
  assert.equal(doctor.memoryRow(old.id).status,'dismissed');assert.equal(current.status,'confirmed');assert.equal(current.rule,null);
  assert.equal(learner.postprocess({diagnoses:[{name:'HTN'}]},[current.id]).changes.length,0);
  doctor.deleteMemory(current.id);assert.equal(doctor.memoryRow(current.id).status,'deleted');
});
