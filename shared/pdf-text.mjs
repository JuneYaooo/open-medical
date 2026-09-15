// PDF text extraction only: does not OCR, execute document scripts, or infer table structure.
// PDF.js is injected so the same extraction contract is tested without browser globals.
export async function extractPdfText(
  bytes,
  getDocument,
  { timeoutMs = 60000, maxPages = 300, maxChars = 400000, pdfOptions = {} } = {},
) {
  if (bytes.byteLength > 20 * 1024 * 1024)
    throw new Error("PDF 超过 20MB，请拆分后导入");
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
    throw new Error("文件不是有效 PDF");
  const task = getDocument({
    ...pdfOptions,
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: true,
  });
  let timer;
  const extract = async () => {
    const pdf = await task.promise;
    if (pdf.numPages > maxPages)
      throw new Error(`PDF 超过 ${maxPages} 页，请拆分后导入`);
    const pages = [];
    let chars = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let value = "";
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        value += item.str + (item.hasEOL ? "\n" : " ");
        if (value.length + chars > maxChars)
          throw new Error("PDF 文本超过 400000 字符，请拆分后导入");
      }
      value = value.replace(/[ \t]+\n/g, "\n").trim();
      pages.push({ page: i, text: value });
      chars += value.length;
      page.cleanup();
    }
    const emptyPages = pages.filter((p) => !p.text).map((p) => p.page);
    if (emptyPages.length === pages.length)
      throw new Error(
        "PDF 没有可提取文字，可能是扫描件。请先进行 OCR 并核对结果后再导入",
      );
    const text = pages
      .map(
        (p) =>
          `[PDF 第 ${p.page} 页]\n${p.text || "[本页没有可提取文字，需核对原件]"}`,
      )
      .join("\n\n");
    if (text.length > maxChars)
      throw new Error("PDF 文本超过 400000 字符，请拆分后导入");
    return {
      text,
      extraction: {
        type: "pdf_text",
        pageCount: pdf.numPages,
        emptyPages,
        originalRetained: false,
      },
    };
  };
  try {
    return await Promise.race([
      extract(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("PDF 解析超时，请拆分或转换为文本后导入")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await task.destroy();
  }
}
