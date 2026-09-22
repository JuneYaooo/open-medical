import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

test("previsit brief preserves uncertainty, provenance and incompatible/conflicting lab observations", async (t) => {
  const f = await fixture(t, { followupOptions: { autoStart: false } });
  const p = (await f.json("/api/patients", "POST", { name: "合成接诊患者", medications: [{ name: "历史用药", status: "stopped", source: "合成停药记录" }, { name: "待核对用药" }], labs: [
    { item: "检验A", value: 9, unit: "单位甲", date: "2026-09-20", source: "新报告" },
    { item: "检验A", value: 5, unit: "单位甲", date: "2026-09-01", source: "旧报告" },
    { item: "检验A", value: 100, unit: "单位乙", date: "2026-09-21" },
    { item: "检验B", value: 1, unit: "单位甲", date: "2026-09-20" },
    { item: "检验B", value: 2, unit: "单位甲", date: "2026-09-20" },
  ], visits: [{ date: "2026-09-20", reason: "本次" }, { date: "2026-09-01", reason: "前次" }] })).data;
  const brief = (await f.json(`/api/patients/${p.id}/brief`)).data;
  assert.equal(brief.allergyStatus, "unknown");
  assert.ok(brief.gaps.some((g) => /1 条用药/.test(g.label)));
  assert.equal(brief.medications[0].status, "stopped");
  assert.equal(brief.labs.length, 3);
  const a = brief.labs.find((lab) => lab.item === "检验A" && lab.unit === "单位甲");
  assert.equal(a.delta, 4);
  assert.equal(a.previous.source, "旧报告");
  assert.equal(brief.labs.find((lab) => lab.unit === "单位乙").delta, null);
  const b = brief.labs.find((lab) => lab.item === "检验B");
  assert.equal(b.conflict, true);
  assert.equal(b.delta, null);
  assert.equal(b.observations.length, 2);
  assert.equal(brief.visits[0].reason, "本次");
  assert.equal((await f.json(`/api/patients/${p.id}/brief`)).data.fingerprint, brief.fingerprint);
  f.server.patients.ingest([{ direction: "in", text: "新的合成反馈" }], { patientId: p.id });
  const changed = (await f.json(`/api/patients/${p.id}/brief`)).data;
  assert.equal(changed.revision, brief.revision);
  assert.notEqual(changed.fingerprint, brief.fingerprint);
  assert.equal(changed.messages[0].text, "新的合成反馈");
  assert.equal((await f.json("/api/patients/missing-patient/brief")).status, 404);
});

test("previsit brief follows recorded contact outcomes without mistaking acknowledgements for contact", async (t) => {
  const f = await fixture(t, { followupOptions: { autoStart: false } });
  const p = (await f.json("/api/patients", "POST", { name: "合成随访近况" })).data;
  const job = f.server.followups.create(p.id, { name: "复查资料", once: true, firstDueAt: new Date(Date.now() + 60000).toISOString() });
  f.server.followups.createReminder(p, job, "提醒");
  const reminder = f.server.followups.reminders({ patientId: p.id })[0];
  f.server.followups.ackReminder(reminder.id);
  assert.equal((await f.json(`/api/patients/${p.id}/brief`)).data.outcomes.length, 0);
  const result = await f.json(`/api/reminders/${reminder.id}/complete`, "POST", { status: "unreachable", note: "合成患者未接听，尚未获知近况" });
  assert.equal(result.status, 200);
  const brief = (await f.json(`/api/patients/${p.id}/brief`)).data;
  assert.equal(brief.outcomes[0].status, "unreachable");
  assert.equal(brief.counts.pendingReminders, 0);
});

test("patient identity edits permit clearing optional fields but retain optimistic concurrency", async (t) => {
  const f = await fixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "可编辑档案", phone: "13800000000", birthYear: 1980, note: "旧备注" })).data;
  const result = await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: p.revision, phone: "", note: "", birthYear: null });
  assert.equal(result.status, 200);
  assert.equal(result.data.phone, "");
  assert.equal(result.data.birthYear, null);
  assert.equal((await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: p.revision, phone: "13900000000" })).status, 409);
});

test("drafts bound maximum-size chart excerpts below task input limits and preserve the source key", async () => {
  const { briefDraft } = await import("../shared/patient-brief.mjs");
  const text = "合成资料".repeat(1300);
  const lab = { item: "合成项目".repeat(15), value: 1, unit: "单位".repeat(15), date: "2026-09-21", source: text };
  const draft = briefDraft({ revision: 9, fingerprint: "source-version", generatedAt: "2026-09-21T17:00:00Z", diagnoses: Array.from({ length: 8 }, () => ({ name: text, code: text, source: text })), medications: Array.from({ length: 20 }, () => ({ name: text, dose: text, frequency: text, note: text, source: text, status: "unknown" })), allergyStatus: "recorded", allergies: Array.from({ length: 20 }, () => "合成过敏原".repeat(20)), labs: Array.from({ length: 8 }, () => ({ ...lab, conflict: true, observations: Array.from({ length: 500 }, () => lab), previous: lab })), visits: Array.from({ length: 5 }, () => ({ date: "2026-09-21", reason: text, note: text })), outcomes: Array.from({ length: 6 }, () => ({ id: "source-id", title: text, note: text, status: "unreachable" })), messages: Array.from({ length: 3 }, () => ({ text, source: "消息 1" })), gaps: [], counts: { medications: 60, labGroups: 500 } });
  assert.ok(draft.length < 20000, `draft has ${draft.length} characters`);
  assert.match(draft, /source-version/);
  assert.match(draft, /节选/);
  assert.match(draft, /未纳入的记录不能视为不存在/);
  assert.match(draft, /"labGroups":500/);
});
