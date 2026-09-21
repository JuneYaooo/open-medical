import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  WorkspaceDatabase,
  WorkspaceService,
  WorkspaceFiles,
  ProjectInstructions,
  GitWorkspace,
  defineDomain,
} from "../server/core/index.mjs";
import { createWorkspaceServer } from "../server/platform.mjs";
import { AppError } from "../server/errors.mjs";

function setup(t, provider = {}, options = {}) {
  const base = mkdtempSync(resolve("output/platform-test-")),
    root = join(base, "project");
  mkdirSync(root);
  const db = new WorkspaceDatabase(join(base, "state", "agent.sqlite"));
  const service = new WorkspaceService(db.db, provider, options);
  const w = service.create({ root, directoryConsent: true });
  t.after(async () => {
    await service.extensions.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });
  const tool = (tool, args = {}) =>
    service.tool(w.id, { tool, arguments: args });
  const writable = () =>
    service.update(w.id, {
      revision: service.get(w.id).revision,
      profile: "standard",
      allowWrite: true,
    });
  const run = (message, extras = {}) =>
    service.execute(
      service.prepare(w.id, {
        revision: service.get(w.id).revision,
        message,
        externalConsent: true,
        ...extras,
      }),
    );
  return { base, root, db, service, id: w.id, tool, writable, run };
}
const call = (id, name, args) => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
  },
});
const final = (content) => ({ message: { role: "assistant", content } });

test("precise edits, nested creation, deletion and restoration bind approvals to actual versions", async (t) => {
  const f = setup(t);
  f.writable();
  writeFileSync(join(f.root, "a.txt"), "same same\nline2\nline3");
  const file = await f.tool("read_file", {
    path: "a.txt",
    startLine: 2,
    endLine: 2,
  });
  assert.equal(file.text, "line2");
  assert.equal(file.totalLines, 3);
  await assert.rejects(
    f.tool("propose_file_edit", {
      path: "a.txt",
      expectedHash: file.hash,
      edits: [{ oldText: "same", newText: "one" }],
    }),
    (e) => e.code === "EDIT_AMBIGUOUS",
  );
  const p = await f.tool("propose_file_edit", {
    path: "a.txt",
    expectedHash: file.hash,
    edits: [{ oldText: "line2", newText: "changed" }],
  });
  assert.match(readFileSync(join(f.root, "a.txt"), "utf8"), /line2/);
  const p2 = await f.tool("revise_file_proposal", {
    approvalId: p.approvalId,
    content: "final",
  });
  assert.throws(
    () =>
      f.service.decide(f.id, p.approvalId, {
        revision: f.service.get(f.id).revision,
        decision: "approve",
      }),
    (e) => e.code === "APPROVAL_STATE",
  );
  f.service.decide(f.id, p2.approvalId, {
    revision: f.service.get(f.id).revision,
    decision: "approve",
  });
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "final");
  const nested = await f.tool("propose_file_write", {
    path: "src/new/deep.txt",
    content: "nested",
  });
  assert.equal(existsSync(join(f.root, "src")), false);
  f.service.decide(f.id, nested.approvalId, {
    revision: f.service.get(f.id).revision,
    decision: "approve",
  });
  assert.equal(
    readFileSync(join(f.root, "src/new/deep.txt"), "utf8"),
    "nested",
  );
  const deletion = await f.tool("propose_file_delete", {
    path: "a.txt",
    expectedHash: (await f.tool("read_file", { path: "a.txt" })).hash,
  });
  f.service.decide(f.id, deletion.approvalId, {
    revision: f.service.get(f.id).revision,
    decision: "approve",
  });
  assert.equal(existsSync(join(f.root, "a.txt")), false);
  const restored = f.service.revert(f.id, deletion.approvalId, {
    revision: f.service.get(f.id).revision,
  });
  f.service.decide(f.id, restored.approvals.at(-1).id, {
    revision: restored.revision,
    decision: "approve",
  });
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "final");
});

test("instructions are scoped, ordered and cannot cross symlinks; minimal runs never read project instructions", async (t) => {
  const f = setup(t, {
    apiKey: "synthetic",
    model: "test",
    async complete(messages) {
      assert.ok(!JSON.stringify(messages).includes("ROOT SECRET"));
      return final("ok");
    },
  });
  writeFileSync(join(f.root, "AGENTS.md"), "ROOT SECRET");
  mkdirSync(join(f.root, "src"));
  writeFileSync(join(f.root, "src/AGENTS.md"), "nested");
  const instructions = new ProjectInstructions(new WorkspaceFiles(f.root));
  assert.deepEqual(
    instructions.read("src/new/file.txt").map((f) => f.path),
    ["AGENTS.md", "src/AGENTS.md"],
  );
  assert.throws(
    () => instructions.read("../outside.txt"),
    (e) => e.code === "PATH_DENIED",
  );
  // Windows needs Developer Mode/admin to create symlinks; skip only the
  // link-escape assertion when the platform itself denies creation.
  let links = true;
  try {
    symlinkSync(f.base, join(f.root, "escape"));
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    links = false;
    t.skip(`symlink creation denied by this platform/account (${error.code}); escape-rejection cannot be exercised`);
  }
  if (links)
    assert.throws(
      () => instructions.read("escape/test.txt"),
      (e) => e.code === "PATH_DENIED",
    );
  f.service.update(f.id, {
    revision: f.service.get(f.id).revision,
    profile: "minimal",
    allowWrite: false,
  });
  assert.equal((await f.run("hello")).status, "completed");
});

test("trusted domain policy restricts both manual and model tools without granting capabilities", async (t) => {
  let requests = 0;
  const domain = defineDomain({
    id: "research",
    system: "Research",
    limits: { maxRounds: 2 },
    beforeTool({ name }) {
      if (name === "read_file")
        throw new AppError("DOMAIN_DENIED", "restricted", 403);
    },
  });
  const f = setup(
    t,
    {
      apiKey: "synthetic",
      model: "test",
      async complete(messages) {
        if (++requests === 1)
          return call("a", "read_file", { path: "note.txt" });
        assert.equal(JSON.parse(messages.at(-1).content).code, "DOMAIN_DENIED");
        return final("restricted");
      },
    },
    { domain },
  );
  writeFileSync(join(f.root, "note.txt"), "not sent");
  await assert.rejects(
    f.tool("read_file", { path: "note.txt" }),
    (e) => e.code === "DOMAIN_DENIED",
  );
  assert.equal((await f.run("read")).status, "completed");
  assert.throws(
    () =>
      f.service.prepare(f.id, {
        revision: f.service.get(f.id).revision,
        message: "too many",
        externalConsent: true,
        limits: { maxRounds: 3 },
      }),
    (e) => e.code === "RUN_LIMITS",
  );
});

test("failed execution resumes a complete checkpoint without replaying its tools and keeps recovered history", async (t) => {
  let step = 0;
  const f = setup(t, {
    apiKey: "synthetic",
    model: "test",
    async complete(messages) {
      step++;
      if (step === 1) return call("read", "read_file", { path: "note.txt" });
      if (step === 2) throw new Error("synthetic disconnect");
      assert.ok(
        messages.some(
          (m) => m.role === "tool" && m.content.includes("checkpoint evidence"),
        ),
      );
      return final("continued");
    },
  });
  writeFileSync(join(f.root, "note.txt"), "checkpoint evidence");
  assert.equal((await f.run("start")).status, "failed");
  const previous = f.service.get(f.id).runs.at(-1);
  assert.equal(previous.canResume, true);
  assert.equal(
    (await f.run("continue", { resumeRunId: previous.id })).status,
    "completed",
  );
  assert.equal((await f.run("continue again")).status, "completed");
  assert.equal(
    f.service.store.events(f.id).filter((e) => e.type === "tool.start").length,
    1,
  );
  assert.equal(
    f.service.get(f.id).runs.some((r) => r.providerMessages),
    false,
  );
});

test("git_log returns per-commit file entries and git_diff accepts a rev", async (t) => {
  const f = setup(t);
  const git = (...args) =>
    execFileSync("git", args, { cwd: f.root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  writeFileSync(join(f.root, "a.txt"), "one");
  writeFileSync(join(f.root, "b.txt"), "one");
  git("add", "a.txt", "b.txt");
  git("commit", "-qm", "feat: baseline");
  writeFileSync(join(f.root, "a.txt"), "two");
  git("add", "a.txt");
  git("commit", "-qm", "fix: update a");
  const log = await f.tool("git_log", { limit: 5 });
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0].subject, "fix: update a");
  assert.deepEqual(log.entries[0].files, ["a.txt"]);
  assert.deepEqual(
    [...log.entries[1].files].sort(),
    ["a.txt", "b.txt"],
  );
  assert.match(log.log, /fix: update a/);
  const diff = await f.tool("git_diff", { path: "a.txt", rev: "HEAD~1" });
  assert.equal(diff.rev, "HEAD~1");
  assert.match(diff.diff, /-one/);
  assert.match(diff.diff, /\+two/);
  await assert.rejects(
    f.tool("git_diff", { path: "a.txt", staged: true, rev: "HEAD" }),
    (e) => e.code === "GIT_REV",
  );
  await assert.rejects(
    f.tool("git_diff", { path: "a.txt", rev: "--output=/tmp/evil" }),
    (e) => e.code === "GIT_REV",
  );
});

function repository(root) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  writeFileSync(join(root, "note.txt"), "base");
  writeFileSync(join(root, ".env"), "synthetic secret");
  git("add", "note.txt", ".env");
  git("commit", "-qm", "synthetic baseline");
  return git;
}

test("Git scopes reads, disables hooks/filters and creates independent clean worktrees", async (t) => {
  const f = setup(t),
    git = repository(f.root);
  f.writable();
  const marker = join(f.base, "HOOK_RAN");
  const hook = join(f.root, ".git/hooks/post-checkout");
  writeFileSync(hook, `#!/bin/sh\necho hook >> '${marker}'\n`, { mode: 0o755 });
  git("config", "filter.unsafe.clean", `echo filter >> '${marker}'; cat`);
  git("config", "filter.unsafe.smudge", `echo filter >> '${marker}'; cat`);
  writeFileSync(join(f.root, ".gitattributes"), "*.txt filter=unsafe\n");
  writeFileSync(join(f.root, ".env"), "changed protected secret");
  writeFileSync(join(f.root, "note.txt"), "changed");
  const status = await f.tool("git_status");
  assert.ok(status.entries.every((e) => e.path !== ".env"));
  assert.match(
    (await f.tool("git_diff", { path: "note.txt" })).diff,
    /changed/,
  );
  // Diff can invoke a clean filter in Git; the harness must disable it too.
  assert.equal(
    existsSync(marker),
    false,
    existsSync(marker) ? readFileSync(marker, "utf8") : "",
  );
  await assert.rejects(
    f.tool("git_diff", { path: ".env" }),
    (e) => e.code === "PATH_DENIED",
  );
  await assert.rejects(
    f.tool("git_diff", { path: "." }),
    (e) => e.code === "GIT_SCOPE",
  );
  const child = await f.service.createWorktree(f.id, {
    revision: f.service.get(f.id).revision,
    expectedHead: status.head,
    branch: "agent/test",
    consent: true,
  });
  assert.notEqual(child.root, f.root);
  assert.equal(readFileSync(join(child.root, "note.txt"), "utf8"), "base");
  assert.equal(child.permissions.grants["filesystem.write"], false);
  assert.equal(
    existsSync(marker),
    false,
    existsSync(marker) ? readFileSync(marker, "utf8") : "",
  );
  const selected = status.entries
    .filter((e) => e.path === "note.txt")
    .map(({ path, hash }) => ({ path, hash }));
  const committed = await f.service.commit(f.id, {
    revision: f.service.get(f.id).revision,
    consent: true,
    expectedHead: status.head,
    message: "controlled commit",
    files: selected,
  });
  assert.equal(committed.status, "committed");
  assert.equal(
    existsSync(marker),
    false,
    existsSync(marker) ? readFileSync(marker, "utf8") : "",
  );
  assert.equal(git("show", "HEAD:note.txt"), "changed");
  assert.equal(git("show", "HEAD:.env"), "synthetic secret");
  mkdirSync(join(f.root, "nested"));
  await assert.rejects(
    new GitWorkspace(join(f.root, "nested")).status(),
    (e) => e.code === "GIT_SCOPE",
  );
});

test("standalone platform exposes only generic tables and authenticated APIs; background tasks outlive requests", async (t) => {
  let release;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  const base = mkdtempSync(resolve("output/platform-http-"));
  const server = createWorkspaceServer({
    database: ":memory:",
    provider: {
      apiKey: "synthetic",
      model: "test",
      async complete() {
        await paused;
        return final("background done");
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    release();
    await server.shutdown();
    rmSync(base, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, data) =>
    fetch(origin + path, {
      method: data ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        "x-agent-token": server.token,
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  assert.equal((await fetch(origin + "/api/workspaces")).status, 401);
  assert.equal(
    (
      await fetch(origin + "/api/bootstrap", {
        headers: { origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  const tables = server.database.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(!tables.includes("patients") && !tables.includes("sessions"));
  const w = await (
    await request("/api/workspaces", { root: base, directoryConsent: true })
  ).json();
  assert.equal((await request("/api/patients")).status, 404);
  const started = await request(`/api/workspaces/${w.id}/runs`, {
    message: "run in background",
    revision: w.revision,
    externalConsent: true,
  });
  assert.equal(started.status, 202);
  assert.equal(server.service.get(w.id).runs.at(-1).status, "running");
  release();
  for (
    let i = 0;
    i < 100 && server.service.get(w.id).runs.at(-1).status === "running";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    server.service.get(w.id).messages.at(-1).content,
    "background done",
  );
});

test(
  "real Docker agent fixes code, tests pending changes and leaves host files untouched until approval",
  { skip: !process.env.TEST_DOCKER_IMAGE },
  async (t) => {
    let step = 0,
      hash,
      approvalId;
    const f = setup(t, {
      apiKey: "synthetic",
      model: "test",
      async complete(messages) {
        step++;
        const result =
          messages.at(-1).role === "tool"
            ? JSON.parse(messages.at(-1).content)
            : null;
        if (step === 1)
          return call("baseline", "terminal_run", {
            command: "node --test",
            snapshot: true,
          });
        if (step === 2) {
          assert.notEqual(result.exitCode, 0);
          return call("read", "read_file", { path: "add.cjs" });
        }
        if (step === 3) {
          hash = result.hash;
          return call("fix", "propose_file_edit", {
            path: "add.cjs",
            expectedHash: hash,
            edits: [{ oldText: "a-b", newText: "a+b" }],
          });
        }
        if (step === 4) {
          approvalId = result.approvalId;
          return call("verify", "terminal_run", {
            command: "node --test",
            snapshot: true,
            approvalIds: [approvalId],
          });
        }
        assert.equal(result.exitCode, 0, JSON.stringify(result));
        assert.deepEqual(
          result.testedApprovals || result.result?.testedApprovals,
          [approvalId],
        );
        return final("隔离快照测试通过，等待审批写入");
      },
    });
    f.writable();
    await f.service.extensions.configure(f.id, {
      revision: f.service.get(f.id).revision,
      consent: true,
      terminal: true,
      image: process.env.TEST_DOCKER_IMAGE,
      browser: false,
      plugins: false,
      mcp: false,
      memoryRead: false,
      memoryWrite: false,
    });
    writeFileSync(join(f.root, "add.cjs"), "module.exports=(a,b)=>a-b;\n");
    writeFileSync(
      join(f.root, "add.test.cjs"),
      "const test=require('node:test');const assert=require('node:assert/strict');test('add',()=>assert.equal(require('./add.cjs')(3,2),5));\n",
    );
    assert.equal((await f.run("fix addition and verify")).status, "waiting_approval");
    const waiting = f.service.get(f.id).runs.at(-1);
    assert.equal(waiting.outcome, "awaiting_approval");
    assert.equal(waiting.delivery, null);
    assert.match(readFileSync(join(f.root, "add.cjs"), "utf8"), /a-b/);
    const w = f.service.get(f.id);
    assert.equal(w.verifications.length, 2);
    assert.notEqual(w.verifications[0].exitCode, 0);
    assert.equal(w.verifications[1].exitCode, 0);
    f.service.decide(f.id, approvalId, {
      revision: w.revision,
      decision: "approve",
    });
    assert.match(readFileSync(join(f.root, "add.cjs"), "utf8"), /a\+b/);
  },
);

test("parallel delegation overlaps independent readers and never gives children write or recursive tools", async (t) => {
  let started = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = setup(t, {
    apiKey: "synthetic",
    model: "test",
    async complete(messages, tools) {
      if (messages[0].content.includes("独立子任务")) {
        assert.ok(
          !tools.some((t) =>
            [
              "propose_file_edit",
              "update_plan",
              "delegate_tasks",
              "delegate_task",
            ].includes(t.function.name),
          ),
        );
        if (++started === 2) release();
        await gate;
        return final("read-only child finished");
      }
      if (messages.at(-1).role === "user")
        return call("parallel", "delegate_tasks", {
          tasks: ["inspect code", "inspect tests"],
        });
      assert.equal(JSON.parse(messages.at(-1).content).children.length, 2);
      return final("both completed");
    },
  });
  assert.equal((await f.run("parallel analysis")).status, "completed");
  assert.equal(started, 2);
  assert.equal(
    f.service
      .get(f.id)
      .runs.at(-1)
      .children.every((c) => c.status === "completed"),
    true,
  );
});

test("Git rejects existing staging, stale file hashes and missing consent before mutation", async (t) => {
  const f = setup(t),
    git = repository(f.root);
  f.writable();
  writeFileSync(join(f.root, "note.txt"), "v2");
  const status = await f.tool("git_status");
  const payload = {
    revision: f.service.get(f.id).revision,
    expectedHead: status.head,
    message: "test",
    files: status.entries.map(({ path, hash }) => ({ path, hash })),
  };
  await assert.rejects(
    f.service.commit(f.id, payload),
    (e) => e.code === "GIT_CONSENT",
  );
  writeFileSync(join(f.root, "note.txt"), "v3");
  await assert.rejects(
    f.service.commit(f.id, { ...payload, consent: true }),
    (e) => e.code === "GIT_CONFLICT",
  );
  git("add", "note.txt");
  await assert.rejects(
    f.service.commit(f.id, { ...payload, consent: true }),
    (e) => e.code === "GIT_INDEX_BUSY",
  );
  assert.equal(git("rev-parse", "HEAD").trim(), status.head);
});

test("domain tools register through the generic SDK without medical dependencies", async (t) => {
  const domain = defineDomain({
    id: "custom",
    system: "Custom",
    registerTools({ registry }) {
      registry.register({
        permission: "tools.execute",
        definition: {
          type: "function",
          function: {
            name: "custom_value",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        },
        execute: () => ({ value: 42 }),
      });
    },
  });
  const f = setup(t, {}, { domain });
  assert.deepEqual(await f.tool("custom_value"), { value: 42 });
  assert.equal(f.service.capabilities(f.id).domain, "custom");
});

test("changing model or domain excludes old private context and revokes checkpoint continuation", async (t) => {
  let requests = 0;
  const provider = {
    apiKey: "synthetic",
    provider: "synthetic",
    model: "first",
    async complete(messages) {
      if (++requests === 1) return final("OLD CONTEXT MARKER");
      assert.ok(!JSON.stringify(messages).includes("OLD CONTEXT MARKER"));
      return final("new model");
    },
  };
  const f = setup(t, provider);
  assert.equal((await f.run("hello")).status, "completed");
  provider.model = "second";
  assert.equal((await f.run("new task")).status, "completed");
  f.service.domain = defineDomain({ id: "other", system: "Other domain" });
  assert.equal((await f.run("different domain")).status, "completed");
});

test("deleted directories cannot expand a Git diff to protected child paths", async (t) => {
  const f = setup(t),
    git = repository(f.root);
  mkdirSync(join(f.root, "removed"));
  writeFileSync(join(f.root, "removed/.env"), "protected secret");
  git("add", "removed/.env");
  git("commit", "-qm", "protected fixture");
  rmSync(join(f.root, "removed"), { recursive: true });
  await assert.rejects(
    f.tool("git_diff", { path: "removed" }),
    (e) => e.code === "GIT_SCOPE",
  );
});

test(
  "real Docker reads binary input and persists downloadable output without putting base64 into model context",
  { skip: !process.env.TEST_DOCKER_IMAGE },
  async (t) => {
    const f = setup(t);
    f.writable();
    await f.service.extensions.configure(f.id, {
      revision: f.service.get(f.id).revision,
      consent: true,
      terminal: true,
      image: process.env.TEST_DOCKER_IMAGE,
      browser: false,
      plugins: false,
      mcp: false,
      memoryRead: false,
      memoryWrite: false,
    });
    const original = Buffer.from([0, 1, 2, 3, 255]);
    writeFileSync(join(f.root, "input.bin"), original);
    const metadata = await f.tool("inspect_file", { path: "input.bin" });
    assert.equal(metadata.size, 5);
    assert.equal(metadata.data, undefined);
    const result = await f.tool("terminal_run", {
      command: `node -e 'const fs=require("fs");const b=fs.readFileSync("input.bin");b[1]=42;fs.writeFileSync("result.bin",b)'`,
      paths: ["input.bin"],
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const artifact = result.result.artifacts[0];
    assert.equal(artifact.name, "result.bin");
    assert.equal(artifact.size, 5);
    assert.equal(artifact.data, undefined);
    assert.deepEqual(
      f.service.artifacts.read(f.id, artifact.id).data,
      Buffer.from([0, 42, 2, 3, 255]),
    );
    assert.equal(existsSync(join(f.root, "result.bin")), false);
    assert.deepEqual(readFileSync(join(f.root, "input.bin")), original);
    const other = f.service.create({ root: f.root, directoryConsent: true });
    assert.throws(
      () => f.service.artifacts.read(other.id, artifact.id),
      (e) => e.code === "NOT_FOUND",
    );
  },
);

test("next model turn receives current approval facts after a user applies a file", async (t) => {
  const f = setup(t, {
    apiKey: "synthetic",
    model: "test",
    async complete(messages) {
      assert.match(messages[0].content, /"status":"applied"/);
      return final("already applied");
    },
  });
  f.writable();
  const proposal = await f.tool("propose_file_write", {
    path: "new.txt",
    content: "verified",
  });
  f.service.decide(f.id, proposal.approvalId, {
    revision: f.service.get(f.id).revision,
    decision: "approve",
  });
  assert.equal((await f.run("continue after approval")).status, "completed");
});
