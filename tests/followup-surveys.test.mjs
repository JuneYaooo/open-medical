import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import {
  normalizeQuestionnaire,
  renderQuestionnaire,
  parseAnswer,
  scoreSurvey,
} from "../server/followup-surveys.mjs";

const QUESTIONNAIRE = {
  title: "月度随访",
  questions: [
    {
      id: "dizzy",
      text: "近一周是否有头晕？",
      type: "single",
      required: true,
      options: [
        { label: "经常", score: 2 },
        { label: "偶尔", score: 1 },
        { label: "没有", score: 0 },
      ],
    },
    {
      id: "bp",
      text: "晨起收缩压平均值？",
      type: "number",
      unit: "mmHg",
      required: true,
      alertIf: { op: "gt", value: 180 },
    },
    { id: "other", text: "其他不适？", type: "text", required: false },
  ],
  scoring: {
    alert: { op: "gte", value: 3, severity: "critical", message: "评分偏高" },
  },
};

const waitFor = async (fn, timeout = 10000) => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) return null;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

test("questionnaire validation, rendering, parsing and scoring are deterministic", () => {
  assert.throws(
    () => normalizeQuestionnaire({ title: "x", questions: [{ id: "a", text: "t", type: "scale" }] }),
    /类型无效/,
  );
  assert.throws(
    () =>
      normalizeQuestionnaire({
        title: "x",
        questions: [
          { id: "a", text: "t", type: "single", options: [{ label: "是" }] },
        ],
      }),
    /2–12 个选项/,
  );
  assert.throws(
    () =>
      normalizeQuestionnaire({
        title: "x",
        questions: [
          { id: "a", text: "t", type: "text" },
          { id: "a", text: "t2", type: "text" },
        ],
      }),
    /不能重复/,
  );
  const rendered = renderQuestionnaire(QUESTIONNAIRE);
  assert.match(rendered, /【随访问卷】月度随访/);
  assert.match(rendered, /1\) 经常  2\) 偶尔/);
  // 按题号的回复才被认作问卷作答。
  const parsed = parseAnswer(QUESTIONNAIRE, "今天还好，血压有点高");
  assert.equal(parsed.hasNumberedLine, false);
  assert.equal(parsed.answers.length, 0);
  const parsed2 = parseAnswer(QUESTIONNAIRE, "1. 经常\n2、185\n3) 想问复查时间");
  assert.deepEqual(parsed2.answers.map((a) => a.questionId), ["dizzy", "bp", "other"]);
  assert.deepEqual(parsed2.answers[0].value, ["经常"]);
  assert.equal(parsed2.answers[1].value, 185);
  // 选项编号、字母、圈号都能命中。
  const parsed3 = parseAnswer(QUESTIONNAIRE, "1. B\n2) 120");
  assert.deepEqual(parsed3.answers[0].value, ["偶尔"]);
  const { score, flags, scoreAlert } = scoreSurvey(QUESTIONNAIRE, parsed2.answers);
  assert.equal(score, 2);
  assert.equal(flags.length, 1);
  assert.equal(scoreAlert, null);
  const severe = scoreSurvey(
    QUESTIONNAIRE,
    parseAnswer(QUESTIONNAIRE, "1. 经常\n2. 120").answers,
  );
  assert.equal(severe.score, 2);
  const high = scoreSurvey(
    QUESTIONNAIRE,
    parseAnswer(QUESTIONNAIRE, "1. 经常\n2. 120").answers,
  );
  assert.equal(high.score, 2);
  // 经常(2)+漏服(2) 到 4 分才触总分线?本问卷只有两题计分,构造 gte3: 经常2+偶尔漏1=3。
  const scoringQuestionnaire = {
    ...QUESTIONNAIRE,
    questions: QUESTIONNAIRE.questions.slice(0, 1),
  };
  const total = scoreSurvey(
    scoringQuestionnaire,
    parseAnswer(scoringQuestionnaire, "1. 经常").answers,
  );
  assert.equal(total.score, 2);
});

test("survey lifecycle: due job creates survey, send via manual, chat reply collects", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "问卷患者" })).data;
  // 问卷校验失败返回 400。
  const bad = await f.json(`/api/patients/${patient.id}/followups`, "POST", {
    name: "坏问卷",
    once: true,
    firstDueAt: new Date(Date.now() + 3600000).toISOString(),
    questionnaire: { title: "x", questions: [{ id: "a", text: "t", type: "single", options: [{ label: "是" }] }] },
  });
  assert.equal(bad.status, 400);
  const created = await f.json(`/api/patients/${patient.id}/followups`, "POST", {
    name: "月度随访计划",
    once: true,
    firstDueAt: new Date(Date.now() + 300).toISOString(),
    questionnaire: QUESTIONNAIRE,
  });
  assert.equal(created.status, 201);
  assert.ok(created.data.questionnaire);
  // 到期执行后应生成待下发问卷。
  const survey = await waitFor(async () => {
    const list = (await f.json(`/api/patients/${patient.id}/followup-surveys`)).data.surveys;
    return list[0] || null;
  });
  assert.ok(survey, "到期执行应生成问卷");
  assert.equal(survey.status, "pending_send");
  // 下发需要确认。
  const noConsent = await f.json(
    `/api/patients/${patient.id}/followup-surveys/${survey.id}/send`,
    "POST",
    { channel: "manual" },
  );
  assert.equal(noConsent.status, 412);
  const sent = await f.json(
    `/api/patients/${patient.id}/followup-surveys/${survey.id}/send`,
    "POST",
    { channel: "manual", consent: true },
  );
  assert.equal(sent.status, 200);
  assert.match(sent.data.text, /【随访问卷】月度随访/);
  assert.equal(sent.data.survey.status, "sent");
  // 非题号格式的闲聊不被消费。
  assert.equal(f.server.surveys.tryCollect(patient.id, "最近还好，谢谢医生"), null);
  // 缺必答题 → 只记部分,状态仍为已发送。
  const partial = f.server.surveys.tryCollect(patient.id, "1. 经常");
  assert.match(partial, /还缺 1 题/);
  let list = (await f.json(`/api/patients/${patient.id}/followup-surveys`)).data.surveys;
  assert.equal(list[0].status, "sent");
  assert.equal(list[0].answers.length, 1);
  // 医生代填补齐(带血压越界标记) → collected + 预警。
  const collected = await f.json(
    `/api/patients/${patient.id}/followup-surveys/${survey.id}/collect`,
    "POST",
    {
      answers: [
        { questionId: "dizzy", value: ["经常"], confidence: "exact" },
        { questionId: "bp", value: 200, confidence: "exact" },
        { questionId: "other", value: "想问复查时间", confidence: "manual" },
      ],
    },
  );
  assert.equal(collected.status, 200);
  assert.equal(collected.data.status, "collected");
  assert.equal(collected.data.score, 2);
  assert.ok(collected.data.alert);
  assert.match(collected.data.alert.message, /200mmHg高于180mmHg/);
  // 预警进入风险提醒,且重复评估不会被误清。
  await f.json("/api/risk-alerts/evaluate", "POST");
  let alerts = (await f.json(`/api/risk-alerts?patientId=${patient.id}`)).data.alerts;
  let surveyAlert = alerts.find((a) => a.ruleKey === `survey_${survey.id}`);
  assert.ok(surveyAlert, "问卷预警应存在");
  assert.equal(surveyAlert.status, "active");
  assert.equal(surveyAlert.severity, "warning");
  // 医生确认后,重评估保持 acknowledged(证据稳定)。
  await f.json(`/api/risk-alerts/${surveyAlert.id}/ack`, "POST");
  await f.json("/api/risk-alerts/evaluate", "POST");
  alerts = (await f.json(`/api/risk-alerts?patientId=${patient.id}`)).data.alerts;
  assert.equal(
    alerts.find((a) => a.ruleKey === `survey_${survey.id}`).status,
    "acknowledged",
  );
  // 自动生成联系记录(source=survey)且原随访提醒被完成。
  const records = f.server.followups
    .reminders({ patientId: patient.id, status: "done" })
    .filter((r) => r.source?.kind === "survey");
  assert.equal(records.length, 1);
  assert.match(records[0].outcome.note, /得分 2/);
  assert.equal(f.server.followups.reminders({ patientId: patient.id }).filter((r) => r.id === survey.reminderId && r.status === "pending").length, 0);
  // 已回收的问卷不可再回收/取消。
  const again = await f.json(
    `/api/patients/${patient.id}/followup-surveys/${survey.id}/collect`,
    "POST",
    { answers: collected.data.answers },
  );
  assert.equal(again.status, 409);
});

test("survey auto-collect from numbered chat replies completes without doctor action", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "自动回收患者" })).data;
  await f.json(`/api/patients/${patient.id}/followups`, "POST", {
    name: "月度随访计划",
    once: true,
    firstDueAt: new Date(Date.now() + 300).toISOString(),
    questionnaire: QUESTIONNAIRE,
  });
  const survey = await waitFor(async () => {
    const row = f.server.surveys.list(patient.id)[0];
    return row || null;
  });
  assert.ok(survey);
  f.server.surveys.save({ ...survey, status: "sent", channel: "wechat", sentAt: survey.createdAt });
  const summary = f.server.surveys.tryCollect(patient.id, "收到\n1. 偶尔\n2. 130");
  assert.match(summary, /问卷已回收，得分 1/);
  assert.equal(f.server.surveys.list(patient.id)[0].status, "collected");
  assert.equal(f.server.surveys.list(patient.id)[0].alert, null);
});

test("survey cancel requires revision and blocks collected rows", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "取消患者" })).data;
  await f.json(`/api/patients/${patient.id}/followups`, "POST", {
    name: "月度随访计划",
    once: true,
    firstDueAt: new Date(Date.now() + 300).toISOString(),
    questionnaire: QUESTIONNAIRE,
  });
  const survey = await waitFor(async () => f.server.surveys.list(patient.id)[0] || null);
  assert.ok(survey);
  const conflict = await f.json(
    `/api/patients/${patient.id}/followup-surveys/${survey.id}/cancel`,
    "POST",
    { revision: 99 },
  );
  assert.equal(conflict.status, 409);
  const cancelled = await f.json(
    `/api/patients/${patient.id}/followup-surveys/${survey.id}/cancel`,
    "POST",
    { revision: survey.revision },
  );
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, "cancelled");
  const collect = await f.json(
    `/api/patients/${patient.id}/followup-surveys/${survey.id}/collect`,
    "POST",
    { answers: [{ questionId: "dizzy", value: ["没有"] }, { questionId: "bp", value: 120 }] },
  );
  assert.equal(collect.status, 409);
});
