import test from "node:test";
import assert from "node:assert/strict";
import { medicalPolicy, artifactLines } from "../shared/medical.mjs";
import { runTool, localWork } from "../server/medical-core.mjs";

test("policy routes intents without emergency interception and marks medication high risk", () => {
  assert.equal(medicalPolicy("整理病历时间线").intent, "record_structuring");
  assert.equal(medicalPolicy("核对这份处方的剂量").risk, "high");
  assert.equal(medicalPolicy("设计胸痛科普工作流").intent, "medical_product");
  assert.equal(medicalPolicy("整理随访材料").mustEscalate, undefined);
});
test("health questions route to consultation with low risk, not workflow drafts", () => {
  const policy = medicalPolicy("血糖有点高，男生 27岁，怎么办");
  assert.equal(policy.intent, "consultation");
  assert.equal(policy.risk, "low");
  assert.equal(policy.requiresClinicianReview, false);
  assert.equal(medicalPolicy("血糖高需要吃药吗").intent, "consultation");
  assert.equal(medicalPolicy("这个指标说明什么？").intent, "consultation");
  // 整理类任务即使用问号结尾也不应被当成咨询
  assert.equal(
    medicalPolicy("帮我把这段就诊记录整理成时间线").intent,
    "record_structuring",
  );
});
test("consultation local work asks the lab knowledge plugin instead of build_workflow", async () => {
  const message = {
    id: "m",
    name: "本轮输入",
    hash: "h",
    text: "血糖有点高，男生 27岁，怎么办",
  };
  const work = localWork(medicalPolicy(message.text), [message]);
  assert.equal(work.tool, "lab_knowledge_search");
  assert.ok(work.args.query.length <= 100);
  assert.match(work.args.query, /血糖/);
  assert.notEqual(work.tool, "build_workflow");
  const definition = {
    type: "function",
    function: {
      name: "lab_knowledge_search",
      description: "检验指标速查插件",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  };
  const result = await runTool(work.tool, work.args, {
    sources: [message],
    definitions: [definition],
    plugins: new Map([
      [
        "lab_knowledge_search",
        {
          definition,
          execute: (args) => ({ query: args.query, entries: [], count: 0 }),
        },
      ],
    ]),
  });
  assert.match(result.query, /血糖/);
});
test("consultation work with a real lab knowledge entry returns interpretation leads", async () => {
  const { searchLabKnowledge } = await import("../server/medical/lab-knowledge.mjs");
  const hit = searchLabKnowledge({ query: "血糖" });
  assert.ok(hit.count >= 1);
  assert.ok(hit.entries[0].high.length > 0);
  assert.match(hit.note, /医生/);
});
test("timeline extracts real source lines, sorts dates and flags impossible dates", async () => {
  const sources = [
    {
      id: "s1",
      name: "病历.txt",
      hash: "hash",
      text: "2026-02-03 复诊\n2025年1月2日 首诊\n2026-02-30 日期待核对\n无日期事件",
    },
  ];
  const result = await runTool("extract_clinical_timeline", {}, { sources });
  assert.equal(result.events.length, 3);
  assert.equal(result.events[0].date, "2025-01-02");
  assert.equal(result.events[0].source.line, 2);
  assert.equal(result.events[2].dateValid, false);
  assert.equal(result.status, "draft");
});
test("tool registry rejects unknown tools, invented event input and unscoped source access", async () => {
  await assert.rejects(() => runTool("shell", { command: "ls" }), /未授权/);
  await assert.rejects(
    () =>
      runTool("extract_clinical_timeline", { events: [{ event: "invented" }] }),
    /未声明/,
  );
  await assert.rejects(
    () =>
      runTool("read_source", {
        sourceId: "another-session",
        startLine: 1,
        endLine: 2,
      }),
    /当前会话/,
  );
  await assert.rejects(
    () =>
      runTool("build_workflow", { title: "test", steps: [{ text: "bad" }] }),
    /文本/,
  );
});
test("server registered medical plugins are schema checked and provenance marked", async () => {
  const definition = {
    type: "function",
    function: {
      name: "medical_demo",
      description: "受控医疗资料转换插件",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
  };
  const result = await runTool(
    "medical_demo",
    { value: "患者资料" },
    {
      definitions: [definition],
      plugins: new Map([
        ["medical_demo", { definition, execute: (args) => ({ value: args.value }) }],
      ]),
    },
  );
  assert.equal(result.value, "患者资料");
  assert.equal(result.provenance, "plugin_draft");
  await assert.rejects(() => runTool("medical_demo", { value: 3 }, {
    definitions: [definition],
    plugins: new Map([["medical_demo", { definition, execute: () => ({}) }]]),
  }), /value/);
});
test("async plugin results are awaited, not swallowed into provenance stubs", async () => {
  const definition = {
    type: "function",
    function: {
      name: "medical_async_demo",
      description: "异步插件（文献/语义检索类）",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
  };
  const result = await runTool(
    "medical_async_demo",
    { value: "检索词" },
    {
      definitions: [definition],
      plugins: new Map([
        [
          "medical_async_demo",
          {
            definition,
            execute: async (args) => {
              await new Promise((resolve) => setTimeout(resolve, 5));
              return { value: args.value, articles: [{ pmid: "1" }] };
            },
          },
        ],
      ]),
    },
  );
  assert.equal(result.value, "检索词");
  assert.deepEqual(result.articles, [{ pmid: "1" }]);
  assert.equal(result.provenance, "plugin_draft");
});
test("object-array args (proposal diagnoses/medications) pass shallow validation", async () => {
  const definition = {
    type: "function",
    function: {
      name: "medical_proposal_demo",
      description: "结构化提案插件",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          diagnoses: {
            type: "array",
            items: {
              type: "object",
              properties: { code: { type: "string" }, name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  };
  let received = null;
  const result = await runTool(
    "medical_proposal_demo",
    {
      name: "吴秀英",
      diagnoses: [{ code: "I20.9", name: "心绞痛" }],
      tags: ["高血压"],
    },
    {
      definitions: [definition],
      plugins: new Map([
        [
          "medical_proposal_demo",
          {
            definition,
            execute: (args) => {
              received = args;
              return { ok: true };
            },
          },
        ],
      ]),
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(received.diagnoses, [{ code: "I20.9", name: "心绞痛" }]);
  // 字符串数组仍受长度约束
  await assert.rejects(
    () =>
      runTool(
        "medical_proposal_demo",
        { name: "x", tags: [123] },
        { definitions: [definition], plugins: new Map() },
      ),
    /tags/,
  );
});
test("evidence plan is clearly unsearched and medication review does not infer safety", async () => {
  const plan = await runTool("build_evidence_question", {
    population: "adult",
    intervention: "care",
    comparison: "usual",
    outcome: "sleep",
  });
  assert.equal(plan.retrieved, false);
  assert.match(plan.searchUrl, /pubmed/);
  const review = await runTool(
    "review_medication_safety",
    {},
    {
      sources: [{ id: "s", name: "r", text: "药品 A 5mg 每日口服", hash: "x" }],
    },
  );
  assert.ok(review.missing.includes("过敏史"));
  assert.ok(review.limitations[0].includes("没有执行"));
  assert.ok(artifactLines(review).length);
});

test("unknown clinical fields are missing information, not confirmation of safe medication", async () => {
  const result = await runTool(
    "review_medication_safety",
    {},
    {
      sources: [
        {
          id: "r",
          name: "record",
          text: "过敏史：未记录\n肾功能：未查\n肝功能：未知\n药品 A 5 mg",
          hash: "x",
        },
      ],
    },
  );
  for (const field of ["过敏史", "肾功能信息", "肝功能信息"])
    assert.ok(result.missing.includes(field));
});
test("lab extraction retains numbers, units and original sources without conversions", async () => {
  const result = await runTool(
    "extract_observations",
    {},
    {
      sources: [
        {
          id: "r",
          name: "lab",
          text: "Hb 98 g/L，肌酐 1.2 mg/dL；血糖 5.6 mmol/L",
          hash: "x",
        },
      ],
    },
  );
  assert.equal(result.observations.length, 3);
  assert.equal(result.observations[1].unit, "mg/dL");
  assert.equal(result.observations[1].value, "1.2");
  assert.equal(result.observations[1].interpretation, "未评价");
});
test("timeline request stays timeline when original records mention drugs", () => {
  assert.equal(
    medicalPolicy("整理病历时间线，列出用药").intent,
    "record_structuring",
  );
});

test("PICO extracts explicitly labelled user fields and model-supplied arguments pass through as provided", async () => {
  const source = {
    id: "s",
    name: "question",
    hash: "h",
    text: "循证任务\nP: 成人群体\nI: 干预 A\nC: 常规方案\nO: 结局 B",
  };
  const args = localWork(medicalPolicy(source.text), [source]).args;
  assert.deepEqual(args, {
    population: "成人群体",
    intervention: "干预 A",
    comparison: "常规方案",
    outcome: "结局 B",
  });
  const result = await runTool("build_workflow", {
    title: "电话 13812345678",
    steps: ["联系 13912345678"],
  });
  assert.ok(JSON.stringify(result).includes("13812345678"));
  assert.equal(result.status, "draft");
});

test("PDF page citations, ambiguous dates and signed laboratory values remain explicit", async () => {
  const sources = [
    {
      id: "p",
      name: "report.pdf",
      hash: "h",
      extraction: { type: "pdf_text" },
      text: "[PDF 第 1 页]\n2026-01-01 至 2026-01-02 门诊\nHb -2.3 g/L\nCRP 1,200 mg/dL",
    },
  ];
  const timeline = await runTool("extract_clinical_timeline", {}, { sources });
  assert.equal(timeline.events[0].ambiguousDates, true);
  assert.equal(timeline.events[0].source.page, 1);
  const obs = await runTool("extract_observations", {}, { sources });
  assert.equal(obs.observations[0].value, "-2.3");
  assert.equal(obs.observations[1].value, "1,200");
});

test("skill registry discovers medical instructions and rejects path or extra arguments", async () => {
  const { SkillRegistry } = await import("../server/skills.mjs");
  const skills = new SkillRegistry(["skills"]);
  assert.deepEqual(
    skills.list().map((s) => s.id),
    [
      "adr-assessment",
      "case-report",
      "clinical-decision-flow",
      "discharge-summary",
      "evidence-planning",
      "guideline-application",
      "handoff-record",
      "knowledge-base",
      "lab-interpretation",
      "medical-record",
      "medication-review",
      "patient-education",
      "similar-case-search",
      "trial-eligibility",
    ],
  );
  const result = await runTool(
    "read_skill",
    { skillId: "medical-record" },
    { skills },
  );
  assert.match(result.instructions, /extract_clinical_timeline/);
  await assert.rejects(
    () =>
      runTool(
        "read_skill",
        { skillId: "medical-record", extra: "nope" },
        { skills },
      ),
    /未声明/,
  );
  assert.throws(() => skills.get("../README"), /技能名称无效/);
});
