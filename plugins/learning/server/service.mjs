import { check } from "../../../server/errors.mjs";
import { HabitLearner } from "./habit-learner.mjs";
import { habitMutation, habitRevision } from "./habit-concurrency.mjs";
import { PersonalContext, learningPrefs, saveLearningPrefs } from "./personal-context.mjs";
import { PersonalRegression } from "./personal-regression.mjs";
import { ReviewLog } from "./review-log.mjs";
import { LearningAutomation } from "./automation.mjs";

const EVENT_TYPES = ["similar-expanded", "similar-collapsed", "similar-disabled", "similar-opened", "references-expanded", "habit-viewed"];

export class LearningService {
  constructor({ store, doctor, pending, bridge, jobs, provider, cases, guidelines, extensions, workspaces, patients, schedule = null, care = () => null, now = Date.now }) {
    this.store = store;
    this.doctor = doctor;
    this.pending = pending;
    this.provider = provider;
    this.cases = cases;
    this.guidelines = guidelines;
    this.extensions = extensions;
    this.workspaces = workspaces;
    this.learner = new HabitLearner(store, doctor);
    this.reviewLog = new ReviewLog(store);
    this.automation = new LearningAutomation(store, { extensions, patients, schedule, sessions: bridge, care, now });
    this.regression = new PersonalRegression({ store, bridge, jobs: jobsProxy(jobs), pending, provider });
    this.context = new PersonalContext({ store, doctor, guidelines, cases, extensions: () => extensions, provider });
    this.ledger = {
      revision: (id) => habitRevision(store.db, id),
      record: (id, decision, snapshot) => { store.db.prepare("INSERT INTO habit_history(habit_id,decision,snapshot,created_at) VALUES (?,?,?,?)").run(id, decision, JSON.stringify(snapshot), new Date(now()).toISOString()); },
      suppress: (id) => { store.db.prepare("UPDATE habit_patterns SET suppressed=1 WHERE memory_id=?").run(id); },
    };
  }
  prefs() { return learningPrefs(this.store.db); }
  savePrefs(input) { return saveLearningPrefs(this.store.db, input); }
  reviewActionPatient(actionId) {
    return this.store.db.prepare("SELECT patient_id FROM review_sessions WHERE action_id=? AND kind='intake' AND superseded=0").get(actionId)?.patient_id;
  }
  eventCursor() {
    return this.store.db.prepare("SELECT COALESCE(MAX(id),0) n FROM learning_events").get().n;
  }
  supersedeIntakeSessions(patientId, sourceSessionId) {
    this.store.db.prepare("UPDATE review_sessions SET patient_id=? WHERE patient_id=? AND superseded=1").run(patientId, sourceSessionId);
  }
  pausedHabits(cursor) {
    return this.store.db.prepare("SELECT subject FROM learning_events WHERE type='habit-paused' AND id>?").all(cursor).map((r) => Number(r.subject));
  }
  events(input) {
    check(EVENT_TYPES.includes(input.type), "INVALID_INPUT", "事件无效");
    this.store.db.prepare("INSERT INTO learning_events(type,subject,data,created_at) VALUES (?,?,?,?)").run(input.type, String(input.subject || "").slice(0, 100), "{}", new Date().toISOString());
    return { ok: true };
  }
  similar(patientId) {
    const p = this.store.db.prepare("SELECT data FROM patients WHERE id=?").get(patientId);
    check(p, "NOT_FOUND", "患者不存在", 404);
    const patient = JSON.parse(p.data);
    const enabled = this.prefs().similarCards;
    const query = patient.diagnoses.map((d) => d.name).join(" ");
    return { enabled, matches: enabled && query ? this.cases().similar({ caseText: query.slice(0, 4000), diagnosis: patient.diagnoses[0]?.name, excludePatientId: patient.id, limit: 3 }).matches.filter((m) => m.score >= 2) : [] };
  }
  changes() {
    return { changes: this.store.db.prepare("SELECT id,habit_id,decision,created_at FROM habit_history ORDER BY id DESC LIMIT 30").all().map((change) => ({ ...change, revision: habitRevision(this.store.db, change.habit_id) })) };
  }
  month() {
    const now = new Date(), start = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(), end = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const learned = this.store.db.prepare("SELECT COUNT(*) n FROM doctor_memories WHERE status='confirmed' AND created_at>=? AND created_at<?").get(start, end).n;
    const stats = this.reviewLog.stats("90d");
    return { show: now.getDate() === 1 && learned > 0, learned, fewerEdits: stats.previousAverage == null ? null : stats.previousAverage - stats.recentAverage };
  }
  exportStats() { return this.reviewLog.stats("365d"); }
  habits() { return { habits: this.doctor.memories().filter((m) => ["confirmed", "paused", "deleted"].includes(m.status)).map((m) => ({ ...m, ledger: this.reviewLog.ledger(m.id) })) }; }
  feedback(input) {
    const action = this.pending.row(input.actionId);
    check(action.payload.personalization?.habits?.some((h) => h.id === input.habitId), "INVALID_INPUT", "此草稿未采用该习惯");
    return this.reviewLog.feedback(input.habitId, input.actionId, "notApplicable");
  }
  stats(range) { return this.reviewLog.stats(range || "90d"); }
  details(section, field) { return { diffs: this.reviewLog.details(section, field) }; }
  clear(input) {
    check(input.confirmed === true, "CONFIRM_REQUIRED", "请确认清空学习记录");
    check(!this.regression.active, "RUN_ACTIVE", "请先停止历史档案评测，再清空学习记录", 409);
    return this.reviewLog.clear({ includeStated: input.includeStated === true });
  }
  habit(id) {
    const memory = this.doctor.memoryRow(Number(id));
    const all = this.store.db.prepare("SELECT id,source FROM doctor_memories").all();
    const descendants = new Set([memory.id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of all) if (!descendants.has(row.id) && descendants.has(JSON.parse(row.source || "{}").replaces)) { descendants.add(row.id); changed = true; }
    }
    const related = this.doctor.memories().filter((m) => ["confirmed", "paused", "deleted"].includes(m.status) && (descendants.has(m.id) || (memory.topic && m.topic === memory.topic)));
    return { ...memory, related };
  }
  decide(id, input) {
    return habitMutation(this.store.db, Number(id), input.decision, input, () => this.learner.decide(Number(id), input.decision, { ...input, requestId: undefined }), { required: true });
  }
  mutateMemory(id, operation, input, execute) {
    return habitMutation(this.store.db, id, operation, input, execute, { required: true });
  }
  consolidateStyle(provider, options) {
    return this.learner.consolidateStyle(provider, options);
  }
  personalContext(run, workspaceId) {
    const prefs = this.prefs();
    const holdout = Boolean(this.workspaces.store.get(workspaceId).learningRegression) || (prefs.pilot && (run.learningHoldout ?? Math.random() < prefs.holdoutRate));
    if (run.learningHoldout === undefined) this.workspaces.store.update(workspaceId, (w) => { w.runs.find((r) => r.id === run.id).learningHoldout = holdout; });
    run.learningHoldout = holdout;
    return {
      build: (notes) => this.context.build(notes, { holdout }),
      modelView: (value) => this.context.modelView(value),
      prepare: (payload, value) => this.context.prepare(payload, value, this.pending),
    };
  }
  start() {
    try { this.regression.cleanupOrphans(); }
    catch (error) { console.warn("[learning] 清理中断评测失败", error?.message); }
    this.automation.start();
  }
  async stop() {
    this.automation.stop();
    await this.regression.stop();
  }
}

function jobsProxy(jobs) {
  return new Proxy({}, {
    get(_target, prop) {
      const value = jobs()[prop];
      return typeof value === "function" ? value.bind(jobs()) : value;
    },
  });
}
