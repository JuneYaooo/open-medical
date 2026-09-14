import test from "node:test";
import assert from "node:assert/strict";
import { extractPdfText } from "../shared/pdf-text.mjs";
const bytes = new TextEncoder().encode("%PDF-synthetic");
function fake(pages) {
  let destroyed = false;
  return {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: async (n) => ({
          getTextContent: async () => ({
            items: pages[n - 1].map((str) => ({ str, hasEOL: true })),
          }),
          cleanup() {},
        }),
      }),
      destroy: async () => {
        destroyed = true;
      },
    }),
    destroyed: () => destroyed,
  };
}
test("PDF extraction preserves page boundaries and flags partially empty documents", async () => {
  const f = fake([["2026-08-10 Hb 98 g/L"], []]);
  const result = await extractPdfText(bytes, f.getDocument);
  assert.match(result.text, /PDF 第 1 页.*\n2026-08-10 Hb 98 g\/L/);
  assert.deepEqual(result.extraction.emptyPages, [2]);
  assert.equal(result.extraction.originalRetained, false);
  assert.equal(f.destroyed(), true);
});
test("PDF scan, page limit, oversized text and malformed header fail explicitly", async () => {
  for (const [pages, options, message] of [
    [[[]], {}, /OCR/],
    [[["a"], ["b"]], { maxPages: 1 }, /超过/],
    [[["a".repeat(100)]], { maxChars: 30 }, /超过/],
  ]) {
    const f = fake(pages);
    await assert.rejects(
      () => extractPdfText(bytes, f.getDocument, options),
      message,
    );
    assert.equal(f.destroyed(), true);
  }
  await assert.rejects(
    () => extractPdfText(new Uint8Array([0]), fake([["text"]]).getDocument),
    /有效 PDF/,
  );
});
test("PDF timeout destroys worker loading task", async () => {
  let destroyed = false;
  await assert.rejects(
    () =>
      extractPdfText(
        bytes,
        () => ({
          promise: new Promise(() => {}),
          destroy: async () => {
            destroyed = true;
          },
        }),
        { timeoutMs: 10 },
      ),
    /超时/,
  );
  assert.equal(destroyed, true);
});

test("real PDF.js parses a valid synthetic PDF with exact numeric values", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { syntheticPdf } = await import("./fixtures/make-pdf.mjs");
  const result = await extractPdfText(
    new Uint8Array(syntheticPdf()),
    getDocument,
    {
      pdfOptions: {
        standardFontDataUrl: new URL(
          "../node_modules/pdfjs-dist/standard_fonts/",
          import.meta.url,
        ).pathname,
      },
    },
  );
  assert.equal(result.extraction.pageCount, 1);
  assert.match(result.text, /2026-08-10 Hb 98 g\/L/);
  assert.match(result.text, /2026-08-17 CRP 5 mg\/dL/);
});
