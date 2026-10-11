import test from "node:test";
import assert from "node:assert/strict";
import { splitOcrPages, cleanText } from "../shared/ocr-pages.mjs";

// 形态取自真实链路的拼接产物（session-bridge / pdf-text / image-text），内容编造。
const singleImageText = `[c1-1.jpg · 本地文字识别]
患者基本情况：
年龄 60
[本段由本地 OCR 识别，不解读 CT/病理等医学图像；表格顺序、数值、小数点、单位与患者身份均需对照原图核对]
[文字识别结果需核对原图；不能据此解读 CT 或病理图像。]`;

const mixedPdfText = `[报告.pdf 第 1 页]
血常规：白细胞 6.2

[报告.pdf 第 2 页]
[本页没有可提取文字，需核对原件]

[报告.pdf 第 2 页 · 视觉模型转录]
骨髓象：增生明显活跃

[PDF 第 2 页扫描图] artifactId: abc123，使用 inspect_image 读取原文，不能猜测不清晰内容。
[文字识别结果需核对原图；不能据此解读 CT 或病理图像。]`;

const textLayerPdfText = `[指南.pdf 第 1 页]
诊断标准如下

[指南.pdf 第 2 页]
鉴别诊断包括`;

const unstructuredText = `一段没有页块头的旧文本
第二行`;

test("单图 OCR：一页、剔除两条系统提示行", () => {
  const { pages, fallback } = splitOcrPages(singleImageText);
  assert.equal(fallback, false);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].page, null);
  assert.equal(pages[0].method, "local-ocr");
  assert.equal(pages[0].text, "患者基本情况：\n年龄 60");
});

test("文件名含数字的单图块头不误判为页块", () => {
  const { pages, fallback } = splitOcrPages("[c1-1.jpg · 视觉模型转录]\n正文");
  assert.equal(fallback, false);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].method, "vision");
});

test("扫描 PDF：文字层页保留、空页占位被 OCR 块替代、指令行剔除", () => {
  const { pages, fallback } = splitOcrPages(mixedPdfText);
  assert.equal(fallback, false);
  assert.deepEqual(pages.map((p) => [p.page, p.method]), [[1, "pdf-text"], [2, "vision"]]);
  assert.ok(pages[0].text.includes("血常规"));
  assert.ok(pages[1].text.includes("骨髓象"));
  assert.ok(!JSON.stringify(pages).includes("artifactId"));
  assert.ok(!JSON.stringify(pages).includes("需核对原件"));
});

test("纯文字层 PDF：逐页保留", () => {
  const { pages, fallback } = splitOcrPages(textLayerPdfText);
  assert.equal(fallback, false);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].method, "pdf-text");
  assert.ok(pages[1].text.includes("鉴别诊断"));
});

test("无块头文本回退为单页且标记 fallback", () => {
  const { pages, fallback } = splitOcrPages(unstructuredText);
  assert.equal(fallback, true);
  assert.equal(pages.length, 1);
  assert.ok(pages[0].text.includes("第二行"));
});

test("空文本回退为空单页", () => {
  const { pages, fallback } = splitOcrPages("");
  assert.equal(fallback, true);
  assert.equal(pages[0].text, "");
});

test("cleanText 只剔指令与提示行，保留正文、页头与行内置信度标记", () => {
  const cleaned = cleanText("[报告.jpg 第 1 页 · 本地文字识别]\n白细胞 6.2 [识别置信度低，请核对原图]\n[文字识别结果需核对原图；不能据此解读 CT 或病理图像。]");
  assert.ok(cleaned.includes("[报告.jpg 第 1 页 · 本地文字识别]"));
  assert.ok(cleaned.includes("白细胞 6.2 [识别置信度低，请核对原图]"));
  assert.ok(!cleaned.includes("文字识别结果需核对原图"));
});
