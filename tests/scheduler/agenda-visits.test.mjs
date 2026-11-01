import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PatientSchedule } from "../../server/medical/patient-schedule.mjs";
import { DoctorOverview } from "../../server/medical/doctor-overview.mjs";

// In-memory store with just enough of the patients service for scheduling.
function setup(today = "2026-03-10") {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE patients (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE pending_actions (id TEXT PRIMARY KEY, patient_id TEXT, summary TEXT, status TEXT, created_at INTEGER);
  `);
  const put = (id, data) => db.prepare("INSERT INTO patients VALUES (?,?)").run(id, JSON.stringify({ id, ...data }));
  put("p1", { name: "甲", treatmentPlan: { status: "active", reviewDate: today, title: "降压方案" } });
  put("p2", { name: "乙" });
  put("p3", { name: "丙", archived: true });
  const patients = {
    all: () => db.prepare("SELECT data FROM patients").all().map((row) => JSON.parse(row.data)),
    row: (id) => {
      const row = db.prepare("SELECT data FROM patients WHERE id=?").get(id);
      if (!row) throw new Error("患者不存在");
      return JSON.parse(row.data);
    },
  };
  const store = { db, audit() {} };
  const now = () => Date.parse(`${today}T07:00:00`);
  const schedule = new PatientSchedule(store, patients, { now });
  return { db, store, schedule, now, put };
}

test("PatientSchedule.range：跨患者按日期列出，同日有时间的在前，排除归档与取消", () => {
  const { db, schedule } = setup();
  const a = schedule.create("p1", { date: "2026-03-10" });
  schedule.create("p2", { date: "2026-03-10", time: "14:30" });
  schedule.create("p2", { date: "2026-03-10", time: "09:00" });
  schedule.create("p1", { date: "2026-03-12", time: "08:00" });
  schedule.create("p1", { date: "2026-03-20" });
  const cancelled = schedule.create("p2", { date: "2026-03-11" });
  schedule.update(cancelled.id, { status: "cancelled" });
  // Archived patient's appointment, inserted directly.
  db.exec(`INSERT INTO appointments VALUES ('x','p3','2026-03-11','scheduled','${JSON.stringify({ id: "x", patientId: "p3", date: "2026-03-11", time: null, status: "scheduled" })}')`);
  const week = schedule.range("2026-03-10", "2026-03-16");
  assert.deepEqual(week.appointments.map((item) => [item.date, item.time, item.patientName]), [
    ["2026-03-10", "09:00", "乙"],
    ["2026-03-10", "14:30", "乙"],
    ["2026-03-10", null, "甲"],
    ["2026-03-12", "08:00", "甲"],
  ]);
  assert.equal(week.appointments[2].id, a.id);
  assert.equal(schedule.range("2026-03-11", "2026-03-11", { includeCancelled: true }).appointments.length, 1);
  assert.throws(() => schedule.range("2026-03-16", "2026-03-10"), /日期范围/);
  assert.throws(() => schedule.range("2026-01-01", "2027-03-01"), /一年/);
});

test("今日待办：未定时间的复诊排在定时复诊之后，带时间与预约版本；复评生成的随访不重复出现", () => {
  const { store, schedule, now } = setup();
  const untimed = schedule.create("p1", { date: "2026-03-10" });
  const timed = schedule.create("p2", { date: "2026-03-10", time: "15:00" });
  const pluginRows = [
    { id: "schedule:f1", kind: "followup", patientId: "p1", title: "复评随访", detail: "", at: now(), weight: 5, covers: "plan-review:p1:2026-03-10" },
    { id: "schedule:f2", kind: "followup", patientId: "p2", title: "普通随访", detail: "", at: now(), weight: 5, covers: "plan-review:p2:2026-03-10" },
  ];
  const overview = new DoctorOverview(store, { list: () => [] }, {
    schedule,
    agendaSources: () => [{ kind: "followup", label: "随访", order: 30 }],
    agendaItems: () => pluginRows,
  });
  const result = overview.read({ now: now(), limit: 100 });
  const visits = result.items.filter((item) => item.kind === "visit");
  assert.deepEqual(visits.map((item) => item.id), [`visit:${timed.id}`, `visit:${untimed.id}`]);
  assert.equal(visits[0].time, "15:00");
  assert.equal(visits[1].time, "");
  assert.equal(visits[0].appointmentId, timed.id);
  assert.equal(visits[0].revision, 0);
  const ids = result.items.map((item) => item.id);
  assert.ok(ids.includes("plan-review:p1:2026-03-10"));
  assert.ok(!ids.includes("schedule:f1"), "与方案复评同一件事的随访不再单独列出");
  assert.ok(ids.includes("schedule:f2"), "没有对应复评行时随访照常显示");
  assert.ok(result.items.every((item) => !("covers" in item)), "covers 不出现在对外行数据里");
});
