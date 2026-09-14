import { GitWorkspace } from "./git-workspace.mjs";
import { check } from "../errors.mjs";
export class GitConflicts extends GitWorkspace {
  async conflicts() {
    await this.checkRoot();
    const rows = (await this.command(["ls-files", "--unmerged", "-z"]))
      .split("\0")
      .filter(Boolean);
    const paths = [...new Set(rows.map((r) => r.slice(r.indexOf("\t") + 1)))];
    return Promise.all(
      paths.map(async (path) => {
        check(
          this.visible(path),
          "GIT_SCOPE",
          "冲突涉及授权范围外文件，请在本机 Git 中处理",
          403,
        );
        const versions = {};
        for (const stage of [1, 2, 3]) {
          try {
            versions[stage] = await this.command([
              "show",
              "--no-ext-diff",
              "--no-textconv",
              `:${stage}:${path}`,
            ]);
          } catch {
            versions[stage] = null;
          }
        }
        return {
          path,
          base: versions[1],
          ours: versions[2],
          theirs: versions[3],
        };
      }),
    );
  }
  async merge({ ref, expectedHead }) {
    check(
      typeof ref === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,150}$/.test(ref) &&
        !ref.includes(".."),
      "GIT_REF",
      "请输入本地或远端跟踪分支名",
    );
    const state = await this.status();
    check(
      state.head === expectedHead && !state.entries.length,
      "GIT_CONFLICT",
      "请先提交本地变更并刷新 HEAD",
      409,
    );
    const paths = (
      await this.command(["diff", "--name-only", "-z", "HEAD", ref, "--"])
    )
      .split("\0")
      .filter(Boolean);
    check(
      paths.every((p) => this.visible(p)),
      "GIT_SCOPE",
      "合并包含受保护路径，请使用系统 Git 处理",
      403,
    );
    const keys = (
      await this.command([
        "config",
        "--name-only",
        "--get-regexp",
        "^merge\\..*\\.driver$",
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    try {
      await this.command(
        ["merge", "--no-ff", "--no-commit", "--no-verify", ref],
        { config: ["merge.autoStash=false", ...keys.map((k) => k + "=false")] },
      );
    } catch (error) {
      const conflicts = await this.conflicts();
      if (!conflicts.length) throw error;
      return { status: "conflicts", conflicts };
    }
    return { status: "merged-pending-commit", conflicts: [] };
  }
  async resolve({ path, expectedHash }) {
    check(
      (await this.conflicts()).some((c) => c.path === path),
      "GIT_CONFLICT",
      "该文件没有待解决的冲突",
    );
    const file = this.files.read(path);
    check(
      file.hash === expectedHash,
      "GIT_CONFLICT",
      "文件已变化，请重新读取",
      409,
    );
    check(
      !/^(<<<<<<< |=======\s*$|>>>>>>> )/m.test(file.text),
      "GIT_CONFLICT",
      "文件仍包含冲突标记",
    );
    const blob = (
      await this.command(["hash-object", "-w", "--no-filters", "--", path])
    ).trim();
    const entries = (
      await this.command(["ls-files", "--stage", "-z", "--", path])
    )
      .split("\0")
      .filter(Boolean);
    const mode = entries.some((r) => r.startsWith("100755 "))
      ? "100755"
      : "100644";
    await this.command([
      "update-index",
      "--add",
      "--cacheinfo",
      `${mode},${blob},${path}`,
    ]);
    return { resolved: path };
  }
  async finish({ expectedHead, message }) {
    check(
      (await this.head()) === expectedHead,
      "GIT_CONFLICT",
      "HEAD 已变化",
      409,
    );
    check(
      typeof message === "string" && message.trim() && message.length <= 2000,
      "GIT_MESSAGE",
      "请填写合并提交说明",
    );
    await this.command(["rev-parse", "--verify", "MERGE_HEAD"]);
    check(!(await this.conflicts()).length, "GIT_CONFLICT", "仍有未解决的冲突");
    const paths = (
      await this.command(["diff", "--cached", "--name-only", "-z"])
    )
      .split("\0")
      .filter(Boolean);
    check(
      paths.every((p) => this.visible(p)),
      "GIT_SCOPE",
      "暂存区包含受保护文件",
      403,
    );
    await this.command(["commit", "--no-verify", "-m", message]);
    return { status: "committed", head: await this.head() };
  }
}
