import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

const today = () => new Date().toISOString().slice(0, 10);

const createPatient = async (f, name = "随访测试患者") => {
  const created = await f.json("/api/patients", "POST", { name });
  return created.data;
};

test('personalized follow-up template is atomic, retry-safe and does not modify the reusable plan',async t=>{
 const f=await fixture(t,{followupOptions:{autoStart:false}}),p=await createPatient(f);
 const payload={planId:'builtin_postop',startDate:today(),requestId:'synthetic-template-request',nodes:[{offsetDays:5,title:'按医嘱联系',items:['核对已有安排']} ]};
 const path=`/api/patients/${p.id}/followups/apply`;
 const a=await f.json(path,'POST',payload);assert.equal(a.status,201);assert.equal(a.data.length,1);assert.match(a.data[0].name,/按医嘱联系/);assert.equal(a.data[0].templateCustomized,true);
 assert.equal(new Date(a.data[0].nextDue).getHours(),9);
 const b=await f.json(path,'POST',payload);assert.equal(b.data[0].id,a.data[0].id);assert.equal(f.server.followups.list(p.id).length,1);
 assert.equal((await f.json(path,'POST',{...payload,nodes:[{offsetDays:7,title:'改过的节点',items:[]}]})).status,409);
 assert.equal(f.server.followups.planRow('builtin_postop').nodes[0].offsetDays,7);
 const audit=f.server.store.audit;f.server.store.audit=()=>{throw Error('synthetic audit failure');};
 assert.equal((await f.json(path,'POST',{...payload,requestId:'another-request'})).status,500);f.server.store.audit=audit;assert.equal(f.server.followups.list(p.id).length,1);
 assert.equal((await f.json(path,'POST',{...payload,requestId:'invalid-date',startDate:'2026-02-30'})).status,400);
});

test("followup plans: builtin seeds, custom template CRUD", async (t) => {
  const f = await fixture(t);
  const list = (await f.json("/api/followup-plans")).data.plans;
  assert.equal(list.length, 3);
  assert.ok(list.every((p) => p.builtin));
  assert.ok(list.some((p) => p.name === "高血压慢病随访" && p.nodes.length === 3));

  const created = await f.json("/api/followup-plans", "POST", {
    name: "甲状腺术后随访",
    disease: "C73 甲状腺癌",
    nodes: [
      { offsetDays: 14, title: "2 周复查", items: ["切口", "甲功"] },
      { offsetDays: 90, title: "3 个月复查", items: ["甲状腺超声"] },
    ],
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.nodes.length, 2);

  const builtinDelete = await f.json(
    "/api/followup-plans/builtin_hypertension",
    "DELETE",
  );
  assert.equal(builtinDelete.status, 409);
  const removed = await f.json(
    `/api/followup-plans/${created.data.id}`,
    "DELETE",
  );
  assert.equal(removed.status, 200);
});

test("apply template: one-shot jobs per node with staggered due dates", async (t) => {
  const f = await fixture(t);
  const patient = await createPatient(f, "模板入组患者");
  const applied = await f.json(
    `/api/patients/${patient.id}/followups/apply`,
    "POST",
    { planId: "builtin_hypertension", startDate: today() },
  );
  assert.equal(applied.status, 201);
  assert.equal(applied.data.length, 3);
  assert.ok(applied.data.every((job) => job.once === true));
  const dueList = applied.data.map((job) => job.nextDue).sort((a, b) => a - b);
  assert.ok(dueList[1] > dueList[0]);
  assert.match(applied.data[0].name, /高血压慢病随访 · 1 个月随访/);

  const jobs = (await f.json(`/api/patients/${patient.id}/followups`)).data.jobs;
  assert.equal(jobs.length, 3);

  const overview = (await f.json("/api/followups/overview")).data.jobs;
  assert.ok(overview.some((job) => job.patientName === "模板入组患者"));

  const badDate = await f.json(
    `/api/patients/${patient.id}/followups/apply`,
    "POST",
    { planId: "builtin_hypertension", startDate: "2020-01-01" },
  );
  assert.equal(badDate.status, 400);

  const missingPlan = await f.json(
    `/api/patients/${patient.id}/followups/apply`,
    "POST",
    { planId: "builtin_missing", startDate: today() },
  );
  assert.equal(missingPlan.status, 404);
});

test("once follow-up completes instead of repeating after execution", async (t) => {
  const f = await fixture(t, {
    followupOptions: { pollMs: 50, autoStart: true },
  });
  const patient = await createPatient(f, "单次随访患者");
  const created = await f.json(`/api/patients/${patient.id}/followups`, "POST", {
    name: "一次性行动项",
    once: true,
    firstDueAt: new Date(Date.now() + 100).toISOString(),
    checklist: ["电话提醒复诊"],
  });
  assert.equal(created.status, 201);
  const first = (await f.json(`/api/patients/${patient.id}/followups`)).data.jobs[0];
  assert.equal(first.once, true);
  // Wait for the poller to execute the one-shot job.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = (await f.json(`/api/patients/${patient.id}/followups`)).data.jobs[0];
  assert.equal(after.status, "completed");
  const reminders = (await f.json("/api/reminders")).data.reminders;
  assert.ok(reminders.some((r) => r.title.includes("一次性行动项")));
});

test("recurring follow-up regression: still advances intervals", async (t) => {
  const f = await fixture(t, {
    followupOptions: { pollMs: 50, autoStart: true },
  });
  const patient = await createPatient(f, "周期随访回归");
  await f.json(`/api/patients/${patient.id}/followups`, "POST", {
    name: "每周随访",
    intervalDays: 7,
    firstDueAt: new Date(Date.now() + 100).toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const jobs = (await f.json(`/api/patients/${patient.id}/followups`)).data.jobs;
  assert.equal(jobs[0].status, "active");
  assert.ok(jobs[0].nextDue > Date.now());
});
