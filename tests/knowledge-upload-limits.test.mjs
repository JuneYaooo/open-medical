import test from "node:test";
import assert from "node:assert/strict";
import { extractPdfText } from "../shared/pdf-text.mjs";
import { extractOfficeText } from "../shared/office-text.mjs";

// 知识库整理通过选项放开提取上限（100MB/200 万字符）；默认值保持原样，
// 患者资料导入等旧调用方不受影响。字节检查在解析前执行，getDocument 不应被触达。
const refuseToParse = () => {
  throw new Error("不应进入解析阶段");
};
test("pdf extraction byte ceiling is option-driven with unchanged default", async () => {
  await assert.rejects(
    extractPdfText(new Uint8Array(11), refuseToParse, { maxBytes: 10 }),
    (e) => /PDF 超过 1MB/.test(e.message),
  );
  await assert.rejects(
    extractPdfText(new Uint8Array(21 * 1024 * 1024), refuseToParse),
    (e) => /PDF 超过 20MB/.test(e.message),
  );
});
test("office extraction byte ceiling is option-driven with unchanged default", async () => {
  await assert.rejects(
    extractOfficeText(new Uint8Array(11), "a.docx", { maxBytes: 10 }),
    (e) => /Office 文件超过 1MB/.test(e.message),
  );
  await assert.rejects(
    extractOfficeText(new Uint8Array(21 * 1024 * 1024), "a.docx"),
    (e) => /Office 文件超过 20MB/.test(e.message),
  );
});
