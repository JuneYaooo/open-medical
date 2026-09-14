import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitWorkspace } from "./git-workspace.mjs";
import { check, AppError } from "../errors.mjs";
const exec = promisify(execFile);
export function githubRepository(value) {
  const m =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(
      value.trim(),
    );
  check(
    m && ![".", ".."].includes(m[2]),
    "GIT_REMOTE",
    "当前支持 github.com 的 HTTPS 或 SSH 仓库地址",
  );
  return `${m[1]}/${m[2]}`;
}
export class GitRemote {
  constructor(root, { run = exec } = {}) {
    this.git = new GitWorkspace(root);
    this.run = run;
  }
  async gh(args) {
    try {
      return (
        await this.run("gh", args, {
          cwd: this.git.root,
          timeout: 60000,
          maxBuffer: 2_000_000,
          env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
        })
      ).stdout;
    } catch (e) {
      throw new AppError(
        "GITHUB_ERROR",
        e.code === "ENOENT"
          ? "请先安装 GitHub CLI，并执行 gh auth login"
          : "GitHub 操作失败，请检查登录、权限与网络；操作可能已执行，请刷新远端状态再重试",
        409,
      );
    }
  }
  async repository() {
    await this.git.checkRoot();
    return githubRepository(
      await this.git.command(["config", "--get", "remote.origin.url"]),
    );
  }
  async api(path, method = "GET", body) {
    // gh api accepts structured fields directly without shell interpolation.
    const args = ["api", "--hostname", "github.com", "--method", method, path];
    if (body)
      for (const [k, v] of Object.entries(body))
        args.push(typeof v === "boolean" ? "-F" : "-f", `${k}=${v}`);
    return JSON.parse(await this.gh(args));
  }
  async status() {
    const repository = await this.repository();
    const [account, pulls, local] = await Promise.all([
      this.api("user"),
      this.api(`repos/${repository}/pulls?state=open&per_page=30`),
      this.git.status(),
    ]);
    return {
      repository,
      account: account.login,
      local,
      pulls: pulls.map((p) => ({
        number: p.number,
        title: p.title,
        url: p.html_url,
        head: p.head.sha,
        branch: p.head.ref,
        base: p.base.ref,
        draft: p.draft,
      })),
    };
  }
  async push(expectedHead) {
    const repository = await this.repository(),
      state = await this.git.status();
    check(
      state.head === expectedHead && state.branch,
      "GIT_CONFLICT",
      "分支或 HEAD 已变化，请刷新",
      409,
    );
    check(
      !["main", "master"].includes(state.branch),
      "GIT_BRANCH",
      "请从独立任务分支推送",
    );
    check(!state.entries.length, "GIT_DIRTY", "请先提交工作区修改");
    // Reject rewrite rules: an explicit URL must not silently send credentials elsewhere.
    const rewrites = await this.git.command([
      "config",
      "--get-regexp",
      "^url\\..*\\.(insteadof|pushinsteadof)$",
    ]);
    check(
      !rewrites.trim(),
      "GIT_REMOTE",
      "仓库包含 URL 重写规则，请先移除后再推送",
    );
    const token = (
      await this.gh(["auth", "token", "--hostname", "github.com"])
    ).trim();
    check(
      token && !/[\r\n]/.test(token),
      "GITHUB_AUTH",
      "无法读取 GitHub 凭据",
    );
    await this.git.command(
      [
        "push",
        "--",
        `https://github.com/${repository}.git`,
        `${expectedHead}:refs/heads/${state.branch}`,
      ],
      {
        config: [
          "credential.helper=",
          "http.proxy=",
          "http.followRedirects=false",
          "push.recurseSubmodules=no",
        ],
        inputEnv: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from("x-access-token:" + token).toString("base64")}`,
        },
      },
    );
    return {
      repository,
      branch: state.branch,
      head: expectedHead,
      pushed: true,
    };
  }
  async fetchBranches() {
    const repository = await this.repository();
    const rewrites = await this.git.command([
      "config",
      "--get-regexp",
      "^url\\..*\\.(insteadof|pushinsteadof)$",
    ]);
    check(!rewrites.trim(), "GIT_REMOTE", "仓库包含 URL 重写规则，请先移除");
    const token = (
      await this.gh(["auth", "token", "--hostname", "github.com"])
    ).trim();
    check(
      token && !/[\r\n]/.test(token),
      "GITHUB_AUTH",
      "无法读取 GitHub 凭据",
    );
    await this.git.command(
      [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--",
        `https://github.com/${repository}.git`,
        "+refs/heads/*:refs/remotes/origin/*",
      ],
      {
        config: [
          "credential.helper=",
          "http.proxy=",
          "http.followRedirects=false",
        ],
        inputEnv: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from("x-access-token:" + token).toString("base64")}`,
        },
      },
    );
    return { fetched: true, repository };
  }
  async create(body) {
    const repository = await this.repository(),
      state = await this.git.status();
    check(
      state.head === body.expectedHead && state.branch,
      "GIT_CONFLICT",
      "HEAD 已变化",
      409,
    );
    check(
      typeof body.title === "string" &&
        body.title.trim() &&
        body.title.length <= 250 &&
        typeof body.body === "string" &&
        body.body.length <= 50000,
      "GITHUB_PR",
      "请填写 PR 标题和说明",
    );
    check(
      typeof body.base === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,150}$/.test(body.base),
      "GITHUB_PR",
      "目标分支无效",
    );
    const existing = await this.api(
      `repos/${repository}/pulls?head=${encodeURIComponent(repository.split("/")[0] + ":" + state.branch)}&state=open`,
    );
    if (existing.length)
      return {
        url: existing[0].html_url,
        number: existing[0].number,
        existing: true,
      };
    const remote = await this.api(
      `repos/${repository}/git/ref/heads/${encodeURIComponent(state.branch)}`,
    );
    check(
      remote.object.sha === body.expectedHead,
      "GIT_CONFLICT",
      "请先推送当前 HEAD，再创建 PR",
      409,
    );
    const p = await this.api(`repos/${repository}/pulls`, "POST", {
      head: state.branch,
      base: body.base,
      title: body.title,
      body: body.body,
      draft: true,
    });
    return { number: p.number, url: p.html_url, draft: p.draft };
  }
  async review(number) {
    check(
      Number.isSafeInteger(number) && number > 0,
      "GITHUB_PR",
      "PR 编号无效",
    );
    const repository = await this.repository();
    const p = await this.api(`repos/${repository}/pulls/${number}`);
    let files = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.api(
        `repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
      );
      files.push(
        ...batch.map((f) => ({
          path: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch || null,
        })),
      );
      if (batch.length < 100) break;
    }
    return {
      number,
      title: p.title,
      url: p.html_url,
      head: p.head.sha,
      base: p.base.ref,
      mergeable: p.mergeable,
      files,
      truncated: files.length < p.changed_files,
    };
  }
}
