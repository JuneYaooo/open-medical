// 把材料识别文本解析成「页」结构，供图文对照视图逐页排版。
// 背景：file.text 是给模型读的拼接体——PDF 文字层页、OCR 页块、扫描图指令行、
// 医生提示行混在一起；对照视图直接展示时，医生看到的是一堆对不上页的文本加
// 「artifactId / inspect_image」这类模型指令。这里把文本还原成页单元并剔除指
// 令行，纯函数、跨端（Node 与浏览器）。解析不出页结构时返回 fallback，由调用
// 方退回「全部图 + 全文」的展示。

// 块头行（开新页）：
//   [<文件名> 第 2 页 · 本地文字识别]   OCR 页块（session-bridge.prepareMaterial）
//   [<文件名> · 视觉模型转录]           单图 OCR 块（无页号）
//   [PDF 第 3 页]                        PDF 文字层页（shared/pdf-text）
// 指令/提示行（剔除，不展示给医生）：
//   [PDF 第 3 页扫描图] artifactId: … 使用 inspect_image 读取原文…
//   [本段由本地 OCR 识别，不解读 CT/病理等医学图像；…]
//   [文字识别结果需核对原图；不能据此解读 CT 或病理图像。]
//   [本页没有可提取文字，需核对原件]     PDF 空页占位（有扫描图时被 OCR 页替代）

const OCR_PAGE_HEAD = /^\[.+? 第 (\d+) 页 · (本地文字识别|视觉模型转录)\]$/;
const OCR_SINGLE_HEAD = /^\[(.+) · (本地文字识别|视觉模型转录)\]$/;
const PDF_PAGE_HEAD = /^\[(?:PDF|.+?\.pdf) 第 (\d+) 页\]$/;
const NOISE_LINES = [
  /^\[PDF 第 \d+ 页扫描图\] artifactId:/,
  /^\[本段由本地 OCR 识别，不解读/,
  /^\[文字识别结果需核对原图；不能据此/,
  /^\[本页没有可提取文字，需核对原件\]$/,
];

// 返回 { pages, fallback }。pages 每项 { page: 页号或 null, method: 'local-ocr'|'vision'|'pdf-text'|null, text }；
// 同一页号既有 PDF 文字层又有 OCR 块时（空页扫描件），OCR 文本优先、占位行丢弃。
export function splitOcrPages(text) {
  const pages = [];
  let current = null;
  let sawStructure = false;
  const push = () => {
    if (!current) return;
    const text = current.lines.join("\n").replace(/^\n+|\n+$/g, "");
    if (text) pages.push({ page: current.page, method: current.method, text });
    current = null;
  };
  const open = (page, method) => { push(); current = { page, method, lines: [] }; sawStructure = true; };
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    const ocrPage = trimmed.match(OCR_PAGE_HEAD);
    if (ocrPage) { open(Number(ocrPage[1]), ocrPage[2] === "视觉模型转录" ? "vision" : "local-ocr"); continue; }
    if (PDF_PAGE_HEAD.test(trimmed)) { open(Number(trimmed.match(PDF_PAGE_HEAD)[1]), "pdf-text"); continue; }
    if (NOISE_LINES.some((re) => re.test(trimmed))) continue;
    const single = trimmed.match(OCR_SINGLE_HEAD);
    if (single) { open(null, single[2] === "视觉模型转录" ? "vision" : "local-ocr"); continue; }
    if (!current) current = { page: null, method: null, lines: [] };
    current.lines.push(line);
  }
  push();
  if (!sawStructure || !pages.length) return { pages: [{ page: null, method: null, text: cleanText(text) }], fallback: true };
  // 同页号合并：pdf-text 在前，OCR 覆盖在后（空页占位行已在上面剔除）。
  const byPage = new Map();
  for (const page of pages) {
    const key = page.page ?? `solo-${byPage.size}`;
    if (!byPage.has(key)) { byPage.set(key, page); continue; }
    const held = byPage.get(key);
    if (held.method === "pdf-text" && page.method !== "pdf-text") byPage.set(key, { ...page, text: page.text });
    else if (page.method === "pdf-text") byPage.set(key, { ...held, text: held.text });
    else byPage.set(key, { ...held, text: `${held.text}\n\n${page.text}` });
  }
  const merged = [...byPage.values()];
  const numbered = merged.filter((p) => p.page !== null).sort((a, b) => a.page - b.page);
  const unnumbered = merged.filter((p) => p.page === null);
  return { pages: [...unnumbered, ...numbered], fallback: false };
}

// 仅供「仅文字」模式使用的轻量清理：去掉模型指令行，保留全部正文与页头。
export function cleanText(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => !NOISE_LINES.some((re) => re.test(line.trim())))
    .join("\n");
}
