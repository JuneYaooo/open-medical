import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PatientSchedule } from "../../server/medical/patient-schedule.mjs";
import { lostPatients } from "../../server/medical/lost-followup.mjs";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE patients (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  const put = (id, data) => db.prepare("INSERT INTO patients VALUES (?,?)").run(id, JSON.stringify({ id, ...data }));
  const patients = {
    all: () => db.prepare("SELECT data FROM patients").all().map((row) => JSON.parse(row.data)),
    row: (id) => JSON.parse(db.prepare("SELECT data FROM patients WHERE id=?").get(id).data),
  };
  let today = "2026-01-05";
  const schedule = new PatientSchedule({ db, audit() {} }, patients, { now: () => Date.parse(`${today}T07:00:00`) });
  return { db, put, schedule, setToday: (d) => { today = d; } };
}

test("lostPatients：未到诊且未再约、超过 N 天未复诊且无随访，两类都列出", () => {
  const { put, schedule, setToday } = setup();
  put("missed", { name: "未到" });
  put("old", { name: "久未来", visits: [{ date: "2026-01-01" }] });
  put("recent", { name: "近期", visits: [{ date: "2026-05-01" }] });
  put("booked", { name: "已再约", visits: [{ date: "2026-01-01" }] });
  put("followed", { name: "有随访", visits: [{ date: "2026-01-01" }] });
  put("reminded", { name: "有提醒", visits: [{ date: "2026-01-01" }] });
  put("archived", { name: "归档", archived: true, visits: [{ date: "2025-01-01" }] });
  put("rebooked", { name: "未到后已约" });
  put("blank", { name: "无记录" });

  const missed = schedule.create("missed", { date: "2026-05-10" });
  const missed2 = schedule.create("rebooked", { date: "2026-05-10" });
  setToday("2026-05-10");
  schedule.update(missed.id, { status: "missed" });
  schedule.update(missed2.id, { status: "missed" });
  schedule.create("rebooked", { date: "2026-06-20" });
  schedule.create("booked", { date: "2026-06-20" });
  setToday("2026-06-01");

  // 随访插件提供「有进行中随访或待处理提醒」的患者。
  const result = lostPatients(schedule, { busyPatientIds: () => ["followed", "reminded"] });
  assert.equal(result.days, 90);
  assert.deepEqual(result.patients.map((p) => [p.patientId, p.reason, p.lastDate]), [
    ["old", "overdue", "2026-01-01"],
    ["missed", "missed", "2026-05-10"],
  ]);
  assert.equal(result.patients[0].daysSince, 151);
  assert.equal(result.patients[0].patientName, "久未来");

  // 阈值调小后近期患者也算失访。
  assert.ok(lostPatients(schedule, { days: 30 }).patients.some((p) => p.patientId === "recent"));
  assert.throws(() => lostPatients(schedule, { days: "abc" }), /天数/);
});

test("lostPatients：未到诊之后又来就诊，按最近就诊日期判断", () => {
  const { put, schedule, setToday } = setup();
  put("p", { name: "补来", visits: [{ date: "2026-05-20" }] });
  const a = schedule.create("p", { date: "2026-05-10" });
  setToday("2026-05-10");
  schedule.update(a.id, { status: "missed" });
  setToday("2026-06-01");
  assert.equal(lostPatients(schedule).patients.length, 0);
  setToday("2026-09-01");
  assert.deepEqual(lostPatients(schedule).patients.map((p) => [p.reason, p.lastDate]), [["overdue", "2026-05-20"]]);
});

test("HTTP：/api/appointments 按日期范围列出全部患者预约，/api/patients-lost 列出失访患者", async (t) => {
  const { createScriptedProvider } = await import("../helpers/scripted-provider.mjs");
  const { startTestServer } = await import("../helpers/server.mjs");
  const app = await startTestServer({ provider: createScriptedProvider([]), seedDemoPack: false });
  t.after(() => app.close());
  const created = await app.request("/api/patients", { method: "POST", body: { name: "张三", visits: [{ date: "2020-01-01", reason: "复诊" }] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const lost = await app.request("/api/patients-lost?days=90");
  assert.equal(lost.status, 200);
  assert.deepEqual(lost.body.patients.map((p) => [p.patientName, p.reason]), [["张三", "overdue"]]);
  const d = new Date(); d.setDate(d.getDate() + 1);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.equal((await app.request(`/api/patients/${created.body.id}/appointments`, { method: "POST", body: { date: day } })).status, 201);
  const range = await app.request(`/api/appointments?from=${day}&to=${day}`);
  assert.equal(range.status, 200);
  assert.deepEqual(range.body.appointments.map((a) => a.patientName), ["张三"]);
  assert.equal((await app.request("/api/appointments?from=bad&to=x")).status, 400);
  assert.equal((await app.request("/api/patients-lost")).body.patients.length, 0);
});
