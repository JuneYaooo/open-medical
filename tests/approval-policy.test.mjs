import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceDatabase, WorkspaceService, GenericDomain } from "../server/core/index.mjs";
import { GitWorkspace } from "../server/core/git-workspace.mjs";

function fixture(t, domain = GenericDomain) {
  const root = mkdtempSync(join(tmpdir(), "omw-policy-")), db = new WorkspaceDatabase(":memory:");
  const service = new WorkspaceService(db.db, {}, { domain });
  const w = service.create({ root, directoryConsent: true });
  t.after(async () => { await service.extensions.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, service, id: w.id,
    update: (extra = {}) => service.update(w.id, { revision: service.get(w.id).revision, profile: "standard", allowWrite: true, ...extra }),
    tool: (tool, args = {}) => service.tool(w.id, { tool, arguments: args }),
  };
}
test("default review and explicitly authorized automatic writes share version checks and audit records", async (t) => {
  const f = fixture(t); f.update();
  const pending = await f.tool("propose_file_write", { path: "note.txt", content: "pending" });
  assert.equal(existsSync(join(f.root, "note.txt")), false);
  assert.throws(() => f.service.applyAutomatic(f.id, pending.approvalId), { code: "APPROVAL_REQUIRED" });
  assert.throws(() => f.update({ approvalPolicy: "workspace-write" }), { code: "APPROVAL_CONSENT" });
  f.update({ approvalPolicy: "workspace-write", autoApplyConsent: true });
  const applied = await f.tool("propose_file_write", { path: "note.txt", content: "applied" });
  assert.equal(applied.status, "applied");
  assert.equal(readFileSync(join(f.root, "note.txt"), "utf8"), "applied");
  await assert.rejects(f.tool("propose_file_edit", { path: "note.txt", expectedHash: "0".repeat(64), edits: [{ oldText: "applied", newText: "bad" }] }), { code: "FILE_CONFLICT" });
  await assert.rejects(f.tool("propose_file_write", { path: ".env", content: "blocked" }), { code: "PATH_DENIED" });
  const deletion = await f.tool("propose_file_delete", { path: "note.txt", expectedHash: applied.hash });
  assert.equal(deletion.deleted, true);
  assert.equal(existsSync(join(f.root, "note.txt")), false);
  assert.equal(f.service.store.events(f.id).filter((e) => e.type === "approval.applied" && e.payload.automatic).length, 2);
  f.update();
  assert.equal((await f.tool("propose_file_write", { path: "review.txt", content: "review" })).status, "pending");
});
test("domains can forbid automatic writes and aliases of the same root share mutation exclusion", async (t) => {
  const restricted = fixture(t, { ...GenericDomain, id: "restricted", allowAutoFileWrites: false });
  assert.throws(() => restricted.update({ approvalPolicy: "workspace-write", autoApplyConsent: true }), { code: "DOMAIN_POLICY" });
  const f = fixture(t); f.update({ approvalPolicy: "workspace-write", autoApplyConsent: true });
  const other = f.service.create({ root: f.root, directoryConsent: true });
  f.service.mutating.add(other.id);
  await assert.rejects(f.tool("propose_file_write", { path: "locked.txt", content: "blocked" }), { code: "RUN_ACTIVE" });
  assert.equal(existsSync(join(f.root, "locked.txt")), false);
  f.service.mutating.delete(other.id);
});
test("full authorization auto-applies writes and grants git with explicit consent", async (t) => {
  const f = fixture(t);
  assert.throws(() => f.update({ approvalPolicy: "full" }), { code: "APPROVAL_CONSENT" });
  assert.throws(() => f.update({ approvalPolicy: "full", autoApplyConsent: true, allowWrite: false }), { code: "APPROVAL_POLICY" });
  f.update({ approvalPolicy: "full", autoApplyConsent: true });
  assert.equal(f.service.get(f.id).permissions.grants["git.write"], false);
  const applied = await f.tool("propose_file_write", { path: "full.txt", content: "auto" });
  assert.equal(applied.status, "applied");
  assert.equal(readFileSync(join(f.root, "full.txt"), "utf8"), "auto");
  f.update({ approvalPolicy: "full", autoApplyConsent: true, allowGit: true, gitConsent: true });
  assert.equal(f.service.get(f.id).permissions.grants["git.write"], true);
  assert.equal(f.service.get(f.id).approvalPolicy, "full");
});
test("restricted domains reject full authorization and review keeps manual approval", async (t) => {
  const restricted = fixture(t, { ...GenericDomain, id: "restricted-full", allowAutoFileWrites: false });
  assert.throws(() => restricted.update({ approvalPolicy: "full", autoApplyConsent: true }), { code: "DOMAIN_POLICY" });
  const f = fixture(t); f.update({ approvalPolicy: "full", autoApplyConsent: true });
  f.update();
  assert.equal((await f.tool("propose_file_write", { path: "back.txt", content: "x" })).status, "pending");
});

test("model-visible Git commit requires separate consent and commits only selected authorized files", async (t) => {
  const f = fixture(t), git = new GitWorkspace(f.root);
  await git.command(["init", "-q"]); await git.command(["config", "user.name", "Fixture"]);
  await git.command(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(f.root, "note.txt"), "before");
  await git.command(["add", "note.txt"]); await git.command(["commit", "-qm", "baseline"]);
  f.update();
  await assert.rejects(f.tool("git_commit", {}), { code: "PERMISSION_DENIED" });
  assert.throws(() => f.update({ allowGit: true }), { code: "GIT_CONSENT" });
  f.update({ allowGit: true, gitConsent: true, approvalPolicy: "workspace-write", autoApplyConsent: true });
  const before = await f.tool("read_file", { path: "note.txt" });
  await f.tool("propose_file_edit", { path: "note.txt", expectedHash: before.hash, edits: [{ oldText: "before", newText: "after" }] });
  const status = await f.tool("git_status");
  const result = await f.tool("git_commit", { expectedHead: status.head, message: "authorized fixture commit",
    files: status.entries.map(({ path, hash }) => ({ path, hash })) });
  assert.equal(result.status, "committed");
  assert.equal(await git.command(["show", "HEAD:note.txt"]), "after");
  assert.equal(f.service.mutating.size, 0);
});

test("authorized Agent autonomously reproduces, edits, tests and commits in the real container workflow", { skip: !process.env.TEST_DOCKER_IMAGE }, async (t) => {
  const f = fixture(t), git = new GitWorkspace(f.root);
  writeFileSync(join(f.root, "sum.mjs"), "export const sum = (a,b) => a-b;\n");
  writeFileSync(join(f.root, "test.mjs"), "import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; assert.equal(sum(2,3),5);\n");
  await git.command(["init", "-q"]); await git.command(["config", "user.name", "Fixture"]);
  await git.command(["config", "user.email", "fixture@example.invalid"]);
  await git.command(["add", "."]); await git.command(["commit", "-qm", "baseline"]);
  f.update({ approvalPolicy: "workspace-write", autoApplyConsent: true, allowGit: true, gitConsent: true });
  await f.service.extensions.operation(f.id, { action: "configure", revision: f.service.get(f.id).revision,
    consent: true, terminal: true, image: process.env.TEST_DOCKER_IMAGE, origins: [], browser: false,
    plugins: false, mcp: false, memoryRead: false, memoryWrite: false, memory: { provider: "lsa" } });
  const call = (name, args) => ({ message: { role: "assistant", content: null, tool_calls: [{
    id: "call-" + name, function: { name, arguments: JSON.stringify(args) },
  }] } });
  f.service.provider = { apiKey: "synthetic", model: "workflow-fixture", async complete(messages) {
    const outputs = messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
    if (!outputs.length) return call("terminal_run", { command: "node test.mjs", snapshot: true });
    if (outputs.length === 1) { assert.notEqual(outputs[0].exitCode, 0); return call("read_file", { path: "sum.mjs" }); }
    if (outputs.length === 2) return call("propose_file_edit", { path: "sum.mjs", expectedHash: outputs[1].hash, edits: [{ oldText: "a-b", newText: "a+b" }] });
    if (outputs.length === 3) { assert.equal(outputs[2].status, "applied"); return call("terminal_run", { command: "node test.mjs", snapshot: true }); }
    if (outputs.length === 4) { assert.equal(outputs[3].exitCode, 0); return call("git_status", {}); }
    if (outputs.length === 5) return call("git_commit", { expectedHead: outputs[4].head, message: "Fix sum",
      files: outputs[4].entries.map(({ path, hash }) => ({ path, hash })) });
    assert.equal(outputs[5].status, "committed");
    return { message: { role: "assistant", content: "Fixed, tested, committed" } };
  } };
  const result = await f.service.execute(f.service.prepare(f.id, { revision: f.service.get(f.id).revision,
    message: "Fix the failing test", externalConsent: true }));
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.match(await git.command(["show", "HEAD:sum.mjs"]), /a\+b/);
  assert.equal(f.service.get(f.id).approvals.filter((a) => a.status === "pending").length, 0);
});
