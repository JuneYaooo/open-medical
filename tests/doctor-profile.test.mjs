import test from "node:test";
import assert from "node:assert/strict";
import { DoctorProfile, doctorMemoryTools } from "../server/medical/doctor-profile.mjs";
import { Store } from "../server/store.mjs";

const newDoctor = (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return new DoctorProfile(store);
};

test("doctor profile: structured fields, revision guard and digest", (t) => {
  const doctor = newDoctor(t);
  const initial = doctor.get();
  assert.equal(initial.revision, 0);
  assert.equal(initial.digest, "");

  assert.throws(
    () =>
      doctor.update({
        expectedRevision: initial.revision + 1,
        specialty: "心内科",
      }),
    (err) => err.code === "REVISION_CONFLICT",
  );

  const updated = doctor.update({
    expectedRevision: initial.revision,
    specialty: "心内科",
    medicationHabits: ["美托洛尔缓释片 47.5mg qd"],
    guidelineSources: ["中国心衰指南 2024"],
  });
  assert.equal(updated.revision, 1);
  assert.equal(updated.fields.specialty, "心内科");
  assert.ok(updated.digest.includes("心内科"));
  assert.ok(updated.digest.includes("美托洛尔缓释片"));
  assert.ok(updated.digest.length <= 800);

  assert.throws(
    () =>
      doctor.update({
        expectedRevision: updated.revision,
        medicationHabits: "不是数组",
      }),
    (err) => err.code === "INVALID_INPUT",
  );
});

test("doctor memories: explicit entries are active, lifecycle and topic replacement", (t) => {
  const doctor = newDoctor(t);
  const first = doctor.addMemory({
    kind: "explicit",
    content: "随访总结用表格输出",
    topic: "输出格式",
  });
  assert.equal(first.status, "confirmed");
  assert.ok(doctor.get().digest.includes("随访总结用表格"));

  const second = doctor.addMemory({
    kind: "explicit",
    content: "随访总结用纯文本输出",
    topic: "输出格式",
    status: "pending",
  });
  assert.equal(second.status, "pending");
  // Pending entry does not take effect.
  assert.ok(!doctor.get().digest.includes("纯文本"));
  const confirmed = doctor.confirmMemory(second.id);
  assert.equal(confirmed.status, "confirmed");
  // Same-topic old entry is superseded (dismissed), not duplicated.
  const list = doctor.memories({ status: "confirmed" });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, second.id);
  assert.ok(doctor.get().digest.includes("纯文本"));

  doctor.pinMemory(second.id, true);
  assert.ok(doctor.memoryRow(second.id).pinned);
  doctor.dismissMemory(second.id);
  assert.equal(doctor.memoryRow(second.id).status, "dismissed");
  assert.equal(doctor.get().digest, "");
  assert.equal(doctor.deleteMemory(second.id).ok, true);
  assert.throws(() => doctor.memoryRow(second.id), /记忆条目不存在/);
});

test("doctor signals: dedupe, deterministic consolidation and manual confirm", (t) => {
  const doctor = newDoctor(t);
  const source = { type: "review_rejected", sessionId: "s1" };
  doctor.recordSignal({ content: "日期必须保留原格式", topic: "复核反馈", source });
  const merged = doctor.recordSignal({ content: "日期必须保留原格式", source });
  assert.equal(merged.count, 2);
  assert.equal(doctor.memories({ kind: "observed" }).length, 1);

  const once = doctor.recordSignal({ content: "只出现过一次的信号", source });
  const result = doctor.consolidate();
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].kind, "consolidated");
  assert.equal(result.created[0].content, "日期必须保留原格式");
  assert.equal(result.created[0].count, 2);
  // Repeated signals are merged away; the single one stays open.
  assert.equal(doctor.memories({ kind: "observed", status: "open" }).length, 1);

  const confirmed = doctor.confirmMemory(result.created[0].id);
  assert.equal(confirmed.status, "confirmed");
  assert.ok(doctor.get().digest.includes("日期必须保留原格式"));
  doctor.dismissMemory(once.id);
});

test("doctor model consolidation requires consent and produces pending candidates", async (t) => {
  const doctor = newDoctor(t);
  doctor.recordSignal({ content: "引用指南时标注年份" });
  doctor.recordSignal({ content: "术语用中文全称" });

  await assert.rejects(
    () => doctor.modelConsolidate(stubProvider, {}),
    (err) => err.code === "CONSENT_REQUIRED",
  );

  const result = await doctor.modelConsolidate(stubProvider, { consent: true });
  assert.equal(result.created.length, 2);
  assert.ok(result.created.every((c) => c.status === "pending" && c.kind === "consolidated"));
  // Pending candidates do not leak into the digest.
  assert.equal(doctor.get().digest, "");
  assert.equal(doctor.counts().openSignals, 0);
});

test("doctor memory tools expose get/save/forget with confirmed-only visibility", () => {
  const store = new Store(":memory:");
  const doctor = new DoctorProfile(store);
  doctor.addMemory({ kind: "explicit", content: "偏好A" });
  doctor.addMemory({ kind: "explicit", content: "偏好B", status: "pending" });
  const tools = doctorMemoryTools(doctor);
  assert.deepEqual(
    tools.map((t) => t.definition.function.name),
    ["doctor_memory_get", "doctor_memory_save", "doctor_memory_forget"],
  );
  const get = tools[0].execute({});
  assert.ok(get.digest.includes("偏好A"));
  assert.ok(!get.digest.includes("偏好B"));
  assert.equal(get.memories.length, 1);

  const save = tools[1].execute({ content: "模型听到的偏好", topic: "格式" });
  assert.equal(save.status, "confirmed");
  const active = doctor.memories({ status: "confirmed" });
  assert.equal(active.length, 2);

  const forgotten = tools[2].execute({ id: active[0].id });
  assert.equal(forgotten.status, "dismissed");
  store.close();
});

test("medical runtime registers doctor tools and bootstrap reports counts", async (t) => {
  const { fixture } = await import("./helpers.mjs");
  const f = await fixture(t);
  const bootstrap = (await f.json("/api/bootstrap")).data;
  assert.ok(bootstrap.tools.includes("doctor_memory_get"));
  assert.ok(bootstrap.tools.includes("doctor_memory_save"));
  assert.equal(bootstrap.doctorMemory.active, 0);

  const created = await f.json("/api/doctor/memories", "POST", {
    content: "检验摘录保留原始单位",
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, "confirmed");
  const counts = (await f.json("/api/bootstrap")).data.doctorMemory;
  assert.equal(counts.active, 1);

  const profile = (await f.json("/api/doctor/profile")).data;
  assert.ok(profile.digest.includes("检验摘录保留原始单位"));
});

test("doctor API routes: profile update, memory lifecycle, consolidation and model consent", async (t) => {
  const { fixture } = await import("./helpers.mjs");
  const f = await fixture(t);
  const profile = (await f.json("/api/doctor/profile")).data;
  const patched = await f.json("/api/doctor/profile", "PATCH", {
    expectedRevision: profile.revision,
    specialty: "内分泌科",
    documentationStyle: ["病程记录按时间分段"],
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.fields.specialty, "内分泌科");

  const memory = await f.json("/api/doctor/memories", "POST", {
    content: "避免使用英文缩写",
    topic: "术语",
    status: "pending",
  });
  assert.equal(memory.status, 201);
  const id = memory.data.id;
  assert.equal((await f.json(`/api/doctor/memories/${id}/confirm`, "POST")).data.status, "confirmed");
  assert.equal((await f.json(`/api/doctor/memories/${id}/pin`, "POST", { pinned: true })).data.pinned, true);
  assert.equal((await f.json(`/api/doctor/memories/${id}/dismiss`, "POST")).data.status, "dismissed");
  assert.equal((await f.json(`/api/doctor/memories/${id}`, "DELETE")).data.ok, true);

  // Deterministic consolidation on empty signals returns no candidates.
  const consolidate = await f.json("/api/doctor/consolidate", "POST");
  assert.equal(consolidate.status, 200);
  assert.equal(consolidate.data.created.length, 0);

  // Model consolidation gates on explicit external-send consent.
  const noConsent = await f.json("/api/doctor/consolidate/model", "POST", {});
  assert.equal(noConsent.status, 412);
});

test("doctor API: model consolidation end-to-end with stub provider", async (t) => {
  const { fixture } = await import("./helpers.mjs");
  const f = await fixture(t, {
    provider: {
      provider: "stub",
      model: "stub-model",
      async complete(messages) {
        assert.match(messages[1].content, /引用指南时标注年份/);
        return {
          text: '[{"content":"指南引用需标注年份","topic":"循证"}]',
          model: "stub-model",
        };
      },
    },
  });
  const session = await f.session();
  // Create a signal through the real review-rejection path: reject requires an
  // artifact, so instead seed one via direct memory insert through the API.
  await f.json("/api/doctor/memories", "POST", {
    content: "引用指南时标注年份",
    status: "pending",
  });
  // pending explicit is not a signal; record an open signal via consolidate seed:
  // use the store directly through the exposed server doctor.
  f.server.doctor.recordSignal({ content: "引用指南时标注年份" });
  void session;
  const result = await f.json("/api/doctor/consolidate/model", "POST", {
    externalConsent: true,
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.created.length, 1);
  assert.equal(result.data.created[0].content, "指南引用需标注年份");
  assert.equal(result.data.created[0].status, "pending");
});

const stubProvider = {
  provider: "stub",
  model: "stub-model",
  async complete() {
    return {
      text: '[{"content":"指南引用需标注年份","topic":"循证"},{"content":"术语用中文全称","topic":"术语"}]',
      model: "stub-model",
    };
  },
};

test("proposal tray feedback becomes observed signals and consolidates", async (t) => {
  const { fixture } = await import("./helpers.mjs");
  const { PermissionEngine } = await import("../server/core/permissions.mjs");
  const f = await fixture(t);
  const session = await f.session("提案反馈");
  const registry = f.server.workspaces.registry(session.id);
  const permissions = new PermissionEngine({ profile: "standard" });
  const propose = (summary) => registry.execute("case_save_propose", { summary, diagnosis: "原发性高血压" }, {}, permissions);
  const first = await propose("把出院小结写成表格");
  const second = await propose("把出院小结写成表格");
  const third = await propose("随访总结用表格");

  // 拒绝并写说明 → 观察信号；相同说明合并计数而不是重复成两行。
  assert.equal((await f.json(`/api/pending-actions/${first.id}/reject`, "POST", { note: "文风要正式，不要表格" })).status, 200);
  assert.equal((await f.json(`/api/pending-actions/${second.id}/reject`, "POST", { note: "文风要正式，不要表格" })).status, 200);
  // 不带说明的拒绝不产生信号。
  assert.equal((await f.json(`/api/pending-actions/${third.id}/reject`, "POST", {})).status, 200);
  const open = f.server.doctor.memories({ status: "open" });
  assert.equal(open.length, 1);
  assert.match(open[0].content, /文风要正式/);
  assert.equal(open[0].count, 2);
  assert.equal(open[0].topic, "提案反馈");

  // 重复出现的反馈经确定性归并成为待确认偏好候选，医生确认后才生效。
  const consolidated = f.server.doctor.consolidate();
  assert.equal(consolidated.created.length, 1);
  assert.equal(consolidated.created[0].status, "pending");
  assert.match(consolidated.created[0].content, /文风要正式/);

  // 确认时带的备注同样进信号。
  const fourth = await propose("随访提醒提前一天");
  assert.equal((await f.json(`/api/pending-actions/${fourth.id}/confirm`, "POST", { note: "好，但提醒时间改到下午三点" })).status, 200);
  const confirmedSignal = f.server.doctor.memories({ status: "open" }).find((row) => row.source.type === "proposal_confirmed");
  assert.ok(confirmedSignal);
  assert.match(confirmedSignal.content, /下午三点/);
});
