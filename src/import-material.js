import { extractPdfText } from "../shared/pdf-text.mjs";
export async function importMaterial(file) {
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
  const result = await extractPdfText(
    new Uint8Array(await file.arrayBuffer()),
    pdfjs.getDocument,
    {
      pdfOptions: {
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
      },
    },
  );
  return { name: file.name, ...result };
}
