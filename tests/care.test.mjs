import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { detectRedFlags, screenOutbound, SAFETY_REPLY, AI_DISCLAIMER } from "../server/care/red-flags.mjs";
import { normalizeTriage } from "../server/care/triage.mjs";
import { careTools } from "../server/care/tools.mjs";

function fakeProvider(respond) {
  const calls = [];
  return {
    calls,
    provider: { apiKey: "test", model: "fake-model", async complete(messages) { calls.push(messages); return { message: { content: JSON.stringify(respond(messages)) } }; } },
  };
}
function wecomFetch(log, syncPages = []) {
  return async (url, init = {}) => {
    const u = new URL(url);
    log.push({ path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    const reply = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/gettoken")) return reply(u.searchParams.get("corpsecret") === "badipsecret" ? { errcode: 60020 } : { errcode: 0, access_token: `tok-${u.searchParams.get("corpsecret")}`, expires_in: 7200 });
    if (u.pathname.endsWith("/get_follow_user_list")) return reply({ errcode: 0, follow_user: ["assistant1"] });
    if (u.pathname.endsWith("/kf/account/list")) return reply({ errcode: 0, account_list: [{ open_kfid: "wk1", name: "术后随访助手" }] });
    if (u.pathname.endsWith("/kf/send_msg")) return reply({ errcode: 0, msgid: `m${log.length}` });
    if (u.pathname.endsWith("/kf/sync_msg")) return reply({ errcode: 0, ...(syncPages.shift() || { msg_list: [], has_more: 0, next_cursor: "" }) });
    if (u.pathname.endsWith("/message/send")) return reply({ errcode: 0 });
    return reply({ errcode: 404 });
  };
}
async function setup(t, { respond, clock, wecom = { corpId: "corp1" }, kfPollMs = null } = {}) {
  const log = [], syncPages = [];
  const fake = respond ? fakeProvider(respond) : null;
  const f = await fixture(t, {
    ...(fake ? { provider: fake.provider } : {}),
    wecom,
    care: { fetch: wecomFetch(log, syncPages), intervalMs: 3600000, kfPollMs, ...(clock ? { now: () => clock.now } : {}) },
  });
  const patient = (await f.json("/api/patients", "POST", { name: "测试患者" })).data;
  return { ...f, log, syncPages, calls: fake?.calls, patient, care: f.server.care };
}
const enableKf = (f) => f.json("/api/care/settings", "PUT", { channels: { kf: { openKfId: "wk1", secret: "kfsecret" }, app: { agentId: "1000002", secret: "appsecret" } }, alerts: { notifyUserIds: ["doctor1"] } });

test("red flags and outbound screen are deterministic", () => {
  assert.deepEqual(detectRedFlags("昨晚开始胸口疼，喘不上气").map((f) => f.id).sort(), ["chest-pain", "dyspnea"]);
  assert.equal(detectRedFlags("请问复诊需要空腹吗").length, 0);
  assert.match(detectRedFlags("伤口有点渗液", ["渗液"])[0].label, /渗液/);
  assert.equal(screenOutbound("术后一周内避免剧烈运动，按时换药即可。").ok, true);
  assert.equal(screenOutbound("您把药量加到每次 20mg。").ok, false);
  assert.equal(screenOutbound("您这就是肺炎。").ok, false);
  assert.equal(screenOutbound("这是术后常见症状，一般会逐步缓解。").ok, true);
  // The model can never mark a non-routine message as auto-repliable.
  assert.equal(normalizeTriage({ category: "education", level: "attention", canAutoReply: true, reply: "x" }).canAutoReply, false);
});

test("rules-only mode records messages, and red flags always alert with a safety draft", async (t) => {
  const f = await setup(t);
  const plain = (await f.json("/api/care/ingest", "POST", { patientId: f.patient.id, text: "医生您好，复查要空腹吗？" })).data;
  const urgent = (await f.json("/api/care/ingest", "POST", { patientId: f.patient.id, text: "我爸突然说话不清楚，一侧手没力气" })).data;
  await f.care.tick();
  assert.equal(f.care.message(plain.id).state.status, "recorded");
  const state = f.care.message(urgent.id).state;
  assert.equal(state.status, "alerted");
  assert.equal(state.level, "urgent");
  const alerts = (await f.json("/api/care/alerts?status=open")).data.alerts;
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].reason, /卒中|红旗/);
  assert.equal(alerts[0].patientName, "测试患者");
  const drafts = (await f.json("/api/care/replies?status=draft")).data.replies;
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].text, SAFETY_REPLY);
  assert.equal(drafts[0].channel, "manual");
  const overview = (await f.json("/api/care/overview")).data;
  assert.equal(overview.stats.urgentAlerts, 1);
  assert.equal(overview.processing.modelConfigured, false);
  // History before the pipeline existed is never discovered.
  assert.equal((await f.json(`/api/care/alerts/${alerts[0].id}/resolve`, "POST", {})).data.status, "resolved");
  assert.equal(f.care.message(urgent.id).state.status, "handled");
});

test("consented patients get screened auto-replies over 微信客服; clinical questions stay drafts", async (t) => {
  const f = await setup(t, {
    respond: (messages) => {
      const data = JSON.parse(messages[1].content.split("\n")[1]).最近对话.at(-1).内容;
      if (data.includes("药")) return { category: "medication", level: "attention", canAutoReply: false, reply: "已转告医生。", sourceIds: [], reason: "用药调整需医生判断" };
      return { category: "education", level: "routine", canAutoReply: true, reply: "复查抽血需要空腹 8 小时。", sourceIds: ["K9"], reason: "科普" };
    },
  });
  const saved = (await enableKf(f)).data;
  assert.equal(saved.channels.kf.hasSecret, true);
  assert.equal(JSON.stringify(saved).includes("kfsecret"), false);
  await f.json("/api/care/settings", "PUT", { autoReply: { mode: "auto" }, processing: { modelConsent: true } });
  await f.json(`/api/care/patients/${f.patient.id}/settings`, "PUT", { consent: true, kfExternalUserId: "wmEXT1" });

  const edu = (await f.json("/api/care/ingest", "POST", { channel: "wecom-kf", kfExternalUserId: "wmEXT1", text: "复查要空腹吗？" })).data;
  assert.equal(edu.patientId, f.patient.id);
  await f.care.tick();
  assert.equal(f.care.message(edu.id).state.status, "auto_replied");
  const send = f.log.find((e) => e.path.endsWith("/kf/send_msg"));
  assert.equal(send.body.touser, "wmEXT1");
  assert.equal(send.body.open_kfid, "wk1");
  assert.ok(send.body.text.content.endsWith(AI_DISCLAIMER));
  // Prompt data carries no name; unknown source ids are dropped.
  assert.equal(f.calls[0][1].content.includes("测试患者"), false);
  const sent = (await f.json("/api/care/replies?status=sent")).data.replies[0];
  assert.deepEqual(sent.sources, []);
  assert.equal(sent.mode, "auto");
  const thread = (await f.json(`/api/care/patients/${f.patient.id}`)).data;
  assert.equal(thread.messages.at(-1).direction, "out");

  const med = (await f.json("/api/care/ingest", "POST", { channel: "wecom-kf", kfExternalUserId: "wmEXT1", text: "降压药能不能减半？" })).data;
  await f.care.tick();
  assert.equal(f.care.message(med.id).state.status, "alerted");
  assert.equal(f.log.filter((e) => e.path.endsWith("/kf/send_msg")).length, 1);
  assert.equal((await f.json("/api/care/replies?status=draft")).data.replies.length, 1);
  await new Promise((r) => setTimeout(r, 20));
  const notify = f.log.filter((e) => e.path.endsWith("/message/send"));
  assert.equal(notify[0].body.touser, "doctor1");

  // Without per-patient consent nothing is sent automatically.
  await f.json(`/api/care/patients/${f.patient.id}/settings`, "PUT", { consent: false });
  const again = (await f.json("/api/care/ingest", "POST", { channel: "wecom-kf", kfExternalUserId: "wmEXT1", text: "复查要空腹吗？还有别的吗" })).data;
  await f.care.tick();
  assert.equal(f.care.message(again.id).state.status, "drafted");
  assert.equal(f.log.filter((e) => e.path.endsWith("/kf/send_msg")).length, 1);
});

test("微信客服 callback sync records unknown customers as unassigned until assigned", async (t) => {
  const f = await setup(t);
  await enableKf(f);
  f.syncPages.push({ msg_list: [
    { msgid: "a1", external_userid: "wmNEW", origin: 3, send_time: Math.floor(Date.now() / 1000), msgtype: "text", text: { content: "你好，我是新患者" } },
    { msgid: "a2", external_userid: "wmNEW", origin: 4, send_time: Math.floor(Date.now() / 1000), msgtype: "event" },
  ], has_more: 0, next_cursor: "c1" });
  assert.deepEqual(await f.care.handleWecomEvent({ Event: "kf_msg_or_event", Token: "tk" }), { synced: 1 });
  assert.equal(f.log.find((e) => e.path.endsWith("/kf/sync_msg")).body.token, "tk");
  assert.equal(f.care.internal().kfCursor, "c1");
  const [msg] = (await f.json("/api/care/inbox?status=unassigned")).data.messages;
  assert.equal(msg.text, "你好，我是新患者");
  await f.json(`/api/care/messages/${msg.id}/assign`, "POST", { patientId: f.patient.id });
  assert.equal(f.care.patientSettings(f.patient.id).kfExternalUserId, "wmNEW");
  assert.equal(f.care.message(msg.id).patientId, f.patient.id);
  assert.notEqual(f.care.message(msg.id).state.status, "unassigned");
  // Redelivery is idempotent.
  f.syncPages.push({ msg_list: [{ msgid: "a1", external_userid: "wmNEW", origin: 3, send_time: 1, msgtype: "text", text: { content: "你好，我是新患者" } }], has_more: 0 });
  assert.deepEqual(await f.care.syncKf(), { synced: 0 });
});

test("chat proposals need confirmation; campaigns send, collect replies and write follow-up records", async (t) => {
  const clock = { now: Date.now() };
  const f = await setup(t, {
    clock,
    respond: (messages) => messages[0].content.includes("随访记录")
      ? { summary: "伤口愈合好，无发热。", symptoms: "无发热", medications: "按时服药", results: "", needsDoctor: false }
      : { category: "followup_reply", level: "routine", canAutoReply: false, reply: "", sourceIds: [], reason: "随访回复" },
  });
  await f.json("/api/care/settings", "PUT", { processing: { modelConsent: true } });
  const today = new Date(clock.now).toISOString().slice(0, 10);
  const created = (await f.json("/api/care/campaigns", "POST", { patientId: f.patient.id, name: "术后随访", startDate: today, steps: [{ dayOffset: 0, time: "00:00", text: "术后第一天，伤口怎么样？", questions: ["有没有发热？"] }] })).data;
  assert.equal(created.steps[0].status, "scheduled");
  await f.care.tick();
  // No consent: the step becomes a draft the doctor confirms.
  let campaign = f.care.campaign(created.id);
  assert.equal(campaign.steps[0].status, "draft");
  const draft = f.care.reply(campaign.steps[0].replyId);
  assert.match(draft.text, /1\. 有没有发热？/);
  assert.equal((await f.json(`/api/care/replies/${draft.id}/send`, "POST", {})).status, 400);
  assert.equal((await f.json(`/api/care/replies/${draft.id}/send`, "POST", { confirmed: true })).data.status, "sent");
  assert.equal(f.care.campaign(created.id).steps[0].status, "sent");

  const answer = (await f.json("/api/care/ingest", "POST", { patientId: f.patient.id, text: "伤口挺好的，没发烧", time: new Date(clock.now + 1000).toISOString() })).data;
  clock.now += 1000;
  await f.care.tick();
  assert.equal(f.care.message(answer.id).state.category, "followup_reply");
  assert.equal(f.care.campaign(created.id).steps[0].status, "replied");
  clock.now += 16 * 60000;
  await f.care.tick();
  campaign = f.care.campaign(created.id);
  assert.equal(campaign.steps[0].status, "recorded");
  assert.equal(campaign.status, "completed");
  assert.equal(campaign.steps[0].result.summary, "伤口愈合好，无发热。");
  const reminders = (await f.json(`/api/reminders?patientId=${f.patient.id}&status=done`)).data;
  const records = reminders.reminders || reminders.items || reminders;
  assert.ok(JSON.stringify(records).includes("伤口愈合好"));
});

test("chat care proposals apply only on doctor confirmation", async (t) => {
  const f = await setup(t);
  const tools = careTools(() => f.care, f.server.pendingActions);
  const run = (name, args) => tools.find((x) => x.definition.function.name === name).execute(args);
  const draft = await run("care_reply_draft", { patientId: f.patient.id, text: "您好，已收到。" });
  assert.equal(draft.status, "draft");

  const proposal = await run("care_send_propose", { patientId: f.patient.id, text: "明天记得复查。" });
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.payload.channel, "manual");
  assert.equal(f.care.replies({ status: "queued,sent" }).replies.length, 0);
  const confirmed = (await f.json(`/api/pending-actions/${proposal.id}/confirm`, "POST", {})).data;
  assert.equal(confirmed.applied.status, "queued");
  await f.care.tick();
  assert.equal(f.care.reply(confirmed.applied.id).status, "sent");

  // Care proposals don't conflict with unrelated record edits.
  const settings = await run("care_settings_propose", { scope: "patient", patientId: f.patient.id, changes: { consent: true } });
  f.server.patients.update(f.patient.id, { note: "改过档案", expectedRevision: f.server.patients.row(f.patient.id).revision });
  assert.equal((await f.json(`/api/pending-actions/${settings.id}/confirm`, "POST", {})).status, 200);
  assert.equal(f.care.patientSettings(f.patient.id).consent, true);

  const campaign = await run("care_campaign_propose", { patientId: f.patient.id, name: "一周随访", steps: [{ dayOffset: 7, text: "最近恢复得怎样？" }] });
  assert.equal(f.care.campaigns().campaigns.length, 0);
  await f.json(`/api/pending-actions/${campaign.id}/reject`, "POST", {});
  assert.equal(f.care.campaigns().campaigns.length, 0);
  assert.throws(() => f.care.normalizeProposal("care-settings", { scope: "global", changes: { channels: { kf: { secret: "x" } } } }), /设置页面/);
});

test("follow-up replies attach to the latest sent step, paused plans keep collecting, and late replies become supplements", async (t) => {
  // Records use the real clock, so the simulated days run in the past.
  const clock = { now: Date.now() - 8 * 86400000 };
  const f = await setup(t, {
    clock,
    respond: (messages) => messages[0].content.includes("随访记录")
      ? { summary: `整理：${messages[1].content.includes("补充") ? "补充" : "首次"}`, symptoms: "", medications: "", results: "", needsDoctor: false }
      : { category: "education", level: "routine", canAutoReply: true, reply: "好的。", sourceIds: [], reason: "x" },
  });
  await enableKf(f);
  await f.json("/api/care/settings", "PUT", { autoReply: { mode: "auto" }, processing: { modelConsent: true } });
  await f.json(`/api/care/patients/${f.patient.id}/settings`, "PUT", { consent: true, kfExternalUserId: "wmEXT1" });
  // 微信客服 can only send within 48 hours of the patient's last message.
  await f.json("/api/care/ingest", "POST", { channel: "wecom-kf", kfExternalUserId: "wmEXT1", text: "医生好", time: new Date(clock.now).toISOString() });
  await f.care.tick();
  const greeted = f.log.filter((e) => e.path.endsWith("/kf/send_msg")).length;
  const d = new Date(clock.now);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const yesterday = new Date(clock.now - 86400000);
  assert.equal((await f.json("/api/care/campaigns", "POST", { patientId: f.patient.id, name: "过去", startDate: `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`, steps: [{ dayOffset: 0, text: "x" }] })).status, 400);
  // Default start date is the local day, not the UTC day.
  const first = (await f.json("/api/care/campaigns", "POST", { patientId: f.patient.id, name: "用药随访", steps: [{ dayOffset: 0, time: "00:00", text: "按时吃药了吗？" }] })).data;
  assert.equal(first.startDate, today);
  await f.care.tick();
  clock.now += 60000;
  const second = (await f.json("/api/care/campaigns", "POST", { patientId: f.patient.id, name: "伤口随访", steps: [{ dayOffset: 0, time: "00:00", text: "伤口怎么样？" }, { dayOffset: 3, text: "拆线了吗？" }] })).data;
  await f.care.tick();
  assert.equal(f.care.campaign(first.id).steps[0].status, "sent");
  assert.equal(f.care.campaign(second.id).steps[0].status, "sent");
  const kfSends = () => f.log.filter((e) => e.path.endsWith("/kf/send_msg")).length - greeted;
  assert.equal(kfSends(), 2);

  await f.json(`/api/care/campaigns/${second.id}/pause`, "POST", {});
  clock.now += 1000;
  const answer = (await f.json("/api/care/ingest", "POST", { channel: "wecom-kf", kfExternalUserId: "wmEXT1", text: "伤口挺好", time: new Date(clock.now).toISOString() })).data;
  await f.care.tick();
  // Linked to the newer plan even though it is paused, and never auto-answered.
  assert.deepEqual(f.care.campaign(second.id).steps[0].messageIds, [answer.id]);
  assert.deepEqual(f.care.campaign(first.id).steps[0].messageIds, []);
  assert.equal(f.care.message(answer.id).state.category, "followup_reply");
  assert.equal(kfSends(), 2);

  clock.now += 16 * 60000;
  await f.care.tick();
  let step = f.care.campaign(second.id).steps[0];
  assert.equal(step.status, "recorded", step.detail);
  assert.equal(f.care.campaign(second.id).status, "paused");
  assert.equal(f.server.store.db.prepare("SELECT processed FROM patient_messages WHERE id=?").get(answer.id).processed, 1);

  clock.now += 3600000;
  const late = (await f.json("/api/care/ingest", "POST", { channel: "wecom-kf", kfExternalUserId: "wmEXT1", text: "补充：有点痒", time: new Date(clock.now).toISOString() })).data;
  await f.care.tick();
  clock.now += 16 * 60000;
  await f.care.tick();
  step = f.care.campaign(second.id).steps[0];
  assert.equal(step.status, "recorded");
  assert.equal(step.records.length, 2);
  assert.deepEqual(step.records[1].messageIds, [late.id]);
  const records = (await f.json(`/api/reminders?patientId=${f.patient.id}&status=done`)).data;
  const list = records.reminders || records.items || records;
  const campaignRecords = list.filter((r) => r.source?.kind === "campaign");
  assert.equal(campaignRecords.length, 2);
  assert.ok(campaignRecords.some((r) => r.title.includes("补充回复")));
  assert.equal(campaignRecords[0].detail, "随访计划自动收集");

  // The first plan's step gets no reply; its no-reply record and alert don't collide or repeat.
  clock.now += 3 * 86400000;
  await f.care.tick();
  await f.care.tick();
  assert.equal(f.care.campaign(first.id).steps[0].status, "no_reply");
  const noReply = f.care.alerts({ status: "open" }).alerts.filter((a) => a.reason.includes("未收到回复"));
  assert.equal(noReply.length, 1);
  // A step that came due while its plan was paused is skipped on resume, not sent late.
  clock.now += 2 * 86400000;
  await f.json(`/api/care/campaigns/${second.id}/resume`, "POST", {});
  await f.care.tick();
  assert.equal(f.care.campaign(second.id).steps[1].status, "skipped");
  assert.equal(kfSends(), 2);
});

test("cancelling a plan withdraws its unsent drafts, and archived patients pause instead of failing", async (t) => {
  const f = await setup(t);
  const c = (await f.json("/api/care/campaigns", "POST", { patientId: f.patient.id, name: "术后", steps: [{ dayOffset: 0, time: "00:00", text: "还好吗？" }, { dayOffset: 7, text: "一周了" }] })).data;
  await f.care.tick();
  const step = f.care.campaign(c.id).steps[0];
  assert.equal(step.status, "draft");
  await f.json(`/api/care/campaigns/${c.id}/cancel`, "POST", {});
  assert.equal(f.care.reply(step.replyId).status, "discarded");
  assert.deepEqual(f.care.campaign(c.id).steps.map((s) => s.status), ["cancelled", "cancelled"]);

  const other = (await f.json("/api/care/campaigns", "POST", { patientId: f.patient.id, name: "复查", steps: [{ dayOffset: 1, text: "记得复查" }] })).data;
  f.server.store.db.prepare("UPDATE patients SET data=json_set(data,'$.archived',json('true')) WHERE id=?").run(f.patient.id);
  await f.care.tick();
  await f.care.tick();
  const paused = f.care.campaign(other.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.steps[0].status, "scheduled");
  assert.equal(f.care.alerts({ status: "open" }).alerts.length, 0);
});

test("WeCom credentials are set on the settings page, stay write-only, and the connection test explains failures", async (t) => {
  const f = await setup(t, { wecom: {} });
  assert.equal((await f.json("/api/wecom/status")).data.configured, false);
  assert.equal((await f.json("/api/care/settings", "PUT", { channels: { corp: { corpId: "bad id!" } } })).status, 400);
  const saved = (await f.json("/api/care/settings", "PUT", { channels: { corp: { corpId: "ww1234567890", corpSecret: "contactsecret123" }, kf: { openKfId: "wk1", secret: "kfsecret" } } })).data;
  assert.equal(saved.channels.corp.corpId, "ww1234567890");
  assert.equal(saved.channels.corp.hasContactSecret, true);
  assert.equal(saved.channels.corp.from.corpSecret, "settings");
  assert.equal(JSON.stringify(saved).includes("contactsecret123"), false);
  assert.equal((await f.json("/api/wecom/status")).data.configured, true);
  // Blank keeps the stored secret.
  await f.json("/api/care/settings", "PUT", { channels: { corp: { corpId: "ww1234567890", corpSecret: "" } } });
  assert.equal(f.server.wecom.corpSecret, "contactsecret123");

  let tested = (await f.json("/api/care/settings/test", "POST", {})).data.results;
  assert.match(tested.find((r) => r.id === "contact").detail, /assistant1/);
  assert.match(tested.find((r) => r.id === "kf").detail, /术后随访助手/);
  assert.equal(tested.find((r) => r.id === "app").ok, null);
  await f.json("/api/care/settings", "PUT", { channels: { kf: { secret: "badipsecret" } } });
  tested = (await f.json("/api/care/settings/test", "POST", {})).data.results;
  assert.equal(tested.find((r) => r.id === "kf").ok, false);
  assert.match(tested.find((r) => r.id === "kf").detail, /可信 IP/);
});

test("微信客服 is polled without callbacks, backs off on errors, keeps first-sync history untriaged and respects the 48h window", async (t) => {
  const clock = { now: Date.now() };
  const f = await setup(t, { clock, kfPollMs: 60000 });
  await enableKf(f);
  await f.json(`/api/care/patients/${f.patient.id}/settings`, "PUT", { kfExternalUserId: "wmEXT1" });
  const now = Math.floor(clock.now / 1000);
  f.syncPages.push({ msg_list: [
    { msgid: "old1", external_userid: "wmEXT1", origin: 3, send_time: now - 2 * 86400, msgtype: "text", text: { content: "两天前的消息" } },
    { msgid: "new1", external_userid: "wmEXT1", origin: 3, send_time: now, msgtype: "text", text: { content: "刚发的消息" } },
  ], has_more: 0, next_cursor: "c1" });
  await f.care.tick();
  const pulls = () => f.log.filter((e) => e.path.endsWith("/kf/sync_msg"));
  assert.equal(pulls().length, 1);
  assert.equal(pulls()[0].body.token, undefined);
  const thread = (await f.json(`/api/care/patients/${f.patient.id}`)).data.messages;
  assert.equal(thread.find((m) => m.text === "两天前的消息").state.status, "recorded");
  assert.notEqual(thread.find((m) => m.text === "刚发的消息").state.status, "pending");
  assert.equal(f.care.overview().kfSync.lastError, null);

  await f.care.tick();
  assert.equal(pulls().length, 1);
  clock.now += 61000;
  f.syncPages.push({ errcode: 45009 });
  await f.care.tick();
  assert.equal(pulls().length, 2);
  assert.match(f.care.overview().kfSync.lastError, /太频繁/);
  clock.now += 61000;
  await f.care.tick();
  assert.equal(pulls().length, 2, "backs off after an error");
  clock.now += 5 * 60000;
  await f.care.tick();
  assert.equal(pulls().length, 3);
  assert.equal(pulls()[2].body.cursor, "c1");

  // Within 48h of the patient's message 微信客服 is used; afterwards it falls back to manual.
  assert.equal((await f.json("/api/care/replies", "POST", { patientId: f.patient.id, text: "收到。" })).data.channel, "wecom-kf");
  clock.now += 49 * 3600000;
  assert.equal((await f.json("/api/care/replies", "POST", { patientId: f.patient.id, text: "收到。" })).data.channel, "manual");
});

test("member-confirmed 客户联系 sends are re-checked until WeCom reports the result", async (t) => {
  const clock = { now: Date.now() };
  const f = await setup(t, { clock });
  const wecom = f.care.channels.wecom;
  const results = ["awaiting_member", "sent"];
  wecom.client = {};
  wecom.refresh = async () => ({ status: results.shift(), detail: "企业微信报告已发送（不代表已读）。" });
  const reply = f.care.createReply({ patientId: f.patient.id, text: "复查提醒", channel: "wecom-contact", status: "draft" });
  f.server.store.db.prepare("UPDATE care_replies SET status='awaiting_member', data=json_set(data,'$.externalId','task1','$.sentAt',?) WHERE id=?").run(new Date(clock.now).toISOString(), reply.id);
  await f.care.tick();
  assert.equal(f.care.reply(reply.id).status, "awaiting_member");
  await f.care.tick();
  assert.equal(results.length, 1, "not re-checked within 10 minutes");
  clock.now += 11 * 60000;
  await f.care.tick();
  assert.equal(f.care.reply(reply.id).status, "sent");
});
