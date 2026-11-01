import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { FollowUpManager } from "../core/followups.mjs";
import { followupAgendaSources } from "../agenda.mjs";
import { careTasksAgendaSources } from "../../care-tasks/agenda.mjs";

const DAY = 86400000;

// Minimal in-memory store: only the tables FollowUpManager touches here.
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE patients (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE patient_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, channel TEXT NOT NULL, direction TEXT NOT NULL, time TEXT NOT NULL, external_id TEXT UNIQUE, processed INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
    CREATE TABLE reminders (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, kind TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE follow_ups (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, status TEXT NOT NULL, next_due INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE followup_creation_requests (request_id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, fingerprint TEXT NOT NULL, job_id TEXT NOT NULL);
    CREATE TABLE followup_surveys (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, follow_up_id TEXT, data TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO patients VALUES (?,?)").run("p1", JSON.stringify({ id: "p1", name: "测试患者", sessionId: "s1", treatmentPlan: { status: "active", reviewDate: "2026-01-10" } }));
  let clock = Date.parse("2026-01-01T09:00:00+08:00");
  const store = { db, audit() {} };
  const manager = new FollowUpManager(store, { active: new Set(), provider: null }, { now: () => clock, autoStart: false });
  return { db, manager, advance: (ms) => { clock += ms; }, now: () => clock };
}

const pending = (db) => db.prepare("SELECT id, due_at, data FROM reminders WHERE status='pending'").all();

test("周期随访连续到期未登记时只保留一条待登记提醒", async () => {
  const { db, manager, advance } = setup();
  const job = manager.create("p1", { name: "血压随访", intervalDays: 7, firstDueAt: new Date(Date.parse("2026-01-01T10:00:00+08:00")).toISOString(), checklist: ["家庭血压"] });
  advance(2 * 3600000);
  await manager.tick();
  await manager.drain();
  const [first] = pending(db);
  assert.ok(first, "第一次到期应生成提醒");
  advance(7 * DAY);
  await manager.tick();
  await manager.drain();
  const rows = pending(db);
  assert.equal(rows.length, 1, "第二次到期不应再叠加一条提醒");
  assert.equal(rows[0].id, first.id, "沿用同一条提醒，id 不变");
  assert.ok(rows[0].due_at > first.due_at, "到期时间更新为本次");
  const data = JSON.parse(rows[0].data);
  assert.equal(data.missedOccurrences, 1);
  assert.match(data.detail, /之前 1 次到期尚未登记/);
  assert.equal(data.reused, undefined, "内部标记不写入数据库");
  assert.equal(manager.row(job.id).history.at(-1).status, "completed");

  // 登记之后再到期，重新生成新的提醒。
  manager.completeReminder(first.id, { status: "completed", note: "", checkedItems: ["家庭血压"] });
  advance(7 * DAY);
  await manager.tick();
  await manager.drain();
  const after = pending(db);
  assert.equal(after.length, 1);
  assert.notEqual(after[0].id, first.id);
});

test("已完成联系且勾选核对条目时文字记录可不填；否则仍须填写", () => {
  const { db, manager } = setup();
  const insert = (id) => db.prepare("INSERT INTO reminders VALUES (?,?,?,?,?,?)").run(id, "p1", "followup", Date.now(), "pending", JSON.stringify({ id, patientId: "p1", followUpId: "f", title: "随访", checklist: ["家庭血压", "服药"], sessionId: "s1" }));
  insert("r1"); insert("r2"); insert("r3");
  const done = manager.completeReminder("r1", { status: "completed", checkedItems: ["家庭血压"] });
  assert.equal(done.outcome.note, "");
  assert.throws(() => manager.completeReminder("r2", { status: "completed", checkedItems: [] }), /随访记录/);
  assert.throws(() => manager.completeReminder("r3", { status: "unreachable", noRetryReason: "原计划继续", checkedItems: [] }), /随访记录/);
});

test("推迟随访提醒：到期前不进今日待办，同一请求重复提交不重复推迟", () => {
  const { db, manager, advance, now } = setup();
  db.prepare("INSERT INTO reminders VALUES (?,?,?,?,?,?)").run("r1", "p1", "followup", now() - 3 * DAY, "pending", JSON.stringify({ id: "r1", patientId: "p1", followUpId: null, title: "随访：血压", checklist: [], sessionId: "s1" }));
  const source = followupAgendaSources.find((item) => item.kind === "followup");
  const ctx = { db };
  const [before] = source.read(ctx, { now: now() });
  assert.equal(before.weight, 1, "逾期提醒排在最前");
  assert.match(before.detail, /已逾期 3 天/);
  const first = manager.snoozeReminder("r1", { days: 3, requestId: "req1" });
  advance(60000);
  const again = manager.snoozeReminder("r1", { days: 3, requestId: "req1" });
  assert.equal(again.dueAt, first.dueAt, "同一请求不重复推迟");
  assert.throws(() => manager.snoozeReminder("r1", { days: 7, requestId: "req1" }), /天数不同/);
  assert.throws(() => manager.snoozeReminder("r1", { days: 0 }), /1–30/);
  assert.equal(source.read(ctx, { now: now() }).length, 0, "推迟期间不在今日待办");
  advance(3 * DAY);
  assert.equal(source.read(ctx, { now: now() }).length, 1, "到期后重新出现");
});

test("逾期的随访计划与提醒同等排序；来自复评日期的随访带 covers", () => {
  const { db, manager, now } = setup();
  const job = manager.create("p1", { name: "方案复评随访", once: true, firstDueAt: new Date(now() + 60000).toISOString(), source: { kind: "treatment-review", reviewDate: "2026-01-10" } });
  db.prepare("UPDATE follow_ups SET next_due=? WHERE id=?").run(now() - 2 * DAY, job.id);
  const source = followupAgendaSources.find((item) => item.kind === "followup");
  const [item] = source.read({ db }, { now: now() });
  assert.equal(item.id, `schedule:${job.id}`);
  assert.equal(item.weight, 1);
  assert.match(item.detail, /已逾期 2 天/);
  assert.equal(item.covers, "plan-review:p1:2026-01-10");
});

test("检查检验等结果逾期：同样显示逾期天数并排到最前", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE care_tasks (id TEXT PRIMARY KEY, patient_id TEXT, status TEXT, due_at INTEGER, data TEXT)");
  const now = Date.parse("2026-01-10T09:00:00+08:00");
  db.prepare("INSERT INTO care_tasks VALUES (?,?,?,?,?)").run("t1", "p1", "waiting_result", now - 4 * DAY, JSON.stringify({ title: "复查肾功能" }));
  db.prepare("INSERT INTO care_tasks VALUES (?,?,?,?,?)").run("t2", "p1", "waiting_result", now - 3600000, JSON.stringify({ title: "复查血钾" }));
  const items = careTasksAgendaSources[0].read({ db }, { now });
  const late = items.find((item) => item.id === "tracking:t1");
  const fresh = items.find((item) => item.id === "tracking:t2");
  assert.equal(late.weight, 1);
  assert.match(late.detail, /^已逾期 4 天，/);
  assert.equal(fresh.weight, 5);
  assert.doesNotMatch(fresh.detail, /逾期/);
});
