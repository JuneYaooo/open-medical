import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekProvider } from "../server/provider.mjs";
import { parseLimits, prefilter } from "../server/medical/trial-candidates.mjs";
import { trialTools } from "../server/medical/trial-tools.mjs";
import { fixture } from "./helpers.mjs";

const criteria = (include, exclude = []) => [...include.map((text, i) => ({ id: `i${i}`, kind: "include", text })), ...exclude.map((text, i) => ({ id: `e${i}`, kind: "exclude", text }))];

test("pre-filter reads age and sex limits and explains diagnosis matches", () => {
  assert.deepEqual(({ ...parseLimits(criteria(["年龄 18-75 岁", "女性患者"])), sources: undefined }), { minAge: 18, maxAge: 75, sex: "female", sources: undefined });
  assert.equal(parseLimits(criteria(["年龄≥18岁"])).minAge, 18);
  assert.equal(parseLimits(criteria(["65岁及以上"])).minAge, 65);
  assert.equal(parseLimits(criteria(["男性或女性均可"])).sex, null);
  assert.equal(parseLimits(criteria([], ["年龄 18-75 岁"])).minAge, null);
  const trial = { title: "2型糖尿病新药研究", criteria: criteria(["年龄18-75岁", "确诊2型糖尿病"], ["正在使用胰岛素"]) };
  const now = Date.parse("2026-09-29");
  const likely = prefilter(trial, { birthYear: 1970, diagnoses: [{ name: "2型糖尿病" }] }, now);
  assert.equal(likely.status, "likely"); assert.match(likely.reasons.join(), /2型糖尿病/);
  assert.equal(prefilter(trial, { birthYear: 1940, diagnoses: [{ name: "2型糖尿病" }] }, now).status, "mismatch");
  // The one-year tolerance of birthYear never excludes an edge case.
  assert.notEqual(prefilter(trial, { birthYear: 2008, diagnoses: [] }, now).status, "mismatch");
  assert.equal(prefilter(trial, { birthYear: 1980, diagnoses: [{ name: "高血压" }] }, now).status, "unclear");
  assert.match(prefilter(trial, { diagnoses: [{ name: "糖尿病" }], medications: [{ name: "胰岛素", status: "active" }] }, now).warnings.join(), /胰岛素/);
});

async function setup(t) {
  const provider = new DeepSeekProvider({ apiKey: "synthetic", model: "test" });
  const box = {};
  // Every run judges each criterion "unknown" with the missing item named.
  provider.complete = async () => ({ message: { role: "assistant", content: "", tool_calls: [{ id: crypto.randomUUID(), type: "function",
    function: { name: "save_trial_eligibility_batch", arguments: JSON.stringify({ checks: box.trial.criteria.map((c) => ({ id: c.id, value: "unknown", reason: "病历未记载", evidenceDate: "未记载", missing: "需补充相关检查", citations: [] })) }) } }] } });
  const f = await fixture(t, { provider });
  const add = async (body) => (await f.json("/api/patients", "POST", body)).data;
  const a = await add({ name: "甲", gender: "female", birthYear: 1975, diagnoses: [{ name: "2型糖尿病" }] });
  const b = await add({ name: "乙", gender: "male", birthYear: 1940, diagnoses: [{ name: "2型糖尿病" }] });
  const c = await add({ name: "丙", birthYear: 1985 });
  box.trial = (await f.json("/api/trials", "POST", { title: "2型糖尿病新药研究", version: "V1 2026-09", inclusion: "年龄18-75岁\n确诊2型糖尿病", exclusion: "正在使用胰岛素" })).data;
  const waitBatch = async () => {
    for (let n = 0; n < 300; n++) {
      const v = (await f.json(`/api/trials/${box.trial.id}/candidates`)).data;
      if (v.batch && v.batch.status !== "running") return v;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("batch timeout");
  };
  return { ...f, a, b, c, trial: box.trial, waitBatch };
}

test("candidates are pre-filtered, batch-screened with consent, and reused results are skipped", async (t) => {
  const f = await setup(t);
  const base = `/api/trials/${f.trial.id}`;
  let v = (await f.json(`${base}/candidates`)).data;
  const by = (id) => v.candidates.find((c) => c.patientId === id);
  assert.equal(by(f.a.id).prefilter.status, "likely"); assert.equal(by(f.b.id).prefilter.status, "mismatch"); assert.equal(by(f.c.id).prefilter.status, "unclear");
  assert.equal(by(f.a.id).next, "建议 AI 初筛"); assert.equal(by(f.b.id).next, "预筛不符，一般无需初筛");
  assert.deepEqual(v.suggested, [f.a.id]);
  assert.equal(v.candidates[0].patientId, f.a.id);
  assert.equal((await f.json(`${base}/batches`, "POST", {})).status, 412);

  assert.equal((await f.json(`${base}/batches`, "POST", { externalConsent: true })).status, 202);
  assert.equal((await f.json(`${base}/batches`, "POST", { externalConsent: true })).status, 409);
  v = await f.waitBatch();
  assert.equal(v.batch.status, "completed"); assert.deepEqual(v.batch.patientIds, [f.a.id]);
  assert.equal(by(f.a.id).ai.status, "completed"); assert.equal(by(f.a.id).ai.missing, 3);
  assert.equal(by(f.a.id).next, "AI 初筛完成，请医生核对");
  assert.equal(v.counts.awaitingReview, 1); assert.deepEqual(v.suggested, []);

  await f.json(`${base}/batches`, "POST", { externalConsent: true, patientIds: [f.a.id, f.c.id] });
  v = await f.waitBatch();
  assert.equal(v.batch.results[f.a.id].status, "reused"); assert.equal(v.batch.results[f.c.id].status, "completed");
  const audit = f.server.store.db.prepare("SELECT action FROM audit WHERE action LIKE 'trial.%'").all().map((r) => r.action);
  assert.equal(audit.filter((a) => a === "trial.batch.started").length, 2);
  assert.equal(audit.filter((a) => a === "trial.ai.started").length, 2);
  const overview = (await f.json("/api/doctor/overview")).data, agenda = [...overview.items, ...overview.work.items];
  // AI screening results are the doctor's workflow, not a patient to-do.
  assert.ok(overview.work.items.some((i) => i.id === `trial-review:${f.trial.id}` && i.action.trialId === f.trial.id));
  assert.equal(overview.items.filter((i) => i.id.startsWith("trial")).length, 0);
  // Per-patient screening sessions are background work: not todos, not in the task list.
  assert.equal(agenda.filter((i) => i.id.startsWith("review:")).length, 0);
  assert.equal((await f.json("/api/sessions")).data.sessions.filter((x) => x.title.startsWith("纳排初筛")).length, 0);
  assert.equal((await f.json("/api/sessions?all=1")).data.sessions.filter((x) => x.title.startsWith("纳排初筛")).length, 2);
});

test("enrollment needs a consent date, then a conflict-free doctor review; every change is kept", async (t) => {
  const f = await setup(t);
  const url = `/api/trials/${f.trial.id}/enrollments/${f.a.id}`;
  const put = async (body) => { const cur = (await f.json(url)).data; return f.json(url, "PUT", { expectedRevision: cur.revision, ...body }); };
  assert.equal((await put({ stage: "enrolled" })).status, 409);
  assert.equal((await put({ stage: "withdrawn" })).status, 409);
  assert.equal((await put({ stage: "shortlisted" })).data.stage, "shortlisted");
  assert.equal((await f.json(url, "PUT", { stage: "contacted", expectedRevision: 0 })).status, 409);
  await put({ stage: "contacted" });
  const next = (await f.json("/api/doctor/overview?kind=trial")).data.items;
  assert.deepEqual(next.map((i) => [i.patientName, i.title]), [["甲", "登记知情同意"]]);
  assert.equal((await put({ stage: "consented" })).status, 400);
  assert.equal((await put({ stage: "consented", consentDate: "2999-01-01" })).status, 400);
  assert.equal((await put({ stage: "consented", consentDate: "2026-09-01", note: "V1 同意书" })).data.consentDate, "2026-09-01");
  const noReview = await put({ stage: "enrolled" });
  assert.equal(noReview.status, 409); assert.match(noReview.data.error?.message || JSON.stringify(noReview.data), /医生逐项核对/);
  const review = (checks) => f.json(`/api/trials/${f.trial.id}/screenings/${f.a.id}`, "PUT", { expectedRevision: 0, checks, note: "" });
  await review(f.trial.criteria.map((c) => ({ id: c.id, value: c.kind === "include" ? "yes" : "no", evidence: "2026-09 门诊病历" })));
  const enrolled = (await put({ stage: "enrolled" })).data;
  assert.equal(enrolled.stage, "enrolled");
  assert.equal((await f.json("/api/doctor/overview?kind=trial")).data.total, 0);
  assert.deepEqual(enrolled.history.map((h) => h.stage), ["shortlisted", "contacted", "consented"]);
  assert.equal(f.server.store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='trial.enrollment.changed'").get().n, 4);
  const v = (await f.json(`/api/trials/${f.trial.id}/candidates?stage=enrolled`)).data;
  assert.deepEqual(v.candidates.map((c) => c.patientId), [f.a.id]); assert.equal(v.counts.stages.enrolled, 1);
});

test("chat tools read candidates and only propose batch screening and enrollment changes", async (t) => {
  const f = await setup(t);
  const tools = Object.fromEntries(trialTools(() => f.server.trialCandidates, f.server.pendingActions).map((x) => [x.definition.function.name, x.execute]));
  assert.equal(tools.trial_list().trials[0].id, f.trial.id);
  assert.equal(tools.trial_candidates({ trialId: f.trial.id, prefilter: "likely" }).candidates.length, 1);
  const batch = tools.trial_batch_screen_propose({ trialId: f.trial.id });
  assert.deepEqual(batch.payload.patientIds, [f.a.id]);
  assert.equal(f.server.trialCandidates.batch(f.trial.id), null);
  await f.json(`/api/pending-actions/${batch.id}/confirm`, "POST", {});
  const v = await f.waitBatch();
  assert.equal(v.batch.status, "completed");
  const screening = tools.trial_patient_screening({ trialId: f.trial.id, patientId: f.a.id });
  assert.equal(screening.aiAttention.length, 3);
  assert.throws(() => tools.trial_enrollment_propose({ trialId: f.trial.id, patientId: f.c.id, stage: "consented" }), /签署日期/);
  const p = tools.trial_enrollment_propose({ trialId: f.trial.id, patientId: f.c.id, stage: "shortlisted", note: "门诊时提及" });
  assert.equal(f.server.trialCandidates.enrollment(f.trial.id, f.c.id).stage, "none");
  const confirmed = await f.json(`/api/pending-actions/${p.id}/confirm`, "POST", {}); assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(f.server.trialCandidates.enrollment(f.trial.id, f.c.id).stage, "shortlisted");
});

test("browser: candidate list, consented batch screening, enrollment stage and per-patient review", async (t) => {
  const { existsSync } = await import("node:fs");
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome) || !existsSync("dist/index.html")) return t.skip("Chrome/build unavailable");
  const { chromium } = await import("playwright-core");
  const f = await setup(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(12000);
  const shots = process.env.TRIAL_SHOTS || "";
  const shot = (name) => shots ? page.screenshot({ path: `${shots}-${name}.png`, fullPage: true }) : null;
  await page.goto(f.origin + "/?view=research");
  await page.locator(".trial-card", { hasText: "2型糖尿病新药研究" }).getByRole("button", { name: "打开初筛" }).click();
  const panel = page.getByRole("region", { name: "候选患者" });
  await panel.getByText("方案要求：18–75 岁").waitFor();
  const row = (name) => panel.locator("tr", { has: page.getByRole("button", { name, exact: true }) });
  await row("甲").getByText("建议 AI 初筛").waitFor();
  assert.equal(await row("乙").count(), 0); // 预筛不符 is hidden from 待处理
  await shot("1-list");
  await panel.getByRole("button", { name: "批量 AI 初筛（建议 1 位）" }).click();
  const dialog = page.getByRole("dialog");
  const start = dialog.getByRole("button", { name: "开始初筛 1 位" });
  assert.equal(await start.isDisabled(), true);
  await dialog.getByLabel(/同意把所选 1 位患者的病历资料/).check();
  await shot("2-batch");
  await start.click();
  await row("甲").getByText("AI 初筛完成，请医生核对").waitFor();
  await row("甲").getByLabel("入组状态").selectOption("consented");
  await page.getByRole("dialog").getByLabel("知情同意书签署日期").fill("2026-09-01");
  await page.getByRole("dialog").getByRole("button", { name: "登记" }).click();
  await row("甲").getByText("同意书 2026-09-01").waitFor();
  await row("甲").getByText("确认入组").waitFor();
  await row("甲").getByLabel("入组状态").selectOption("enrolled");
  await panel.getByText(/请先完成并保存医生逐项核对/).waitFor();
  await shot("3-enrollment");
  await row("甲").getByRole("button", { name: "逐项核对" }).click();
  await page.getByRole("region", { name: "AI 自动纳排" }).waitFor();
  await page.getByText("知情同意 2026-09-01").waitFor();
  await page.getByRole("button", { name: "← 返回候选患者" }).click();
  await panel.getByRole("button", { name: "全部", exact: true }).click();
  await row("乙").getByText("预筛不符", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test("agenda counts a run's final draft, not the extraction steps behind it", async () => {
  const { DoctorOverview } = await import("../server/medical/doctor-overview.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  for (const table of ["patients(id TEXT, data TEXT)", "risk_alerts(id,patient_id,severity,updated_at,data,status)", "care_tasks(id,patient_id,status,due_at,data)", "reminders(id,patient_id,due_at,data,status)",
    "follow_ups(id,patient_id,status,next_due,data)", "patient_messages(patient_id,processed,time)", "pending_actions(id,patient_id,summary,created_at,status)"]) db.exec(`CREATE TABLE ${table}`);
  const sessions = [
    { id: "s1", title: "林某 · 病例", updatedAt: "2026-09-28", reviewCount: 3, reviewItems: ["出院小结草稿"] },
    { id: "s2", title: "纳排初筛 · X", updatedAt: "2026-09-28", reviewCount: 1, reviewItems: [], background: true },
  ];
  const overview = new DoctorOverview({ db }, { list: () => sessions });
  const value = overview.read({});
  assert.equal(value.items.length, 0);
  assert.deepEqual(value.work.items.map((i) => [i.title, i.count]), [["出院小结草稿", 1]]);
});
