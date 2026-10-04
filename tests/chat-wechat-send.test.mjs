import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

const wechatReader = () => ({
  platform: "win32",
  status: async () => ({ ready: true, message: "已找到微信窗口" }),
  capture: async () => ({
    image: "c3ludGhldGlj",
    width: 1000,
    height: 800,
    lines: [{ text: "合成微信会话", confidence: 0.95, box: { x: 0.4, y: 0.1, width: 0.2, height: 0.03 } }],
  }),
  title: async () => "合成微信会话",
  read: async () => ({
    text: "合成可见文字：血压偏高",
    fingerprint: "frame1",
    evidence: { coverage: "visible-window", lines: [] },
  }),
  send: async (binding, text) => ({
    text,
    fingerprint: "sent1",
    evidence: { coverage: "verified-send", inputRatio: 0.9, sentRatio: 0.88 },
  }),
});

async function connected(t, overrides = {}) {
  const f = await fixture(t, { chatFollowups: { wechat: wechatReader(), ...overrides } });
  await f.json("/api/chat-followups/connections/wechat", "POST", {
    enabled: true,
    accountId: "synthetic-account",
    revision: 0,
  });
  const p = (await f.json("/api/patients", "POST", { name: "回复测试患者" })).data;
  const preview = (
    await f.json("/api/chat-followups/preview", "POST", { consent: true, title: "合成微信会话" })
  ).data;
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
      inputPoint: { x: 0.5, y: 0.85 },
    })
  ).data;
  assert.equal(binding.calibration.titleRegion, null);
  assert.equal(binding.calibration.inputPoint.y, 0.85);
  return { ...f, p, binding };
}

test("desktop reply requires fresh read, consent and a calibrated non-import binding", async (t) => {
  const f = await connected(t);
  const url = `/api/chat-followups/bindings/${f.binding.id}/send`;
  const noConsent = await f.json(url, "POST", { text: "回复", consent: false });
  assert.equal(noConsent.status, 412);
  const noRead = await f.json(url, "POST", { text: "回复", consent: true });
  assert.equal(noRead.status, 409);
  assert.match(noRead.data.error, /读取/);
  const sync = await f.json(
    "/api/chat-followups/connections/wechat/sync",
    "POST",
    { bindingId: f.binding.id, consent: true },
  );
  assert.equal(sync.status, 200);
  const ok = await f.json(url, "POST", { text: "回复内容：请按时服药", consent: true });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.sent, true);
  assert.equal(ok.data.coverage, "verified-send");
  const state = (await f.json(`/api/chat-followups/patients/${f.p.id}`)).data;
  const sent = state.inbox.filter((m) => m.direction === "out");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "回复内容：请按时服药");
  assert.equal(state.drafts.length, 1);
  assert.ok(!state.drafts.some((d) => d.sourceText?.includes("请按时服药")), "发出的消息不应生成草稿");
});

test("stale read window blocks desktop reply", async (t) => {
  const f = await connected(t);
  const s = f.server.chatFollowups;
  await s.sync("wechat", { bindingId: f.binding.id, consent: true });
  const rows = s.db.prepare("SELECT data FROM chat_messages ORDER BY rowid DESC LIMIT 1").all();
  const m = JSON.parse(rows[0].data);
  m.observedAt = new Date(Date.now() - 7200000).toISOString();
  s.db.prepare("UPDATE chat_messages SET data=? WHERE id=?").run(JSON.stringify(m), m.id);
  const reply = await f.json(`/api/chat-followups/bindings/${f.binding.id}/send`, "POST", {
    text: "回复",
    consent: true,
  });
  assert.equal(reply.status, 409);
  assert.match(reply.data.error, /1 小时/);
});

test("send failures surface lastError and never record a sent message", async (t) => {
  const failing = wechatReader();
  failing.send = async () => {
    const { AppError } = await import("../server/errors.mjs");
    throw new AppError("CHAT_SEND_VERIFY", "输入框内容未通过核验(匹配率 0.2)，已取消发送", 409);
  };
  const f = await fixture(t, { chatFollowups: { wechat: failing } });
  await f.json("/api/chat-followups/connections/wechat", "POST", {
    enabled: true,
    accountId: "synthetic-account",
    revision: 0,
  });
  const p = (await f.json("/api/patients", "POST", { name: "失败核验患者" })).data;
  const preview = (
    await f.json("/api/chat-followups/preview", "POST", { consent: true, title: "合成微信会话" })
  ).data;
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
  await f.json("/api/chat-followups/connections/wechat/sync", "POST", {
    bindingId: binding.id,
    consent: true,
  });
  const reply = await f.json(`/api/chat-followups/bindings/${binding.id}/send`, "POST", {
    text: "回复",
    consent: true,
  });
  assert.equal(reply.status, 409);
  assert.match(reply.data.error, /核验/);
  assert.equal(f.server.chatFollowups.config("wechat").lastError.includes("核验"), true);
  const state = (await f.json(`/api/chat-followups/patients/${p.id}`)).data;
  assert.equal(state.inbox.filter((m) => m.direction === "out").length, 0);
});

test("registry reports send capability for desktop only", async (t) => {
  const f = await fixture(t, { chatFollowups: { wechat: wechatReader() } });
  const settings = (await f.json("/api/chat-followups/settings")).data;
  const capabilities = Object.fromEntries(
    settings.connections.map((c) => [c.channel, c.plugin.capabilities.send]),
  );
  assert.equal(capabilities.wechat, true);
  assert.equal(capabilities["wx-cli"], false);
  assert.equal(capabilities.wecom, false);
});
