import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

test("doctor agenda unifies actionable work without treating read/generated as completed", async (t) => {
  const f = await fixture(t, { followupOptions: { autoStart: false } });
  const p = (await f.json("/api/patients", "POST", { name: "今日患者", patientNumber: "TODAY-1", labs: [{ item: "血钾", value: 2.5, unit: "mmol/L", date: "2026-09-21" }] })).data;
  const job = f.server.followups.create(p.id, { name: "复诊联系", once: true, firstDueAt: new Date(Date.now() + 60000).toISOString() });
  const reminder = f.server.followups.createReminder(p, job, "请联系");
  f.server.patients.ingest([{ direction: "in", text: "合成消息" }], { patientId: p.id });
  f.server.patients.ingest([{ direction: "in", text: "归属不明" }]);
  const all = (await f.json("/api/doctor/overview?limit=2")).data;
  assert.equal(all.patientCount, 1);
  assert.equal(all.counts.risk, 1);
  assert.equal(all.counts.followup, 1);
  assert.equal(all.counts.messages, 2);
  assert.equal(all.counts.tracking, 1, "the new potassium value is an unread result");
  assert.equal(all.total, 5);
  assert.equal(all.items.length, 2);
  assert.equal(all.hasMore, true);
  assert.equal(all.items[0].kind, "risk");
  const filtered = (await f.json("/api/doctor/overview?kind=followup&q=TODAY-1")).data;
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].action.tab, "followups");
  await f.json(`/api/reminders/${reminder.id}/complete`, "POST", { status: "completed", note: "已登记反馈" });
  assert.equal((await f.json("/api/doctor/overview")).data.counts.followup, 0);
  await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: p.revision, archived: true });
  assert.equal((await f.json("/api/doctor/overview")).data.total, 1, "archived patient work is not mixed into daily queue");
});

test("doctor agenda pagination counts all reminders beyond legacy first 100", async (t) => {
  const f = await fixture(t, { followupOptions: { autoStart: false } });
  const p = (await f.json("/api/patients", "POST", { name: "批量提醒患者" })).data;
  const job = { id: "synthetic-followup", name: "合成随访", checklist: [] };
  for (let i = 0; i < 125; i++) f.server.followups.createReminder(p, job, String(i));
  const data = (await f.json("/api/doctor/overview?kind=followup&offset=120&limit=10")).data;
  assert.equal(data.counts.followup, 125);
  assert.equal(data.items.length, 5);
  assert.equal(data.hasMore, false);
  assert.equal((await f.json("/api/doctor/overview?kind=missing")).status, 400);
  assert.equal((await f.json("/api/doctor/overview?offset=-1")).status, 400);
});
