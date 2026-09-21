// eval-v1 代表性验收器测试:
// 1) 自测矩阵(C02 执行断言 / S01 数值 / S04 真实xlsx / D02 PDF页归属)全绿,
//    错误样例(伪造扩展名、硬编码、错误数字、页归属错)必须全部被拒;
// 2) D02 夹具机制:纯 JS PDF 写入器生成的两页 PDF 能被 pdfjs-dist 独立读回;
// 3) xlsx 写入/解析/公式降级重算闭环(74→49)。
import test from "node:test";
import assert from "node:assert/strict";
import { runSelftest } from "../scripts/eval-v1/selftest.mjs";
import {
  buildPdf,
  extractPdfPages,
} from "../scripts/eval-v1/lib/pdf-writer.mjs";
import {
  buildXlsx,
  parseXlsx,
  checkQuoteWorkbook,
  evalFormula,
} from "../scripts/eval-v1/lib/xlsx-check.mjs";
import { readZip } from "../scripts/eval-v1/lib/zip.mjs";

test("代表性验收器矩阵:C02/S01/S04/D02 正确样例通过、错误样例全部被拒", async () => {
  const report = await runSelftest({ filter: ["C02", "S01", "S04", "D02"] });
  assert.equal(report.ok, true, JSON.stringify(report.failures, null, 2));
  assert.equal(report.acceptedCorrectly, 4);
  assert.ok(report.rejectedCorrectly >= 6);
  const fake = report.matrix.find((m) => m.sample === "fake-extension");
  assert.equal(fake.actual, "fail");
  assert.match(fake.reason, /伪造扩展名|不是真实 xlsx/);
  const wrongNumber = report.matrix.find((m) => m.sample === "wrong-number");
  assert.equal(wrongNumber.actual, "fail");
  const stale = report.matrix.find((m) => m.sample === "stale-no-marker");
  assert.equal(stale.actual, "fail");
});

test("D02 夹具:自研 PDF 写入器 → pdfjs-dist 独立读回(两页、内容、页归属)", async () => {
  const { bytes, fontPath, glyphCount, fontHash } = buildPdf([
    ["合成合同(评估夹具)", "金额12000元。"],
    ["交付截止2026年2月10日。", "逾期每日违约金20元。"],
  ]);
  assert.ok(fontPath.endsWith(".ttf"));
  assert.ok(glyphCount > 10);
  assert.match(fontHash, /^[0-9a-f]{64}$/);
  // Explicit font selection must fail rather than substituting a missing glyph.
  assert.throws(
    () => buildPdf([["\u{10FFFF}"], ["fixture"]], { fontPath }),
    /字体缺少字形/,
  );
  const pages = await extractPdfPages(bytes);
  assert.equal(pages.length, 2);
  assert.match(pages[0], /12000/);
  assert.ok(!/每日违约金/.test(pages[0]), "违约金应只在第2页");
  assert.match(pages[1], /2月10日/);
  assert.match(pages[1], /每日违约金20元/);
  // 字节以 %PDF 开头且为有效结构。
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
});

test("S04 机制:真实 xlsx 闭环与降级公式重算 74→49", () => {
  const good = buildXlsx([
    ["项目", "单价", "数量", "总额"],
    ["甲", 12.5, 4, { f: "B2*C2+B3*C3", cached: 74 }],
    ["乙", 8, 3, null],
  ]);
  const parsed = parseXlsx(good);
  assert.equal(parsed.sheets[0].cells.get("A1").value, "项目");
  assert.equal(parsed.sheets[0].cells.get("D2").formula, "B2*C2+B3*C3");
  assert.equal(checkQuoteWorkbook(good).ok, true);
  // 硬编码总额必须被拒。
  const hardcoded = buildXlsx([
    ["项目", "单价", "数量", "总额"],
    ["甲", 12.5, 4, 74],
    ["乙", 8, 3, null],
  ]);
  assert.equal(checkQuoteWorkbook(hardcoded).ok, false);
  // 文本冒充 xlsx 在 ZIP 结构层就被拒。
  assert.throws(() => readZip(Buffer.from("已完成:报价表", "utf8")), /ZIP/);
  // 迷你求值器:SUMPRODUCT 与改值重算。
  const grid = new Map([
    ["B2", 12.5],
    ["C2", 4],
    ["B3", 8],
    ["C3", 3],
  ]);
  assert.equal(evalFormula("SUMPRODUCT(B2:B3,C2:C3)", grid), 74);
  grid.set("C2", 2);
  assert.equal(evalFormula("B2*C2+B3*C3", grid), 49);
});

test("协议约定:S04 重算模式必须显式标注为降级(不冒充独立引擎)", () => {
  const good = buildXlsx([
    ["项目", "单价", "数量", "总额"],
    ["甲", 12.5, 4, { f: "B2*C2+B3*C3", cached: 74 }],
    ["乙", 8, 3, null],
  ]);
  const check = checkQuoteWorkbook(good);
  assert.match(check.mode, /降级|degraded/);
  assert.match(check.mode, /非独立电子表格引擎/);
});
