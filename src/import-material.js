import { extractPdfText } from "../shared/pdf-text.mjs";
import { api } from "./agent-runtime";
export const MATERIAL_ACCEPT = ".png,.jpg,.jpeg,.webp,.pdf,.xlsx,.docx,.txt,.md,.markdown,.csv,.tsv,.json";
export function encodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
// 单页渲染图要能通过服务端图片上传上限（base64 ≤ 5333336 ≈ 4MB 二进制），
// 超限的页按质量/分辨率逐级降档重渲；页与页独立上传，总量不再受限。
const PAGE_BUDGET = 5333336;
const RENDER_ATTEMPTS = [[1800, 0.85], [1800, 0.65], [1350, 0.7], [1000, 0.7]];
async function renderScannedPage(page, [maxEdge, quality]) {
  const initial = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2, maxEdge / Math.max(initial.width, initial.height)) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  const data = canvas.toDataURL("image/jpeg", quality).split(",")[1];
  canvas.width = 0; canvas.height = 0;
  return data;
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
      for (const number of result.extraction.emptyPages) {
        const page = await pdf.getPage(number);
        let data;
        for (const attempt of RENDER_ATTEMPTS) {
          data = await renderScannedPage(page, attempt);
          if (data.length <= PAGE_BUDGET) break;
        }
        if (data.length > PAGE_BUDGET)
          throw new Error(`第 ${number} 页扫描内容过密，压缩后仍超出单页图片上限，请降低扫描分辨率后重试`);
        pageImages.push({ page: number, data });
        page.cleanup();
      }
    } finally { await task.destroy(); }
  }
  return { name: file.name, ...result, ...(pageImages.length ? { pageImages } : {}) };
}
// 把扫描页逐页上传成图片 artifact（复用工作台图片端点），再把 pageImages
// 换成 artifactId 引用。建档与首页附件都走这里，单请求只携带引用，
// 因此扫描 PDF 不再受"整份材料一个请求"的体积限制。
export async function uploadScannedPages(sessionId, input, onProgress = () => {}) {
  if (!input.pageImages?.length) return input;
  const pageImages = [];
  for (const [index, page] of input.pageImages.entries()) {
    onProgress(index, input.pageImages.length);
    const image = await api(`/api/workspaces/${sessionId}/images`, "POST", {
      name: `PDF-page-${page.page}.jpg`,
      data: page.data,
    });
    pageImages.push({ page: page.page, artifactId: image.id });
  }
  return { ...input, pageImages };
}
