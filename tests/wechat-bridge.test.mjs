import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

const PROBE_OK = JSON.stringify({ ok: true, running: true, process: "WeChat" });
const READ = (texts) =>
  JSON.stringify({ ok: true, process: "WeChat", texts });
const SEND_OK = JSON.stringify({ ok: true });
const kind = (script) =>
  script.includes("AXStaticText")
    ? "read"
    : script.includes("keystroke")
      ? "send"
      : "probe";

function fakeRunner(log, outputs) {
  return async (script, args) => {
    const k = kind(script);
    log.push({ kind: k, args });
    if (outputs[k] instanceof Error) throw outputs[k];
    return typeof outputs[k] === "function" ? outputs[k](args) : outputs[k];
  };
}

test("wechat bridge is disabled by default and fails closed", async (t) => {
  const f = await fixture(t);
  const status = (await f.json("/api/wechat/status")).data;
  assert.equal(status.enabled, false);
  assert.equal(status.available, false);
  assert.match(status.reason, /MEDICAL_WECHAT_BRIDGE/);
  const patient = (
    await f.json("/api/patients", "POST", { name: "桥接患者" })
  ).data;
  const denied = await f.json("/api/wechat/read", "POST", {
    patientId: patient.id,
  });
  assert.equal(denied.status, 503);
  assert.equal(denied.data.code, "BRIDGE_DISABLED");
  const send = await f.json("/api/wechat/send", "POST", {
    patientId: patient.id,
    text: "不应发出",
  });
  assert.equal(send.status, 503);
  assert.equal(send.data.code, "BRIDGE_DISABLED");
});

test("readFrontChat archives window texts for one patient and deduplicates re-reads", async (t) => {
  const f = await fixture(t, { wechatBridge: true });
  const log = [];
  const texts = [
    "张三：今天血压 150/95，早上忘吃药了",
    "张三：今天血压 150/95，早上忘吃药了",
    "好的，明天上午来复诊",
  ];
  f.server.wechat.runner = fakeRunner(log, {
    probe: PROBE_OK,
    read: READ(texts),
  });
  const patient = (
    await f.json("/api/patients", "POST", { name: "张三", phone: "13800007777" })
  ).data;
  const first = await f.json("/api/wechat/read", "POST", {
    patientId: patient.id,
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.captured, 3);
  assert.equal(first.data.stored, 2);
  assert.equal(first.data.duplicates, 1);
  assert.equal(first.data.window, "WeChat");
  const messages = (await f.json(`/api/patients/${patient.id}/messages`)).data
    .messages;
  assert.ok(messages.every((m) => m.channel === "wechat-mac"));
  assert.ok(messages.every((m) => m.patientId === patient.id));
  const second = await f.json("/api/wechat/read", "POST", {
    patientId: patient.id,
  });
  assert.equal(second.data.stored, 0);
  assert.equal(second.data.duplicates, 3);
  assert.equal(log.filter((l) => l.kind === "probe").length, 1);
});

test("send uses the phone as contact, logs the outbound draft and refuses to act when WeChat is missing", async (t) => {
  const f = await fixture(t, { wechatBridge: true });
  const log = [];
  f.server.wechat.runner = fakeRunner(log, {
    probe: PROBE_OK,
    send: SEND_OK,
  });
  const patient = (
    await f.json("/api/patients", "POST", { name: "发送患者", phone: "13900005555" })
  ).data;
  const empty = await f.json("/api/wechat/send", "POST", {
    patientId: patient.id,
    text: "   ",
  });
  assert.equal(empty.status, 400);
  const sent = await f.json("/api/wechat/send", "POST", {
    patientId: patient.id,
    text: "明天上午 9 点复诊，请空腹。",
  });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.data, { sent: true, contact: "13900005555" });
  const sendCall = log.find((l) => l.kind === "send");
  assert.equal(sendCall.args[0], "13900005555");
  assert.equal(sendCall.args[1], "明天上午 9 点复诊，请空腹。");
  const messages = (await f.json(`/api/patients/${patient.id}/messages`)).data
    .messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].direction, "out");
  assert.equal(messages[0].channel, "wechat-mac");
  // Unavailable backend: no message is logged and the client sees 503.
  f.server.wechat.probe = {
    at: Date.now(),
    available: false,
    reason: "微信客户端未运行",
  };
  const refused = await f.json("/api/wechat/send", "POST", {
    patientId: patient.id,
    text: "不应发出",
  });
  assert.equal(refused.status, 503);
  assert.equal(refused.data.code, "BRIDGE_UNAVAILABLE");
  assert.equal(
    (await f.json(`/api/patients/${patient.id}/messages`)).data.messages.length,
    1,
  );
});

test("missing automation permission surfaces as an actionable 503 and is cached in status", async (t) => {
  const f = await fixture(t, { wechatBridge: true });
  const { AppError } = await import("../server/errors.mjs");
  f.server.wechat.runner = fakeRunner([], {
    probe: new AppError(
      "WECHAT_PERMISSION",
      "需要在 系统设置 → 隐私与安全性 → 辅助功能/自动化 中授权",
      503,
    ),
  });
  const patient = (
    await f.json("/api/patients", "POST", { name: "权限患者" })
  ).data;
  const denied = await f.json("/api/wechat/read", "POST", {
    patientId: patient.id,
  });
  assert.equal(denied.status, 503);
  assert.equal(denied.data.code, "WECHAT_PERMISSION");
  const status = (await f.json("/api/wechat/status")).data;
  assert.equal(status.available, false);
  assert.match(status.reason, /授权/);
});
