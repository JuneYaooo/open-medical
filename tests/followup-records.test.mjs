import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

async function setup(t) {
  const f = await fixture(t, { followupOptions: { autoStart: false } });
  const p = (await f.json("/api/patients", "POST", { name: "合成主动联系" })).data;
  return { ...f, p };
}

test("completed follow-up history does not consume the active plan allowance", async (t) => {
  const f = await setup(t), manager = f.server.followups;
  const input = { name: "合成历史计划", once: true, firstDueAt: new Date(Date.now() + 86400000).toISOString() };
  for (let i = 0; i < 20; i++) {
    const job = manager.create(f.p.id, input); job.status = "completed";
    f.server.store.db.prepare("UPDATE follow_ups SET status=?,data=? WHERE id=?").run(job.status, JSON.stringify(job), job.id);
  }
  for (let i = 0; i < 20; i++) manager.create(f.p.id, input);
  assert.equal(manager.list(f.p.id).length, 40);
  assert.throws(() => manager.create(f.p.id, input), { code: "SCHEDULE_LIMIT" });
});

test("manual contact is durable and an uncertain retry cannot duplicate the next reminder", async (t) => {
  const f = await setup(t);
  const payload = { requestId: "contact-retry-1", title: "主动核对资料", status: "unreachable", note: "合成患者未接听，安排再次联系", contactedAt: "2026-01-01T10:00:00Z", nextDueAt: new Date(Date.now() + 86400000).toISOString() };
  const first = await f.json(`/api/patients/${f.p.id}/followup-records`, "POST", payload);
  assert.equal(first.status, 201);
  assert.equal(first.data.outcome.contactedAt, payload.contactedAt.replace("Z", ".000Z"));
  const retry = await f.json(`/api/patients/${f.p.id}/followup-records`, "POST", payload);
  assert.equal(retry.status, 201);
  assert.equal(retry.data.id, first.data.id);
  assert.equal(f.server.followups.list(f.p.id).length, 1);
  assert.equal((await f.json(`/api/reminders?patientId=${f.p.id}&status=done`)).data.total, 1);
  const changed = await f.json(`/api/patients/${f.p.id}/followup-records`, "POST", { ...payload, note: "不同内容" });
  assert.equal(changed.status, 409);
  const bad = await f.json(`/api/patients/${f.p.id}/followup-records`, "POST", { requestId: "bad-contact", note: "缺少结果" });
  assert.equal(bad.status, 400);
  assert.equal((await f.json(`/api/reminders?patientId=${f.p.id}`)).data.counts.pending, 0, "invalid manual record rolls back its placeholder");
});

test("contact addenda preserve original entry and reject conflicting or archived edits", async (t) => {
  const f = await setup(t);
  const record = (await f.json(`/api/patients/${f.p.id}/followup-records`, "POST", { status: "completed", note: "原始合成记录" })).data;
  const before = (await f.json(`/api/patients/${f.p.id}/brief`)).data;
  const added = await f.json(`/api/reminders/${record.id}/addendum`, "POST", { expectedRevision: 0, note: "更正：原反馈日期登记有误，以纸质记录为准" });
  assert.equal(added.status, 200);
  assert.equal(added.data.outcome.note, "原始合成记录");
  assert.equal(added.data.outcome.addenda.length, 1);
  assert.equal(added.data.outcome.revision, 1);
  assert.equal((await f.json(`/api/reminders/${record.id}/addendum`, "POST", { expectedRevision: 0, note: "过期补充" })).status, 409);
  const after = (await f.json(`/api/patients/${f.p.id}/brief`)).data;
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.match(after.outcomes[0].addenda[0].note, /更正/);
  await f.json(`/api/patients/${f.p.id}`, "PATCH", { expectedRevision: f.p.revision, archived: true });
  assert.equal((await f.json(`/api/reminders/${record.id}/addendum`, "POST", { expectedRevision: 1, note: "归档后不可追加" })).status, 409);
});

test("follow-up history pagination is exact and newest-first across more than 100 records", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 125; i++) {
    f.server.store.db.prepare("INSERT INTO reminders VALUES (?,?,?,?,?,?)").run(`history-${String(i).padStart(3, "0")}`, f.p.id, "manual-contact", i, "done", JSON.stringify({ patientId: f.p.id, sessionId: f.p.sessionId, title: `合成历史 ${i}`, outcome: { status: "completed", note: `记录 ${i}`, checkedItems: [], recordedAt: new Date(Date.UTC(2025, 0, i + 1)).toISOString() } }));
  }
  const page = (await f.json(`/api/reminders?patientId=${f.p.id}&status=done&limit=20&offset=0`)).data;
  assert.equal(page.total, 125);
  assert.equal(page.counts.done, 125);
  assert.equal(page.reminders.length, 20);
  assert.equal(page.reminders[0].id, "history-124");
  const last = (await f.json(`/api/reminders?patientId=${f.p.id}&status=done&limit=20&offset=120`)).data;
  assert.equal(last.reminders.length, 5);
  assert.equal(last.hasMore, false);
  assert.equal(last.reminders.at(-1).id, "history-000");
  assert.equal((await f.json("/api/reminders?offset=-1")).status, 400);
  const other = (await f.json("/api/patients", "POST", { name: "另一合成患者" })).data;
  assert.equal((await f.json(`/api/reminders?patientId=${other.id}&status=done`)).data.total, 0);
});
