import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkspaceDatabase,
  WorkspaceService,
  GenericDomain,
} from "../server/core/index.mjs";

// Cross-platform regression: write-scope comparisons must not depend on the
// platform path separator. Windows `relative()` yields `a\b.txt`; scopes and
// subagent lists are spelled with `/`. All comparisons go through one
// canonical form, while real-path/traversal/symlink checks stay in
// WorkspaceFiles.path.

function fixture(t, domain = GenericDomain) {
  const root = mkdtempSync(join(tmpdir(), "omw-scope-paths-")),
    db = new WorkspaceDatabase(":memory:");
  const service = new WorkspaceService(db.db, {}, { domain });
  const w = service.create({ root, directoryConsent: true });
  t.after(async () => {
    await service.extensions.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    service,
    id: w.id,
    update: (extra = {}) =>
      service.update(w.id, {
        revision: service.get(w.id).revision,
        profile: "code",
        allowWrite: true,
        approvalPolicy: "full",
        autoApplyConsent: true,
        ...extra,
      }),
    write: (path) =>
      service.tool(w.id, {
        tool: "propose_file_write",
        arguments: { path, content: "x" },
      }),
  };
}

test("in-scope writes with CJK names, spaces and nesting pass on every platform", async (t) => {
  const f = fixture(t);
  const scope = ["docs", "资料 备份/2026 报告"];
  f.update({ writeScope: scope });
  // Stored scope entries keep one canonical (forward-slash) form so API
  // consumers and comparisons see identical values on Windows and POSIX.
  assert.deepEqual(f.service.get(f.id).writeScope, scope);
  const inScope = [
    "docs/a.md",
    "docs/子 目录/嵌套 很深/结果 文件.md",
    "资料 备份/2026 报告/表 单.csv",
    "./docs/./plain.md",
  ];
  for (const path of inScope) {
    assert.equal((await f.write(path)).status, "applied", path);
  }
  assert.ok(existsSync(join(f.root, "docs", "子 目录", "嵌套 很深", "结果 文件.md")));
});

test("boundary writes are rejected: adjacent dirs, prefix look-alikes, escapes", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "docs"), { recursive: true });
  f.update({ writeScope: ["docs"] });
  for (const path of ["other/x.md", "docs2/x.md", "docs.txt", "do"]) {
    await assert.rejects(f.write(path), { code: "WRITE_SCOPE" }, path);
  }
  // Traversal and absolute paths are denied before scope comparison.
  await assert.rejects(f.write("../escape.md"), { code: "PATH_DENIED" });
  await assert.rejects(f.write(resolve(f.root, "..", "escape.md")), {
    code: "PATH_DENIED",
  });
  assert.equal(existsSync(resolve(f.root, "..", "escape.md")), false);
});

test("each entry of a multi-scope writeScope is honored independently", async (t) => {
  const f = fixture(t);
  f.update({ writeScope: ["docs", "src/lib", "资料 备份"] });
  assert.equal((await f.write("docs/a.md")).status, "applied");
  assert.equal((await f.write("src/lib/deep/util.js")).status, "applied");
  assert.equal((await f.write("资料 备份/档案 一.txt")).status, "applied");
  await assert.rejects(f.write("src/top.js"), { code: "WRITE_SCOPE" });
  await assert.rejects(f.write("root.md"), { code: "WRITE_SCOPE" });
});

test("case folding follows the platform volume, matching overlap semantics", async (t) => {
  const f = fixture(t);
  f.update({ writeScope: ["docs"] });
  if (["darwin", "win32"].includes(process.platform)) {
    // NTFS/APFS volumes treat Docs/a.md as docs/a.md — allowing it does not
    // widen the scope; refusing it would block legal in-scope writes.
    assert.equal((await f.write("Docs/Case.md")).status, "applied");
  } else {
    await assert.rejects(f.write("Docs/Case.md"), { code: "WRITE_SCOPE" });
  }
});

test("subagent writePaths compare across separator spellings and stay confined", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "docs"), { recursive: true });
  f.update({ writeScope: ["docs"] });
  const { AgentTeam } = await import("../server/core/agent-team.mjs");
  const team = new AgentTeam(
    f.service,
    f.id,
    "run-paths",
    new AbortController().signal,
    () => {},
    () => {},
  );
  f.service.teams.set(f.id, team);
  f.service.store.update(f.id, (w) => {
    w.runs.push({ id: "run-paths", status: "running", children: [] });
  });
  t.after(() => f.service.teams.delete(f.id));
  // The list is stored in canonical form whatever spelling the model used.
  const input = process.platform === "win32" ? "docs\\子 目录\\文件 一.md" : "docs/子 目录/文件 一.md";
  const job = team.spawn({ task: "write inside", role: "writer", writePaths: [input] });
  assert.deepEqual(team.describe(job).writePaths, ["docs/子 目录/文件 一.md"]);
  // Exact in-list path passes both workspace and job checks.
  f.service.assertWriteScope(f.id, "docs/子 目录/文件 一.md", job.id);
  // A different file under the same workspace scope is still not in the list.
  assert.throws(() => f.service.assertWriteScope(f.id, "docs/other.md", job.id), {
    code: "AGENT_SCOPE",
  });
  // Workspace scope bounds the runtime check even for listed writers.
  assert.throws(() => f.service.assertWriteScope(f.id, "outside/x.md", job.id), {
    code: "WRITE_SCOPE",
  });
  // Spawn-time defenses: outside workspace scope; overlapping writer.
  assert.throws(
    () => team.spawn({ task: "evil", role: "writer", writePaths: ["outside/e.md"] }),
    { code: "WRITE_SCOPE" },
  );
  assert.throws(
    () =>
      team.spawn({ task: "clash", role: "writer", writePaths: ["docs/子 目录/文件 一.md"] }),
    { code: "AGENT_CONFLICT" },
  );
});
