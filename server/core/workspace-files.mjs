import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  lstatSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import {
  matchesGlob,
  isAbsolute,
  resolve,
  relative,
  sep,
  dirname,
  basename,
  join,
} from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { check, AppError } from "../errors.mjs";
export const hashText = (text) =>
  createHash("sha256").update(text).digest("hex");
const blocked = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".codex",
  ".gnupg",
  "node_modules",
  "model.env",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
]);
// 按原因给出可操作的替代做法，而不是一句笼统的「受保护」。
const deniedReason = (part) => {
  const name = part.toLowerCase();
  if (name === "node_modules")
    return "node_modules 由包管理器管理，不可直接写入；离线内联依赖请放入仓库内普通目录（如 src/vendor/<包名>/）并用相对路径导入";
  if (/^\.env(?:\.|$)/i.test(part))
    return "环境配置文件（.env*）受保护，不可读写";
  if (/\.(?:sqlite(?:-wal|-shm)?|pem|key)$/i.test(name))
    return "数据库与密钥文件（*.sqlite、*.pem、*.key）受保护，不可读写";
  if (blocked.has(name)) return `${part} 属于受保护的配置或数据，不可读写`;
  return null;
};
const forbidden = (part) => deniedReason(part) !== null;
// ---------------------------------------------------------------------------
// search_files：受控 ripgrep 引擎 + 受限内置降级引擎
//
// 安全边界（先于任何读取生效）：
//  1. rg 只访问私有临时快照；目录枚举创建空占位文件，忽略元文件通过
//     bytes() 的 O_NOFOLLOW 读取复制，遵守忽略规则后才读取候选内容。
//  2. 候选通过 bytes() 校验并读取为快照后才启动内容子进程；原文件在
//     校验后被替换为 symlink 也不能让 rg 读取越界/受保护文件。
//  3. 内容阶段 argv 数组直接调用 rg，无 shell、最小环境、--no-config；
//     超时 / 取消 / 输出预算超限立即 kill 子进程，finally 删除私有快照。
//  4. 降级引擎复用 path()/read()，其路径校验天然生效，并保留明确上限。
// ---------------------------------------------------------------------------

const SEARCH_LIMITS = {
  maxTextLength: 200,
  maxContext: 5,
  maxLimit: 200,
  defaultLimit: 50,
  maxOffset: 1000000,
  defaultTimeoutMs: 30000,
  minTimeoutMs: 1,
  maxTimeoutMs: 120000,
  maxFileBytes: 500000,
  maxCandidates: 50000,
  batchFiles: 128,
  searchBudget: 10000000,
  listingBudget: 32000000,
  maxStreamed: 100000,
  fallback: { files: 2000, directories: 5000, depth: 32, bytes: 8000000 },
};
// 与 deniedReason 保持一致；iglob 保证与 WorkspaceFiles 的大小写不敏感判断相同。
const SEARCH_PROTECTION_GLOBS = [
  ".git",
  ".ssh",
  ".aws",
  ".codex",
  ".gnupg",
  "node_modules",
  "model.env",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
  ".env",
  ".env.*",
  "*.sqlite",
  "*.sqlite-wal",
  "*.sqlite-shm",
  "*.pem",
  "*.key",
].flatMap((pattern) => ["--iglob", `!${pattern}`]);

const rgEnvironment = () =>
  Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USERPROFILE",
      "SYSTEMROOT",
      "SYSTEMDRIVE",
      "COMSPEC",
      "TEMP",
      "TMP",
      "TMPDIR",
      "LANG",
      "LC_ALL",
    ]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );

// Availability is checked by the bounded asynchronous listing call itself.
// Avoid synchronous version probes that would block cancellation and bypass the request deadline.
const resolveRipgrep = () => [process.env.RIPGREP_PATH || "rg"];

const normalizeCandidate = (path) =>
  process.platform === "win32" ? path.replaceAll("\\", "/") : path;

const cleanLine = (text) => text.replace(/\r?\n$/, "").slice(0, 240);

const matchGlob = (glob, path) =>
  matchesGlob(glob.includes("/") ? path : basename(path), glob);

// 受控进程容器：argv 数组直调、无 shell、最小环境；onLine 返回字符串可请求
// 提前终止（记录为该原因）。输出按行投递，预算超限 / 超时 / 取消都会 kill。
const runControlled = ({
  command,
  args,
  cwd,
  signal,
  timeoutMs,
  budgetBytes,
  onLine,
  delimiter = 0x0a,
}) =>
  new Promise((resolveOutcome) => {
    const outcome = {
      code: null,
      reason: null,
      stderr: "",
      error: null,
      bytes: 0,
    };
    if (signal?.aborted) {
      outcome.reason = "cancelled";
      resolveOutcome(outcome);
      return;
    }
    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd,
      env: rgEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let pending = Buffer.alloc(0);
    let settled = false;
    let escalated = false;
    let timer = null;
    const stop = (reason) => {
      if (outcome.reason === null) outcome.reason = reason;
      if (!escalated) {
        escalated = true;
        try {
          child.kill();
        } catch {
          /* 进程已退出时 kill 失败不影响结果 */
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* 同上 */
          }
        }, 2000).unref?.();
      }
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveOutcome(outcome);
    };
    const onAbort = () => stop("cancelled");
    timer = setTimeout(() => stop("timeout"), Math.max(1, timeoutMs));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      outcome.bytes += chunk.length;
      if (outcome.reason) return;
      if (budgetBytes !== undefined && outcome.bytes > budgetBytes) {
        stop("output-budget");
        return;
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      const cut = pending.lastIndexOf(delimiter);
      if (cut >= 0) {
        const complete = pending.subarray(0, cut + 1).toString("utf8");
        pending = pending.subarray(cut + 1);
        for (const raw of complete.split(String.fromCharCode(delimiter))) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (!line) continue;
          const requested = onLine(line);
          if (typeof requested === "string") {
            stop(requested);
            break;
          }
          if (outcome.reason) break;
        }
      }
      if (budgetBytes !== undefined && outcome.bytes > budgetBytes)
        stop("output-budget");
    });
    child.stderr.on("data", (chunk) => {
      if (outcome.stderr.length < 65536)
        outcome.stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      outcome.error = error;
      settle();
    });
    child.on("close", (code) => {
      outcome.code = code;
      settle();
    });
  });

const newSearchState = () => ({
  matches: [],
  derivedEntries: [],
  scanned: 0,
  skippedProtected: 0,
  skipped: 0,
  streamed: 0,
  derived: 0,
  stopped: null,
});

// 把单个文件的全部命中写入状态流。content 模式按匹配行编号流式分页；
// files/count 模式以“文件”为分页单位（顺序与候选排序一致，翻页不漏不重）。
const collectFile = (
  state,
  request,
  path,
  entries,
  lines,
  { binary = false } = {},
) => {
  entries.sort((a, b) => a.line - b.line);
  if (!entries.length) return;
  if (binary) {
    state.skipped++;
    return;
  }
  let derivedOrdinal = null;
  for (const entry of entries) {
    const ordinal = state.streamed++;
    if (ordinal >= request.offset && ordinal < request.offset + request.limit) {
      const match = { path, line: entry.line, text: entry.text };
      if (request.context > 0 && lines) {
        match.before = [];
        match.after = [];
        for (let n = entry.line - request.context; n < entry.line; n++) {
          const text = lines.get(n);
          if (text !== undefined) match.before.push({ line: n, text });
        }
        for (let n = entry.line + 1; n <= entry.line + request.context; n++) {
          const text = lines.get(n);
          if (text !== undefined) match.after.push({ line: n, text });
        }
      }
      state.matches.push(match);
    }
    if (derivedOrdinal === null) {
      derivedOrdinal = state.derived++;
      if (
        derivedOrdinal >= request.offset &&
        derivedOrdinal < request.offset + request.limit
      )
        state.derivedEntries.push(
          request.outputMode === "count"
            ? { path, count: entries.length }
            : { path },
        );
    }
  }
};

const checkPageStop = (state, request) => {
  const units =
    request.outputMode === "content" ? state.streamed : state.derived;
  if (units >= request.offset + request.limit + 1 && state.stopped === null)
    state.stopped = "page-limit";
  if (
    request.outputMode === "content" &&
    state.streamed >= SEARCH_LIMITS.maxStreamed &&
    state.stopped === null
  )
    state.stopped = "match-limit";
};

const assembleResult = (state, request, engine, extra = {}) => {
  const units =
    request.outputMode === "content" ? state.streamed : state.derived;
  const pageEnd = request.offset + request.limit;
  const complete = state.stopped === null;
  const truncated = complete ? units > pageEnd : true;
  let nextOffset;
  if (complete) {
    if (truncated) nextOffset = pageEnd;
  } else if (
    state.stopped === "candidate-limit" ||
    state.stopped === "match-limit"
  ) {
    // 硬上限：下一轮调用会在同一上限处再次截断，因此不承诺可继续。
    nextOffset = undefined;
  } else if (state.stopped === "page-limit") nextOffset = pageEnd;
  else nextOffset = undefined;
  return {
    engine,
    matches:
      request.outputMode === "content" ? state.matches : state.derivedEntries,
    scannedFiles: state.scanned,
    skippedProtected: state.skippedProtected,
    skipped: state.skipped,
    offset: request.offset,
    limit: request.limit,
    truncated,
    complete,
    ...(state.stopped === null ? {} : { reason: state.stopped }),
    ...(nextOffset === undefined ? {} : { nextOffset }),
    ...(complete ? { total: units } : {}),
    ...extra,
  };
};

export class WorkspaceFiles {
  constructor(root, { rgCommand } = {}) {
    this.rgCommand = rgCommand;
    check(
      typeof root === "string" && isAbsolute(root),
      "WORKSPACE_PATH",
      "请选择绝对路径的本地文件夹",
    );
    this.root = realpathSync(root);
    check(
      lstatSync(this.root).isDirectory(),
      "WORKSPACE_PATH",
      "工作区必须是文件夹",
    );
    check(
      dirname(this.root) !== this.root,
      "WORKSPACE_PATH",
      "不能将整个文件系统设为工作区",
    );
  }
  path(input = ".", { create = false, parents = false } = {}) {
    check(
      typeof input === "string" &&
        input.length <= 2000 &&
        !input.includes("\0") &&
        !isAbsolute(input),
      "PATH_DENIED",
      "只能使用工作区内的相对路径",
      403,
    );
    const target = resolve(this.root, input);
    const rel = relative(this.root, target);
    check(
      rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel),
      "PATH_DENIED",
      "路径超出授权文件夹",
      403,
    );
    check(
      realpathSync(this.root) === this.root,
      "PATH_DENIED",
      "授权文件夹已变化",
      403,
    );
    const parts = rel ? rel.split(sep) : [];
    let cursor = this.root;
    for (const [index, part] of parts.entries()) {
      if (process.platform === "win32")
        check(
          !/[<>:"|?*]/.test(part) &&
            !/[ .]$/.test(part) &&
            !/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part),
          "PATH_DENIED",
          "不支持 Windows 设备路径或备用数据流",
          403,
        );
      check(!forbidden(part), "PATH_DENIED", deniedReason(part), 403);
      cursor = join(cursor, part);
      try {
        check(
          !lstatSync(cursor).isSymbolicLink(),
          "PATH_DENIED",
          "不允许通过符号链接访问文件",
          403,
        );
      } catch (error) {
        if (!(
          create &&
          (parents || index === parts.length - 1) &&
          error.code === "ENOENT"
        ))
          throw error;
      }
    }
    return target;
  }
  list(path = ".") {
    return readdirSync(this.path(path), { withFileTypes: true })
      .filter((d) => !d.isSymbolicLink() && !forbidden(d.name))
      .slice(0, 500)
      .map((d) => ({ name: d.name, directory: d.isDirectory() }));
  }
  bytes(path, limit = 10000000) {
    const fd = openSync(
      this.path(path),
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    try {
      const stat = fstatSync(fd);
      check(
        stat.isFile() && stat.size <= limit,
        "FILE_LIMIT",
        "文件超出读取预算",
      );
      const data = readFileSync(fd);
      return { path, data, size: data.length, hash: hashText(data) };
    } finally {
      closeSync(fd);
    }
  }
  read(path, { startLine, endLine } = {}) {
    const fd = openSync(
      this.path(path),
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    try {
      const stat = fstatSync(fd);
      check(
        stat.isFile() && stat.size <= 512000,
        "FILE_LIMIT",
        "只支持不超过 500KB 的文本文件",
      );
      const text = readFileSync(fd, "utf8");
      check(!text.includes("\0"), "FILE_TYPE", "该文件不是可读取的文本");
      const hash = hashText(text);
      if (startLine !== undefined || endLine !== undefined) {
        const lines = text.split("\n"),
          start = startLine ?? 1,
          end = endLine ?? start + 199;
        check(
          Number.isInteger(start) &&
            Number.isInteger(end) &&
            start >= 1 &&
            end >= start &&
            end - start < 1000,
          "LINE_RANGE",
          "行范围须为 1–1000 行",
        );
        return {
          path,
          text: lines.slice(start - 1, end).join("\n"),
          hash,
          startLine: start,
          endLine: Math.min(end, lines.length),
          totalLines: lines.length,
        };
      }
      return { path, text, hash };
    } finally {
      closeSync(fd);
    }
  }
  // 兼容旧调用 search("字面词")；新调用传参数对象与 { signal }。
  // 返回 { engine, matches, scannedFiles, truncated, complete, reason?,
  //        nextOffset?, total?, skippedProtected, skipped, offset, limit }。
  // 分页单位：content 模式为匹配行，files/count 模式为去重文件。
  // complete=true 时 truncated 精确；complete=false 表示扫描被提前终止
  // （reason 说明原因），truncated=true 仅表示“可能还有更多”。
  async search(options, { signal } = {}) {
    if (typeof options === "string") options = { query: options };
    check(
      options && typeof options === "object" && !Array.isArray(options),
      "INVALID_INPUT",
      "检索词须为 1–200 字符",
    );
    const query = options.query,
      regex = options.regex;
    check(
      (typeof query === "string") !== (typeof regex === "string"),
      "INVALID_INPUT",
      "query 与 regex 必须二选一",
    );
    let pattern;
    if (typeof query === "string") {
      check(
        query.trim().length > 0 && query.length <= SEARCH_LIMITS.maxTextLength,
        "INVALID_INPUT",
        "检索词须为 1–200 字符",
      );
      pattern = query;
    } else {
      check(
        regex.trim().length > 0 && regex.length <= SEARCH_LIMITS.maxTextLength,
        "INVALID_INPUT",
        "正则须为 1–200 字符",
      );
      pattern = regex;
    }
    const scopeInput = options.path ?? ".";
    check(
      typeof scopeInput === "string" &&
        scopeInput.length > 0 &&
        scopeInput.length <= 2000 &&
        !scopeInput.includes("\0"),
      "INVALID_INPUT",
      "path 参数须为 1–2000 字符",
    );
    check(
      lstatSync(this.path(scopeInput)).isDirectory(),
      "INVALID_INPUT",
      "检索范围必须是目录",
    );
    check(
      !relative(this.root, this.path(scopeInput))
        .split(sep)
        .some((part) => part.startsWith(".")),
      "PATH_DENIED",
      "检索不读取隐藏路径",
      403,
    );
    const glob = options.glob;
    check(
      glob === undefined ||
        (typeof glob === "string" &&
          glob.length >= 1 &&
          glob.length <= 200 &&
          !glob.includes("\0")),
      "INVALID_INPUT",
      "glob 参数须为 1–200 字符",
    );
    const ignoreCase = options.ignoreCase ?? true;
    check(
      typeof ignoreCase === "boolean",
      "INVALID_INPUT",
      "ignoreCase 须为布尔值",
    );
    const context = options.context ?? 0;
    check(
      Number.isInteger(context) &&
        context >= 0 &&
        context <= SEARCH_LIMITS.maxContext,
      "INVALID_INPUT",
      "context 须为 0–5 的整数",
    );
    const outputMode = options.outputMode ?? "content";
    check(
      ["content", "files", "count"].includes(outputMode),
      "INVALID_INPUT",
      "outputMode 须为 content、files 或 count",
    );
    const offset = options.offset ?? 0;
    check(
      Number.isInteger(offset) &&
        offset >= 0 &&
        offset <= SEARCH_LIMITS.maxOffset,
      "INVALID_INPUT",
      "offset 须为非负整数",
    );
    const limit = options.limit ?? SEARCH_LIMITS.defaultLimit;
    check(
      Number.isInteger(limit) && limit >= 1 && limit <= SEARCH_LIMITS.maxLimit,
      "INVALID_INPUT",
      "limit 须为 1–200 的整数",
    );
    const timeoutMs = options.timeoutMs ?? SEARCH_LIMITS.defaultTimeoutMs;
    check(
      Number.isInteger(timeoutMs) &&
        timeoutMs >= SEARCH_LIMITS.minTimeoutMs &&
        timeoutMs <= SEARCH_LIMITS.maxTimeoutMs,
      "INVALID_INPUT",
      "timeoutMs 须为 1–120000 的整数",
    );
    const request = {
      pattern,
      regex: typeof regex === "string",
      scopeInput,
      glob,
      ignoreCase,
      context,
      outputMode,
      offset,
      limit,
      signal,
      root: this.root,
    };
    if (signal?.aborted) throw new AppError("CANCELLED", "检索已取消");
    const command =
      this.rgCommand === null ? null : (this.rgCommand ?? resolveRipgrep());
    if (command) {
      const outcome = await this.#ripgrepSearch(
        command,
        request,
        Date.now() + timeoutMs,
      );
      if (outcome !== null) return outcome;
    }
    return this.#fallbackSearch(
      request,
      Date.now() + timeoutMs,
      "ripgrep 不可用，已降级为受限内置扫描（最多 2000 文件 / 5000 目录 / 深度 32 / 8MB）",
    );
  }

  // 返回 null 表示 ripgrep 缺失（ENOTENT），调用方降级到内置扫描。
  async #ripgrepSearch(command, request, deadline) {
    const snapshotRoot = mkdtempSync(join(tmpdir(), "workspace-search-snapshot-"));
    try {
      return await this.#snapshotSearch(command, request, deadline, snapshotRoot);
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
    }
  }

  async #snapshotSearch(command, request, deadline, snapshotRoot) {
    const remainingMs = () => Math.max(1, deadline - Date.now());
    const candidates = [];
    const seen = new Set();
    const pendingDirectories = ["."];
    let directoriesChecked = 0;
    let placeholders = 0;
    let ignoreBytes = 0;
    let entriesChecked = 0;
    while (pendingDirectories.length) {
      if (request.signal?.aborted)
        throw new AppError("CANCELLED", "检索已取消");
      if (Date.now() >= deadline)
        return assembleResult(
          { ...newSearchState(), stopped: "timeout" },
          request,
          "ripgrep",
        );
      const dir = pendingDirectories.pop();
      const entries = readdirSync(this.path(dir), { withFileTypes: true });
      mkdirSync(join(snapshotRoot, dir), { recursive: true });
      for (const entry of entries) {
        if (++entriesChecked % 128 === 0) {
          await new Promise((done) => setImmediate(done));
          if (request.signal?.aborted) throw new AppError("CANCELLED", "检索已取消");
          if (Date.now() >= deadline)
            return assembleResult({ ...newSearchState(), stopped: "timeout" }, request, "ripgrep");
        }
        const path = join(dir, entry.name);
        const ignoreFile = [".gitignore", ".ignore", ".rgignore"].includes(entry.name);
        if (ignoreFile && entry.isSymbolicLink())
          return assembleResult({ ...newSearchState(), stopped: "unsafe-ignore-file" }, request, "ripgrep");
        if (forbidden(entry.name) || entry.isSymbolicLink()) continue;
        if (ignoreFile && entry.isFile()) {
          let content;
          try { content = this.bytes(path, SEARCH_LIMITS.maxFileBytes).data; }
          catch (error) {
            if (["PATH_DENIED", "ELOOP", "ENOENT", "FILE_LIMIT"].includes(error.code))
              return assembleResult({ ...newSearchState(), stopped: "unsafe-ignore-file" }, request, "ripgrep");
            throw error;
          }
          ignoreBytes += content.length;
          if (ignoreBytes > SEARCH_LIMITS.searchBudget)
            return assembleResult({ ...newSearchState(), stopped: "snapshot-budget" }, request, "ripgrep");
          writeFileSync(join(snapshotRoot, path), content);
        } else if (!entry.name.startsWith(".")) {
          if (entry.isDirectory()) pendingDirectories.push(path);
          else if (entry.isFile()) {
            if (++placeholders > SEARCH_LIMITS.maxCandidates)
              return assembleResult({ ...newSearchState(), stopped: "candidate-limit" }, request, "ripgrep");
            writeFileSync(join(snapshotRoot, path), "");
          }
        }
      }
      if (++directoriesChecked % 32 === 0)
        await new Promise((done) => setImmediate(done));
    }
    // 阶段一：rg --files 列举候选（保护 glob 已把受保护路径排除在读取之外）。
    const listing = await runControlled({
      command,
      cwd: snapshotRoot,
      signal: request.signal,
      timeoutMs: remainingMs(),
      budgetBytes: SEARCH_LIMITS.listingBudget,
      delimiter: 0,
      args: [
        "--files",
        "--no-config",
        "--no-messages",
        "--no-ignore-global",
        "--no-ignore-parent",
        "--no-require-git",
        ...SEARCH_PROTECTION_GLOBS,
        "--glob",
        "!**/.*",
        "--null",
        ...(request.scopeInput === "." ? [] : ["--", request.scopeInput]),
      ],
      onLine: (line) => {
        if (!line) return;
        const path = normalizeCandidate(line);
        if (request.glob && !matchGlob(request.glob, path)) return;
        if (seen.has(path)) return;
        seen.add(path);
        if (candidates.length >= SEARCH_LIMITS.maxCandidates)
          return "candidate-limit";
        candidates.push(path);
      },
    });
    if (listing.error) {
      if (listing.error.code === "ENOENT") return null;
      throw new AppError(
        "SEARCH_ENGINE",
        `ripgrep 无法启动：${listing.error.message}`,
        500,
      );
    }
    if (listing.reason === null && listing.code === 2)
      throw new AppError(
        "SEARCH_ENGINE",
        `ripgrep 列举失败：${
          listing.stderr.trim().split("\n").filter(Boolean)[0] ?? "未知错误"
        }`,
        500,
      );
    candidates.sort();
    const state = newSearchState();
    state.stopped = listing.reason;
    let budgetSpent = 0;
    if (state.stopped === null || state.stopped === "candidate-limit") {
      // 阶段二：逐批校验候选并交给 rg 检索；批内按 (path, line) 排序，
      // 批间按候选字典序，保证分页顺序确定、不漏不重。
      for (
        let start = 0;
        start < candidates.length && state.stopped === null;
        start += SEARCH_LIMITS.batchFiles
      ) {
        const validated = [];
        for (const path of candidates.slice(
          start,
          start + SEARCH_LIMITS.batchFiles,
        )) {
          try {
            const snapshot = this.bytes(path, SEARCH_LIMITS.maxFileBytes);
            writeFileSync(join(snapshotRoot, path), snapshot.data);
            validated.push(path);
          } catch (error) {
            if (error.code === "PATH_DENIED") state.skippedProtected++;
            else if (["ENOENT", "EACCES", "EPERM", "ELOOP", "FILE_LIMIT"].includes(error.code))
              state.skipped++;
            else throw error;
          }
        }
        if (!validated.length) continue;
        const budgetLeft = SEARCH_LIMITS.searchBudget - budgetSpent;
        if (budgetLeft <= 4096) {
          state.stopped = "output-budget";
          break;
        }
        const perFile = new Map();
        let current = null;
        const outcome = await runControlled({
          command,
          cwd: snapshotRoot,
          signal: request.signal,
          timeoutMs: remainingMs(),
          budgetBytes: budgetLeft,
          args: [
            "--json",
            "--no-config",
            "--no-messages",
            ...SEARCH_PROTECTION_GLOBS,
            ...(request.regex ? [] : ["--fixed-strings"]),
            "-e",
            request.pattern,
            ...(request.ignoreCase ? ["--ignore-case"] : []),
            ...(request.context > 0
              ? ["--context", String(request.context)]
              : []),
            "--max-filesize",
            String(SEARCH_LIMITS.maxFileBytes),
            "--",
            ...validated,
          ],
          onLine: (line) => {
            if (!line.startsWith("{")) return;
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              return;
            }
            const data = event.data;
            if (!data) return;
            const pathText = normalizeCandidate(data.path?.text ?? "");
            if (event.type === "begin") {
              current = {
                path: pathText,
                entries: [],
                lines: request.context > 0 ? new Map() : null,
                binary: false,
              };
            } else if (
              current &&
              (event.type === "match" || event.type === "context")
            ) {
              if (!Number.isInteger(data.line_number)) return;
              const text = cleanLine(data.lines?.text ?? "");
              if (event.type === "match")
                current.entries.push({ line: data.line_number, text });
              if (current.lines) current.lines.set(data.line_number, text);
            } else if (
              event.type === "end" &&
              current &&
              pathText === current.path
            ) {
              if (
                data.binary_offset !== null &&
                data.binary_offset !== undefined
              )
                current.binary = true;
              perFile.set(current.path, current);
              current = null;
            }
          },
        });
        for (const path of validated) unlinkSync(join(snapshotRoot, path));
        budgetSpent += outcome.bytes;
        if (outcome.error) {
          if (outcome.error.code === "ENOENT") return null;
          throw new AppError(
            "SEARCH_ENGINE",
            `ripgrep 无法启动：${outcome.error.message}`,
            500,
          );
        }
        if (outcome.reason === null && outcome.code === 2) {
          const message =
            outcome.stderr.trim().split("\n").filter(Boolean)[0] ??
            "ripgrep 检索失败";
          if (/regex parse error/.test(outcome.stderr))
            throw new AppError("INVALID_INPUT", `正则无效：${message}`);
          throw new AppError("SEARCH_ENGINE", message, 500);
        }
        for (const path of validated) {
          state.scanned++;
          const file = perFile.get(path);
          if (file)
            collectFile(state, request, path, file.entries, file.lines, {
              binary: file.binary,
            });
        }
        if (outcome.reason && state.stopped === null)
          state.stopped = outcome.reason;
        if (budgetSpent >= SEARCH_LIMITS.searchBudget && state.stopped === null)
          state.stopped = "output-budget";
        if (start + SEARCH_LIMITS.batchFiles < candidates.length)
          checkPageStop(state, request);
      }
    }
    if (request.signal?.aborted) throw new AppError("CANCELLED", "检索已取消");
    return assembleResult(state, request, "ripgrep");
  }

  // ripgrep 缺失时的受限降级：使用目录枚举与 read() 的路径校验（禁止名、
  // symlink、越界天然被拒），保留文件/目录/深度/字节与时间预算上限。
  async #fallbackSearch(request, deadline, fallbackReason) {
    const state = newSearchState();
    if (request.regex)
      return assembleResult(
        { ...state, stopped: "regex-unavailable" },
        request,
        "fallback",
        {
          fallbackReason:
            "ripgrep 不可用；降级仅支持字面查询，不执行不可中断的 JavaScript 正则",
        },
      );
    // An unavailable ignore engine must not silently read files excluded by ancestor rules.
    let ancestor = request.scopeInput;
    while (true) {
      const entries = readdirSync(this.path(ancestor), { withFileTypes: true });
      if (
        entries.some((entry) =>
          [".gitignore", ".ignore", ".rgignore"].includes(entry.name),
        )
      )
        return assembleResult(
          { ...state, stopped: "ignore-rules-unavailable" },
          request,
          "fallback",
          { fallbackReason },
        );
      if (ancestor === ".") break;
      ancestor = dirname(ancestor);
    }
    const matcher = request.regex
      ? new RegExp(request.pattern, request.ignoreCase ? "i" : "")
      : request.ignoreCase
        ? request.pattern.toLowerCase()
        : request.pattern;
    const matchesLine = (line) => {
      if (request.regex) return matcher.test(line);
      return request.ignoreCase
        ? line.toLowerCase().includes(matcher)
        : line.includes(matcher);
    };
    const pending = [{ path: request.scopeInput, depth: 0 }];
    let directories = 0,
      bytesRead = 0,
      sinceYield = 0;
    while (pending.length && state.stopped === null) {
      if (Date.now() >= deadline) {
        state.stopped = "timeout";
        break;
      }
      if (directories >= SEARCH_LIMITS.fallback.directories) {
        state.stopped = "directory-limit";
        break;
      }
      const current = pending.shift();
      directories++;
      if (request.signal?.aborted)
        throw new AppError("CANCELLED", "检索已取消");
      const rawEntries = readdirSync(this.path(current.path), {
        withFileTypes: true,
      });
      if (
        rawEntries.some((entry) =>
          [".gitignore", ".ignore", ".rgignore"].includes(entry.name),
        )
      ) {
        state.stopped = "ignore-rules-unavailable";
        break;
      }
      const entries = rawEntries
        .filter(
          (entry) =>
            !entry.name.startsWith(".") &&
            !entry.isSymbolicLink() &&
            !forbidden(entry.name),
        )
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
      const sorted = [...entries].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      for (const entry of sorted) {
        const path =
          current.path === "." ? entry.name : `${current.path}/${entry.name}`;
        if (entry.directory) {
          if (current.depth + 1 <= SEARCH_LIMITS.fallback.depth)
            pending.push({ path, depth: current.depth + 1 });
          else if (state.stopped === null) state.stopped = "depth-limit";
          continue;
        }
        if (state.scanned >= SEARCH_LIMITS.fallback.files) {
          state.stopped = "file-limit";
          break;
        }
        if (Date.now() >= deadline) {
          state.stopped = "timeout";
          break;
        }
        if (request.glob && !matchGlob(request.glob, path)) continue;
        if (++sinceYield >= 16) {
          sinceYield = 0;
          await new Promise((resolve) => setImmediate(resolve));
          if (request.signal?.aborted) {
            state.stopped = "cancelled";
            break;
          }
        }
        try {
          const file = this.read(path);
          bytesRead += Buffer.byteLength(file.text);
          if (bytesRead > SEARCH_LIMITS.fallback.bytes) {
            state.stopped = "output-budget";
            break;
          }
          const lines = file.text.split("\n");
          const hits = [];
          for (let i = 0; i < lines.length; i++)
            if (matchesLine(lines[i]))
              hits.push({ line: i + 1, text: cleanLine(lines[i]) });
          state.scanned++;
          collectFile(
            state,
            request,
            path,
            hits,
            request.context > 0
              ? new Map(lines.map((text, i) => [i + 1, cleanLine(text)]))
              : null,
          );
        } catch (error) {
          if (
            ![
              "FILE_TYPE",
              "FILE_LIMIT",
              "PATH_DENIED",
              "ENOENT",
              "EACCES",
            ].includes(error.code)
          )
            throw error;
          if (error.code === "PATH_DENIED") state.skippedProtected++;
          else state.skipped++;
        }
      }
    }
    if (request.signal?.aborted) throw new AppError("CANCELLED", "检索已取消");
    // 降级引擎枚举完整跑完（上限内），complete 语义保持精确。
    return assembleResult(state, request, "fallback", { fallbackReason });
  }

  proposal(path, content, expectedHash) {
    check(
      typeof content === "string" && Buffer.byteLength(content) <= 512000,
      "FILE_LIMIT",
      "修改内容超过 500KB",
    );
    this.path(path, { create: true, parents: true });
    let before = null;
    try {
      before = this.read(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    check(
      expectedHash === (before?.hash ?? null),
      "FILE_CONFLICT",
      "文件版本已变化，请重新读取后修改",
      409,
    );
    return {
      id: randomUUID(),
      kind: "file.write",
      path,
      before: before?.text ?? null,
      expectedHash,
      content,
      status: "pending",
      createdAt: Date.now(),
    };
  }
  apply(proposal) {
    if (proposal.kind === "file.delete") {
      check(
        this.read(proposal.path).hash === proposal.expectedHash,
        "FILE_CONFLICT",
        "待删除文件版本已变化",
        409,
      );
      unlinkSync(this.path(proposal.path));
      return { path: proposal.path, deleted: true, hash: null };
    }
    this.proposal(proposal.path, proposal.content, proposal.expectedHash);
    const target = this.path(proposal.path, { create: true, parents: true });
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    this.path(proposal.path, { create: true });
    const temp = join(
      dirname(target),
      `.${basename(target)}.${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temp, proposal.content, {
        flag: "wx",
        mode:
          proposal.expectedHash === null
            ? 0o600
            : lstatSync(target).mode & 0o777,
      });
      // Revalidate immediately before mutation. Other local processes are outside this application boundary.
      this.proposal(proposal.path, proposal.content, proposal.expectedHash);
      if (proposal.expectedHash === null) {
        linkSync(temp, target);
        unlinkSync(temp);
      } else renameSync(temp, target);
      return { path: proposal.path, hash: hashText(proposal.content) };
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* A cleanup error cannot change the outcome of a completed write. */
      }
    }
  }
  edit(path, edits, expectedHash) {
    const file = this.read(path);
    check(
      file.hash === expectedHash,
      "FILE_CONFLICT",
      "文件已变化，请重新读取",
      409,
    );
    check(
      Array.isArray(edits) && edits.length > 0 && edits.length <= 50,
      "EDIT_LIMIT",
      "每次支持 1–50 项精确编辑",
    );
    let content = file.text;
    for (const edit of edits) {
      check(
        typeof edit.oldText === "string" &&
          edit.oldText.length > 0 &&
          typeof edit.newText === "string",
        "EDIT_INPUT",
        "编辑必须提供非空原文及替换文本",
      );
      const first = content.indexOf(edit.oldText);
      check(
        first >= 0 && content.indexOf(edit.oldText, first + 1) < 0,
        "EDIT_AMBIGUOUS",
        "原文必须唯一匹配，请扩大上下文",
      );
      content =
        content.slice(0, first) +
        edit.newText +
        content.slice(first + edit.oldText.length);
    }
    return this.proposal(path, content, expectedHash);
  }
  deletion(path, expectedHash) {
    const file = this.read(path);
    check(
      file.hash === expectedHash,
      "FILE_CONFLICT",
      "文件已变化，请重新读取",
      409,
    );
    return {
      id: randomUUID(),
      kind: "file.delete",
      path,
      before: file.text,
      content: null,
      expectedHash,
      status: "pending",
      createdAt: Date.now(),
    };
  }
  snapshot() {
    const paths = [],
      skipped = [],
      pending = ["."];
    let bytes = 0,
      directories = 0;
    while (pending.length) {
      check(
        ++directories <= 300,
        "SNAPSHOT_LIMIT",
        "目录超过 300 个，请明确选择文件",
      );
      const dir = pending.shift(),
        entries = this.list(dir);
      check(
        entries.length < 500,
        "SNAPSHOT_LIMIT",
        "目录条目过多，请明确选择文件",
      );
      for (const entry of entries) {
        if (
          [
            "dist",
            "build",
            "release",
            "output",
            ".venv",
            "__pycache__",
          ].includes(entry.name)
        )
          continue;
        const path = dir === "." ? entry.name : dir + "/" + entry.name;
        if (entry.directory) {
          pending.push(path);
          continue;
        }
        try {
          const file = this.read(path);
          bytes += Buffer.byteLength(file.text);
          paths.push(path);
        } catch (error) {
          if (
            ![
              "FILE_LIMIT",
              "FILE_TYPE",
              "ENOENT",
              "PATH_DENIED",
              "EACCES",
            ].includes(error.code)
          )
            throw error;
          skipped.push(path);
        }
        check(
          paths.length <= 500 && bytes <= 10000000,
          "SNAPSHOT_LIMIT",
          "快照超过 500 文件或 10MB，请明确选择文件",
        );
      }
    }
    return { paths, skipped, bytes };
  }
}
