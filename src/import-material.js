import { extractPdfText } from "../shared/pdf-text.mjs";
export const MATERIAL_ACCEPT = ".png,.jpg,.jpeg,.webp,.pdf,.xlsx,.docx,.txt,.md,.markdown,.csv,.tsv,.json";
export function encodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export async function importMaterial(file) {
  if (!file.size) throw new Error(`${file.name} 是空文件（0 字节），请检查原文件后重新上传`);
  if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
    if (file.size > 4000000) throw new Error("图片超过 4MB，请压缩后导入");
    return { name: file.name, image: encodeBytes(new Uint8Array(await file.arrayBuffer())) };
  }
  if (/\.(docx|xlsx)$/i.test(file.name)) {
    const { extractOfficeText } = await import("../shared/office-text.mjs");
    return { name: file.name, ...await extractOfficeText(new Uint8Array(await file.arrayBuffer()), file.name) };
  }
  if (/\.(heic|heif)$/i.test(file.name)) throw new Error("HEIC 请先导出为 JPG 或 PNG 后上传");
  if (!/\.pdf$/i.test(file.name)) {
    if (file.size > 2000000) throw new Error(`${file.name} 超过 2MB`);
    return { name: file.name, text: await file.text() };
  }
  if (file.size > 20 * 1024 * 1024)
    throw new Error("PDF 超过 20MB，请拆分后导入");
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist/build/pdf.mjs"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await extractPdfText(
    bytes.slice(),
    pdfjs.getDocument,
    {
      allowEmpty: true,
      pdfOptions: {
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
      },
    },
  );
  const pageImages = [];
  if (result.extraction.emptyPages.length) {
    if (result.extraction.emptyPages.length > 30) throw new Error("扫描 PDF 超过 30 页，请拆分后上传");
    const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, standardFontDataUrl: "/pdfjs/standard_fonts/", cMapUrl: "/pdfjs/cmaps/", cMapPacked: true });
    try {
      const pdf = await task.promise;
      let total = 0;
      for (const number of result.extraction.emptyPages) {
        const page = await pdf.getPage(number);
        const initial = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 1800 / Math.max(initial.width, initial.height)) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
        total += data.length;
        if (total > 6500000) throw new Error("扫描页面图片超过单次上传容量，请拆分 PDF");
        pageImages.push({ page: number, data });
        canvas.width = 0; canvas.height = 0;
        page.cleanup();
      }
    } finally { await task.destroy(); }
  }
  return { name: file.name, ...result, ...(pageImages.length ? { pageImages } : {}) };
}
