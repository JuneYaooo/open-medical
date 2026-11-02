import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  chunkText,
  deidentifyViaService,
  maskIdentities,
  reidentifyProposal,
  rulesDeidentify,
  rulesIdentity,
} from "../../server/medical/privacy.mjs";
import { createScriptedProvider, textTurn, toolCall } from "../helpers/scripted-provider.mjs";
import { startTestServer } from "../helpers/server.mjs";
import { redactionRects, replacedSpans } from "../../server/medical/image-redact.mjs";
import { createRequire } from "node:module";

const sharp = createRequire(import.meta.url)("sharp");

const RECORD = `入院记录
姓名：赵测试  性别：男  年龄：58岁  出生日期：1967-03-12
住院号：ZY20260011  身份证号：110101196703120015  电话：13912345678
住址：北京市朝阳区测试路18号院3号楼
联系人：钱测试（妻子） 13800001111
现病史：患者赵测试3年前诊断2型糖尿病，口服二甲双胍。2026-09-01 查HbA1c 8.6%。
主治医师：孙医生`;
const SECRETS = ["赵测试", "钱测试", "13912345678", "13800001111", "110101196703120015", "ZY20260011", "测试路18号", "1967-03-12"];

// 假 OCR 结果：600×200 的图上三行，坐标为 [x1,y1,x2,y2] 像素。
const OCR_RECORDS = [
  { text: "姓名：赵测试", box: [20, 20, 320, 60], score: 0.99 },
  { text: "电话：13912345678", box: [20, 80, 420, 120], score: 0.99 },
  { text: "诊断：2型糖尿病", box: [20, 140, 320, 180], score: 0.99 },
];

// 假 gpu-worker：实现 /v1/deidentify、/v1/identity、/v1/ocr/records 的契约。
async function fakeWorker({ verified = true, fail = false } = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const request = new Request(`http://x${req.url}`, { method: req.method, headers: req.headers, body: req, duplex: "half" });
    const form = await request.formData();
    const text = typeof form.get("text") === "string" ? form.get("text") : "";
    calls.push({ path: req.url, auth: req.headers.authorization, text });
    res.setHeader("content-type", "application/json");
    if (fail) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ detail: "model not ready" }));
    }
    if (req.url === "/v1/ocr/records")
      return res.end(JSON.stringify({ records: OCR_RECORDS }));
    if (req.url === "/v1/identity")
      return res.end(JSON.stringify({ identity: { name: "赵测试", gender: "男", birth_date: "1967-03-12" }, model: "fake" }));
    let out = text;
    for (const [from, to] of [["赵测试", "[患者姓名]"], ["钱测试", "[联系人]"], ["北京市朝阳区测试路18号院3号楼", "[地址]"]]) out = out.split(from).join(to);
    out = out.replace(/1[3-9]\d{9}/g, "[电话]").replace(/\d{17}[\dX]/g, "[身份证号]").replace(/ZY\d+/g, "[医疗编号]").replace(/1967-03-12/g, "[出生日期]");
    res.end(JSON.stringify({ text: out, pii_deidentified: true, verified, policy_version: "cn-medical-pii-v2" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

const waitFor = async (fn, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("本地规则：打码带标签的身份字段、证件号、电话和已知姓名，保留临床内容", () => {
  const out = rulesDeidentify(RECORD, ["赵测试"]);
  for (const secret of SECRETS.filter((s) => s !== "钱测试")) assert.ok(!out.includes(secret), `应打码 ${secret}`);
  assert.ok(out.includes("[联系人]"));
  for (const keep of ["孙医生", "HbA1c 8.6%", "2026-09-01", "二甲双胍", "性别：男"]) assert.ok(out.includes(keep), `应保留 ${keep}`);
  assert.deepEqual(rulesIdentity(RECORD), { name: "赵测试", gender: "男", birthDate: "1967-03-12", age: "58" });
});

test("长文本按行切块，拼回后与原文一致", () => {
  const text = Array.from({ length: 400 }, (_, i) => `第${i}行 血糖 7.${i % 10}`).join("\n");
  const chunks = chunkText(text, 500);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every((c) => c.length <= 500));
  assert.equal(chunks.join(""), text);
});

test("服务脱敏：带鉴权分块调用，拒绝未复检的结果", async (t) => {
  const worker = await fakeWorker();
  t.after(worker.close);
  const result = await deidentifyViaService({ baseUrl: worker.url, apiKey: "k1" }, `${RECORD}\n`.repeat(12));
  assert.ok(worker.calls.length >= 2, "长文本应分块");
  assert.ok(worker.calls.every((c) => c.auth === "Bearer k1"));
  for (const secret of SECRETS) assert.ok(!result.text.includes(secret), secret);
  assert.equal(result.policy, "cn-medical-pii-v2");
  const unverified = await fakeWorker({ verified: false });
  t.after(unverified.close);
  await assert.rejects(deidentifyViaService({ baseUrl: unverified.url }, RECORD), { code: "PRIVACY_SERVICE" });
});

test("建档回填：占位符换成本机身份，工具结果回给模型前再遮掉", () => {
  const sources = [{ privacy: { identity: { name: "赵测试", gender: "男", birthDate: "1967-03-12" } } }];
  const { args, filled } = reidentifyProposal(
    "patient_create_propose",
    { name: "[患者姓名]", phone: "[电话]", clinicalSummary: { text: "[患者姓名]糖尿病3年", source: "入院记录" } },
    sources,
    { findPatients: () => [] },
  );
  assert.deepEqual(filled, ["name", "gender", "birthYear"]);
  assert.equal(args.name, "赵测试");
  assert.equal(args.gender, "male");
  assert.equal(args.birthYear, 1967);
  assert.ok(!("phone" in args), "占位符电话不能写入档案");
  assert.equal(args.clinicalSummary.text, "赵测试糖尿病3年");
  const masked = maskIdentities({ payload: args }, sources.map((s) => s.privacy.identity));
  assert.ok(!JSON.stringify(masked).includes("赵测试"));
  const conflict = reidentifyProposal("patient_create_propose", { name: "[患者姓名]" }, [
    { privacy: { identity: { name: "甲" } } },
    { privacy: { identity: { name: "乙某" } } },
  ]);
  assert.equal(conflict.args.name, "[患者姓名]");
  assert.match(conflict.args.note, /多个姓名/);
});

test("开启脱敏：模型只看到脱敏资料，建档提案在本机回填真实身份", async (t) => {
  const worker = await fakeWorker();
  t.after(worker.close);
  const provider = createScriptedProvider([
    toolCall("patient_create_propose", { name: "[患者姓名]", phone: "[电话]", summary: "新建档案" }, "call_create"),
    textTurn("已生成建档提案。"),
  ]);
  const app = await startTestServer({ provider, seedDemoPack: false });
  t.after(() => app.close());
  const saved = await app.request("/api/privacy-settings", { method: "PUT", body: { enabled: true, service: { baseUrl: worker.url, apiKey: "k1" } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.service.hasKey, true);
  assert.ok(!JSON.stringify(saved.body).includes("k1"), "不回显密钥");
  const session = await app.request("/api/assistant/session", { method: "POST", body: {} });
  const id = session.body.id;
  const file = await app.request(`/api/sessions/${id}/files`, { method: "POST", body: { name: "入院记录.txt", text: RECORD } });
  assert.equal(file.status, 201, JSON.stringify(file.body));
  const ready = await waitFor(async () => {
    const detail = await app.request(`/api/sessions/${id}`);
    const material = detail.body.files.find((f) => f.id === file.body.id);
    return material?.privacy?.status === "ready" ? material : null;
  });
  assert.equal(ready.privacy.method, "service");
  for (const secret of SECRETS) assert.ok(!ready.text.includes(secret), `保存的资料文本不应包含 ${secret}`);
  assert.match(ready.text, /\[患者姓名\]/);
  assert.equal(ready.privacy.identity.name, "赵测试", "身份只在本机留存，用于建档回填");
  const run = await app.request("/api/agent/run", {
    method: "POST",
    body: { sessionId: id, message: "根据资料建档", fileIds: [file.body.id], mode: "model", externalConsent: true },
  });
  assert.equal(run.body.status, "completed", JSON.stringify(run.body));
  const sent = JSON.stringify(provider.calls.map((call) => call.messages));
  for (const secret of SECRETS) assert.ok(!sent.includes(secret), `模型不应看到 ${secret}`);
  assert.ok(sent.includes("[患者姓名]"));
  const pending = await app.request("/api/pending-actions");
  const proposal = (pending.body.actions || pending.body).find((a) => a.type === "patient-create");
  assert.equal(proposal.payload.name, "赵测试", "提案在本机回填了真实姓名");
  assert.equal(proposal.payload.gender, "male");
  assert.equal(proposal.payload.birthYear, 1967);
});

test("严格模式且服务不可用：资料不发给模型", async (t) => {
  const worker = await fakeWorker({ fail: true });
  t.after(worker.close);
  const provider = createScriptedProvider([textTurn("好的。")]);
  const app = await startTestServer({ provider, seedDemoPack: false });
  t.after(() => app.close());
  await app.request("/api/privacy-settings", { method: "PUT", body: { enabled: true, mode: "strict", service: { baseUrl: worker.url } } });
  const session = await app.request("/api/assistant/session", { method: "POST", body: {} });
  const id = session.body.id;
  const file = await app.request(`/api/sessions/${id}/files`, { method: "POST", body: { name: "入院记录.txt", text: RECORD } });
  await waitFor(async () => {
    const detail = await app.request(`/api/sessions/${id}`);
    return detail.body.files.find((f) => f.id === file.body.id)?.privacy?.status === "failed";
  });
  const run = await app.request("/api/agent/run", {
    method: "POST",
    body: { sessionId: id, message: "看看这份资料", fileIds: [file.body.id], mode: "model", externalConsent: true },
  });
  assert.equal(run.body.status, "completed", JSON.stringify(run.body));
  const sent = JSON.stringify(provider.calls.map((call) => call.messages));
  for (const secret of SECRETS) assert.ok(!sent.includes(secret), `模型不应看到 ${secret}`);
  assert.match(sent, /脱敏失败/);
});

test("规则兜底模式且未配置服务：用本地规则脱敏", async (t) => {
  const provider = createScriptedProvider([textTurn("好的。")]);
  const app = await startTestServer({ provider, seedDemoPack: false });
  t.after(() => app.close());
  await app.request("/api/privacy-settings", { method: "PUT", body: { enabled: true } });
  const session = await app.request("/api/assistant/session", { method: "POST", body: {} });
  const id = session.body.id;
  const file = await app.request(`/api/sessions/${id}/files`, { method: "POST", body: { name: "入院记录.txt", text: RECORD } });
  const ready = await waitFor(async () => {
    const detail = await app.request(`/api/sessions/${id}`);
    const material = detail.body.files.find((f) => f.id === file.body.id);
    return material?.privacy?.status === "ready" ? material : null;
  });
  assert.equal(ready.privacy.method, "rules");
  await app.request("/api/agent/run", {
    method: "POST",
    body: { sessionId: id, message: "看看这份资料", fileIds: [file.body.id], mode: "model", externalConsent: true },
  });
  const sent = JSON.stringify(provider.calls.map((call) => call.messages));
  for (const secret of ["赵测试", "13912345678", "110101196703120015", "ZY20260011"]) assert.ok(!sent.includes(secret), `模型不应看到 ${secret}`);
});

test("脱敏服务地址：允许 HTTP，非本机 HTTP 标记为明文传输", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]), seedDemoPack: false });
  t.after(() => app.close());
  const response = await app.request("/api/privacy-settings", { method: "PUT", body: { service: { baseUrl: "http://36.0.0.1:18090", apiKey: "x" } } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.service.insecure, true);
  const local = await app.request("/api/privacy-settings", { method: "PUT", body: { service: { baseUrl: "http://127.0.0.1:18090" } } });
  assert.equal(local.body.service.insecure, false);
  const bad = await app.request("/api/privacy-settings", { method: "PUT", body: { service: { baseUrl: "ftp://x" } } });
  assert.equal(bad.status, 400);
});

test("打码对齐：容忍脱敏服务合并空格、吞字，找出被替换的原文片段", () => {
  const raw = "姓名：周样例性别：女\n门诊号：MZ20260088   电话：13711112222\n检查：LDL-C 4.2  mmol/L";
  const deid = "姓名：[患者姓名]别：女\n门诊号：[医疗编号] 电话：[电话]\n检查：LDL-C 4.2 mmol/L";
  const spans = replacedSpans(raw, deid);
  for (const secret of ["周样例", "MZ20260088", "13711112222"]) assert.ok(spans.some((s) => s.includes(secret)), secret);
  assert.ok(!spans.some((s) => s.includes("LDL")), "未改动的临床内容不遮");
});

test("打码定位：中文按全宽、数字按半宽加权，并留余量", () => {
  const { rects, missing } = redactionRects([{ text: "号：MZ2026", box: [0, 0, 100, 20] }, { text: "无坐标 MZ2026" }], ["MZ2026"], 200, 100);
  assert.equal(missing, 1, "需要遮却没有坐标的行要报告");
  assert.equal(rects.length, 1);
  const [r] = rects;
  assert.ok(r.x <= 40 && r.x + r.w >= 100, JSON.stringify(r));
});

test("开启脱敏：图片识别后按脱敏结果打码，替换并删除原图", async (t) => {
  const worker = await fakeWorker();
  t.after(worker.close);
  const app = await startTestServer({ provider: createScriptedProvider([]), seedDemoPack: false });
  t.after(() => app.close());
  const ocr = await app.request("/api/ocr-settings", { method: "PUT", body: { service: { baseUrl: worker.url } } });
  assert.equal(ocr.status, 200, JSON.stringify(ocr.body));
  await app.request("/api/privacy-settings", { method: "PUT", body: { enabled: true } });
  const session = await app.request("/api/assistant/session", { method: "POST", body: {} });
  const id = session.body.id;
  const png = await sharp({ create: { width: 600, height: 200, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const file = await app.request(`/api/sessions/${id}/files`, { method: "POST", body: { name: "赵测试-门诊.png", image: png.toString("base64") } });
  assert.equal(file.status, 201, JSON.stringify(file.body));
  const originalArtifact = file.body.extraction.artifactId;
  const prepared = await app.request(`/api/sessions/${id}/files/${file.body.id}/prepare`, { method: "POST", body: {} });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const material = prepared.body.file;
  assert.equal(material.privacy.status, "ready");
  assert.equal(material.privacy.images.length, 1);
  assert.equal(material.privacy.images[0].complete, true);
  assert.notEqual(material.extraction.artifactId, originalArtifact, "引用换成打码图");
  for (const secret of ["赵测试", "13912345678"]) {
    assert.ok(!material.text.includes(secret), `文本不应包含 ${secret}`);
    assert.ok(!material.name.includes(secret), `文件名不应包含 ${secret}`);
  }
  assert.match(material.text, /2型糖尿病/);
  const workspace = await app.request(`/api/workspaces/${id}`);
  const artifacts = workspace.body.artifacts || workspace.body.workspace?.artifacts || [];
  assert.ok(artifacts.length, JSON.stringify(Object.keys(workspace.body)));
  assert.ok(!artifacts.some((a) => a.id === originalArtifact), "原图已删除");
  const masked = artifacts.find((a) => a.id === material.extraction.artifactId);
  assert.equal(masked.privacy, "masked");
  // 打码区域是黑色，临床内容所在行不受影响。
  const response = await fetch(new URL(`/api/workspaces/${id}/artifacts/${masked.id}`, app.url), { headers: { "x-medical-token": app.token } });
  assert.equal(response.status, 200);
  {
    const { data, info } = await sharp(Buffer.from(await response.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x, y) => data[(y * info.width + x) * info.channels];
    assert.ok(pixel(250, 40) < 40, "姓名处应为黑色");
    assert.ok(pixel(300, 100) < 40, "电话号码处应为黑色");
    assert.ok(pixel(200, 160) > 200, "诊断行不应被遮");
  }
});

test("脱敏默认开启；内置服务没有 Key 时不使用，有 Key 时作为最后一级", async () => {
  const { PrivacySettings, builtinPrivacyService, BUILTIN_PRIVACY_SERVICE_URL } = await import("../../server/medical/privacy.mjs");
  const store = new Map();
  const vault = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };

  assert.deepEqual(builtinPrivacyService({}), { baseUrl: BUILTIN_PRIVACY_SERVICE_URL, apiKey: "" });
  assert.equal(builtinPrivacyService({ MEDICAL_PRIVACY_SERVICE_URL: "off" }), null);
  assert.equal(builtinPrivacyService({ MEDICAL_PRIVACY_SERVICE_URL: "" }), null);
  assert.equal(builtinPrivacyService({ MEDICAL_PRIVACY_SERVICE_URL: "http://10.0.0.2:18090/v1/" }).baseUrl, "http://10.0.0.2:18090");

  const noKey = new PrivacySettings(vault, null, { builtin: builtinPrivacyService({}) });
  assert.equal(noKey.enabled(), true);
  assert.equal(noKey.service(), null);
  assert.deepEqual(noKey.public().builtin, { baseUrl: BUILTIN_PRIVACY_SERVICE_URL, enabled: true, hasKey: false, keySource: null, active: false, insecure: true });

  const withKey = new PrivacySettings(vault, null, { builtin: builtinPrivacyService({ MEDICAL_PRIVACY_SERVICE_KEY: "k" }) });
  assert.equal(withKey.service().source, "builtin");
  const ocrFirst = new PrivacySettings(vault, { service: () => ({ baseUrl: "http://127.0.0.1:1" }) }, { builtin: { baseUrl: "http://x", apiKey: "k" } });
  assert.equal(ocrFirst.service().source, "ocr");

  withKey.save({ enabled: false });
  assert.equal(withKey.enabled(), false);
  assert.equal(withKey.public().enabled, false);
});

test("内置脱敏服务可单独关闭，API Key 可在设置页填写", async () => {
  const { PrivacySettings, BUILTIN_PRIVACY_SERVICE_URL } = await import("../../server/medical/privacy.mjs");
  const store = new Map();
  const vault = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  const settings = new PrivacySettings(vault, null, { builtin: { baseUrl: BUILTIN_PRIVACY_SERVICE_URL, apiKey: "" } });
  assert.equal(settings.service(), null);

  settings.save({ builtinApiKey: " typed-key " });
  assert.deepEqual(settings.service(), { baseUrl: BUILTIN_PRIVACY_SERVICE_URL, apiKey: "typed-key", source: "builtin" });
  assert.equal(settings.public().builtin.keySource, "settings");
  assert.equal(settings.public().builtin.active, true);
  assert.ok(!JSON.stringify(settings.public()).includes("typed-key"), "Key 不回传给界面");

  settings.save({ useBuiltin: false });
  assert.equal(settings.service(), null);
  assert.equal(settings.public().builtin.enabled, false);
  assert.equal(settings.enabled(), true, "关闭内置服务不等于关闭脱敏");

  settings.save({ useBuiltin: true, builtinApiKey: "" });
  assert.equal(settings.service(), null, "清空 Key 后不再调用");
  assert.throws(() => settings.save({ useBuiltin: "no" }), /useBuiltin/);
});

test("网页截图：规则兜底模式可交给视觉模型，严格模式禁止；导入的资料原图始终禁止", async () => {
  const { MaterialPrivacy } = await import("../../server/medical/privacy.mjs");
  const settings = (mode) => ({ enabled: () => true, mode: () => mode, service: () => null });
  const fallback = new MaterialPrivacy({ settings: settings("fallback") });
  assert.equal(fallback.screenshotsBlocked(), false);
  assert.equal(fallback.rawImagesBlocked(), true);
  assert.equal(new MaterialPrivacy({ settings: settings("strict") }).screenshotsBlocked(), true);
});

test("设置页填写的内置服务 API Key 在本机加密保存，数据库里没有明文", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { CredentialVault } = await import("../../server/core/oauth.mjs");
  const { PrivacySettings } = await import("../../server/medical/privacy.mjs");
  const dir = mkdtempSync(join(tmpdir(), "privacy-vault-"));
  try {
    const db = new DatabaseSync(":memory:");
    const settings = new PrivacySettings(new CredentialVault(db, dir), null, { builtin: { baseUrl: "http://x", apiKey: "" } });
    settings.save({ builtinApiKey: "secret-worker-key-123" });
    const raw = JSON.stringify(db.prepare("SELECT * FROM agent_credentials").all());
    assert.ok(!raw.includes("secret-worker-key-123"), "数据库中不应有明文 Key");
    const reopened = new PrivacySettings(new CredentialVault(db, dir), null, { builtin: { baseUrl: "http://x", apiKey: "" } });
    assert.equal(reopened.service().apiKey, "secret-worker-key-123", "重启后可解密使用");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("对话里直接建档：发送前先识别图片并存档，模型读到的是带行号的脱敏文字", async (t) => {
  const worker = await fakeWorker();
  t.after(worker.close);
  const provider = createScriptedProvider([textTurn("已读取资料。")]);
  const app = await startTestServer({ provider, seedDemoPack: false });
  t.after(() => app.close());
  await app.request("/api/ocr-settings", { method: "PUT", body: { service: { baseUrl: worker.url } } });
  await app.request("/api/privacy-settings", { method: "PUT", body: { enabled: true } });
  const id = (await app.request("/api/assistant/session", { method: "POST", body: {} })).body.id;
  const png = await sharp({ create: { width: 600, height: 200, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const file = await app.request(`/api/sessions/${id}/files`, { method: "POST", body: { name: "门诊.png", image: png.toString("base64") } });
  const revision = (await app.request(`/api/sessions/${id}`)).body.revision;
  const chat = await app.request(`/api/chat/${id}`, {
    method: "POST",
    body: { message: "帮我添加这个患者", mode: "model", externalConsent: true, fileIds: [file.body.id], sessionRevision: revision },
  });
  assert.equal(chat.status, 200);
  assert.match(chat.text, /material\.progress/, "识别进度通过事件流返回");
  assert.match(chat.text, /message\.complete/, "识别后照常执行，旧的 sessionRevision 不算冲突");
  const material = (await app.request(`/api/sessions/${id}`)).body.files.find((f) => f.id === file.body.id);
  assert.equal(material.extraction.ocr.status, "ready");
  assert.equal(material.privacy.images[0].complete, true);
  assert.match(material.text, /2型糖尿病/);
  const sent = JSON.stringify(provider.calls.map((call) => call.messages));
  assert.ok(!sent.includes("赵测试") && !sent.includes("13912345678"), "模型看不到身份信息");
});

test("发送前识别失败：记录原因告诉模型，不阻断发送，同一版本不重复识别", async (t) => {
  const worker = await fakeWorker({ fail: true });
  t.after(worker.close);
  const provider = createScriptedProvider([textTurn("好的。"), textTurn("好的。")]);
  const app = await startTestServer({ provider, seedDemoPack: false });
  t.after(() => app.close());
  await app.request("/api/ocr-settings", { method: "PUT", body: { service: { baseUrl: worker.url } } });
  await app.request("/api/privacy-settings", { method: "PUT", body: { enabled: true } });
  const id = (await app.request("/api/assistant/session", { method: "POST", body: {} })).body.id;
  // 空白图：OCR 服务失败后落回系统识别，也读不出文字。
  const png = await sharp({ create: { width: 60, height: 20, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const file = await app.request(`/api/sessions/${id}/files`, { method: "POST", body: { name: "空白.png", image: png.toString("base64") } });
  const body = { message: "帮我添加这个患者", mode: "model", externalConsent: true, fileIds: [file.body.id] };
  const first = await app.request(`/api/chat/${id}`, { method: "POST", body });
  assert.match(first.text, /识别失败/);
  assert.match(first.text, /message\.complete/);
  const material = (await app.request(`/api/sessions/${id}`)).body.files.find((f) => f.id === file.body.id);
  assert.ok(material.extraction.ocrFailure?.error, "失败原因存进资料");
  assert.match(JSON.stringify(provider.calls[0].messages), /自动文字识别失败/, "模型看到失败原因");
  const second = await app.request(`/api/chat/${id}`, { method: "POST", body });
  assert.doesNotMatch(second.text, /material\.progress/, "同一版本不重复识别");
});
