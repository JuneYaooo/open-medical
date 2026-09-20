import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ProcessRunner } from "../server/core/process-runner.mjs";
import { WorkspaceFiles } from "../server/core/workspace-files.mjs";
import { GitWorkspace } from "../server/core/git-workspace.mjs";

function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), "harness-guidance-" + label + "-"));
  return dir;
}

test("image() 把 Docker 未运行与镜像缺失区分开", (t) => {
  // Node 的安全策略(CVE-2024-27980 修复)禁止 child_process 直接执行
  // .cmd/.bat,sh 脚本 stub 在 Windows 无法运行;两种场景都会退化为
  // spawn 失败,区分断言失去意义。需 POSIX sh 或真实 docker.exe 覆盖。
  if (process.platform === "win32")
    return t.skip(
      "Windows 上 Node 禁止直接 spawn .cmd/.bat stub;daemon-down 与镜像缺失区分断言需 POSIX 或真实 docker.exe 覆盖",
    );
  const dir = tempDir("docker");
  try {
    const down = join(dir, "docker-down");
    writeFileSync(down, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.throws(
      () => new ProcessRunner({ docker: down }).image("some-image:1"),
      (e) =>
        e.code === "SANDBOX_BACKEND" && /Docker 未运行|colima/.test(e.message),
    );

    const noImage = join(dir, "docker-noimage");
    writeFileSync(
      noImage,
      '#!/bin/sh\nif [ "$1" = "info" ]; then echo linux; exit 0; fi\nexit 1\n',
      { mode: 0o755 },
    );
    assert.throws(
      () => new ProcessRunner({ docker: noImage }).image("some-image:1"),
      (e) => e.code === "SANDBOX_IMAGE" && /离线导入/.test(e.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("受保护路径错误按原因给出替代做法", () => {
  const dir = tempDir("paths");
  try {
    const files = new WorkspaceFiles(dir);
    const denied = (path) => {
      try {
        files.path(path);
        return null;
      } catch (e) {
        return e;
      }
    };
    assert.match(
      denied("node_modules/pkg/index.mjs").message,
      /src\/vendor/,
    );
    assert.match(denied(".env").message, /环境配置/);
    assert.match(denied("secrets.key").message, /密钥/);
    writeFileSync(join(dir, "regular.mjs"), "export const ok = 1;\n");
    assert.equal(denied("regular.mjs"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitWorkspace.describe() 区分仓库根、子目录与非仓库", async () => {
  const dir = tempDir("git");
  try {
    const git = (args) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git(["init", "-q"]);
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid",
      "commit", "--allow-empty", "-qm", "init"]);
    const rootFact = await new GitWorkspace(dir).describe();
    assert.equal(rootFact.scope, "root");
    assert.ok(["master", "main"].includes(rootFact.branch));
    assert.match(rootFact.head, /^[0-9a-f]{40,64}$/);

    const sub = join(dir, "sub");
    mkdirSync(sub);
    assert.deepEqual(await new GitWorkspace(sub).describe(), {
      scope: "subdir",
    });

    const plain = tempDir("plain");
    try {
      assert.deepEqual(await new GitWorkspace(plain).describe(), {
        scope: "none",
      });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
