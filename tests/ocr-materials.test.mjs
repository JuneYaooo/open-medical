import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekProvider } from "../server/core/providers.mjs";
import { fixture } from "./helpers.mjs";

// 1x1 纯色 PNG：本地 OCR 读不出任何文字，识别链路必然落到视觉模型，
// 视觉输出由 fake provider 脚本化，保证测试确定性。
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TRANSCRIPT = "合成患者记录：2026年3月1日入院，行合成检查，示轻度贫血，铁蛋白降低。建议结合肠镜病理进一步明确，定期随访复查。";

function visionProvider() {
  const provider = new DeepSeekProvider({ apiKey: "synthetic", model: "ocr-materials-test" });
  provider.vision = true;
  let calls = 0;
  provider.complete = async () => {
    calls++;
    return { message: { content: TRANSCRIPT }, usage: {} };
  };
  provider.callCount = () => calls;
  return provider;
}

async function sessionWithImage(f, name = "样本.png") {
  const session = await f.session("OCR 质量测试会话");
  const r = await f.json(`/api/sessions/${session.id}/files`, "POST", { name, image: PNG_1PX });
  assert.equal(r.status, 201);
  return { session, file: r.data };
}

test("识别后材料带质量评分，缓存生效，force 重新识别保留上次记录", async (t) => {
  const provider = visionProvider();
  const f = await fixture(t, { provider });
  const { session, file } = await sessionWithImage(f);

  const first = await f.json(`/api/sessions/${session.id}/files/${file.id}/prepare`, "POST", {});
  assert.equal(first.status, 200);
  assert.ok(first.data.file.text.includes("合成患者记录"), "transcript lands in material text");
  assert.equal(first.data.file.extraction.ocr.method, "vision");
  assert.equal(first.data.file.extraction.ocr.quality.level, "good");
  assert.ok(first.data.file.extraction.ocr.quality.score >= 75);
  assert.equal(provider.callCount(), 1, "empty local OCR falls through to vision once");

  // 已识别材料默认直接返回缓存，不再调用视觉模型。
  const cached = await f.json(`/api/sessions/${session.id}/files/${file.id}/prepare`, "POST", {});
  assert.equal(cached.status, 200);
  assert.equal(provider.callCount(), 1);

  // force 重新识别：再次转录，旧识别结果挪到 ocrPrevious。
  const forced = await f.json(`/api/sessions/${session.id}/files/${file.id}/prepare`, "POST", { force: true });
  assert.equal(forced.status, 200);
  assert.equal(provider.callCount(), 2);
  assert.equal(forced.data.file.extraction.ocrPrevious.method, "vision");

  const projected = (await f.json(`/api/sessions/${session.id}`)).data;
  assert.equal(projected.files[0].extraction.ocr.quality.level, "good", "quality persists in session projection");
});

test("当前模型不支持图片时 preferVision 报 503 并指引更换模型", async (t) => {
  const f = await fixture(t);
  const { session, file } = await sessionWithImage(f);
  const r = await f.json(`/api/sessions/${session.id}/files/${file.id}/prepare`, "POST", { force: true, preferVision: true });
  assert.equal(r.status, 503);
  assert.match(r.data.error, /多模态/);
});

test("医生修正识别文本：替换正文、记录修正时间、重算质量", async (t) => {
  const provider = visionProvider();
  const f = await fixture(t, { provider });
  const { session, file } = await sessionWithImage(f);
  await f.json(`/api/sessions/${session.id}/files/${file.id}/prepare`, "POST", {});

  const edited = await f.json(`/api/sessions/${session.id}/files/${file.id}/text`, "PUT", {
    text: "修正后的合成记录：2026年3月2日出院，血红蛋白 105 g/L，建议门诊随访复查。",
  });
  assert.equal(edited.status, 200);
  assert.ok(edited.data.file.text.startsWith("修正后的合成记录"));
  assert.ok(edited.data.file.extraction.edited?.at, "edited timestamp recorded");
  assert.equal(edited.data.file.extraction.ocr.quality.level, "good", "quality recomputed after edit");
  assert.notEqual(edited.data.file.hash, file.hash, "hash tracks the corrected text");

  const empty = await f.json(`/api/sessions/${session.id}/files/${file.id}/text`, "PUT", { text: "  " });
  assert.equal(empty.status, 400);
});

test("自动发起病历重新整理：未关联患者时给出明确错误，不回滚识别结果", async (t) => {
  const provider = visionProvider();
  const f = await fixture(t, { provider });
  const { session, file } = await sessionWithImage(f);

  const standalone = await f.json(`/api/sessions/${session.id}/record-refresh`, "POST", { fileIds: [file.id] });
  assert.equal(standalone.status, 422);
  assert.match(standalone.data.error, /尚未关联患者/);

  const unknown = await f.json(`/api/sessions/${session.id}/record-refresh`, "POST", { fileIds: ["no-such-id"] });
  assert.equal(unknown.status, 404);

  const chained = await f.json(`/api/sessions/${session.id}/files/${file.id}/prepare`, "POST", { force: true, refreshRecord: true });
  assert.equal(chained.status, 200);
  assert.match(chained.data.refreshError, /尚未关联患者/, "chained refresh failure surfaces without failing the OCR");
  assert.ok(chained.data.file.text.includes("合成患者记录"), "re-transcribed text is kept");
});
