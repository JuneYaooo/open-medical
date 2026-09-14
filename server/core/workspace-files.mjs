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
} from "node:fs";
import {
  isAbsolute,
  resolve,
  relative,
  sep,
  dirname,
  basename,
  join,
} from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { check } from "../errors.mjs";
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
const forbidden = (part) =>
  blocked.has(part.toLowerCase()) ||
  /^\.env(?:\.|$)/i.test(part) ||
  /\.(?:sqlite(?:-wal|-shm)?|pem|key)$/i.test(part);
export class WorkspaceFiles {
  constructor(root) {
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
      check(
        !forbidden(part),
        "PATH_DENIED",
        "此路径属于受保护的配置或数据",
        403,
      );
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
  search(query) {
    check(
      typeof query === "string" &&
        query.trim().length > 0 &&
        query.length <= 200,
      "INVALID_INPUT",
      "检索词须为 1–200 字符",
    );
    const pending = [{ path: ".", depth: 0 }],
      matches = [];
    let directories = 0,
      scanned = 0,
      bytes = 0,
      truncated = false;
    while (
      pending.length &&
      directories < 50 &&
      scanned < 100 &&
      bytes < 5000000 &&
      matches.length < 80
    ) {
      const current = pending.shift();
      directories++;
      const entries = this.list(current.path);
      if (entries.length === 500) truncated = true;
      for (const entry of entries) {
        const path =
          current.path === "." ? entry.name : current.path + "/" + entry.name;
        if (entry.directory) {
          if (current.depth < 5)
            pending.push({ path, depth: current.depth + 1 });
          else truncated = true;
          continue;
        }
        if (scanned >= 100 || bytes >= 5000000 || matches.length >= 80) {
          truncated = true;
          break;
        }
        scanned++;
        try {
          const { text } = this.read(path);
          bytes += Buffer.byteLength(text);
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && matches.length < 80; i++)
            if (lines[i].toLowerCase().includes(query.toLowerCase()))
              matches.push({ path, line: i + 1, text: lines[i].slice(0, 240) });
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
        }
      }
    }
    return {
      matches,
      scannedFiles: scanned,
      truncated: truncated || pending.length > 0 || matches.length >= 80,
    };
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
