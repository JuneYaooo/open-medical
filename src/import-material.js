import { extractPdfText } from "../shared/pdf-text.mjs";
import { api } from "./agent-runtime.js";
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
// 附件导入进度文案：逐份、逐阶段（读取/解析/压缩/渲染页/上传页/保存），与建档弹窗同一口径
export const uploadProgressText = (progress) => {
  if (!progress) return "正在导入材料…";
  const file = `第 ${progress.index + 1}/${progress.files} 份 · ${progress.name}`;
  if (progress.stage === "render") return `${file} · 正在读取第 ${progress.done + 1}/${progress.total} 页`;
  if (progress.stage === "compress") return `${file} · 图片较大，正在自动压缩`;
  if (progress.stage === "upload") return `${file} · 正在上传第 ${progress.done + 1}/${progress.count} 页`;
  if (progress.stage === "save") return `${file} · 正在保存材料`;
  return `${file} · 正在读取内容…`;
};
// 单张图片超过上传预算时不再推给医生手动压缩：解码后按扫描页同一梯子降档
// 重编码 JPEG（先铺白底，透明 PNG 不会压成黑底）；最低档仍超限才如实报错。
async function compressImage(file, onProgress = () => {}) {
  onProgress({ stage: "compress", done: 0, total: 0 });
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`${file.name} 无法解码，请确认图片未损坏，或转成 JPG 后重试`);
  }
  try {
    for (const [maxEdge, quality] of RENDER_ATTEMPTS) {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", quality).split(",")[1];
      canvas.width = 0; canvas.height = 0;
      if (data.length <= PAGE_BUDGET) return data;
    }
  } finally {
    bitmap.close();
  }
  throw new Error(`${file.name} 压缩后仍超过单张图片上限，请降低图片分辨率后重试`);
}
export async function importMaterial(file, onProgress = () => {}) {
  if (!file.size) throw new Error(`${file.name} 是空文件（0 字节），请检查原文件后重新上传`);
  if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
    const raw = encodeBytes(new Uint8Array(await file.arrayBuffer()));
    if (raw.length <= PAGE_BUDGET) return { name: file.name, image: raw };
    return { name: file.name.replace(/\.[^.]+$/, "") + ".jpg", image: await compressImage(file, onProgress) };
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
  onProgress({ stage: "parse", done: 0, total: 0 });
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
      const pages = result.extraction.emptyPages;
      for (const [index, number] of pages.entries()) {
        // 渲染密集扫描页可能数秒一页，逐页上报让界面能显示“读取第 x/y 页”
        onProgress({ stage: "render", done: index, total: pages.length });
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
