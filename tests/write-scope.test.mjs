import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkspaceDatabase,
  WorkspaceService,
  GenericDomain,
} from "../server/core/index.mjs";

function fixture(t, domain = GenericDomain) {
  const root = mkdtempSync(join(tmpdir(), "omw-scope-")),
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
        ...extra,
      }),
    tool: (tool, args = {}) =>
      service.tool(w.id, { tool, arguments: args }),
  };
}

test("write scope confines proposals to authorized subtrees in every approval mode", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "docs"), { recursive: true });
  mkdirSync(join(f.root, "src/lib"), { recursive: true });
  f.update({ approvalPolicy: "full", autoApplyConsent: true });
  // Default: no scope, whole root writable.
  assert.equal(
    (await f.tool("propose_file_write", { path: "root.md", content: "x" }))
      .status,
    "applied",
  );
  f.update({ writeScope: ["docs", "src/lib"], approvalPolicy: "full", autoApplyConsent: true });
  assert.deepEqual(f.service.get(f.id).writeScope, ["docs", "src/lib"]);
  assert.equal(
    (
      await f.tool("propose_file_write", {
        path: "docs/a.md",
        content: "in scope",
      })
    ).status,
    "applied",
  );
  assert.equal(
    (
      await f.tool("propose_file_write", {
        path: "src/lib/deep/nested.js",
        content: "in scope",
      })
    ).status,
    "applied",
  );
  // Outside the scope — even with full-auto authorization the write is denied.
  await assert.rejects(
    f.tool("propose_file_write", { path: "outside.md", content: "no" }),
    { code: "WRITE_SCOPE" },
  );
  await assert.rejects(
    f.tool("propose_file_write", { path: "src/top.js", content: "no" }),
    { code: "WRITE_SCOPE" },
  );
  await assert.rejects(
    f.tool("propose_file_delete", { path: "root.md", expectedHash: "0".repeat(64) }),
    (error) => error.code === "WRITE_SCOPE" || error.code === "FILE_CONFLICT",
  );
  assert.equal(existsSync(join(f.root, "outside.md")), false);
  // Clearing the scope (null) restores whole-root writes.
  f.update({ writeScope: null, approvalPolicy: "full", autoApplyConsent: true });
  assert.equal(f.service.get(f.id).writeScope, null);
  assert.equal(
    (
      await f.tool("propose_file_write", { path: "outside.md", content: "ok" })
    ).status,
    "applied",
  );
});

test("scope entries are validated with the same path protections as writes", async (t) => {
  const f = fixture(t);
  assert.throws(() => f.update({ writeScope: [] }), { code: "WRITE_SCOPE" });
  assert.throws(() => f.update({ writeScope: ["docs", "docs/sub"] }), {
    code: "WRITE_SCOPE",
  });
  assert.throws(() => f.update({ writeScope: ["/etc"] }), { code: "PATH_DENIED" });
  assert.throws(() => f.update({ writeScope: ["../sibling"] }), {
    code: "PATH_DENIED",
  });
  assert.throws(() => f.update({ writeScope: [".git/config"] }), {
    code: "PATH_DENIED",
  });
  assert.throws(() => f.update({ writeScope: [".env.local"] }), {
    code: "PATH_DENIED",
  });
  assert.throws(
    () =>
      f.update({
        writeScope: Array.from({ length: 11 }, (_, i) => `dir${i}`),
      }),
    { code: "WRITE_SCOPE" },
  );
  // Symlinked scope entries are rejected like symlinked writes.
  mkdirSync(join(f.root, "real"), { recursive: true });
  writeFileSync(join(f.root, "real/f.txt"), "x");
  const { symlinkSync } = await import("node:fs");
  symlinkSync(join(f.root, "real"), join(f.root, "link-dir"));
  assert.throws(() => f.update({ writeScope: ["link-dir"] }), {
    code: "PATH_DENIED",
  });
  // Case-insensitive overlap on macOS/Windows.
  assert.throws(() => f.update({ writeScope: ["Docs", "docs/x"] }), {
    code: "WRITE_SCOPE",
  });
});

test("approval decisions and reverts re-verify scope; authority change revokes pending", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "docs"), { recursive: true });
  f.update({ writeScope: ["docs"] });
  const pending = await f.tool("propose_file_write", {
    path: "docs/keep.md",
    content: "v1",
  });
  // Narrow the scope away from this path: pending approvals must be revoked.
  f.update({ writeScope: ["other"] });
  assert.equal(
    f.service.get(f.id).approvals.find((a) => a.id === pending.approvalId)
      .status,
    "revoked",
  );
  assert.throws(
    () =>
      f.service.decide(f.id, pending.approvalId, {
        revision: f.service.get(f.id).revision,
        decision: "approve",
      }),
    { code: "APPROVAL_STATE" },
  );
  // An applied edit can no longer be reverted once its path left the scope.
  writeFileSync(join(f.root, "docs/keep.md"), "v1");
  f.update({ writeScope: ["docs"] });
  const { hashText } = await import("../server/core/workspace-files.mjs");
  const applied = await f.tool("propose_file_edit", {
    path: "docs/keep.md",
    expectedHash: hashText("v1"),
    edits: [{ oldText: "v1", newText: "v2" }],
  });
  assert.equal(applied.status, "pending");
  f.service.decide(f.id, applied.approvalId, {
    revision: f.service.get(f.id).revision,
    decision: "approve",
  });
  assert.equal(
    f.service.get(f.id).approvals.find((a) => a.id === applied.approvalId)
      .status,
    "applied",
  );
  f.update({ writeScope: ["other"] });
  assert.throws(
    () =>
      f.service.revert(f.id, applied.approvalId, {
        revision: f.service.get(f.id).revision,
      }),
    { code: "WRITE_SCOPE" },
  );
  const events = f.service.store.events(f.id);
  assert.ok(events.some((e) => e.type === "write_scope.changed"));
});

test("subagent write lists must stay inside the workspace write scope", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "docs"), { recursive: true });
  f.update({ writeScope: ["docs"] });
  const { AgentTeam } = await import("../server/core/agent-team.mjs");
  const team = new AgentTeam(
    f.service,
    f.id,
    "run-test",
    new AbortController().signal,
    () => {},
    () => {},
  );
  f.service.teams.set(f.id, team);
  // AgentTeam persists children onto the parent run record.
  f.service.store.update(f.id, (w) => {
    w.runs.push({ id: "run-test", status: "running", children: [] });
  });
  t.after(() => f.service.teams.delete(f.id));
  assert.throws(
    () =>
      team.spawn({ task: "write outside", role: "writer", writePaths: ["outside/evil.md"] }),
    { code: "WRITE_SCOPE" },
  );
  const job = team.spawn({
    task: "write inside",
    role: "writer",
    writePaths: ["docs/ok.md"],
  });
  assert.ok(job.id);
  // Runtime defense: even the in-scope subagent cannot escape the workspace scope.
  assert.throws(
    () => f.service.assertWriteScope(f.id, "outside/x", job.id),
    { code: "WRITE_SCOPE" },
  );
  // In-scope path for this writer passes both the workspace and job checks.
  f.service.assertWriteScope(f.id, "docs/ok.md", job.id);
});
