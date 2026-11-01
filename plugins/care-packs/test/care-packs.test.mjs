import "../../../tests/helpers/fixed-clock.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createScriptedProvider } from "../../../tests/helpers/scripted-provider.mjs";
import { startTestServer } from "../../../tests/helpers/server.mjs";
import { localCalendarDate } from "../../../shared/calendar-date.mjs";
import { loadPacks } from "../server/service.mjs";
import { followupToolPlugins } from "../../followup/tools.mjs";

const PACK_DIR = fileURLToPath(new URL("../packs", import.meta.url));

test("专病包：内置包内容全部通过问卷与模板校验", () => {
  const packs = loadPacks(PACK_DIR);
  assert.deepEqual(packs.map((pack) => pack.id).sort(), ["diabetes", "hypertension"]);
  for (const pack of packs) {
    assert.ok(pack.plan.nodes.some((node) => node.questionnaire), `${pack.id} 至少一份问卷`);
    assert.ok(pack.labMonitors.length >= 1, `${pack.id} 至少一项检验监测`);
    assert.ok(pack.education.length >= 3, `${pack.id} 至少三篇患教`);
  }
});

test("专病包：安装模板与患教，重复安装不覆盖素材；入组提案确认后生成随访与监测", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]) });
  t.after(() => app.close());

  const before = await app.request("/api/p/care-packs/packs");
  assert.equal(before.status, 200);
  const htn = before.body.packs.find((pack) => pack.id === "hypertension");
  assert.equal(htn.installed, null);

  const installed = await app.request("/api/p/care-packs/packs/hypertension/install", { method: "POST", body: {} });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  assert.equal(installed.body.planId, "pack_hypertension");
  assert.equal(installed.body.education.imported.length, htn.education.length);

  const again = await app.request("/api/p/care-packs/packs/hypertension/install", { method: "POST", body: {} });
  assert.equal(again.body.education.imported.length, 0);
  assert.equal(again.body.education.skipped.length, htn.education.length, "医生可能已编辑同名素材，不覆盖");

  const after = await app.request("/api/p/care-packs/packs");
  assert.equal(after.body.packs.find((pack) => pack.id === "hypertension").upToDate, true);

  const [patient] = await app.patients();
  const proposed = await app.request("/api/p/care-packs/packs/hypertension/apply", {
    method: "POST",
    body: { patientId: patient.id, startDate: localCalendarDate() },
  });
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  const confirmed = await app.request(`/api/pending-actions/${proposed.body.proposal.id}/confirm`, { method: "POST", body: {} });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.applied.followups, htn.nodes.length);
  assert.equal(confirmed.body.applied.monitors, htn.labMonitors.length);

  const monitors = await app.request(`/api/patients/${patient.id}/lab-monitors`);
  assert.equal(monitors.body.monitors.filter((m) => m.note.startsWith("高血压管理包")).length, htn.labMonitors.length);

  // 再次入组：随访按模板再排一轮由医生决定，监测不重复添加。
  const second = await app.request("/api/p/care-packs/packs/hypertension/apply", {
    method: "POST",
    body: { patientId: patient.id, startDate: localCalendarDate() },
  });
  const secondConfirmed = await app.request(`/api/pending-actions/${second.body.proposal.id}/confirm`, { method: "POST", body: {} });
  if (secondConfirmed.status === 200) assert.equal(secondConfirmed.body.applied.monitors, 0);
});

test("随访问卷工具：预览提示阈值问题，模板提案确认后保存问卷，可应用到患者", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]) });
  t.after(() => app.close());
  const host = app.server.pluginHost;
  const tools = Object.fromEntries(
    followupToolPlugins(host.contextFor(host.byId.get("followup")), { messaging: false })
      .map((item) => [item.definition.function.name, item.execute]),
  );
  const questionnaire = {
    title: "术后 1 周",
    questions: [
      { text: "伤口疼痛程度？", type: "single", required: true, options: [{ label: "不痛", score: 0 }, { label: "有点痛", score: 1 }, { label: "很痛", score: 2 }] },
      { text: "今天最高体温？", type: "number", unit: "℃", alertIf: { op: "gt", value: 38.5 } },
    ],
    scoring: { alert: { op: "gte", value: 5 } },
  };
  const preview = tools.questionnaire_preview({ questionnaire });
  assert.match(preview.patientText, /【随访问卷】术后 1 周/);
  assert.deepEqual(preview.scoreRange, { min: 0, max: 2 });
  assert.ok(preview.notes.some((note) => note.includes("永远不会触发")));

  const proposal = tools.followup_plan_propose({
    name: "术后快速随访",
    nodes: [{ offsetDays: 7, title: "术后 1 周", items: ["伤口情况"], questionnaire: { ...questionnaire, scoring: { alert: { op: "gte", value: 2 } } } }],
  });
  const confirmed = await app.request(`/api/pending-actions/${proposal.id}/confirm`, { method: "POST", body: {} });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const planId = confirmed.body.applied.id;
  const plans = tools.followup_plans_list();
  const saved = plans.plans.find((plan) => plan.id === planId);
  assert.equal(saved.nodes[0].questionnaire, "术后 1 周", "自建模板保留问卷");

  const [patient] = await app.patients();
  const applyProposal = tools.followup_plan_apply_propose({ patientId: patient.id, planId, startDate: localCalendarDate() });
  const applied = await app.request(`/api/pending-actions/${applyProposal.id}/confirm`, { method: "POST", body: {} });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.applied[0].questionnaire.title, "术后 1 周");
});

const PLUGIN_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHANNEL_FAKE = fileURLToPath(new URL("../../../tests/fixtures/plugins/channel-fake", import.meta.url));

test("闭环：专病包入组 → 问卷到期进待办 → 企业微信客户联系下发 → 患者回复自动计分 → 预警", async (t) => {
  const app = await startTestServer({
    provider: createScriptedProvider([]),
    serverOptions: { pluginDirs: [PLUGIN_ROOT, CHANNEL_FAKE] },
  });
  t.after(() => app.close());
  const host = app.server.pluginHost;
  const followup = host.pluginServices.followup;
  const db = app.server.store.db;
  const [patient] = await app.patients();

  // 1. 设置页入组：提案 + 确认，随访与监测一次排好。
  const proposed = await app.request("/api/p/care-packs/packs/hypertension/apply", {
    method: "POST",
    body: { patientId: patient.id, startDate: localCalendarDate() },
  });
  const confirmed = await app.request(`/api/pending-actions/${proposed.body.proposal.id}/confirm`, { method: "POST", body: {} });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

  // 2. 第 7 天的问卷节点到期：生成提醒和待下发问卷，待办写明“问卷待下发”。
  const row = db
    .prepare("SELECT data FROM follow_ups WHERE patient_id=? AND json_extract(data,'$.questionnaire.title')=?")
    .get(patient.id, "降压治疗第 1 周自测");
  assert.ok(row, "入组后生成带问卷的随访节点");
  await followup.followups.execute(JSON.parse(row.data));
  const overview = await app.request(`/api/doctor/overview?limit=50&patientId=${patient.id}`);
  const item = overview.body.items.find((entry) => entry.patientId === patient.id && /问卷「降压治疗第 1 周自测」待下发/.test(entry.detail || ""));
  assert.ok(item, "今日待办提示问卷待下发");
  const surveys = (await app.request(`/api/patients/${patient.id}/followup-surveys`)).body.surveys;
  const survey = surveys.find((entry) => entry.questionnaire.title === "降压治疗第 1 周自测");
  assert.equal(survey.status, "pending_send");

  // 3. 未连接患者渠道：企业微信下发被拦，手动复制发送仍可用。
  host.pluginServices["channel-fake"].setConnected(false);
  const blocked = await app.request(`/api/patients/${patient.id}/followup-surveys/${survey.id}/send`, {
    method: "POST", body: { channel: "wecom-contact", consent: true },
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "PATIENT_CHANNEL_NOT_CONNECTED");
  const manual = await app.request(`/api/patients/${patient.id}/followup-surveys/${survey.id}/send`, {
    method: "POST", body: { channel: "manual", consent: true },
  });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.match(manual.body.text, /降压治疗第 1 周自测/);
  host.pluginServices["channel-fake"].setConnected(true);

  // 4. 企业微信客户联系下发：走 CareEngine 的通道（这里替换为假发送）。
  const sent = [];
  followup.care.targets = () => ({ bindingId: "binding-1", kfExternalUserId: null });
  followup.care.channels.send = async (channel, input) => {
    sent.push({ channel, ...input });
    return { status: "awaiting_member", externalId: "task-1", detail: "已生成群发任务，需成员在企业微信确认发送" };
  };
  const delivered = await app.request(`/api/patients/${patient.id}/followup-surveys/${survey.id}/send`, {
    method: "POST", body: { channel: "wecom-contact", consent: true },
  });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.survey.channel, "wecom-contact");
  assert.match(delivered.body.survey.channelDetail, /成员在企业微信确认/);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /【随访问卷】降压治疗第 1 周自测/);

  // 5. 患者在企业微信按题号回复：不依赖模型分诊，本地解析计分并触发预警。
  const { id: messageId } = followup.care.ingest({
    patientId: patient.id,
    channel: "wecom-contact",
    direction: "in",
    text: "1. 185\n2. 100\n3. 偶尔\n4. 都没有",
    externalId: "wecom-msg-survey-1",
  });
  await followup.care.tick();
  const after = (await app.request(`/api/patients/${patient.id}/followup-surveys?surveyId=${survey.id}`)).body.surveys[0];
  assert.equal(after.status, "collected");
  assert.equal(after.score, 1);
  assert.match(after.alert.message, /收缩压/);
  const state = followup.care.message(messageId).state;
  assert.equal(state.status, "handled");
  assert.equal(state.category, "survey_reply");

  // 6. 回收后立即重算风险规则：预警进入风险提醒和今日待办，不用等下次评估。
  const alert = db
    .prepare("SELECT id FROM risk_alerts WHERE patient_id=? AND rule_key=? AND status='active'")
    .get(patient.id, `survey_${survey.id}`);
  assert.ok(alert, "问卷预警进入风险提醒");
  const agenda = await app.request(`/api/doctor/overview?limit=50&patientId=${patient.id}`);
  assert.ok(agenda.body.items.some((entry) => entry.patientId === patient.id && /随访问卷预警/.test(entry.title || "")), "今日待办出现问卷预警");
});

test("从随访管理套用专病包模板：单独补加检验监测，不重复", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]) });
  t.after(() => app.close());
  const [patient] = await app.patients();
  const first = await app.request("/api/p/care-packs/packs/diabetes/monitors", { method: "POST", body: { patientId: patient.id } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.monitors, 2);
  const again = await app.request("/api/p/care-packs/packs/diabetes/monitors", { method: "POST", body: { patientId: patient.id } });
  assert.equal(again.body.monitors, 0);
  assert.equal(again.body.monitorsSkipped, 2);
});
