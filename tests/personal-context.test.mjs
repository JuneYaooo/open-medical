import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";
import { DoctorProfile } from "../server/medical/doctor-profile.mjs";
import { ReviewLog } from "../server/medical/review-log.mjs";
import {
  PersonalContext,
  saveLearningPrefs,
  localModel,
} from "../server/medical/personal-context.mjs";
import { configureIntakeTools } from "../server/medical/intake-tools.mjs";
import { ToolRegistry } from "../server/core/tool-registry.mjs";
function setup(t, local = false) {
  const store = new Store(":memory:");
  saveLearningPrefs(store.db, { personalContext: true, habits: true });
  t.after(() => store.close());
  const doctor = new DoctorProfile(store);
  new ReviewLog(store).record({
    action: { id: "private-case" },
    patientId: "private-patient",
    ai: {
      name: "金丝雀患者",
      clinicalSummary: { text: "CANARY_OTHER_PATIENT_782", source: "资料" },
      diagnoses: [{ name: "HTN" }],
    },
    final: {
      name: "金丝雀患者",
      diagnoses: [{ name: "高血压" }],
      clinicalSummary: { text: "CANARY_OTHER_PATIENT_782", source: "资料" },
    },
  });
  let exampleReads = 0;
  const service = new PersonalContext({
    store,
    doctor,
    provider: () => ({
      local,
      baseUrl: local ? "http://127.0.0.1:11434/v1" : "https://model.invalid/v1",
      model: "synthetic",
    }),
    cases: () => ({
      similar: () => {
        exampleReads++;
        return { matches: [{ caseId: "patient:private-patient", score: 5 }] };
      },
    }),
    guidelines: {
      search: async () => ({
        hits: [
          {
            docId: "kb",
            docTitle: "合成指南",
            startLine: 1,
            endLine: 3,
            snippet: "高血压知识",
          },
        ],
      }),
    },
    extensions: () => ({
      list: () => [
        {
          id: "skill",
          status: "active",
          name: "摘要技能",
          appliesTo: ["病史摘要"],
          body: "保留来源。",
        },
      ],
    }),
  });
  return { store, doctor, service, reads: () => exampleReads };
}
test("default cloud privacy never reads examples or emits other patient content, including metadata", async (t) => {
  const { service, reads } = setup(t);
  const value = await service.build([{ notes: "高血压" }]);
  assert.equal(reads(), 0);
  assert.equal(value.examples.length, 0);
  assert.doesNotMatch(
    JSON.stringify(service.modelView(value)),
    /CANARY_OTHER|金丝雀患者|private-patient/,
  );
  assert.match(value.examplesSkipped, /云端/);
  assert.ok(value.knowledge.length);
  assert.ok(value.skills.length);
});
test("local opt-in includes redacted examples, all budgets bound text and whole skill bodies", async (t) => {
  const { service, doctor, store } = setup(t, true);
  for (let i = 0; i < 20; i++)
    doctor.saveStated({ content: `习惯${i}${"写法".repeat(100)}` });
  const value = await service.build([{ notes: "高血压" }]);
  assert.equal(value.examples.length, 1);
  assert.ok(value.text.length <= 6000);
  assert.doesNotMatch(value.text, /金丝雀患者/);
  assert.match(value.text, /CANARY_OTHER/);
  assert.ok(
    value.habits.map((h) => `H${h.id} ${h.content}\n`).join("").length <= 1500,
  );
  saveLearningPrefs(store.db, { examples: "never" });
  assert.equal((await service.build([{ notes: "高血压" }])).examples.length, 0);
  assert.equal(
    localModel({ local: true, baseUrl: "https://cloud.invalid" }),
    false,
  );
});
test("holdout has no personalized contents; global switch yields empty context", async (t) => {
  const { service, store, doctor } = setup(t, true);
  doctor.saveStated({ content: "以后诊断写全称" });
  assert.equal(
    (await service.build([{ notes: "高血压" }], { holdout: true })).text,
    "",
  );
  saveLearningPrefs(store.db, { personalContext: false });
  assert.equal((await service.build([{ notes: "高血压" }])).text, "");
});
test("intake gate requires personal context when nonempty, permits empty and resets after notes change", async () => {
  for (const text of ["习惯内容", ""]) {
    const source = { id: "m", name: "record.txt", text: "合成来源" },
      ctx = { sources: [source] };
    const registry = new ToolRegistry(
      ["read_source", "patient_create_propose"].map((name) => ({
        definition: {
          type: "function",
          function: { name, parameters: { type: "object", properties: {} } },
        },
        execute: () => ({ ok: true }),
      })),
    );
    configureIntakeTools(registry, { materials: [source] }, () => {}, [], {
      build: async () => ({ text }),
      modelView: (v) => v,
      prepare: (payload) => payload,
    });
    registry.get("read_intake_batch").execute({}, ctx);
    registry.get("save_intake_notes").execute({ notes: "合成来源" });
    assert.match(
      registry.get("read_intake_notes").execute({}).instruction,
      /read_personal_context/,
    );
    if (text)
      await assert.rejects(
        registry.get("patient_create_propose").execute({}, ctx),
        /read_personal_context/,
      );
    else
      assert.equal(
        (await registry.get("patient_create_propose").execute({}, ctx)).ok,
        true,
      );
    await registry.get("read_personal_context").execute({});
    assert.equal(
      (await registry.get("patient_create_propose").execute({}, ctx)).ok,
      true,
    );
  }
});
test("full sources trim lowest-priority blocks instead of failing the intake", async (t) => {
  const store = new Store(":memory:");
  saveLearningPrefs(store.db, { personalContext: true, habits: true });
  t.after(() => store.close());
  const doctor = new DoctorProfile(store);
  const log = new ReviewLog(store);
  for (const id of ["p1", "p2"])
    log.record({
      action: { id: `a-${id}` },
      patientId: id,
      ai: {
        diagnoses: [1, 2, 3, 4, 5].map((n) => ({ name: `偶然发现的影像小结节${n}`.repeat(6), status: "finding" })),
        clinicalSummary: { text: "长".repeat(900) },
      },
      final: { diagnoses: [], clinicalSummary: { text: "长".repeat(900) } },
      reasons: Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`diagnoses:${i}`, "不该算诊断"])),
    });
  // Many short habits: each block join adds a newline on top of the 1450-char habit cap.
  for (let i = 0; i < 120; i++) doctor.saveStated({ content: `第${i}条习惯写法要求` });
  const service = new PersonalContext({
    store,
    doctor,
    provider: () => ({ local: true, baseUrl: "http://127.0.0.1:11434/v1", model: "synthetic" }),
    cases: () => ({
      similar: () => ({
        matches: [
          { caseId: "patient:p1", score: 5 },
          { caseId: "patient:p2", score: 4 },
        ],
      }),
    }),
    guidelines: {
      search: async () => ({
        hits: [1, 2, 3].map((ord) => ({
          docId: "kb",
          ord,
          docTitle: "合成指南",
          startLine: ord,
          endLine: ord,
          snippet: "知识".repeat(200),
        })),
      }),
    },
    extensions: () => ({
      list: () => [
        { id: "s1", status: "active", name: "摘要技能", appliesTo: ["病史摘要"], body: "规则".repeat(468) },
      ],
    }),
  });
  const value = await service.build([{ notes: "高血压" }]);
  assert.ok(value.text.length <= 6000);
  assert.equal(value.examples.length, 2);
  assert.equal(value.skills.length, 0, "skills are dropped first");
  assert.ok(value.knowledge.length >= 1);
  assert.match(value.text, /删除诊断「偶然发现的影像小结节1.*（原因：不该算诊断）/);
});
test("habits switch alone post-processes drafts without injecting prompt context", async (t) => {
  const store = new Store(":memory:");
  saveLearningPrefs(store.db, { personalContext: false, habits: true });
  t.after(() => store.close());
  const doctor = new DoctorProfile(store);
  const habit = doctor.saveStated({ content: "以后诊断都写全称" });
  const service = new PersonalContext({
    store,
    doctor,
    provider: () => ({ local: false, baseUrl: "https://model.invalid/v1", model: "synthetic" }),
    cases: () => ({ similar: () => ({ matches: [] }) }),
    guidelines: { search: async () => ({ hits: [] }) },
    extensions: () => ({ list: () => [] }),
  });
  const context = await service.build([{ notes: "HTN" }]);
  assert.equal(context.text, "", "gate stays open when P1 is off");
  const { HabitLearner } = await import("../server/medical/habit-learner.mjs");
  const payload = service.prepare({ diagnoses: [{ name: "HTN" }] }, context, {
    habitLearner: new HabitLearner(store, doctor),
  });
  assert.equal(payload.diagnoses[0].name, "高血压");
  assert.deepEqual(payload.personalization.habits.map((h) => h.id), [habit.id]);
  assert.equal(payload.habitChanges[0].habitId, habit.id);
});
