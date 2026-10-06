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
  assert.match(reply.data.error, /画面基准|读取已打开的会话/);
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

const locatingReader = () => {
  const reader = wechatReader();
  const calls = { locate: [], avatar: 0 };
  reader.findAvatar = async () => {
    calls.avatar++;
    return { found: true, hash: "f1e0e1e1e1e1e1e1", region: { x: 0.16, y: 0.49, width: 0.13, height: 0.057 } };
  };
  reader.locate = async (name, avatarHash) => {
    calls.locate.push({ name, avatarHash });
    if (!calls.locateOk) {
      const { AppError } = await import("../server/errors.mjs");
      throw new AppError("CHAT_LOCATE", "会话列表中未找到「" + name + "」", 409);
    }
    return { snapshot: { image: "c3ludGhldGlj", width: 1000, height: 800, lines: [] }, navigated: true, nameVisible: true };
  };
  reader.calls = calls;
  return reader;
};

async function connectedByName(t, reader) {
  const f = await fixture(t, { chatFollowups: { wechat: reader } });
  await f.json("/api/chat-followups/connections/wechat", "POST", {
    enabled: true,
    accountId: "synthetic-account",
    revision: 0,
  });
  const p = (await f.json("/api/patients", "POST", { name: "按名关联患者" })).data;
  const preview = (
    await f.json("/api/chat-followups/preview", "POST", { consent: true, title: "June", locateName: "June" })
  ).data;
  assert.equal(preview.avatar.hash, "f1e0e1e1e1e1e1e1");
  const binding = (
    await f.json("/api/chat-followups/bindings", "POST", {
      channel: "wechat",
      patientId: p.id,
      title: "June",
      speakerName: "June",
      relationship: "self",
      confirmed: true,
      previewId: preview.id,
      inputPoint: { x: 0.5, y: 0.85 },
    })
  ).data;
  assert.equal(binding.calibration.titleRegion, null);
  assert.equal(binding.calibration.avatarHash, "f1e0e1e1e1e1e1e1");
  assert.equal(binding.calibration.messageRegion.x, 0.17);
  assert.equal(binding.calibration.inputPoint.y, 0.85);
  return { ...f, p, binding, reader };
}

test("name-based bind stores avatar fingerprint and autoLocate reply navigates without a fresh read", async (t) => {
  const reader = locatingReader();
  reader.calls.locateOk = true;
  const f = await connectedByName(t, reader);
  const reply = await f.json(`/api/chat-followups/bindings/${f.binding.id}/send`, "POST", {
    text: "自动定位回复",
    consent: true,
    autoLocate: true,
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.data));
  assert.equal(reply.data.coverage, "verified-send");
  assert.deepEqual(reader.calls.locate.map((c) => c.name), ["June", "June"]);
  assert.equal(reader.calls.locate[0].avatarHash, null, "预览阶段尚无头像指纹");
  assert.equal(reader.calls.locate[1].avatarHash, "f1e0e1e1e1e1e1e1", "发送时应携带关联时存下的头像指纹");
  const state = (await f.json(`/api/chat-followups/patients/${f.p.id}`)).data;
  assert.equal(state.inbox.filter((m) => m.direction === "out").length, 1);
});

test("autoLocate reply aborts with the locate error and records no message", async (t) => {
  const reader = locatingReader();
  reader.calls.locateOk = true;
  const f = await connectedByName(t, reader);
  reader.calls.locateOk = false;
  const reply = await f.json(`/api/chat-followups/bindings/${f.binding.id}/send`, "POST", {
    text: "不应发出",
    consent: true,
    autoLocate: true,
  });
  assert.equal(reply.status, 409);
  assert.match(reply.data.error, /未找到/);
  const state = (await f.json(`/api/chat-followups/patients/${f.p.id}`)).data;
  assert.equal(state.inbox.filter((m) => m.direction === "out").length, 0);
});

test("contacts endpoint lists visible conversation candidates on Windows only", async (t) => {
  const reader = locatingReader();
  reader.listNames = async () => ({ names: ["June", "李雷"] });
  const f = await fixture(t, { chatFollowups: { wechat: reader } });
  const disabled = await f.json("/api/chat-followups/contacts", "POST", { consent: true });
  assert.equal(disabled.status, 409);
  await f.json("/api/chat-followups/connections/wechat", "POST", {
    enabled: true,
    accountId: "synthetic-account",
    revision: 0,
  });
  const noConsent = await f.json("/api/chat-followups/contacts", "POST", { consent: false });
  assert.equal(noConsent.status, 412);
  const ok = await f.json("/api/chat-followups/contacts", "POST", { consent: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.names, ["June", "李雷"]);
  const mac = wechatReader();
  mac.platform = "darwin";
  const f2 = await fixture(t, { chatFollowups: { wechat: mac } });
  await f2.json("/api/chat-followups/connections/wechat", "POST", {
    enabled: true,
    accountId: "synthetic-account",
    revision: 0,
  });
  const refused = await f2.json("/api/chat-followups/contacts", "POST", { consent: true });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /Windows/);
});

test("refresh avatar re-locates by name and stores the new fingerprint without unbinding", async (t) => {
  const reader = locatingReader();
  reader.calls.locateOk = true;
  const f = await connectedByName(t, reader);
  reader.findAvatar = async () => ({
    found: true,
    hash: "0e11e1e1e1e1e102",
    region: { x: 0.16, y: 0.49, width: 0.13, height: 0.057 },
  });
  const noConsent = await f.json(`/api/chat-followups/bindings/${f.binding.id}/avatar`, "POST", { consent: false });
  assert.equal(noConsent.status, 412);
  const ok = await f.json(`/api/chat-followups/bindings/${f.binding.id}/avatar`, "POST", { consent: true });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.updated, true);
  assert.equal(ok.data.changed, true);
  assert.deepEqual(reader.calls.locate.map((c) => c.avatarHash), [null, null], "重抓按备注名定位，不携带旧指纹");
  const state = (await f.json(`/api/chat-followups/patients/${f.p.id}`)).data;
  assert.equal(state.bindings.find((b) => b.id === f.binding.id).calibration.avatarHash, "0e11e1e1e1e1e102");
});

test("refresh avatar keeps the old fingerprint when locate or capture fails", async (t) => {
  const reader = locatingReader();
  reader.calls.locateOk = true;
  const f = await connectedByName(t, reader);
  reader.calls.locateOk = false;
  const locateFail = await f.json(`/api/chat-followups/bindings/${f.binding.id}/avatar`, "POST", { consent: true });
  assert.equal(locateFail.status, 409);
  assert.match(locateFail.data.error, /未找到/);
  reader.calls.locateOk = true;
  reader.findAvatar = async () => ({ found: false });
  const noAvatar = await f.json(`/api/chat-followups/bindings/${f.binding.id}/avatar`, "POST", { consent: true });
  assert.equal(noAvatar.status, 409);
  assert.match(noAvatar.data.error, /未能抓取头像/);
  const state = (await f.json(`/api/chat-followups/patients/${f.p.id}`)).data;
  assert.equal(state.bindings.find((b) => b.id === f.binding.id).calibration.avatarHash, "f1e0e1e1e1e1e1e1");
});

test("autoLocate sync navigates to the binding conversation before reading", async (t) => {
  const reader = locatingReader();
  reader.calls.locateOk = true;
  const f = await connectedByName(t, reader);
  assert.equal(reader.calls.locate.length, 1, "预览阶段定位一次");
  const sync = await f.json("/api/chat-followups/connections/wechat/sync", "POST", {
    bindingId: f.binding.id,
    consent: true,
    autoLocate: true,
  });
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  assert.equal(reader.calls.locate.length, 2, "读取前按绑定备注名再定位一次");
  assert.equal(reader.calls.locate[1].name, "June");
  assert.equal(reader.calls.locate[1].avatarHash, "f1e0e1e1e1e1e1e1", "读取定位携带关联时的头像指纹");
  const state = (await f.json(`/api/chat-followups/patients/${f.p.id}`)).data;
  assert.equal(state.drafts.length, 1, "定位读取照常入库生成草稿");
});

test("manual sync reads the currently open conversation without navigation", async (t) => {
  const reader = locatingReader();
  reader.calls.locateOk = true;
  const f = await connectedByName(t, reader);
  const sync = await f.json("/api/chat-followups/connections/wechat/sync", "POST", {
    bindingId: f.binding.id,
    consent: true,
  });
  assert.equal(sync.status, 200);
  assert.equal(reader.calls.locate.length, 1, "未勾选自动定位时不导航");
});

test("failed autoLocate sync aborts before reading and records no draft", async (t) => {
  const reader = locatingReader();
  reader.calls.locateOk = true;
  const f = await connectedByName(t, reader);
  reader.calls.locateOk = false;
  const sync = await f.json("/api/chat-followups/connections/wechat/sync", "POST", {
    bindingId: f.binding.id,
    consent: true,
    autoLocate: true,
  });
  assert.equal(sync.status, 409);
  assert.match(sync.data.error, /未找到/);
  const state = (await f.json(`/api/chat-followups/patients/${f.p.id}`)).data;
  assert.equal(state.drafts.length, 0, "定位失败不得读取当前窗口");
});

test("autoLocate sync is ignored off Windows or without a locate-capable reader", async (t) => {
  const mac = wechatReader();
  mac.platform = "darwin";
  const f = await fixture(t, { chatFollowups: { wechat: mac } });
  await f.json("/api/chat-followups/connections/wechat", "POST", {
    enabled: true,
    accountId: "synthetic-account",
    revision: 0,
  });
  const p = (await f.json("/api/patients", "POST", { name: "平台差异患者" })).data;
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
      titleRegion: { x: 0.4, y: 0.02, width: 0.3, height: 0.06 },
      messageRegion: { x: 0.1, y: 0.25, width: 0.85, height: 0.6 },
    })
  ).data;
  const sync = await f.json("/api/chat-followups/connections/wechat/sync", "POST", {
    bindingId: binding.id,
    consent: true,
    autoLocate: true,
  });
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  const state = (await f.json(`/api/chat-followups/patients/${p.id}`)).data;
  assert.equal(state.drafts.length, 1);
});

test("bind preview and avatar refresh use the scanning grab when the viewport lacks an avatar", async (t) => {
  const reader = locatingReader();
  reader.calls.locateOk = true;
  reader.findAvatar = async () => ({ found: false });
  const grabs = [];
  reader.findAvatarScanning = async (_snapshot, _signal, band) => {
    grabs.push(band === undefined ? "default-band" : "binding-band");
    return { found: true, hash: "abcdabcdabcdabcd", region: { x: 0.16, y: 0.4, width: 0.13, height: 0.05 } };
  };
  const f = await fixture(t, { chatFollowups: { wechat: reader } });
  await f.json("/api/chat-followups/connections/wechat", "POST", {
    enabled: true,
    accountId: "synthetic-account",
    revision: 0,
  });
  const p = (await f.json("/api/patients", "POST", { name: "卡片视口患者" })).data;
  const preview = await f.json("/api/chat-followups/preview", "POST", { consent: true, title: "June", locateName: "June" });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(grabs, ["default-band"], "预览阶段用默认头像带扫描抓取");
  assert.equal(preview.data.avatar.hash, "abcdabcdabcdabcd", "卡片视口下也能取得头像指纹完成按名关联");
  const binding = (
    await f.json("/api/chat-followups/bindings", "POST", {
      channel: "wechat",
      patientId: p.id,
      title: "June",
      speakerName: "June",
      relationship: "self",
      confirmed: true,
      previewId: preview.data.id,
    })
  ).data;
  assert.equal(binding.calibration.avatarHash, "abcdabcdabcdabcd");
  const again = await f.json(`/api/chat-followups/bindings/${binding.id}/avatar`, "POST", { consent: true });
  assert.equal(again.status, 201);
  assert.deepEqual(grabs, ["default-band", "binding-band"], "重抓用绑定里的头像带扫描");
});
