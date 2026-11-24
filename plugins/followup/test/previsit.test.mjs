import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { FollowUpManager } from "../core/followups.mjs";
import { FollowUpSurveys } from "../core/surveys.mjs";
import { PREVISIT_BASE_QUESTIONS, previsitBrief } from "../core/previsit.mjs";

const DAY = 86400000;

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE patients (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE patient_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, channel TEXT NOT NULL, direction TEXT NOT NULL, time TEXT NOT NULL, external_id TEXT UNIQUE, processed INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
    CREATE TABLE reminders (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, kind TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE follow_ups (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, status TEXT NOT NULL, next_due INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE followup_creation_requests (request_id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, fingerprint TEXT NOT NULL, job_id TEXT NOT NULL);
    CREATE TABLE followup_surveys (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, follow_up_id TEXT, data TEXT NOT NULL);
    CREATE TABLE appointments (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO patients VALUES (?,?)").run("p1", JSON.stringify({ id: "p1", name: "测试患者", sessionId: "s1" }));
  db.prepare("INSERT INTO appointments VALUES (?,?,?,?,?)").run("a1", "p1", "2026-01-10", "scheduled", "{}");
  db.prepare("INSERT INTO appointments VALUES (?,?,?,?,?)").run("a2", "p1", "2026-01-02", "attended", "{}");
  db.prepare("INSERT INTO appointments VALUES (?,?,?,?,?)").run("a3", "p1", "2026-01-01", "scheduled", "{}");
  let clock = new Date("2026-01-01T08:00:00").getTime(); // local time, like the due-time rule
  const store = { db, audit() {} };
  const now = () => clock;
  const manager = new FollowUpManager(store, { active: new Set(), provider: null }, { now, autoStart: false });
  manager.surveys = new FollowUpSurveys(store, manager, { now });
  return { db, manager, now, advance: (ms) => { clock += ms; } };
}

test("诊前问卷：按预约排到复诊前一天 9 点，同一预约只排一次，追加病种题", () => {
  const { manager, now } = setup();
  const extra = [{ id: "hypertension_sbp", text: "家庭收缩压", type: "number", unit: "mmHg", required: false }];
  const job = manager.schedulePrevisit("p1", { appointmentId: "a1", extraQuestions: extra });
  assert.equal(job.name, "诊前问卷 · 2026-01-10 复诊");
  assert.equal(job.once, true);
  assert.equal(job.nextDue, new Date("2026-01-09T09:00:00").getTime());
  assert.deepEqual(job.source, { kind: "previsit", appointmentId: "a1", visitDate: "2026-01-10" });
  assert.equal(job.questionnaire.questions.length, PREVISIT_BASE_QUESTIONS.length + 1);
  assert.equal(job.questionnaire.questions.at(-1).id, "hypertension_sbp");

  const again = manager.schedulePrevisit("p1", { appointmentId: "a1" });
  assert.equal(again.id, job.id);
  assert.equal(again.reused, true);
  assert.equal(manager.list("p1").length, 1);

  // 当天的复诊：前一天 9 点已过，一分钟后到期。
  const today = manager.schedulePrevisit("p1", { appointmentId: "a3" });
  assert.equal(today.nextDue, now() + 60000);

  assert.throws(() => manager.schedulePrevisit("p1", { appointmentId: "a2" }), /待到的复诊/);
  assert.throws(() => manager.schedulePrevisit("p1", { appointmentId: "missing" }), /预约不存在/);
});

test("诊前问卷：到期生成带来源的问卷，回收后进入接诊简报，标为患者自述", async () => {
  const { db, manager, now, advance } = setup();
  manager.schedulePrevisit("p1", { appointmentId: "a1" });
  assert.deepEqual(previsitBrief(db, "p1", now()).status, "scheduled");

  advance(8 * DAY + 2 * 3600000); // 2026-01-09 10:00
  await manager.tick();
  await manager.drain();
  const [survey] = manager.surveys.list("p1");
  assert.equal(survey.source.kind, "previsit");
  assert.equal(previsitBrief(db, "p1", now()).status, "pending_send");

  await manager.surveys.send("p1", survey.id, { consent: true, channel: "manual" });
  assert.equal(previsitBrief(db, "p1", now()).status, "sent");
  manager.surveys.collect("p1", survey.id, { answers: [
    { questionId: "goal", value: "最近血压偏高，想调药" },
    { questionId: "change", value: "有一点" },
    { questionId: "meds", value: "一样，但经常漏吃" },
  ] });
  const brief = previsitBrief(db, "p1", now());
  assert.equal(brief.status, "collected");
  assert.equal(brief.visitDate, "2026-01-10");
  assert.match(brief.source, /患者自述/);
  assert.deepEqual(brief.answers[0], { question: PREVISIT_BASE_QUESTIONS[0].text, answer: "最近血压偏高，想调药" });
  assert.equal(brief.answers.length, 3, "未作答的选填题不列出");

  // 复诊过去两天后不再出现在简报里。
  advance(3 * DAY);
  assert.equal(previsitBrief(db, "p1", now()), null);
});
