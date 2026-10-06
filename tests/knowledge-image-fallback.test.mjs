import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDocument } from "../server/medical/knowledge-media.mjs";

// 最小合法 PNG(1x1 白色像素)与非法字节
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

test("image extraction falls back: local OCR → vision model, with an actionable error last", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "knowledge-image-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const jpg = join(dir, "sample.jpg");
  await writeFile(jpg, PNG_1PX);

  // 本机 OCR 不可用、或识别不出文字时,都交给视觉模型兜底。
  const parts = await extractDocument(jpg, "sample.jpg", undefined, {
    analyzeImage: async () => "视觉模型转录结果",
  });
  assert.equal(parts[0].kind, "vision");
  assert.match(parts[0].text, /视觉模型转录结果/);

  // 本机 OCR 无法解码的字节 → 落到视觉模型
  const broken = join(dir, "broken.jpg");
  await writeFile(broken, Buffer.from("not-an-image"));
  const vision = await extractDocument(broken, "broken.jpg", undefined, {
    analyzeImage: async () => "视觉模型转录结果",
  });
  assert.equal(vision[0].kind, "vision");

  // 没有视觉模型时的错误必须可行动
  await assert.rejects(
    extractDocument(broken, "broken.jpg", undefined, {}),
    (e) =>
      e.code === "OCR_UNAVAILABLE" &&
      /多模态|视觉/.test(e.message) &&
      /PDF/.test(e.message),
  );
});
