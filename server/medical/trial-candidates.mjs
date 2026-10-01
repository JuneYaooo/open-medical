import { randomUUID } from "node:crypto";
import { check, identifier, string } from "../errors.mjs";
import { sqliteTransaction } from "../sqlite-transaction.mjs";
import { isCalendarDate, localCalendarDate } from "../../shared/calendar-date.mjs";

// Trial-wide work on top of per-patient screening: a deterministic
// pre-filter, queued AI screening for many patients, the candidate list and
// the enrollment pipeline. The model only drafts per-criterion judgements;
// eligibility and enrollment are always recorded by the doctor.
export const STAGES = Object.freeze({
  none: "未处理", shortlisted: "拟邀请", contacted: "已联系", consented: "已签知情同意",
  enrolled: "已入组", declined: "患者拒绝", ineligible: "不符合", withdrawn: "已退出",
});
const GENERIC = new Set(["患者", "病史", "诊断", "治疗", "术后", "疾病", "慢性", "急性", "病变", "其他", "未分", "综合", "检查", "异常", "伴有", "合并"]);
const bigrams = (text) => {
  const out = new Set();
  for (const run of String(text || "").match(/[一-鿿]{2,}/g) || [])
    for (let i = 0; i < run.length - 1; i++) { const b = run.slice(i, i + 2); if (!GENERIC.has(b)) out.add(b); }
  for (const word of String(text || "").toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []) out.add(word);
  return out;
};
const year = (now) => new Date(now).getFullYear();

// Age and sex limits stated in the inclusion criteria, e.g. "18–75 岁", "年龄≥18岁", "女性".
export function parseLimits(criteria) {
  const limits = { minAge: null, maxAge: null, sex: null, sources: [] };
  for (const c of criteria.filter((x) => x.kind === "include")) {
    const t = c.text.replace(/\s+/g, "");
    let m;
    if ((m = t.match(/(\d{1,3})(?:周?岁)?[-–—~～至到](\d{1,3})(?:周)?岁/)) || (m = t.match(/aged?(\d{1,3})(?:-|to)(\d{1,3})/i))) {
      limits.minAge = Number(m[1]); limits.maxAge = Number(m[2]); limits.sources.push(c.text);
    } else {
      if ((m = t.match(/(?:年龄)?(?:≥|>=|大于等于|不小于)(\d{1,3})岁?/) || t.match(/(\d{1,3})岁(?:及|或)?以上/) || t.match(/(?:≥|>=)(\d{1,3})years/i))) { limits.minAge = Number(m[1]); limits.sources.push(c.text); }
      if ((m = t.match(/(?:年龄)?(?:≤|<=|小于等于|不大于|不超过)(\d{1,3})岁/) || t.match(/(\d{1,3})岁(?:及|或)?以下/))) { limits.maxAge = Number(m[1]); limits.sources.push(c.text); }
    }
    const female = /女性|女患者|female|women/i.test(t), male = /男性|男患者|\bmale\b|\bmen\b/i.test(t);
    if (female !== male && !/男女|男性或女性|女性或男性|性别不限/.test(t)) { limits.sex = female ? "female" : "male"; limits.sources.push(c.text); }
  }
  return limits;
}

// Explainable pre-filter from the chart only: hard limits exclude, diagnosis overlap ranks.
export function prefilter(trial, patient, now = Date.now()) {
  const limits = parseLimits(trial.criteria), reasons = [], warnings = [];
  let mismatch = false;
  if (patient.birthYear && (limits.minAge !== null || limits.maxAge !== null)) {
    const age = year(now) - Number(patient.birthYear);
    // birthYear alone gives the age within one year.
    if (limits.minAge !== null && age + 1 < limits.minAge) { mismatch = true; reasons.push(`约 ${age} 岁，低于 ${limits.minAge} 岁`); }
    else if (limits.maxAge !== null && age - 1 > limits.maxAge) { mismatch = true; reasons.push(`约 ${age} 岁，超过 ${limits.maxAge} 岁`); }
    else reasons.push(`年龄约 ${age} 岁，在范围内`);
  } else if (limits.minAge !== null || limits.maxAge !== null) warnings.push("档案缺出生年份，年龄待核对");
  if (limits.sex && patient.gender && patient.gender !== limits.sex) { mismatch = true; reasons.push(`方案限${limits.sex === "female" ? "女性" : "男性"}`); }
  const includeText = [trial.title, ...trial.criteria.filter((c) => c.kind === "include").map((c) => c.text)].join("\n");
  const excludeText = trial.criteria.filter((c) => c.kind === "exclude").map((c) => c.text).join("\n");
  const wanted = bigrams(includeText);
  let score = 0;
  const terms = [...(patient.diagnoses || []).map((d) => d.name), ...(patient.tags || []), ...(patient.groups || [])].filter(Boolean);
  for (const term of terms) {
    const grams = [...bigrams(term)];
    if (!grams.length) continue;
    const hit = grams.filter((g) => wanted.has(g));
    if (includeText.includes(term) || hit.length >= 2 || (grams.length === 1 && hit.length === 1)) {
      score += includeText.includes(term) ? 3 : hit.length >= 2 ? 2 : 1;
      if (reasons.length < 6) reasons.push(`「${term}」与入选条件相关`);
    }
    if (term.length >= 2 && excludeText.includes(term)) warnings.push(`「${term}」出现在排除条件中`);
  }
  for (const m of (patient.medications || []).filter((x) => x.status !== "stopped" && x.name)) if (excludeText.includes(m.name)) warnings.push(`正在使用「${m.name}」，排除条件提到该药`);
  const status = mismatch ? "mismatch" : score >= 2 ? "likely" : score ? "possible" : "unclear";
  return { status, score, reasons, warnings: warnings.slice(0, 4) };
}

export class TrialCandidates {
  constructor({ store, patients, trials, jobs, now = Date.now }) {
    Object.assign(this, { store, patients, trials, jobs, now });
    this.db = store.db;
    this.runners = new Map();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trial_enrollments(trial_id TEXT NOT NULL, patient_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(trial_id, patient_id));
      CREATE TABLE IF NOT EXISTS trial_batches(id TEXT PRIMARY KEY, trial_id TEXT NOT NULL, data TEXT NOT NULL);
    `);
    for (const b of this.batches().filter((x) => x.status === "running"))
      this.writeBatch({ ...b, status: "interrupted", detail: "应用重启，批量初筛已暂停；再次开始会跳过已完成的患者。" });
  }
  iso() { return new Date(this.now()).toISOString(); }

  // ---------- enrollment ----------
  enrollment(trialId, patientId) {
    const row = this.db.prepare("SELECT data FROM trial_enrollments WHERE trial_id=? AND patient_id=?").get(trialId, patientId);
    return row ? JSON.parse(row.data) : { trialId, patientId, stage: "none", revision: 0, note: "", consentDate: null, history: [] };
  }
  normalizeEnrollment(trialId, patientId, input = {}) {
    this.trials.get(identifier(trialId));
    const patient = this.patients.row(identifier(patientId));
    check(STAGES[input.stage], "INVALID_INPUT", `入组状态须为：${Object.keys(STAGES).join("/")}`);
    const current = this.enrollment(trialId, patientId);
    const note = input.note ? string(input.note, "备注", 1000) : "";
    let consentDate = current.consentDate;
    if (input.stage === "consented") {
      check(isCalendarDate(input.consentDate), "CONSENT_REQUIRED", "请填写有效的知情同意书签署日期（YYYY-MM-DD）");
      check(input.consentDate <= localCalendarDate(this.now()), "INVALID_INPUT", "签署日期不能晚于今天");
      consentDate = input.consentDate;
    }
    if (input.stage === "enrolled") {
      check(current.stage === "consented" || current.history.some((h) => h.stage === "consented"), "CONSENT_REQUIRED", "尚未登记知情同意，不能标记为已入组", 409);
      const review = this.trials.screening(trialId, patientId);
      check(review.revision > 0, "TRIAL_REVIEW_REQUIRED", "请先完成并保存医生逐项核对", 409);
      check(!review.conflicts, "TRIAL_REVIEW_REQUIRED", "医生核对中仍有条件冲突，不能标记入组", 409);
      check(!review.missing || note, "TRIAL_REVIEW_REQUIRED", `医生核对仍有 ${review.missing} 项待补资料；如研究团队已确认，请在备注中说明`, 409);
    }
    if (input.stage === "withdrawn") check(["consented", "enrolled"].includes(current.stage), "INVALID_INPUT", "只有已签同意或已入组的患者可以标记退出", 409);
    check(!patient.archived || ["withdrawn", "declined", "ineligible"].includes(input.stage), "PATIENT_ARCHIVED", "已归档患者不能进入入组流程", 409);
    return { trialId, patientId: patient.id, stage: input.stage, note, consentDate, expectedRevision: input.expectedRevision ?? current.revision };
  }
  setEnrollment(trialId, patientId, input = {}) {
    return sqliteTransaction(this.db, () => {
      const value = this.normalizeEnrollment(trialId, patientId, input);
      const current = this.enrollment(value.trialId, value.patientId);
      check(value.expectedRevision === current.revision, "REVISION_CONFLICT", "入组状态已被修改，请刷新后重试", 409);
      const item = {
        trialId: value.trialId, patientId: value.patientId, stage: value.stage, note: value.note, consentDate: value.consentDate,
        revision: current.revision + 1, updatedAt: this.iso(),
        history: [...current.history, ...(current.revision ? [{ stage: current.stage, note: current.note, consentDate: current.consentDate, updatedAt: current.updatedAt }] : [])].slice(-50),
      };
      this.db.prepare("INSERT INTO trial_enrollments VALUES (?,?,?) ON CONFLICT(trial_id,patient_id) DO UPDATE SET data=excluded.data").run(item.trialId, item.patientId, JSON.stringify(item));
      this.store.audit(null, "trial.enrollment.changed", { trialId: item.trialId, patientId: item.patientId, from: current.stage, to: item.stage, revision: item.revision });
      return item;
    });
  }

  // ---------- candidates ----------
  latestJobs(trialId) {
    const map = new Map();
    for (const job of this.jobs.list(trialId)) if (!map.has(job.patientId)) map.set(job.patientId, job);
    return map;
  }
  aiSummary(job) {
    if (!job) return null;
    try {
      const p = this.jobs.public(job);
      return { jobId: p.id, status: p.status, conflicts: p.conflicts, missing: p.missing, checked: p.checks.length, total: p.total, stale: p.stale, screeningDate: p.screeningDate, updatedAt: p.updatedAt, error: p.error || "" };
    } catch { return null; }
  }
  // One sentence telling the doctor what to do with this patient next.
  next(c) {
    const stage = c.enrollment.stage;
    if (stage === "enrolled") return "已入组";
    if (["declined", "ineligible", "withdrawn"].includes(stage)) return "已结束";
    if (stage === "consented") return "确认入组";
    if (stage === "contacted") return "登记知情同意";
    if (stage === "shortlisted") return "联系患者说明研究";
    if (c.review) {
      if (c.review.conflicts) return "存在条件冲突，可标记不符合";
      if (c.review.missing) return `补充 ${c.review.missing} 项资料`;
      return "可邀请入组";
    }
    if (c.ai?.status === "running") return "AI 初筛中";
    if (c.ai?.status === "completed" && !c.ai.stale) return c.ai.conflicts ? "AI 发现冲突，请医生核对" : "AI 初筛完成，请医生核对";
    if (c.prefilter.status === "mismatch") return "预筛不符，一般无需初筛";
    return c.prefilter.status === "unclear" ? "资料不足，可 AI 初筛" : "建议 AI 初筛";
  }
  candidates(trialId, { stage, status } = {}) {
    const trial = this.trials.get(identifier(trialId));
    const jobs = this.latestJobs(trial.id);
    const reviews = new Map(this.db.prepare("SELECT patient_id, data FROM trial_screenings WHERE trial_id=?").all(trial.id).map((r) => [r.patient_id, JSON.parse(r.data)]));
    const enrollments = new Map(this.db.prepare("SELECT patient_id, data FROM trial_enrollments WHERE trial_id=?").all(trial.id).map((r) => [r.patient_id, JSON.parse(r.data)]));
    const list = [];
    for (const p of this.patients.all()) {
      const enrollment = enrollments.get(p.id) || this.enrollment(trial.id, p.id);
      if (p.archived && enrollment.stage === "none") continue;
      const r = reviews.get(p.id);
      const c = {
        patientId: p.id, name: p.name, patientNumber: p.patientNumber || "", gender: p.gender || null, birthYear: p.birthYear || null,
        diagnoses: (p.diagnoses || []).slice(0, 3).map((d) => d.name), archived: Boolean(p.archived),
        prefilter: prefilter(trial, p, this.now()), ai: this.aiSummary(jobs.get(p.id)),
        review: r?.revision ? { revision: r.revision, summary: r.summary, conflicts: r.conflicts, missing: r.missing, updatedAt: r.updatedAt, stale: r.patientRevision !== p.revision } : null,
        enrollment: { stage: enrollment.stage, label: STAGES[enrollment.stage], revision: enrollment.revision, note: enrollment.note, consentDate: enrollment.consentDate, updatedAt: enrollment.updatedAt || null },
      };
      c.next = this.next(c);
      list.push(c);
    }
    const rank = (c) => {
      const s = c.enrollment.stage;
      if (["consented", "contacted", "shortlisted"].includes(s)) return 0;
      if (c.ai?.status === "completed" && !c.review) return 1;
      if (c.review && !c.review.conflicts && s === "none") return 2;
      if (c.ai?.status === "running") return 3;
      if (s === "enrolled") return 4;
      if (s === "none" && c.prefilter.status === "likely") return 5;
      if (s === "none" && c.prefilter.status === "possible") return 6;
      if (s === "none" && c.prefilter.status === "unclear") return 7;
      return 8;
    };
    list.sort((a, b) => rank(a) - rank(b) || b.prefilter.score - a.prefilter.score || a.name.localeCompare(b.name));
    const counts = { total: list.length, stages: Object.fromEntries(Object.keys(STAGES).map((k) => [k, list.filter((c) => c.enrollment.stage === k).length])),
      prefilter: Object.fromEntries(["likely", "possible", "unclear", "mismatch"].map((k) => [k, list.filter((c) => c.prefilter.status === k).length])),
      aiDone: list.filter((c) => c.ai?.status === "completed").length, awaitingReview: list.filter((c) => c.ai?.status === "completed" && !c.review).length };
    const filtered = list.filter((c) => (!stage || String(stage).split(",").includes(c.enrollment.stage)) && (!status || String(status).split(",").includes(c.prefilter.status)));
    const suggested = list.filter((c) => ["likely", "possible"].includes(c.prefilter.status) && !c.archived && c.enrollment.stage === "none" && !c.review && (!c.ai || c.ai.stale || !["completed", "running"].includes(c.ai.status))).map((c) => c.patientId);
    return { suggested, trial: { id: trial.id, title: trial.title, registration: trial.registration, recruitment: trial.recruitment, criteria: trial.criteria.length, limits: parseLimits(trial.criteria) }, candidates: filtered, counts, batch: this.batch(trial.id) };
  }

  // ---------- batch AI screening ----------
  batches(trialId) {
    return this.db.prepare(`SELECT data FROM trial_batches ${trialId ? "WHERE trial_id=?" : ""} ORDER BY rowid DESC`).all(...(trialId ? [trialId] : [])).map((r) => JSON.parse(r.data));
  }
  batch(trialId) { return this.batches(trialId)[0] || null; }
  writeBatch(b) { b.updatedAt = this.iso(); this.db.prepare("INSERT INTO trial_batches VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(b.id, b.trialId, JSON.stringify(b)); return b; }
  // Patients the batch dialog preselects: pre-filter match, no current AI result, not closed.
  suggestedBatch(trialId) {
    return this.candidates(trialId).suggested;
  }
  normalizeBatch(trialId, input = {}) {
    const trial = this.trials.get(identifier(trialId));
    check(input.externalConsent === true, "CONSENT_REQUIRED", "请确认同意把所选患者资料交给当前配置的模型分析", 412);
    const ids = Array.isArray(input.patientIds) && input.patientIds.length ? input.patientIds : this.suggestedBatch(trial.id);
    check(ids.length >= 1 && ids.length <= 50, "INVALID_INPUT", ids.length ? "一次最多批量初筛 50 位患者" : "没有需要初筛的患者");
    const patientIds = [...new Set(ids.map((id) => this.patients.row(identifier(id)).id))];
    return { trialId: trial.id, trialTitle: trial.title, patientIds, patientNames: patientIds.map((id) => this.patients.row(id).name) };
  }
  startBatch(trialId, input = {}) {
    check(this.batch(identifier(trialId))?.status !== "running", "CONFLICT", "该试验已有批量初筛在进行", 409);
    const value = this.normalizeBatch(trialId, input);
    const b = this.writeBatch({ id: randomUUID(), trialId: value.trialId, patientIds: value.patientIds, results: {}, status: "running", createdAt: this.iso(), detail: "" });
    this.store.audit(null, "trial.batch.started", { trialId: b.trialId, batchId: b.id, patients: b.patientIds.length, externalConsent: true });
    const task = this.runBatch(b.id).catch((e) => { const cur = this.getBatch(b.id); if (cur.status === "running") this.writeBatch({ ...cur, status: "failed", detail: e.message }); }).finally(() => this.runners.delete(b.id));
    this.runners.set(b.id, task);
    return this.publicBatch(b);
  }
  getBatch(id) {
    const row = this.db.prepare("SELECT data FROM trial_batches WHERE id=?").get(identifier(id));
    check(row, "NOT_FOUND", "批量初筛不存在", 404);
    return JSON.parse(row.data);
  }
  publicBatch(b) {
    if (!b) return null;
    const results = Object.values(b.results || {});
    return { ...b, total: b.patientIds.length, done: results.filter((r) => r.status !== "running").length, completed: results.filter((r) => ["completed", "reused"].includes(r.status)).length, failed: results.filter((r) => ["failed", "cancelled", "interrupted", "skipped"].includes(r.status)).length };
  }
  async runBatch(id) {
    for (const patientId of this.getBatch(id).patientIds) {
      let b = this.getBatch(id);
      if (b.status !== "running") return;
      if (b.results[patientId] && b.results[patientId].status !== "running") continue;
      const latest = this.latestJobs(b.trialId).get(patientId), summary = this.aiSummary(latest);
      let result;
      if (summary?.status === "completed" && !summary.stale) result = { status: "reused", jobId: summary.jobId };
      else {
        try {
          const job = this.jobs.start(b.trialId, patientId, { externalConsent: true });
          this.writeBatch({ ...b, current: patientId, results: { ...b.results, [patientId]: { status: "running", jobId: job.id } } });
          await this.jobs.active.get(job.id);
          const done = this.jobs.get(job.id);
          result = { status: done.status, jobId: job.id, ...(done.error ? { error: done.error } : {}) };
        } catch (e) { result = { status: "skipped", error: e.message }; }
      }
      b = this.getBatch(id);
      this.writeBatch({ ...b, current: null, results: { ...b.results, [patientId]: result } });
    }
    const b = this.getBatch(id);
    if (b.status === "running") this.writeBatch({ ...b, status: "completed", detail: "" });
  }
  cancelBatch(id) {
    const b = this.getBatch(id);
    if (b.status === "running") {
      this.writeBatch({ ...b, status: "cancelled", detail: "已停止；已完成的患者结果保留。" });
      const cur = b.current && b.results[b.current];
      if (cur?.status === "running") this.jobs.cancel(cur.jobId);
      this.store.audit(null, "trial.batch.cancelled", { trialId: b.trialId, batchId: b.id });
    }
    return this.publicBatch(this.getBatch(id));
  }
  async stop() {
    for (const id of this.runners.keys()) this.cancelBatch(id);
    await Promise.allSettled([...this.runners.values()]);
  }

  // ---------- proposals (chat) ----------
  normalizeProposal(type, payload = {}) {
    if (type === "trial-batch") return this.normalizeBatch(payload.trialId, { ...payload, externalConsent: true });
    if (type === "trial-enrollment") {
      const value = this.normalizeEnrollment(payload.trialId, payload.patientId, payload);
      return { ...value, trialTitle: this.trials.get(value.trialId).title, label: STAGES[value.stage] };
    }
    check(false, "INVALID_INPUT", "未知的临床试验提案");
  }
  // Runs inside the confirm transaction; the batch itself continues afterwards.
  applyProposal(action) {
    const p = action.payload;
    if (action.type === "trial-enrollment") return this.setEnrollment(p.trialId, p.patientId, { ...p, expectedRevision: this.enrollment(p.trialId, p.patientId).revision });
    if (action.type === "trial-batch") {
      const running = this.batch(p.trialId);
      check(running?.status !== "running", "CONFLICT", "该试验已有批量初筛在进行", 409);
      queueMicrotask(() => { try { this.startBatch(p.trialId, { patientIds: p.patientIds, externalConsent: true }); } catch { /* reported by the batch record */ } });
      return { queued: p.patientIds.length };
    }
  }
}
