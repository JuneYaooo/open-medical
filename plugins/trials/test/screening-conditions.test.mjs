import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_TOOL_GROUPS } from "../../../server/medical/medical-workspace-domain.mjs";
import { createScriptedProvider, textTurn, toolCall } from "../../../tests/helpers/scripted-provider.mjs";
import { startTestServer } from "../../../tests/helpers/server.mjs";

const year = new Date().getFullYear();
const recent = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
const T2DM = [{ name: "2型糖尿病", code: "E11.9", status: "confirmed", date: "2020-01-01" }];
const PATIENTS = [
  // 符合：诊断、近期 HbA1c ≥ 8%、年龄在范围、未用胰岛素
  { name: "赵符合", gender: "male", birthYear: year - 60, diagnoses: T2DM, medications: [{ name: "二甲双胍", status: "active" }], labs: [{ item: "糖化血红蛋白", value: 8.6, unit: "%", date: recent }] },
  // 待核对：没有检验记录（缺资料不是不符合）
  { name: "钱待核", gender: "female", birthYear: year - 55, diagnoses: T2DM, medications: [{ name: "二甲双胍", status: "active" }] },
  // 不符合：HbA1c 未达阈值（规则预筛原本看不到检验）
  { name: "孙不符", gender: "male", birthYear: year - 50, diagnoses: T2DM, medications: [{ name: "二甲双胍", status: "active" }], labs: [{ item: "HbA1c", value: 7.1, unit: "%", date: recent }] },
  // 不符合：触发排除（正在用胰岛素）
  { name: "李胰岛", gender: "male", birthYear: year - 58, diagnoses: T2DM, medications: [{ name: "甘精胰岛素", status: "active" }], labs: [{ item: "HbA1c", value: 9.2, unit: "%", date: recent }] },
];
const CONDITIONS = {
  title: "HbA1c 控制不佳的 2 型糖尿病",
  conditions: [
    { label: "确诊 2 型糖尿病", kind: "include", field: "diagnosis", terms: ["2型糖尿病", "T2DM"], codes: ["E11"] },
    { label: "近 90 天 HbA1c ≥ 8%", kind: "include", field: "lab", items: ["HbA1c", "糖化血红蛋白"], op: "gte", value: 8, unit: "%", withinDays: 90 },
    { label: "年龄 18–75 岁", kind: "include", field: "age", min: 18, max: 75 },
    { label: "正在使用胰岛素", kind: "exclude", field: "medication", terms: ["胰岛素", "insulin"] },
  ],
  manualCriteria: ["签署知情同意", "预计 3 个月内可规律随访"],
};

async function setup(t, serverOptions = {}) {
  const provider = createScriptedProvider([]);
  const app = await startTestServer({ provider, seedDemoPack: false, serverOptions });
  t.after(() => app.close());
  const ids = {};
  for (const input of PATIENTS) {
    const created = await app.request("/api/patients", { method: "POST", body: input });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    ids[input.name] = created.body.id;
  }
  const trial = await app.request("/api/trials", {
    method: "POST",
    body: { title: "降糖新药 III 期", version: "v2.0 2026-09", recruitment: "正在招募", inclusion: "年龄 18–75 岁\n确诊 2 型糖尿病\nHbA1c ≥ 8%（近 3 个月）\n签署知情同意", exclusion: "正在使用胰岛素\n预计不能规律随访" },
  });
  assert.equal(trial.status, 201);
  // 让助手跑一轮：依次调用给定工具，返回每个工具的结果（JSON 解析后）。
  const ask = async (message, calls, body = {}) => {
    const callIds = calls.map((_, i) => `call_${Math.random().toString(36).slice(2)}_${i}`);
    provider.enqueue(...calls.map(([name, args], i) => toolCall(name, args, callIds[i])), textTurn("好的。"));
    const session = await app.request("/api/assistant/session", { method: "POST", body: {} });
    const response = await app.request("/api/agent/run", { method: "POST", body: { sessionId: session.body.id, message, mode: "model", externalConsent: true, ...body } });
    assert.equal(response.body.status, "completed", JSON.stringify(response.body));
    const messages = provider.calls.at(-1).messages;
    return {
      tools: provider.calls.at(-(calls.length + 1)).tools.map((x) => x.function.name),
      system: provider.calls.at(-(calls.length + 1)).messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"),
      results: callIds.map((id) => {
        const content = messages.find((m) => m.role === "tool" && m.tool_call_id === id)?.content;
        try { return JSON.parse(content); } catch { return content; }
      }),
      raw: callIds.map((id) => messages.find((m) => m.role === "tool" && m.tool_call_id === id)?.content || ""),
    };
  };
  return { app, provider, ids, trial: trial.body, ask };
}

const byName = (body) => Object.fromEntries(body.candidates.map((c) => [c.name, c]));

test("筛选条件：助手起草 → 医生确认 → 候选患者按条件逐条预筛（检验参与、缺资料待核对）", async (t) => {
  const { app, trial, ask } = await setup(t);
  // 未设置条件：一律待核对，旧的字面预筛只作粗略提示。
  const before = await app.request(`/api/trials/${trial.id}/candidates`);
  assert.equal(before.body.trial.screening, null);
  assert.ok(before.body.candidates.every((c) => c.screen.source === "none" && c.screen.status === "unclear" && c.prefilter.rough));
  assert.equal(byName(before.body)["孙不符"].prefilter.status, "likely", "粗略提示看不到检验，这正是要替换它的原因");

  const { tools, results, raw } = await ask("把这个试验的入排标准整理成筛选条件", [
    ["trial_protocol_criteria", { trialId: trial.id }],
    ["trial_screening_conditions_propose", { trialId: trial.id, ...CONDITIONS }],
  ]);
  assert.ok(tools.includes("trial_screening_conditions_propose"), "试验类提问应列出筛选条件工具");
  assert.equal(results[0].criteria.length, 6);
  const proposal = results[1];
  assert.equal(proposal.type, "trial-screening-conditions");
  assert.equal(proposal.status, "pending");
  assert.deepEqual(proposal.preview.counts, { total: 4, match: 1, unclear: 1, mismatch: 2 });
  assert.ok(!raw[1].includes("赵符合") && !raw[1].includes("钱待核"), "试算结果不含姓名");

  // 确认前不生效。
  assert.equal((await app.request(`/api/trials/${trial.id}/candidates`)).body.trial.screening, null);
  const confirmed = await app.request(`/api/pending-actions/${proposal.id}/confirm`, { method: "POST", body: {} });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

  const after = await app.request(`/api/trials/${trial.id}/candidates`);
  const screening = after.body.trial.screening;
  assert.equal(screening.source, "model_draft");
  assert.equal(screening.conditions.length, 4);
  assert.deepEqual(screening.manualCriteria, CONDITIONS.manualCriteria);
  assert.deepEqual({ met: screening.conditions[1].met, unknown: screening.conditions[1].unknown, not_met: screening.conditions[1].not_met }, { met: 2, unknown: 1, not_met: 1 });
  const c = byName(after.body);
  assert.equal(c["赵符合"].screen.status, "match");
  assert.equal(c["钱待核"].screen.status, "unclear");
  assert.match(c["钱待核"].screen.open[0].evidence, /没有「HbA1c」检验记录/);
  assert.equal(c["孙不符"].screen.status, "mismatch");
  assert.match(c["孙不符"].screen.open[0].evidence, /7\.1/);
  assert.equal(c["李胰岛"].screen.status, "mismatch");
  assert.equal(after.body.candidates[0].name, "赵符合", "符合者排在前面");
  assert.deepEqual(after.body.counts.screen, { source: "conditions", match: 1, unclear: 1, mismatch: 2 });
  assert.equal(after.body.suggestedBy, "conditions");
  assert.deepEqual(new Set(after.body.suggested), new Set([c["赵符合"].patientId, c["钱待核"].patientId]), "批量初筛默认不选不符合者");
  const onlyMatch = await app.request(`/api/trials/${trial.id}/candidates?status=match`);
  assert.deepEqual(onlyMatch.body.candidates.map((x) => x.name), ["赵符合"]);
  // 旧调用方传 likely 时按符合处理。
  assert.deepEqual((await app.request(`/api/trials/${trial.id}/candidates?status=likely`)).body.candidates.map((x) => x.name), ["赵符合"]);

  const protocol = await app.request(`/api/trials/${trial.id}`);
  assert.equal(protocol.body.screeningSpecSource, "model_draft");
  assert.equal(protocol.body.criteria.length, 6, "原有方案字段不变");
});

test("筛选条件：医生在界面保存、删改、清除；过期提案不能覆盖医生的修改", async (t) => {
  const { app, trial, ask } = await setup(t);
  const { results } = await ask("整理试验筛选条件", [["trial_screening_conditions_propose", { trialId: trial.id, ...CONDITIONS }]]);
  const stale = results[0];

  const saved = await app.request(`/api/trials/${trial.id}/screening-conditions`, {
    method: "PUT",
    body: { spec: { title: CONDITIONS.title, conditions: CONDITIONS.conditions.slice(0, 1) }, manualCriteria: [], expectedRevision: 0 },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.screeningSpecSource, "doctor");
  assert.equal(saved.body.screeningSpecRevision, 1);
  const conflict = await app.request(`/api/trials/${trial.id}/screening-conditions`, { method: "PUT", body: { spec: null, expectedRevision: 0 } });
  assert.equal(conflict.status, 409);
  const invalid = await app.request(`/api/trials/${trial.id}/screening-conditions`, { method: "PUT", body: { spec: { title: "x", conditions: [{ label: "a", kind: "include", field: "lab", items: ["HbA1c"], op: "gte" }] } } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error?.message || invalid.text, /第 1 条条件需要比较数值/);

  const rejected = await app.request(`/api/pending-actions/${stale.id}/confirm`, { method: "POST", body: {} });
  assert.equal(rejected.status, 409, "提案之后医生改过条件，确认时拒绝覆盖");

  const candidates = await app.request(`/api/trials/${trial.id}/candidates`);
  assert.equal(candidates.body.trial.screening.conditions.length, 1);
  assert.equal(byName(candidates.body)["孙不符"].screen.status, "match", "只剩诊断条件");

  const cleared = await app.request(`/api/trials/${trial.id}/screening-conditions`, { method: "PUT", body: { spec: null, expectedRevision: 1 } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.screeningSpec, undefined);
  const back = await app.request(`/api/trials/${trial.id}/candidates`);
  assert.equal(back.body.trial.screening, null);
  assert.ok(back.body.candidates.every((c) => c.screen.source === "none"));
});

test("患者侧：一位患者对照各试验的筛选条件，模型只拿到编号和依据", async (t) => {
  const { app, trial, ids, ask } = await setup(t);
  await app.request("/api/trials", { method: "POST", body: { title: "未整理条件的试验", version: "v1", inclusion: "成人", exclusion: "妊娠" } });
  await app.request(`/api/trials/${trial.id}/screening-conditions`, { method: "PUT", body: { spec: CONDITIONS, manualCriteria: CONDITIONS.manualCriteria } });

  const { results, raw, tools } = await ask("这位患者适合哪些临床试验", [["trial_match_patient", { patientId: ids["钱待核"] }]]);
  assert.ok(tools.includes("trial_match_patient"));
  const match = results[0];
  assert.equal(match.trials.length, 1);
  assert.equal(match.trials[0].status, "unclear");
  assert.equal(match.trials[0].manualCriteria, 2);
  assert.match(match.trials[0].open[0], /待核对/);
  assert.deepEqual(match.withoutConditions.map((x) => x.title), ["未整理条件的试验"]);
  assert.ok(!raw[0].includes("钱待核"), "结果不含姓名");

  const ui = await app.request(`/api/trials/match/${ids["李胰岛"]}`);
  assert.equal(ui.status, 200);
  assert.equal(ui.body.trials[0].status, "mismatch");
  assert.match(ui.body.trials[0].open[0], /胰岛素/);
  assert.equal((await app.request("/api/trials/match/not-a-patient")).status, 404);

  await app.request("/api/trials", { method: "POST", body: { title: "已结束的试验", version: "v1", recruitment: "已完成", inclusion: "成人", exclusion: "妊娠" } });
  const after = await app.request(`/api/trials/match/${ids["李胰岛"]}`);
  assert.deepEqual(after.body.closed.map((x) => x.title), ["已结束的试验"], "已结束招募的试验不参与匹配");
  assert.ok(!after.body.withoutConditions.some((x) => x.title === "已结束的试验"));
});

test("招募状态：只有明确结束/暂停才算不在招募", async () => {
  const { recruitmentClosed } = await import("../server/trial-candidates.mjs");
  for (const text of ["已完成", "进行中，不再招募", "已暂停", "Terminated", "ACTIVE, NOT RECRUITING", "招募结束"]) assert.equal(recruitmentClosed(text), true, text);
  for (const text of ["正在招募", "尚未开始招募", "邀请入组", "待研究中心确认", "", "Recruiting", "Not yet recruiting"]) assert.equal(recruitmentClosed(text), false, text);
});

const study = (id, title, countries) => ({
  protocolSection: {
    identificationModule: { nctId: id, briefTitle: title },
    statusModule: { overallStatus: "RECRUITING", lastUpdatePostDateStruct: { date: "2026-09-01" } },
    conditionsModule: { conditions: ["Type 2 Diabetes"] },
    designModule: { phases: ["PHASE3"] },
    eligibilityModule: {
      eligibilityCriteria: "Inclusion Criteria:\n\n* Adults 18-75 years\n* HbA1c 7.5-10.5%\n\nExclusion Criteria:\n\n* Insulin use within 3 months",
      sex: "ALL", minimumAge: "18 Years", maximumAge: "75 Years",
    },
    contactsLocationsModule: { locations: countries.map(([city, country]) => ({ facility: `${city} Hospital`, city, country })) },
  },
});

test("注册平台：ClinicalTrials.gov 检索（中国地点优先）、失败如实报告、按注册号导入方案提案", async (t) => {
  const requests = [];
  let failNext = false;
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (failNext) { failNext = false; return new Response("busy", { status: 503 }); }
    if (String(url).includes("/studies/NCT01234567"))
      return Response.json(study("NCT01234567", "A Study of Drug X in T2DM", [["Beijing", "China"]]));
    return Response.json({ totalCount: 2, studies: [study("NCT07654321", "US only", [["Boston", "United States"]]), study("NCT01234567", "A Study of Drug X in T2DM", [["Boston", "United States"], ["Shanghai", "China"]])] });
  };
  const { app, ask } = await setup(t, { trialRegistryOptions: { fetchImpl } });

  const { results, tools } = await ask("帮我在 ClinicalTrials.gov 找正在招募的 2 型糖尿病试验，中国优先", [
    ["trial_registry_search", { condition: "type 2 diabetes", term: "HbA1c", country: "China", pageSize: 5 }],
  ]);
  assert.ok(tools.includes("trial_registry_search"));
  const url = new URL(requests[0]);
  assert.equal(url.origin + url.pathname, "https://clinicaltrials.gov/api/v2/studies");
  assert.equal(url.searchParams.get("query.cond"), "type 2 diabetes");
  assert.equal(url.searchParams.get("query.term"), "HbA1c");
  assert.equal(url.searchParams.get("filter.overallStatus"), "RECRUITING");
  assert.equal(url.searchParams.get("pageSize"), "5");
  assert.equal(url.searchParams.get("query.locn"), null, "未要求只看中国时不过滤");
  const search = results[0];
  assert.equal(search.total, 2);
  assert.equal(search.studies[0].registration, "NCT01234567", "有中国中心的试验排在前面");
  assert.match(search.studies[0].locations[0], /Shanghai · China/);
  assert.match(search.studies[0].eligibility.excerpt, /Inclusion Criteria/);

  failNext = true;
  const failed = await ask("再查一次", [["trial_registry_search", { condition: "type 2 diabetes" }]]);
  assert.match(failed.raw[0], /注册平台暂时不可用（HTTP 503）/);

  const imported = await ask("把 NCT01234567 导入试验列表", [["trial_protocol_propose", { registryId: "NCT01234567" }]]);
  const proposal = imported.results[0];
  assert.equal(proposal.type, "trial-protocol", imported.raw[0]);
  assert.equal(proposal.payload.registration, "NCT01234567");
  assert.ok(proposal.payload.criteria.some((c) => c.kind === "exclude" && /Insulin/.test(c.text)));
  const before = (await app.request("/api/trials")).body.trials.length;
  const confirmed = await app.request(`/api/pending-actions/${proposal.id}/confirm`, { method: "POST", body: {} });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const list = (await app.request("/api/trials")).body.trials;
  assert.equal(list.length, before + 1);
  assert.equal(list.find((x) => x.registration === "NCT01234567").sourceUrl, "https://clinicaltrials.gov/study/NCT01234567");

  // 医生口述/ChiCTR 文字：逐条 criteria。
  const manual = await ask("导入这个 ChiCTR 试验", [["trial_protocol_propose", { title: "ChiCTR 示例", registration: "ChiCTR2400012345", criteria: [{ kind: "include", text: "18–70 岁" }, { kind: "exclude", text: "妊娠" }] }]]);
  assert.equal(manual.results[0].type, "trial-protocol", manual.raw[0]);
  assert.match(manual.results[0].payload.version, /助手导入草稿/);
});

test("工具分组与任务上下文：试验类提问开启全部试验工具，试验页上下文校验方案", async (t) => {
  const group = SESSION_TOOL_GROUPS.find((g) => g.id === "trials");
  for (const name of ["trial_screening_conditions_propose", "trial_match_patient", "trial_registry_search", "trial_protocol_propose", "trial_protocol_criteria"])
    assert.ok(group.names.includes(name), name);
  for (const text of ["帮我查 NCT01234567", "整理入排标准", "ChiCTR 上有没有相关研究"]) assert.ok(group.when.test(text), text);

  const { app, trial, ask } = await setup(t);
  const tools = app.server.sessionBridge.toolNames();
  for (const name of group.names) assert.ok(tools.includes(name), `${name} 已注册`);
  const run = await ask("请整理筛选条件", [["trial_protocol_criteria", { trialId: trial.id }]], {
    context: { kind: "trials-protocol", label: `试验：${trial.title}`, scope: { task: "conditions", trialId: trial.id } },
  });
  assert.ok(run.tools.includes("trial_screening_conditions_propose"));
  assert.match(run.system, /先用 trial_protocol_criteria 读取入排标准原文/, "试验页上下文的说明进入系统提示");
  assert.match(run.system, /trial_match_patient/, "插件提示说明试验工作流");
  const session = await app.request("/api/assistant/session", { method: "POST", body: {} });
  const bad = await app.request("/api/agent/run", { method: "POST", body: { sessionId: session.body.id, message: "x", mode: "model", externalConsent: true, context: { kind: "trials-protocol", label: "试验", scope: { task: "drop" } } } });
  assert.equal(bad.status, 400);
});
