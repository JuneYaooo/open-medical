// 夹具注入与工作区隔离:
// - fixtures 路径必须限制在本次临时工作区内(拒绝绝对路径/..穿越/盘符/反斜杠)。
// - 每次运行注入独立标记文件;初始/最终清单用 SHA-256 记录,防旧产物冒充。
// - D02:评估侧把 contract-source.txt 生成真实两页 PDF,被测方只收 PDF。
// - C03:控制器附加接口约定(README 明确允许,不改 cases.json)。
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { buildPdf, extractPdfPages } from "./pdf-writer.mjs";

export const C03_INTERFACE_NOTE = [
  "分页接口约定:",
  "- 页码从 1 开始(第 1 页是首页,不是第 0 页)。",
  "- 页大小 size 必须为正整数。",
  "- 非法参数(如页码小于 1、size 非正整数)必须抛出明确错误,不能静默返回空列表。",
  "",
].join("\n");

/** 夹具路径安全校验:仅允许工作区内的相对正斜杠路径。 */
export function safeRelativePath(p) {
  if (typeof p !== "string" || !p.length) return { ok: false, reason: "路径为空" };
  if (p.includes("\\"))
    return { ok: false, reason: `路径包含反斜杠:${p}` };
  if (/^[a-zA-Z]:/.test(p)) return { ok: false, reason: `绝对盘符路径:${p}` };
  if (p.startsWith("/") || p.startsWith("//"))
    return { ok: false, reason: `绝对路径:${p}` };
  if (p.includes("\0")) return { ok: false, reason: "路径包含 NUL" };
  const normalized = normalize(p).split(sep).join("/");
  if (normalized.split("/").includes(".."))
    return { ok: false, reason: `路径包含 .. 穿越:${p}` };
  if (normalized !== p) return { ok: false, reason: `路径未规范化:${p}` };
  if (normalized.startsWith(".") && !normalized.startsWith("./"))
    return { ok: false, reason: `隐藏段路径:${p}` };
  return { ok: true, path: normalized };
}

export function sha256Bytes(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** 递归哈希清单:relativePath -> {sha256, size}。 */
export function hashTree(root) {
  const manifest = {};
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile())
        manifest[rel] = { sha256: sha256Bytes(readFileSync(abs)), size: st.size };
    }
  };
  walk(root, "");
  return manifest;
}

export function diffManifests(initial, final) {
  const added = [];
  const modified = [];
  const removed = [];
  for (const [path, info] of Object.entries(final)) {
    if (!(path in initial)) added.push(path);
    else if (initial[path].sha256 !== info.sha256) modified.push(path);
  }
  for (const path of Object.keys(initial)) if (!(path in final)) removed.push(path);
  return { added, modified, removed };
}

/** 生成运行标记。 */
export function markerToken() {
  return `EVAL-${Date.now().toString(36).toUpperCase()}-${randomHex(6)}`;
}
function randomHex(n) {
  let s = "";
  while (s.length < n) s += Math.floor(Math.random() * 16).toString(16);
  return s.toUpperCase();
}

/**
 * 把夹具写入独立工作区。
 * 返回 { injected: [paths], marker, d02?: { pdfPath, sha256, readback } }。
 */
export async function injectFixtures(root, caseItem, { marker }) {
  const injected = [];
  let d02 = null;
  for (const [rawPath, content] of Object.entries(caseItem.fixtures || {})) {
    const check = safeRelativePath(rawPath);
    if (!check.ok) throw new Error(`夹具路径不安全:${rawPath}(${check.reason})`);
    if (caseItem.id === "D02") {
      // 被测方只能收到真实 PDF,源 txt 不落盘。
      const lines = String(content)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.replace(/^\[第(\d)页\]\s*/, ""));
      const pages = [lines.slice(0, Math.ceil(lines.length / 2)), lines.slice(Math.ceil(lines.length / 2))];
      const { bytes } = buildPdf(pages);
      // 冻结前先独立读回校验:两页、内容、页归属。
      const readback = await extractPdfPages(bytes);
      const flat = readback.join("\n");
      const mustContain = ["12000", "2026年2月10日", "20元"];
      for (const needle of mustContain)
        if (!flat.includes(needle))
          throw new Error(`D02 PDF 读回缺少关键内容 ${needle}`);
      const pdfPath = "contract.pdf";
      mkdirSync(join(root, dirnameOf(pdfPath)), { recursive: true });
      writeFileSync(join(root, pdfPath), bytes);
      injected.push(pdfPath);
      d02 = { pdfPath, sha256: sha256Bytes(bytes), readback, pages: readback.length };
      continue;
    }
    const target = join(root, check.path);
    mkdirSync(join(root, dirnameOf(check.path)), { recursive: true });
    writeFileSync(target, String(content), "utf8");
    injected.push(check.path);
  }
  // C03:接口约定作为夹具的一部分提供给被测方(控制器附加,不改数据集)。
  if (caseItem.id === "C03") {
    writeFileSync(join(root, "接口约定.txt"), C03_INTERFACE_NOTE, "utf8");
    injected.push("接口约定.txt");
  }
  // 运行标记:防旧产物冒充;标记文件本身不得被改动或删除。
  writeFileSync(
    join(root, "EVAL-RUN-MARKER.txt"),
    `EVAL-RUN-MARKER:${marker}\ncase:${caseItem.id}\ndataset:general-agent-v1\n`,
    "utf8",
  );
  injected.push("EVAL-RUN-MARKER.txt");
  return { injected, marker, d02 };
}

function dirnameOf(p) {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? "." : p.slice(0, idx);
}
