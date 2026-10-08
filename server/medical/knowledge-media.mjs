import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { spawn } from "node:child_process";
import { recognizeImage } from "../core/image-ocr.mjs";
import { imageTextWithFallback } from "../core/image-text.mjs";
import { extractOfficeText } from "../../shared/office-text.mjs";
import { check } from "../errors.mjs";

export const MEDIA_EXTENSIONS = new Set([
  ".mp3",
  ".m4a",
  ".wav",
  ".mp4",
  ".mov",
]);
export const KNOWLEDGE_EXTENSIONS = new Set([
  ...MEDIA_EXTENSIONS,
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".docx",
  ".xlsx",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".srt",
  ".vtt",
]);
const binary = (name) =>
  resolve(import.meta.dirname, "../../desktop/bin/" + name);
export const mediaAvailable = () =>
  process.platform === "darwin" && existsSync(binary("native-media"));
export function nativeJson(name, input, signal) {
  check(
    process.platform === "darwin" && existsSync(binary(name)),
    "MEDIA_UNAVAILABLE",
    "此平台尚未安装本地媒体处理组件，可先导入文字或字幕",
    503,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(binary(name), [], {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });
    let text = "",
      error = "";
    const timer = setTimeout(() => child.kill(), 300000);
    child.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.length > 6000000) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      if (error.length < 2000) error += chunk;
    });
    child.stdin.on("error", () => {});
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(error || "本地媒体读取未完成"));
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("本地媒体组件返回无效数据"));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
export function clockTime(value) {
  const n = Math.max(0, Math.floor(value));
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}
export function subtitles(text) {
  const chunks = text.replaceAll("\r", "").split(/\n\s*\n/);
  const stamp = (value) =>
    value
      .split(":")
      .reduce((n, part) => n * 60 + Number(part.replace(",", ".")), 0);
  return chunks.flatMap((chunk) => {
    const lines = chunk.split("\n");
    const index = lines.findIndex((l) =>
      /\d{2}:\d{2}(?::\d{2})?[,.]\d{3}\s+-->/.test(l),
    );
    if (index < 0) return [];
    const match = lines[index].match(/([\d:,.]+)\s+-->\s+([\d:,.]+)/);
    const start = stamp(match[1]),
      end = stamp(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      return [];
    const content = lines
      .slice(index + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .trim();
    return content
      ? [{ start, end, text: content, kind: "subtitle", timing: "segment" }]
      : [];
  });
}
export async function extractDocument(path, name, signal, options = {}) {
  const ext = extname(name).toLowerCase();
  signal?.throwIfAborted();
  if (ext === ".pdf" && process.platform === "darwin") {
    const result = await nativeJson("native-document", { path }, signal);
    return result.pages.map((p) => ({
      text: p.text || "[本页未识别到文字，请核对原件]",
      page: p.page,
      kind: p.ocr ? "ocr" : "text",
    }));
  }
  const bytes = await readFile(path);
  if (ext === ".pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { extractPdfText } = await import("../../shared/pdf-text.mjs");
    return [
      {
        // 容量与整理器 TEXT_LIMIT 对齐：100MB、2000 页、200 万字符；
        // 大文件解析慢，超时放宽到 10 分钟。
        text: (
          await extractPdfText(new Uint8Array(bytes), getDocument, {
            timeoutMs: 600000,
            maxPages: 2000,
            maxChars: 2000000,
            maxBytes: 100 * 1024 * 1024,
          })
        ).text,
        kind: "text",
      },
    ];
  }
  if ([".docx", ".xlsx"].includes(ext))
    return [
      {
        // 与整理器 TEXT_LIMIT 对齐：100MB、200 万字符。
        text: (
          await extractOfficeText(new Uint8Array(bytes), name, {
            maxBytes: 100 * 1024 * 1024,
            maxChars: 2000000,
          })
        ).text,
        kind: "text",
      },
    ];
  // 图片文字读取走共享回退链(见 core/image-text.mjs)。
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
    const result = await imageTextWithFallback(bytes, signal, options.analyzeImage);
    return [{ text: result.text, kind: result.kind }];
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  check(
    !text.includes("\u0000"),
    "TEXT_ENCODING",
    "文本编码无效，请转换为 UTF-8",
  );
  if (ext === ".srt" || ext === ".vtt") {
    const segments = subtitles(text);
    check(segments.length, "SUBTITLE_EMPTY", "字幕没有可识别的时间轴");
    return segments;
  }
  return [{ text, kind: "text" }];
}
export async function transcribe(
  path,
  config,
  start,
  length,
  signal,
  fetchImpl = fetch,
) {
  const data = await readFile(path);
  check(
    data.length <= 25 * 1024 * 1024,
    "MEDIA_LIMIT",
    "转写分段超过 25MB，请缩短分段",
  );
  const form = new FormData();
  form.set("file", new Blob([data], { type: "audio/mp4" }), "segment.m4a");
  form.set("model", config.model);
  const timed =
    config.model === "whisper-1" || config.timestampFormat === "verbose_json";
  form.set("response_format", timed ? "verbose_json" : "json");
  if (timed) form.append("timestamp_granularities[]", "segment");
  const response = await fetchImpl(
    config.baseUrl.replace(/\/$/, "") + "/audio/transcriptions",
    {
      method: "POST",
      headers: config.apiKey
        ? { Authorization: "Bearer " + config.apiKey }
        : {},
      body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
      redirect: "error",
    },
  );
  check(
    response.ok,
    "TRANSCRIPTION_FAILED",
    `转写服务返回 HTTP ${response.status}，请检查接口地址、转写模型和额度`,
    502,
  );
  let size = 0;
  const parts = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    check(size <= 2000000, "MEDIA_LIMIT", "转写返回超过 2MB");
    parts.push(chunk);
  }
  let result;
  try {
    result = JSON.parse(Buffer.concat(parts).toString());
  } catch {
    throw new Error("转写接口没有返回 JSON");
  }
  if (Array.isArray(result.segments) && result.segments.length) {
    return result.segments
      .filter((s) => typeof s.text === "string" && s.text.trim())
      .map((s) => {
        check(
          Number.isFinite(s.start) &&
            Number.isFinite(s.end) &&
            s.start >= 0 &&
            s.end >= s.start &&
            s.end <= length + 2,
          "TRANSCRIPTION_TIME",
          "转写时间点超出当前片段",
        );
        return {
          start: start + s.start,
          end: start + Math.min(s.end, length),
          text: s.text.trim(),
          kind: "speech",
          timing: "segment",
        };
      });
  }
  check(
    typeof result.text === "string" && result.text.trim(),
    "TRANSCRIPTION_EMPTY",
    "没有识别到语音文字",
  );
  return [
    {
      start,
      end: start + length,
      text: result.text.trim(),
      kind: "speech",
      timing: "chunk",
    },
  ];
}
export async function extractAudioChunk(
  path,
  folder,
  index,
  start,
  length,
  signal,
) {
  const output = join(folder, `audio-${index}.m4a`);
  await unlink(output).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  await nativeJson(
    "native-media",
    { path, action: "audio", start, length, output },
    signal,
  );
  return output;
}
export async function extractFrame(path, folder, index, start, signal) {
  const output = join(folder, `frame-${index}.jpg`);
  const result = await nativeJson(
    "native-media",
    { path, action: "frame", start, output },
    signal,
  );
  const ocr = await recognizeImage(await readFile(output), signal);
  return {
    start: result.actualTime ?? start,
    text: ocr.lines.map((l) => l.text).join("\n"),
    kind: "frame",
    frame: `frame-${index}.jpg`,
    timing: "sample",
  };
}
export function sourceLines(parts) {
  const lines = [],
    locators = [];
  for (const part of parts) {
    const marker = part.page
      ? `[第 ${part.page} 页]`
      : Number.isFinite(part.start)
        ? `[${clockTime(part.start)}${Number.isFinite(part.end) ? "–" + clockTime(part.end) : ""} · ${part.kind === "frame" ? "画面抽样" : part.timing === "chunk" ? "分段转写，句子时间未提供" : "转写/字幕"}]`
        : "";
    const startLine = lines.length + 1;
    if (marker) lines.push(marker);
    for (const line of part.text.split("\n")) {
      if (!line.length) lines.push("");
      else
        for (let i = 0; i < line.length; i += 1800)
          lines.push(line.slice(i, i + 1800));
    }
    locators.push({
      ...part,
      text: undefined,
      startLine,
      endLine: lines.length,
    });
  }
  return { text: lines.join("\n"), locators };
}
