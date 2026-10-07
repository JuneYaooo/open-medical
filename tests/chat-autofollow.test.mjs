import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

const wechatReader = () => {
  const calls = { locate: [], pasted: [] };
  const reader = {
    platform: "win32",
    status: async () => ({ ready: true, message: "已找到微信窗口" }),
    capture: async () => ({
      image: "c3ludGhldGlj",
      width: 1000,
      height: 800,
      lines: [{ text: "合成微信会话", confidence: 0.95, box: { x: 0.4, y: 0.1, width: 0.2, height: 0.03 } }],
    }),
    title: async () => "合成微信会话",
    findAvatar: async () => ({ found: true, hash: "f1e0e1e1e1e1e1e1", region: { x: 0.16, y: 0.49, width: 0.13, height: 0.057 } }),
    locate: async (name, avatarHash) => {
      calls.locate.push({ name, avatarHash });
      return { snapshot: { image: "c3ludGhldGlj", width: 1000, height: 800, lines: [] }, navigated: true, nameVisible: true };
    },
    read: async () => ({
      text: "合成可见文字：血压偏高",
      fingerprint: "frame1",
      evidence: { coverage: "visible-window", lines: [] },
    }),
    send: async (binding, text) => {
      calls.pasted.push(text);
      return { text, fingerprint: "sent1", evidence: { coverage: "verified-send", inputRatio: 0.9, sentRatio: 0.88 } };
    },
    calls,
  };
  return reader;
};

const syntheticProvider = (overrides = {}) => {
  const calls = [];
  const provider = {
    model: "synthetic",
    baseUrl: "http://synthetic.invalid",
    complete: async (messages) => {
      calls.push(messages[0]?.content || "");
      const system = messages[0]?.content || "";
      if (overrides.outreach && system.includes("只输出消息正文")) return { message: { content: overrides.outreach } };
      if (overrides.extract && system.includes("整理成随访记录")) return { message: { content: JSON.stringify(overrides.extract) } };
      if (system.includes("只输出消息正文")) return { message: { content: "您好，请问今天血压测量了吗？最近有没有不舒服？" } };
      if (system.includes("整理成随访记录")) return { message: { content: JSON.stringify({ summary: "患者已回复：血压 135/85，无不适。", symptoms: "", medications: "", results: "血压 135/85", needsDoctor: false, reason: "" }) } };
      return { message: { content: "{}" } };
    },
    calls,
  };
  return provider;
};

async function setupWithDueJob(t, { provider, once = true } = {}) {
  const reader = wechatReader();
  const model = provider === null ? null : (provider || syntheticProvider());
  const f = await fixture(t, { chatFollowups: { wechat: reader }, chatAutoFollow: { provider: model } });
  await f.json("/api/chat-followups/connections/wechat", "POST", { enabled: true, accountId: "synthetic-account", revision: 0 });
  const p = (await f.json("/api/patients", "POST", { name: "自动随访患者" })).data;
  const preview = (await f.json("/api/chat-followups/preview", "POST", { consent: true, title: "合成微信会话" })).data;
  const binding = (
    await f.json("/api/chat-followups/bindings", "POST", {
      channel: "wechat",
      patientId: p.id,
      title: "合成微信会话",
      speakerName: "本人",
      relationship: "self",
      confirmed: true,
      previewId: preview.id,
      messageRegion: { x: 0.1, y: 0.25, width: 0.85, height: 0.6 },
    })
  ).data;
  const job = f.server.followups.create(p.id, {
    name: "术后30天随访",
    once,
    ...(once ? {} : { intervalDays: 30 }),
    firstDueAt: new Date(Date.now() + 60000).toISOString(),
    checklist: ["血压测量了吗", "有无不舒服"],
    externalConsent: true,
  });
  const mutable = f.server.followups.row(job.id);
  mutable.nextDue = Date.now() - 1000;
  f.server.followups.save(mutable);
  return { ...f, p, binding, job, reader };
}

test("outreach queue lists due jobs with wechat bindings and generates a screened draft", async (t) => {
  const f = await setupWithDueJob(t);
  const queue = (await f.json("/api/chat-autofollow/queue")).data;
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].patientName, "自动随访患者");
  assert.equal(queue.items[0].bindingId, f.binding.id);
  assert.equal(queue.items[0].outreach, null);
  const generated = (await f.json(`/api/chat-autofollow/${queue.items[0].jobId}/generate`, "POST", {})).data;
  assert.equal(generated.status, "draft");
  assert.match(generated.text, /血压/);
  assert.equal(generated.screen.ok, true);
  assert.equal(f.reader.calls.pasted.length, 0, "生成话术绝不发送");
});

test("doctor-confirmed send goes through the verified chain and harvests the reply", async (t) => {
  const f = await setupWithDueJob(t);
  const s = f.server.chatAutoFollow;
  const generated = (await f.json(`/api/chat-autofollow/${f.job.id}/generate`, "POST", {})).data;
  const noConsent = await f.json(`/api/chat-autofollow/${f.job.id}/send`, "POST", { text: generated.text, consent: false });
  assert.equal(noConsent.status, 412);
  const sent = await f.json(`/api/chat-autofollow/${f.job.id}/send`, "POST", { text: generated.text, consent: true });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.status, "sent");
  assert.deepEqual(f.reader.calls.locate.map((c) => c.name), ["合成微信会话"], "发送走自动定位链");
  assert.equal(f.reader.calls.pasted[0].includes("血压"), true);
  // 监听模式读到回复 → 入库钩子标记已回复
  s.harvest(f.binding, "血压135/85，没有不舒服");
  const replied = (await f.json(`/api/chat-autofollow/queue`)).data.items[0].outreach;
  assert.equal(replied.status, "replied");
  assert.deepEqual(replied.redFlags, []);
  const recorded = (await f.json(`/api/chat-autofollow/${f.job.id}/record`, "POST", {})).data;
  assert.match(recorded.record.summary, /血压/);
  assert.equal(recorded.record.needsDoctor, false);
  const archived = await f.json(`/api/chat-autofollow/${f.job.id}/archive`, "POST", {
    note: recorded.record.summary,
    contactedAt: new Date().toISOString(),
    confirmed: true,
  });
  assert.equal(archived.status, 201);
  assert.equal(archived.data.status, "recorded");
  assert.equal(f.server.followups.row(f.job.id).status, "completed", "一次性任务随归档完成");
  const records = f.server.store.db.prepare("SELECT COUNT(*) n FROM reminders WHERE patient_id=?").get(f.p.id).n;
  assert.ok(records >= 1, "随访联系记录已写入");
});

test("red-flag replies escalate to urgent and never auto-archive silently", async (t) => {
  const f = await setupWithDueJob(t);
  const s = f.server.chatAutoFollow;
  await f.json(`/api/chat-autofollow/${f.job.id}/generate`, "POST", {});
  await f.json(`/api/chat-autofollow/${f.job.id}/send`, "POST", { consent: true });
  s.harvest(f.binding, "今天胸口痛得厉害，还喘不上气");
  const item = (await f.json("/api/chat-autofollow/queue")).data.items[0].outreach;
  assert.equal(item.status, "replied");
  assert.equal(item.urgent, true);
  assert.ok(item.redFlags.some((label) => label.includes("胸") || label.includes("呼吸")), JSON.stringify(item.redFlags));
  const recorded = (await f.json(`/api/chat-autofollow/${f.job.id}/record`, "POST", {})).data;
  assert.equal(recorded.urgent, true, "红旗保持置顶");
  // 未确认不归档
  const refused = await f.json(`/api/chat-autofollow/${f.job.id}/archive`, "POST", { confirmed: false });
  assert.equal(refused.status, 412);
});

test("outreach text with dosage is screened but a doctor-reviewed send is not blocked", async (t) => {
  const f = await setupWithDueJob(t, { provider: syntheticProvider({ outreach: "请每天早上服用5毫克降压药并记录血压。" }) });
  const generated = (await f.json(`/api/chat-autofollow/${f.job.id}/generate`, "POST", {})).data;
  assert.equal(generated.screen.ok, false);
  assert.ok(generated.screen.reasons.some((r) => r.includes("剂量")));
  const sent = await f.json(`/api/chat-autofollow/${f.job.id}/send`, "POST", { consent: true });
  assert.equal(sent.status, 201, "医生确认后的发送不被筛查拦截");
  assert.equal(sent.data.screen.ok, false);
});

test("recurring jobs are archived as records but stay active for the next interval", async (t) => {
  const f = await setupWithDueJob(t, { once: false });
  await f.json(`/api/chat-autofollow/${f.job.id}/generate`, "POST", {});
  await f.json(`/api/chat-autofollow/${f.job.id}/send`, "POST", { consent: true });
  f.server.chatAutoFollow.harvest(f.binding, "都正常，血压正常");
  await f.json(`/api/chat-autofollow/${f.job.id}/record`, "POST", {});
  const archived = await f.json(`/api/chat-autofollow/${f.job.id}/archive`, "POST", { note: "周期随访正常", confirmed: true });
  assert.equal(archived.status, 201);
  assert.equal(f.server.followups.row(f.job.id).status, "active", "周期任务保持 active 等下个间隔");
});

test("queue without a wechat binding or model surfaces actionable errors", async (t) => {
  const f = await setupWithDueJob(t, { provider: null });
  const queue = (await f.json("/api/chat-autofollow/queue")).data;
  assert.equal(queue.items.length, 1, "队列仍列出到期任务");
  const noModel = await f.json(`/api/chat-autofollow/${f.job.id}/generate`, "POST", {});
  assert.equal(noModel.status, 503);
});
