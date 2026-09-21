// 评估侧 PDF 生成器(D02 夹具):仓库 node_modules 没有 PDF 写入库
// (pdfjs-dist 只读;scripts/prepare-pdf-assets.mjs 只复制字体资源),
// 因此这里实现一个最小但真实的 PDF 1.4 写入器:
// - 从已安装字体中选择覆盖夹具字符的 TrueType，FontFile2 全量嵌入
// - Type0/CIDFontType2 + Identity-H 编码,文本用字形 ID 直书
// - 附 ToUnicode CMap,保证 pdfjs-dist 能把文本逐页读回
// 生成后必须先用 pdfjs-dist 读回校验(页数/内容/页归属),再冻结哈希。
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readZip } from "./zip.mjs";

function parseTtf(buf) {
  if (
    buf.readUInt32BE(0) !== 0x00010000 &&
    buf.toString("latin1", 0, 4) !== "true"
  )
    throw new Error("不是 TrueType 字体");
  const numTables = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    tables[buf.toString("latin1", off, off + 4)] = {
      offset: buf.readUInt32BE(off + 8),
      length: buf.readUInt32BE(off + 12),
    };
  }
  for (const required of ["cmap", "head", "hhea", "hmtx"])
    if (!tables[required]) throw new Error(`字体缺少 ${required} 表`);
  // cmap:优先 (3,10) format12,其次 (3,1) format4,再次 (0,*)。
  const cmap = tables.cmap;
  const numSub = buf.readUInt16BE(cmap.offset + 2);
  let best = null;
  for (let i = 0; i < numSub; i++) {
    const rec = cmap.offset + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const subOff = cmap.offset + buf.readUInt32BE(rec + 4);
    const format = buf.readUInt16BE(subOff);
    const score =
      platform === 3 && encoding === 10
        ? 4
        : platform === 3 && encoding === 1
          ? 3
          : platform === 0
            ? 2
            : 0;
    if (score && (!best || score > best.score))
      best = { score, subOff, format };
  }
  if (!best) throw new Error("字体 cmap 没有可用的 Unicode 子表");
  const unicodeToGid = new Map();
  if (best.format === 12) {
    const nGroups = buf.readUInt32BE(best.subOff + 12);
    for (let g = 0; g < nGroups; g++) {
      const rec = best.subOff + 16 + g * 12;
      const start = buf.readUInt32BE(rec);
      const end = buf.readUInt32BE(rec + 4);
      const startGid = buf.readUInt32BE(rec + 8);
      for (let cp = start; cp <= end && cp - start < 0x20000; cp++)
        unicodeToGid.set(cp, startGid + (cp - start));
    }
  } else if (best.format === 4) {
    const segCount = buf.readUInt16BE(best.subOff + 6) / 2;
    const endOff = best.subOff + 14;
    const startOff = endOff + segCount * 2 + 2;
    const deltaOff = startOff + segCount * 2;
    const rangeOff = deltaOff + segCount * 2;
    for (let s = 0; s < segCount; s++) {
      const end = buf.readUInt16BE(endOff + s * 2);
      const start = buf.readUInt16BE(startOff + s * 2);
      const delta = buf.readInt16BE(deltaOff + s * 2);
      const rangePos = rangeOff + s * 2;
      const rangeOffset = buf.readUInt16BE(rangePos);
      if (end === 0xffff) continue;
      for (let cp = start; cp <= end; cp++) {
        let gid;
        if (rangeOffset === 0) gid = (cp + delta) & 0xffff;
        else {
          const glyphPos = rangePos + rangeOffset + (cp - start) * 2;
          gid = buf.readUInt16BE(glyphPos);
          if (gid) gid = (gid + delta) & 0xffff;
        }
        if (gid) unicodeToGid.set(cp, gid);
      }
    }
  } else throw new Error(`不支持的 cmap format ${best.format}`);
  const head = tables.head;
  return {
    buf,
    unicodeToGid,
    unitsPerEm: buf.readUInt16BE(head.offset + 18),
    bbox: [
      buf.readInt16BE(head.offset + 36),
      buf.readInt16BE(head.offset + 38),
      buf.readInt16BE(head.offset + 40),
      buf.readInt16BE(head.offset + 42),
    ],
    ascent: buf.readInt16BE(tables.hhea.offset + 4),
    descent: -buf.readInt16BE(tables.hhea.offset + 6),
  };
}

function hex4(n) {
  return n.toString(16).padStart(4, "0").toUpperCase();
}

function toUnicodeCMap(used /* Map<gid, cp> */) {
  const entries = [...used.entries()].sort((a, b) => a[0] - b[0]);
  const chunks = [];
  for (let i = 0; i < entries.length; i += 100)
    chunks.push(entries.slice(i, i + 100));
  let body =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
  for (const chunk of chunks) {
    body += `${chunk.length} beginbfchar\n`;
    for (const [gid, cp] of chunk)
      body += `<${hex4(gid)}> <${cp.toString(16).padStart(4, "0").toUpperCase()}>\n`;
    body += "endbfchar\n";
  }
  body += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
  return body;
}

// Only local TrueType files: TTC/OTF collections are not silently treated as
// standalone TTF. Every required glyph is checked before selecting a fallback.
const installedFontCandidates = () => [
  join(process.env.WINDIR || "C:/Windows", "Fonts", "simhei.ttf"),
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
  "/usr/share/fonts/truetype/arphic/uming.ttf",
  "/usr/share/fonts/truetype/arphic/ukai.ttf",
  "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
];
function loadFont(pages, fontPath) {
  const required = new Set(pages.flat().join(""));
  const failures = [];
  for (const candidate of fontPath ? [fontPath] : installedFontCandidates()) {
    if (!fontPath && !existsSync(candidate)) continue;
    try {
      const font = parseTtf(readFileSync(candidate));
      for (const ch of required) {
        if (!font.unicodeToGid.get(ch.codePointAt(0)))
          throw new Error(`字体缺少字形:${ch}`);
      }
      return { font, fontPath: candidate };
    } catch (error) {
      if (fontPath) throw error;
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(
    "未找到覆盖全部夹具字符的本机 CJK TrueType 字体；请通过 fontPath 指定已安装的 .ttf 字体。" +
      failures.join("; "),
  );
}

/**
 * 生成真实多页 PDF。pages: string[][],每页为若干行文本。
 * 返回 { bytes, fontHash, glyphCoverage }。
 */
export function buildPdf(pages, { fontPath } = {}) {
  // 对象编号按固定布局编排,当前仅支持两页(D02 夹具规格就是两页)。
  if (pages.length !== 2)
    throw new Error("buildPdf 目前只支持两页 PDF(D02 规格)");
  const loaded = loadFont(pages, fontPath);
  const font = loaded.font;
  const fontBuf = font.buf;
  const used = new Map(); // gid -> unicode
  const pageStreams = pages.map((lines, pageIdx) => {
    let s = "BT\n";
    lines.forEach((line, li) => {
      const y = 780 - li * 24;
      let hex = "";
      for (const ch of line) {
        const gid = font.unicodeToGid.get(ch.codePointAt(0));
        if (!gid) throw new Error(`字体缺少字形:${ch}`);
        used.set(gid, ch.codePointAt(0));
        hex += hex4(gid);
      }
      s += `/F1 14 Tf 1 0 0 1 60 ${y} Tm <${hex}> Tj\n`;
    });
    s += "ET";
    return { text: s, idx: pageIdx };
  });
  const scale = (n) => Math.round((n / font.unitsPerEm) * 1000);
  // 对象编号:1 Catalog, 2 Pages, 3/4 Page, 5/6 Contents, 7 Type0,
  // 8 CIDFont, 9 Descriptor, 10 FontFile2, 11 ToUnicode。
  const objects = new Map();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    `<< /Type /Pages /Kids [3 0 R 4 0 R] /Count ${pages.length} >>`,
  );
  pages.forEach((_, i) => {
    objects.set(
      3 + i,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 7 0 R >> >> /Contents ${5 + i} 0 R >>`,
    );
    const stream = pageStreams[i].text;
    objects.set(5 + i, {
      stream,
      dict: `<< /Length ${Buffer.byteLength(stream, "latin1")} >>`,
    });
  });
  objects.set(
    7,
    `<< /Type /Font /Subtype /Type0 /BaseFont /EmbeddedCJK /Encoding /Identity-H ` +
      `/DescendantFonts [8 0 R] /ToUnicode 11 0 R >>`,
  );
  objects.set(
    8,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /EmbeddedCJK ` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
      // Type0 的 FontMatrix 固定为 0.001,字形空间宽度 = 字体单位 × 1000/unitsPerEm。
      // CJK 全角步进使用 1em；夹具的文本内容仍须经独立解析器验证。
      `/FontDescriptor 9 0 R /DW 1000 /CIDToGIDMap /Identity >>`,
  );
  objects.set(
    9,
    `<< /Type /FontDescriptor /FontName /EmbeddedCJK /Flags 4 ` +
      `/FontBBox [${font.bbox.map(scale).join(" ")}] /ItalicAngle 0 ` +
      `/Ascent ${scale(font.ascent)} /Descent ${scale(-font.descent)} ` +
      `/CapHeight ${scale(font.ascent)} /StemV 80 /FontFile2 10 0 R >>`,
  );
  objects.set(10, {
    stream: fontBuf,
    dict: `<< /Length ${fontBuf.length} /Length1 ${fontBuf.length} >>`,
    binary: true,
  });
  const cmapText = toUnicodeCMap(used);
  objects.set(11, {
    stream: cmapText,
    dict: `<< /Length ${Buffer.byteLength(cmapText)} >>`,
  });

  let out = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const offsets = [];
  for (let id = 1; id <= objects.size; id++) {
    const obj = objects.get(id);
    offsets[id] = out.length;
    let chunk;
    if (typeof obj === "string")
      chunk = Buffer.from(`${id} 0 obj\n${obj}\nendobj\n`, "latin1");
    else {
      const head = Buffer.from(`${id} 0 obj\n${obj.dict}\nstream\n`, "latin1");
      const body = obj.binary ? obj.stream : Buffer.from(obj.stream, "latin1");
      const tail = Buffer.from("\nendstream\nendobj\n", "latin1");
      chunk = Buffer.concat([head, body, tail]);
    }
    out = Buffer.concat([out, chunk]);
  }
  const xrefStart = out.length;
  let xref = `xref\n0 ${objects.size + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objects.size; id++)
    xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.size + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  out = Buffer.concat([out, Buffer.from(xref, "latin1")]);
  return {
    bytes: out,
    fontPath: loaded.fontPath,
    fontHash: createHash("sha256").update(fontBuf).digest("hex"),
    glyphCount: used.size,
  };
}

/** 用 pdfjs-dist 把 PDF 文本逐页读回(独立读回校验,禁止以写代读)。 */
export async function extractPdfPages(bytes) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(content.items.map((i) => i.str).join(""));
    page.cleanup?.();
  }
  doc.cleanup?.();
  return pages;
}

/** 校验产物是不是 ZIP 类容器(如 xlsx/docx 伪造扩展名检查的第一道门)。 */
export function isZipContainer(bytes) {
  try {
    readZip(bytes);
    return true;
  } catch {
    return false;
  }
}
