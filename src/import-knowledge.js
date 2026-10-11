import { importMaterial } from "./import-material";
import { api } from "./agent-runtime";
// OCR is explicitly local; never silently send a scan to a model service.
export async function importKnowledge(file, onProgress = () => {}) {
  const material = await importMaterial(file, ({ stage, done, total }) => {
    if (stage === "render") onProgress(`${file.name}：正在读取扫描页 ${done + 1}/${total}`);
    else if (stage === "parse") onProgress(`${file.name}：正在解析 PDF 文本…`);
  });
  const pages = material.image
    ? [{ page: 1, data: material.image }]
    : material.pageImages || [];
  const parts = material.text?.trim() ? [material.text] : [];
  for (let i = 0; i < pages.length; i++) {
    onProgress(`正在识别第 ${i + 1}/${pages.length} 页`);
    const result = await api("/api/knowledge/ocr", "POST", {
      image: pages[i].data,
    });
    parts.push(
      `[${file.name} 第 ${pages[i].page} 页 · 本地文字识别]\n${result.text}`,
    );
  }
  return { ...material, text: parts.join("\n\n"), ocr: pages.length > 0 };
}
