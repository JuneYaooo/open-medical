import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

async function setup(t) {
  let now = Date.now();
  const f = await fixture(t, {
    followupOptions: { now: () => now, autoStart: false },
  });
  const patient = (
    await f.json("/api/patients", "POST", { name: "随访闭环测试" })
  ).data;
  const job = (
    await f.json(`/api/patients/${patient.id}/followups`, "POST", {
      name: "复诊反馈",
      once: true,
      firstDueAt: new Date(now + 60000).toISOString(),
      checklist: ["核对反馈", "核对材料"],
    })
  ).data;
  now += 60001;
  await f.server.followups.tick();
  const reminder = (await f.json(`/api/reminders?patientId=${patient.id}`)).data
    .reminders[0];
  assert.ok(reminder);
  assert.equal(
    f.server.followups.row(job.id).status,
    "completed",
    "scheduler completion is not clinical completion",
  );
  return { ...f, patient, reminder, now };
}

test("follow-up outcome, next reminder, patient history and replay protection", async (t) => {
  const f = await setup(t);
  const payload = {
    status: "unreachable",
    note: "电话未接，明日再次联系。",
    checkedItems: [],
    nextDueAt: new Date(f.now + 86400000).toISOString(),
  };
  const saved = await f.json(
    `/api/reminders/${f.reminder.id}/complete`,
    "POST",
    payload,
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.data.outcome.status, "unreachable");
  assert.ok(saved.data.outcome.nextFollowUpId);
  assert.equal(
    f.server.followups.row(saved.data.outcome.nextFollowUpId).externalConsent,
    false,
  );
  assert.equal(
    (await f.json(`/api/reminders?patientId=${f.patient.id}`)).data.reminders
      .length,
    0,
  );
  const history = (
    await f.json(`/api/reminders?status=done&patientId=${f.patient.id}`)
  ).data.reminders;
  assert.equal(history[0].outcome.note, payload.note);
  assert.equal(
    (await f.json(`/api/reminders/${f.reminder.id}/complete`, "POST", payload))
      .status,
    409,
  );
  assert.equal(f.server.followups.list(f.patient.id).length, 2);
  const other = (await f.json("/api/patients", "POST", { name: "另一患者" }))
    .data;
  assert.equal(
    (await f.json(`/api/reminders?status=done&patientId=${other.id}`)).data
      .reminders.length,
    0,
  );
});

test("invalid follow-up results leave reminders pending; acknowledged reminders can be completed", async (t) => {
  const f = await setup(t);
  const path = `/api/reminders/${f.reminder.id}/complete`;
  for (const payload of [
    null,
    {},
    { status: "completed", note: " " },
    { status: "completed", note: "记录", checkedItems: ["捏造条目"] },
    { status: "completed", note: "记录", nextDueAt: "2020-01-01" },
  ]) {
    assert.equal((await f.json(path, "POST", payload)).status, 400);
  }
  assert.equal(f.server.followups.list(f.patient.id).length, 1);
  assert.equal(
    (await f.json(`/api/reminders?patientId=${f.patient.id}`)).data.reminders
      .length,
    1,
  );
  await f.json(`/api/reminders/${f.reminder.id}/ack`, "POST");
  assert.equal(
    (
      await f.json(path, "POST", {
        status: "completed",
        note: "已核实患者反馈。",
        checkedItems: ["核对反馈"],
      })
    ).status,
    200,
  );
});

test("pending fired reminders remain visible to overdue risk rules after schedule advances", async (t) => {
  const f = await setup(t);
  const old = Date.now() - 9 * 86400000;
  f.server.store.db
    .prepare("UPDATE reminders SET due_at=? WHERE id=?")
    .run(old, f.reminder.id);
  f.server.risks.evaluatePatient(f.patient.id);
  assert.ok(
    f.server.risks
      .list({ patientId: f.patient.id, status: "active" })
      .some((a) => a.ruleKey === `followup_pending_${f.reminder.id}`),
  );
  await f.json(`/api/reminders/${f.reminder.id}/complete`, "POST", {
    status: "completed",
    note: "已完成核对。",
  });
  assert.equal(
    f.server.risks.list({ patientId: f.patient.id, status: "active" }).length,
    0,
  );
});

test("follow-up result and next plan roll back together if audit persistence fails", async (t) => {
  const f = await setup(t);
  const audit = f.server.store.audit.bind(f.server.store);
  f.server.store.audit = (sessionId, type, data) => {
    if (type === "followup.recorded")
      throw new Error("simulated persistence failure");
    return audit(sessionId, type, data);
  };
  assert.throws(
    () =>
      f.server.followups.completeReminder(f.reminder.id, {
        status: "completed",
        note: "事务测试",
        nextDueAt: new Date(f.now + 86400000).toISOString(),
      }),
    /persistence failure/,
  );
  f.server.store.audit = audit;
  assert.equal(f.server.followups.list(f.patient.id).length, 1);
  const pending = f.server.followups.reminders({ patientId: f.patient.id });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].outcome, undefined);
});
