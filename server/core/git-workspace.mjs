import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, lstatSync } from "node:fs";
import { mkdtemp, rm, open, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { check, AppError } from "../errors.mjs";
import { WorkspaceFiles } from "./workspace-files.mjs";

const exec = promisify(execFile);
// No shell, external diffs, textconv, hooks, fsmonitor, pager, signing or inherited GIT_* overrides.
export class GitWorkspace {
  constructor(root) {
    this.files = new WorkspaceFiles(root);
    this.root = this.files.root;
  }
  async command(args, { signal, inputEnv = {}, config = [], input } = {}) {
    if (args[0] !== "config")
      config = [...config, ...(await this.disabledFilters(signal))];
    const env = Object.fromEntries(
      ["PATH", "SYSTEMROOT", "TMPDIR", "TEMP"]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    );
    try {
      return (
        await exec(
          "git",
          [
            "--no-pager",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "diff.external=",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "core.quotePath=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            ...config.flatMap((value) => ["-c", value]),
            ...args,
          ],
          {
            cwd: this.root,
            signal,
            timeout: 15000,
            maxBuffer: 512000,
            ...(input !== undefined ? { input } : {}),
            env: {
              ...env,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL:
                process.platform === "win32" ? "NUL" : "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
              GIT_OPTIONAL_LOCKS: "0",
              GIT_LITERAL_PATHSPECS: "1",
              ...inputEnv,
            },
          },
        )
      ).stdout;
    } catch (error) {
      signal?.throwIfAborted();
      if (
        args[0] === "config" &&
        args.includes("--get-regexp") &&
        error.code === 1
      )
        return "";
      throw new AppError(
        "GIT_ERROR",
        error.code === "ENOENT"
          ? "未安装 Git"
          : "Git 操作失败：请检查仓库、版本和工作区状态",
        409,
      );
    }
  }
  async checkRoot(signal) {
    const top = (
      await this.command(["rev-parse", "--show-toplevel"], { signal })
    ).trim();
    check(
      realpathSync(top) === this.root,
      "GIT_SCOPE",
      "请将仓库根目录作为授权工作区，不能读取父级仓库",
      403,
    );
  }
  visible(path) {
    try {
      this.files.path(path, { create: true, parents: true });
      return true;
    } catch {
      return false;
    }
  }
  async head(signal) {
    return (
      await this.command(["rev-parse", "--verify", "HEAD"], { signal })
    ).trim();
  }
  async disabledFilters(signal) {
    const filters = (
      await this.command(
        [
          "config",
          "--name-only",
          "--get-regexp",
          "^filter\\..*\\.(smudge|clean|process|required)$",
        ],
        { signal },
      )
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    const disabled = filters.map(
      (key) => key + (key.endsWith(".required") ? "=false" : "="),
    );
    return disabled;
  }
  async fileScope(path, signal) {
    const target = this.files.path(path, { create: true, parents: true });
    try {
      check(lstatSync(target).isFile(), "GIT_SCOPE", "必须指定单个文件", 403);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const tracked = (
      await this.command(["ls-files", "--stage", "-z", "--", path], { signal })
    )
      .split("\0")
      .filter(Boolean);
    check(
      tracked.every((line) => line.slice(line.indexOf("\t") + 1) === path),
      "GIT_SCOPE",
      "路径不能展开为目录或其他文件",
      403,
    );
  }
  async commit({ expectedHead, message, files }, signal) {
    await this.checkRoot(signal);
    check(
      typeof message === "string" &&
        message.trim().length > 0 &&
        message.length <= 2000,
      "GIT_MESSAGE",
      "提交说明须为 1–2000 字符",
    );
    check(
      Array.isArray(files) &&
        files.length > 0 &&
        files.length <= 100 &&
        files.every(
          (file) =>
            file &&
            typeof file === "object" &&
            typeof file.path === "string" &&
            file.path.length > 0 &&
            (file.hash === null ||
              (typeof file.hash === "string" &&
                /^[a-f0-9]{64}$/.test(file.hash))),
        ) &&
        new Set(files.map((f) => f.path)).size === files.length,
      "GIT_FILES",
      "需要 1–100 个不同文件及其版本",
    );
    check(
      (await this.head(signal)) === expectedHead,
      "GIT_CONFLICT",
      "HEAD 已变化",
      409,
    );
    const staged = await this.command(
      [
        "diff",
        "--cached",
        "--name-only",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
      ],
      { signal },
    );
    check(
      !staged,
      "GIT_INDEX_BUSY",
      "存在用户已暂存的修改，请先自行处理，避免混入提交",
      409,
    );
    for (const file of files) {
      await this.fileScope(file.path, signal);
      let actual = null;
      try {
        actual = this.files.read(file.path).hash;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      check(
        actual === file.hash,
        "GIT_CONFLICT",
        "文件已变化，请刷新后提交",
        409,
      );
    }
    const paths = files.map((f) => f.path);
    const directory = await mkdtemp(join(tmpdir(), "omw-git-index-"));
    const index = (args, options = {}) =>
      this.command(args, {
        ...options,
        inputEnv: { GIT_INDEX_FILE: join(directory, "index") },
      });
    try {
      await index(["read-tree", expectedHead], { signal });
      // `git add` can invoke a repository clean filter before command-line
      // overrides are applied on some Git versions. Build the index from raw
      // blobs instead, so a hostile filter process can never run or alter data.
      for (const file of files) {
        if (file.hash === null) {
          await index(["update-index", "--remove", "--", file.path], {
            signal,
          });
          continue;
        }
        const blob = (
          await this.command(
            ["hash-object", "-w", "--no-filters", "--", file.path],
            { signal },
          )
        ).trim();
        check(
          /^[a-f0-9]{40,64}$/.test(blob),
          "GIT_CONFLICT",
          "无法创建受控 Git 对象",
          409,
        );
        let mode = "100644";
        try {
          if (lstatSync(this.files.path(file.path)).mode & 0o111)
            mode = "100755";
        } catch {}
        await index(
          [
            "update-index",
            "--add",
            "--cacheinfo",
            `${mode},${blob},${file.path}`,
          ],
          { signal },
        );
      }
      check(
        (await this.head(signal)) === expectedHead,
        "GIT_CONFLICT",
        "HEAD 已变化；选中文件已暂存，请检查索引",
        409,
      );
      const nowStaged = (
        await index(
          [
            "diff",
            "--cached",
            "--name-only",
            "-z",
            "--no-ext-diff",
            "--no-textconv",
          ],
          { signal },
        )
      )
        .split("\0")
        .filter(Boolean);
      check(
        nowStaged.length > 0 && nowStaged.every((path) => paths.includes(path)),
        "GIT_CONFLICT",
        "暂存区无变更或包含其他文件，请检查索引",
        409,
      );
      // Plumbing avoids `git commit` refreshing tracked files through clean filters.
      const tree = (await index(["write-tree"], { signal })).trim();
      const commit = (
        await this.command(
          ["commit-tree", tree, "-p", expectedHead, "-m", message],
          { signal },
        )
      ).trim();
      check(/^[a-f0-9]{40,64}$/.test(commit), "GIT_COMMIT", "无法创建提交对象");
      const indexPath = resolve(
        this.root,
        (
          await this.command(["rev-parse", "--git-path", "index"], { signal })
        ).trim(),
      );
      let lock;
      try {
        lock = await open(indexPath + ".lock", "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST")
          throw new AppError(
            "GIT_INDEX_BUSY",
            "Git 索引正在被其他程序使用",
            409,
          );
        throw error;
      }
      try {
        check(
          !(await this.command(["diff", "--cached", "--name-only", "-z"], {
            signal,
          })),
          "GIT_INDEX_BUSY",
          "用户暂存区已变化，未更新 HEAD",
          409,
        );
        await lock.writeFile(await readFile(join(directory, "index")));
        await lock.close();
        await this.command(
          [
            "update-ref",
            "-m",
            "commit: " + message.split("\n")[0],
            "HEAD",
            commit,
            expectedHead,
          ],
          { signal },
        );
        await rename(indexPath + ".lock", indexPath);
      } finally {
        await lock.close().catch(() => {});
        await rm(indexPath + ".lock", { force: true });
      }
      return {
        head: await this.head(signal),
        paths: nowStaged,
        status: "committed",
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async status(signal) {
    await this.checkRoot(signal);
    const raw = await this.command(
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
        "--ignore-submodules=all",
      ],
      { signal },
    );
    const entries = raw
      .split("\0")
      .filter(Boolean)
      .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }))
      .filter((entry) => this.visible(entry.path));
    for (const entry of entries) {
      try {
        entry.hash = this.files.read(entry.path).hash;
        entry.committable = true;
      } catch (error) {
        entry.hash = null;
        entry.committable = error.code === "ENOENT";
      }
    }
    let head = null;
    try {
      head = await this.head(signal);
    } catch {}
    const branch = (
      await this.command(["symbolic-ref", "--quiet", "--short", "HEAD"], {
        signal,
      }).catch(() => "")
    ).trim();
    return { head, branch: branch || null, entries, filtered: true };
  }
  async diff(path, staged = false, signal) {
    await this.checkRoot(signal);
    await this.fileScope(path, signal);
    const diff = await this.command(
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--ignore-submodules=all",
        ...(staged ? ["--cached"] : []),
        "--",
        path,
      ],
      { signal },
    );
    return { path, staged, diff };
  }
  async log(limit = 10, signal) {
    await this.checkRoot(signal);
    check(
      Number.isInteger(limit) && limit > 0 && limit <= 30,
      "GIT_LIMIT",
      "最多读取 30 条提交",
    );
    return {
      log: await this.command(
        ["log", `-${limit}`, "--format=%h %s", "--no-decorate"],
        { signal },
      ),
    };
  }
  async worktree(target, branch, expectedHead, signal) {
    await this.checkRoot(signal);
    check(
      typeof branch === "string" &&
        /^agent\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}$/.test(branch),
      "GIT_BRANCH",
      "分支名格式为 agent/name",
    );
    check(
      (await this.head(signal)) === expectedHead,
      "GIT_CONFLICT",
      "仓库 HEAD 已变化，请刷新",
      409,
    );
    const rel = relative(this.root, target);
    check(
      isAbsolute(target) && (rel.startsWith("..") || isAbsolute(rel)),
      "GIT_TARGET",
      "隔离工作树不能位于当前仓库内部",
    );
    const config = await this.disabledFilters(signal);
    await this.command(
      ["worktree", "add", "-b", branch, "--", target, expectedHead],
      { signal, config },
    );
    return {
      root: target,
      branch,
      head: expectedHead,
      includesUncommittedChanges: false,
    };
  }
}
