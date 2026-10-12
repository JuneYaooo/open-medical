import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { connect as tlsConnect } from "node:tls";
import http from "node:http";
import https from "node:https";
import { posix } from "node:path";
import tar from "tar-stream";
import yaml from "js-yaml";
import { check, string } from "../errors.mjs";

// Install ready-made skill packs (a GitHub repo or any HTTPS tar.gz) into the
// doctor's own skill library. A skill is instructions plus reference files:
// nothing extracted here is ever executed, and every skill is validated with
// the same rules the SkillRegistry enforces (frontmatter name === directory
// id, description required, SKILL.md ≤ 100KB) before it can become a pending
// proposal. The doctor confirms before anything lands in their library.
const ID = /^[-a-z0-9_]+$/;
const FRONT = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n([\s\S]*)$/;
// Caps sized for real packs (e.g. gpt-image2-ppt-skills: 629 files, 28MB,
// largest file 3.8MB) — a pack over these is refused with a readable error,
// not silently trimmed.
export const IMPORT_LIMITS = {
  download: 50_000_000,
  expanded: 50_000_000,
  entries: 2500,
  file: 4_000_000,
  skillFile: 100_000,
  filesPerSkill: 700,
  bytesPerSkill: 40_000_000,
  skillsPerInstall: 8,
  timeoutMs: 300_000,
};
const decoder = new TextDecoder("utf-8", { fatal: true });
const encodingFor = (data) => {
  try {
    decoder.decode(data);
    return "utf8";
  } catch {
    return "base64";
  }
};

// https://github.com/<owner>/<repo>[/tree/<ref>[/<subdir>]] → target; else null.
export function parseGitHubTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1])) return null;
  const target = { owner: parts[0], repo: parts[1].replace(/\.git$/, ""), ref: null, subdir: "" };
  if (parts[2]) {
    if (parts[2] !== "tree" || parts.length < 4) return null;
    target.ref = parts[3];
    target.subdir = parts.slice(4).join("/");
  }
  return target;
}

// Doctors who reach GitHub at all usually do it through a system proxy;
// Node's fetch ignores it (a 22KB/s direct route vs 4MB/s through the very
// proxy the browser uses). Honour env vars first, then the OS setting.
const isLocalHost = (hostname) =>
  ["localhost", "::1"].includes(hostname) ||
  /^127\./.test(hostname) ||
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname) ||
  hostname.endsWith(".local");

export async function resolveProxyFor(rawUrl, { env = process.env, platform = process.platform, run = execFile } = {}) {
  let host;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return null;
  }
  // 本机与内网地址永不走代理：本地 OCR worker、wx-cli 等回环服务不能被劫持。
  if (isLocalHost(host)) return null;
  const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  if (fromEnv) return fromEnv;
  try {
    if (platform === "win32") {
      const query = (name) => new Promise((resolve, reject) =>
        run("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", name], (error, stdout) => error ? reject(error) : resolve(stdout)));
      const [enabled, server] = await Promise.all([query("ProxyEnable"), query("ProxyServer")]);
      if (!/ProxyEnable\s+REG_DWORD\s+0x1/.test(enabled)) return null;
      const match = server.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
      if (!match) return null;
      const value = match[1];
      const httpsPart = value.includes(";") ? (value.split(";").find((p) => p.startsWith("https=")) || "").slice(6) : value;
      if (!httpsPart) return null;
      return httpsPart.includes(":") ? `http://${httpsPart}` : `http://${httpsPart}:80`;
    }
    if (platform === "darwin") {
      const stdout = await new Promise((resolve, reject) =>
        run("scutil", ["--proxy"], (error, out) => error ? reject(error) : resolve(out)));
      if (!/HTTPSEnable\s*:\s*1/.test(stdout)) return null;
      const host = stdout.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      if (!host) return null;
      const port = stdout.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      return `http://${host}:${port || 80}`;
    }
  } catch {
    return null;
  }
  return null;
}

// CONNECT tunnel + TLS, then a plain HTTPS request through it. Only the
// happy direct path (codeload answers 200) needs redirect handling; the
// proxied path reports a readable error instead of following redirects.
function requestViaProxy(proxyUrl, targetUrl) {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  const port = target.port || 443;
  return new Promise((resolve, reject) => {
    const tunnel = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}` },
      timeout: IMPORT_LIMITS.timeoutMs,
    });
    tunnel.on("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败（HTTP ${response.statusCode}）`));
        return;
      }
      const secure = tlsConnect({ socket, server: target.hostname, servername: target.hostname });
      secure.once("error", (error) => reject(new Error(`代理 TLS 握手失败：${error.message}`)));
      secure.once("secureConnect", () => {
        const request = https.request(target, { createConnection: () => secure, headers: { "accept-encoding": "identity" }, timeout: IMPORT_LIMITS.timeoutMs }, (upstream) => {
          resolve({
            ok: upstream.statusCode >= 200 && upstream.statusCode < 300,
            status: upstream.statusCode,
            url: target.href,
            body: upstream,
          });
        });
        request.on("error", reject);
        request.on("timeout", () => request.destroy(new Error("连接超时")));
        request.end();
      });
    });
    tunnel.on("timeout", () => tunnel.destroy(new Error("连接超时")));
    tunnel.on("error", (error) => reject(new Error(`代理连接失败：${error.message}`)));
    tunnel.end();
  });
}

async function download(url, fetchImpl, proxyUrl) {
  const source = new URL(url);
  check(
    source.protocol === "https:" && !source.username && !source.password,
    "SKILL_SOURCE",
    "技能包地址须为不含凭据的 HTTPS 链接",
  );
  let response;
  try {
    response = proxyUrl
      ? await requestViaProxy(proxyUrl, source)
      : await fetchImpl(source, { redirect: "follow", signal: AbortSignal.timeout(IMPORT_LIMITS.timeoutMs) });
  } catch (error) {
    check(false, "SKILL_SOURCE", `技能包下载失败：${error?.name === "TimeoutError" || error?.message === "连接超时" ? `连接超时（${IMPORT_LIMITS.timeoutMs / 1000} 秒），仓库过大或网络较慢，可稍后重试` : error?.message || "网络错误"}`);
  }
  if (response.status === 404 || response.status === 410) throw Object.assign(new Error(`SKILL_MISSING:${response.status}`), { notFound: true });
  check(response.ok && response.body, "SKILL_SOURCE", `技能包下载失败（HTTP ${response.status}），请确认地址指向公开仓库或压缩包`);
  check(String(response.url || url).startsWith("https://"), "SKILL_SOURCE", "下载被重定向到非 HTTPS 地址，已中止");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    check(size <= IMPORT_LIMITS.download, "SKILL_LIMIT", "技能包压缩包超过 50MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function extractArchive(compressed) {
  const archive =
    compressed[0] === 0x1f && compressed[1] === 0x8b
      ? gunzipSync(compressed, { maxOutputLength: IMPORT_LIMITS.expanded })
      : compressed;
  const files = new Map();
  let entries = 0;
  let expanded = 0;
  await new Promise((resolve, reject) => {
    const extract = tar.extract();
    extract.on("error", reject);
    extract.on("finish", resolve);
    extract.on("entry", (header, stream, next) => {
      stream.on("error", reject);
      const name = header.name.replace(/^\.\//, "");
      if (
        ++entries > IMPORT_LIMITS.entries ||
        !["directory", "file"].includes(header.type) ||
        posix.isAbsolute(name) ||
        name.includes("\\") ||
        name.includes("\0") ||
        name.split("/").includes("..") ||
        (header.type === "file" && header.size > IMPORT_LIMITS.file * 2)
      ) {
        extract.destroy(new Error("压缩包含链接、越界路径或过大条目"));
        return;
      }
      const chunks = [];
      stream.on("data", (chunk) => {
        expanded += chunk.length;
        if (expanded > IMPORT_LIMITS.expanded) extract.destroy(new Error("技能包解包超过 45MB"));
        else chunks.push(chunk);
      });
      stream.on("end", () => {
        if (header.type === "file") {
          if (files.has(name)) {
            extract.destroy(new Error("压缩包含重复路径"));
            return;
          }
          files.set(name, Buffer.concat(chunks));
        }
        next();
      });
      stream.resume();
    });
    extract.end(archive);
  });
  return files;
}

// Git tarballs wrap everything in one top directory; plain tars may not.
function stripCommonPrefix(files) {
  const names = [...files.keys()];
  if (names.length < 2) return files;
  const first = names[0].split("/")[0];
  if (!first || names.some((name) => !name.startsWith(first + "/"))) return files;
  return new Map(names.map((name) => [name.slice(first.length + 1), files.get(name)]));
}

function* discover(files) {
  const paths = [...files.keys()];
  if (paths.includes("SKILL.md")) {
    yield { id: null, root: "", raw: files.get("SKILL.md") };
    return;
  }
  for (const marker of paths.filter((p) => p.endsWith("/SKILL.md")))
    yield { id: marker.slice(0, -"SKILL.md".length).split("/").filter(Boolean).pop(), root: marker.slice(0, -"SKILL.md".length), raw: files.get(marker) };
}

function frontmatter(raw, hint) {
  const match = raw.toString("utf8").match(FRONT);
  check(match, "SKILL_FORMAT", `技能 ${hint || "(根目录)"} 的 SKILL.md 缺少有效 frontmatter`);
  let meta;
  try {
    meta = yaml.load(match[1], { schema: yaml.FAILSAFE_SCHEMA, maxDepth: 10 });
  } catch {
    meta = null;
  }
  check(
    meta && !Array.isArray(meta) && typeof meta.name === "string" && typeof meta.description === "string" &&
      meta.description.trim() && meta.description.length <= 4000,
    "SKILL_FORMAT",
    `技能 ${hint || meta?.name || "(?)"} 需要 name 和不超过 4000 字的 description`,
  );
  return {
    name: meta.name,
    description: meta.description,
    title: typeof meta.title === "string" ? meta.title.slice(0, 200) : null,
    body: match[2],
  };
}

function validateSkill(candidate, files, origin) {
  const meta = frontmatter(candidate.raw, candidate.id);
  const id = candidate.root ? candidate.id : meta.name;
  check(ID.test(id), "SKILL_FORMAT", `技能名 ${id || "(空)"} 只能包含小写字母、数字、- 和 _`);
  if (candidate.root) check(meta.name === id, "SKILL_FORMAT", `技能 ${id} 的 frontmatter name 与目录名不一致`);
  check(candidate.raw.length <= IMPORT_LIMITS.skillFile, "SKILL_LIMIT", `技能 ${id} 的 SKILL.md 超过 100KB`);
  // A nested SKILL.md marks another skill; it is discovered on its own and
  // must not ship twice inside the parent's reference files.
  const members = [...files.keys()]
    .filter((p) => p.startsWith(candidate.root) && p !== candidate.root + "SKILL.md")
    .filter((p) => !candidate.root || !isSkillMarker(p))
    .sort();
  check(members.length + 1 <= IMPORT_LIMITS.filesPerSkill, "SKILL_LIMIT", `技能 ${id} 文件数超过 ${IMPORT_LIMITS.filesPerSkill}`);
  const skillFiles = [{ path: "SKILL.md", encoding: "utf8", content: candidate.raw.toString("utf8") }];
  let total = candidate.raw.length;
  for (const path of members) {
    const data = files.get(path);
    const rel = path.slice(candidate.root.length);
    check(rel.length > 0 && rel.length <= 200, "SKILL_LIMIT", `技能 ${id} 文件路径过长`);
    check(data.length <= IMPORT_LIMITS.file, "SKILL_LIMIT", `技能 ${id} 的文件 ${rel.slice(0, 80)} 超过 ${IMPORT_LIMITS.file / 1_000_000}MB`);
    total += data.length;
    check(total <= IMPORT_LIMITS.bytesPerSkill, "SKILL_LIMIT", `技能 ${id} 总大小超过 12MB`);
    const encoding = encodingFor(data);
    skillFiles.push({ path: rel, encoding, content: encoding === "utf8" ? data.toString("utf8") : data.toString("base64") });
  }
  return {
    imported: true,
    id,
    name: meta.name,
    title: meta.title || meta.name,
    description: meta.description,
    body: meta.body,
    files: skillFiles,
    origin,
  };
}

function isSkillMarker(path) {
  return path === "SKILL.md" || path.endsWith("/SKILL.md");
}

export async function stageSkillImport({
  url,
  select,
  skillExists = () => false,
  lookupExtension = () => null,
  fetchImpl = fetch,
  resolveProxy = resolveProxyFor,
} = {}) {
  check(typeof url === "string" && url.trim(), "INVALID_INPUT", "请提供 GitHub 仓库或 tar.gz 压缩包地址");
  const target = parseGitHubTarget(url.trim());
  let displayUrl;
  let attempts;
  if (target) {
    const base = `https://codeload.github.com/${target.owner}/${target.repo}/tar.gz/`;
    attempts = target.ref
      ? [`${base}refs/heads/${target.ref}`, `${base}refs/tags/${target.ref}`, base + target.ref]
      : [base + "HEAD"];
    displayUrl = `https://github.com/${target.owner}/${target.repo}${target.ref ? `/tree/${target.ref}${target.subdir ? `/${target.subdir}` : ""}` : ""}`;
  } else {
    const direct = string(url, "技能包地址", 500);
    check(/^https:\/\/[^\s"<>]+(\.tar\.gz|\.tgz)$/i.test(direct), "SKILL_SOURCE", "地址须为 GitHub 仓库链接或 https 的 .tar.gz/.tgz 压缩包");
    attempts = [direct];
    displayUrl = direct;
  }
  let proxyUrl = null;
  try {
    proxyUrl = resolveProxy ? await resolveProxy(displayUrl) : null;
  } catch {
    proxyUrl = null;
  }
  let compressed = null;
  let lastError = null;
  for (const candidate of attempts) {
    try {
      compressed = await download(candidate, fetchImpl, proxyUrl);
      break;
    } catch (error) {
      lastError = error;
      if (!error?.notFound) break;
    }
  }
  check(compressed, "SKILL_SOURCE", lastError?.notFound
    ? "仓库或分支不存在（404），请确认地址与分支名"
    : lastError?.message || "技能包下载失败");
  const origin = {
    url: displayUrl,
    repo: target ? `${target.owner}/${target.repo}` : new URL(displayUrl).hostname,
    ref: target?.ref || null,
    hash: createHash("sha256").update(compressed).digest("hex"),
  };
  let files;
  try {
    files = await extractArchive(compressed);
  } catch (error) {
    check(false, "SKILL_LIMIT", `技能包解包失败：${error?.message || "压缩包格式无效"}`);
  }
  files = stripCommonPrefix(files);
  if (target?.subdir) {
    const prefix = target.subdir.replace(/\/+$/, "") + "/";
    const scoped = new Map([...files].filter(([p]) => p.startsWith(prefix)).map(([p, data]) => [p.slice(prefix.length), data]));
    files = scoped;
    check(files.size > 0, "SKILL_FORMAT", `子目录 ${target.subdir} 里没有文件`);
  }
  const skills = [];
  const skipped = [];
  for (const candidate of discover(files)) {
    try {
      const value = validateSkill(candidate, files, origin);
      const existing = lookupExtension(value.id);
      if (existing) {
        check(existing.kind === "skill" && existing.imported, "NAME_CONFLICT", `与已有${existing.kind === "skill" ? "技能" : "扩展"}「${existing.name}」重名`);
        value.previousVersion = existing.version;
      } else if (skillExists(value.id)) {
        check(false, "NAME_CONFLICT", "与内置技能重名");
      }
      skills.push(value);
    } catch (error) {
      skipped.push({ id: candidate.id || "(根目录)", reason: error.message });
    }
  }
  const chosen = new Set((Array.isArray(select) ? select : []).map(String));
  for (let index = skills.length - 1; index >= 0; index--) {
    const skill = skills[index];
    if (chosen.size && !chosen.has(skill.id)) {
      skills.splice(index, 1);
      skipped.push({ id: skill.id, reason: "未选择" });
    }
  }
  if (chosen.size) {
    const known = new Set([...skills, ...skipped].map((s) => s.id));
    const unknown = [...chosen].filter((id) => !known.has(id));
    check(!unknown.length, "INVALID_INPUT", `压缩包里没有这些技能：${unknown.join("、")}`);
  }
  check(skills.length > 0, "SKILL_FORMAT", skipped.length
    ? `没有可安装的技能：${skipped.map((s) => `${s.id}（${s.reason}）`).join("；")}`
    : "压缩包里没有找到技能（未发现 SKILL.md）");
  check(skills.length <= IMPORT_LIMITS.skillsPerInstall, "INVALID_INPUT",
    `这个包里有 ${skills.length} 个技能，一次最多安装 ${IMPORT_LIMITS.skillsPerInstall} 个，请用 skills 参数选择`);
  const preview = {
    skills: skills.map((s) => ({
      id: s.id,
      name: s.name,
      title: s.title,
      description: s.description.slice(0, 200),
      files: s.files.length,
      bytes: s.files.reduce((n, f) => n + (f.encoding === "base64" ? Math.ceil(f.content.length * 0.75) : f.content.length), 0),
      update: s.previousVersion || null,
    })),
    skipped,
  };
  return {
    source: origin,
    skills,
    preview,
    skipped,
    summary: `安装 ${skills.length} 个技能：${skills.map((s) => s.name).join("、")}`.slice(0, 300),
  };
}
