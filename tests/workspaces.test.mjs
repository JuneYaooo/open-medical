import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture } from "./helpers.mjs";
import { WorkspaceFiles } from "../server/core/workspace-files.mjs";
import { WorkspaceStore } from "../server/core/workspace-store.mjs";
import { Store } from "../server/store.mjs";

async function setup(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "generic-workspace-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "note.txt"), "SYNTHETIC original");
  const f = await fixture(t, options);
  const created = await f.json("/api/workspaces", "POST", {
    root,
    title: "Generic test",
    directoryConsent: true,
  });
  assert.equal(created.status, 201);
  const id = created.data.id,
    base = "/api/workspaces/" + id;
  const latest = async () => (await f.json(base)).data;
  const writable = async () =>
    f.json(base, "PATCH", {
      revision: (await latest()).revision,
      profile: "standard",
      allowWrite: true,
    });
  return { ...f, root, base, id, latest, writable };
}

test("generic workspaces require directory consent and do not become patients or medical sessions", async (t) => {
  const f = await setup(t);
  assert.equal(
    (await f.json("/api/workspaces", "POST", { root: f.root })).status,
    412,
  );
  assert.equal((await f.json("/api/sessions")).data.sessions.length, 0);
  assert.equal((await f.json("/api/patients")).data.patients.length, 0);
  assert.equal((await fetch(f.origin + f.base)).status, 401);
  assert.equal(
    (
      await f.json(f.base + "/tools", "POST", {
        tool: "read_file",
        arguments: { path: "note.txt" },
      })
    ).data.text,
    "SYNTHETIC original",
  );
});

test("workspace files reject traversal, protected files, links and unknown arguments", async (t) => {
  const f = await setup(t);
  writeFileSync(join(f.root, ".env"), "SYNTHETIC SECRET");
  symlinkSync(join(f.root, "note.txt"), join(f.root, "alias.txt"));
  for (const path of [
    "../outside.txt",
    "/etc/passwd",
    ".env",
    "alias.txt",
    ".SSH/key.txt",
    "MODEL.ENV",
    ".GIT/config",
  ]) {
    const r = await f.json(f.base + "/tools", "POST", {
      tool: "read_file",
      arguments: { path },
    });
    assert.equal(r.status, 403, path);
  }
  assert.equal(
    (
      await f.json(f.base + "/tools", "POST", {
        tool: "read_file",
        arguments: { path: "note.txt", elevated: true },
      })
    ).status,
    400,
  );
});

test("file edits require write authorization, exact hash, explicit approval and cannot replay", async (t) => {
  const f = await setup(t),
    files = new WorkspaceFiles(f.root);
  const args = {
    path: "note.txt",
    content: "SYNTHETIC revised",
    expectedHash: files.read("note.txt").hash,
  };
  assert.equal(
    (
      await f.json(f.base + "/tools", "POST", {
        tool: "propose_file_write",
        arguments: args,
      })
    ).status,
    403,
  );
  await f.writable();
  const proposal = await f.json(f.base + "/tools", "POST", {
    tool: "propose_file_write",
    arguments: args,
  });
  assert.equal(proposal.data.status, "pending");
  assert.equal(
    readFileSync(join(f.root, "note.txt"), "utf8"),
    "SYNTHETIC original",
  );
  const url = f.base + "/approvals/" + proposal.data.approvalId;
  assert.equal(
    (
      await f.json(url, "POST", {
        revision: (await f.latest()).revision,
        decision: "approve",
        content: "injected",
      })
    ).status,
    200,
  );
  assert.equal(
    readFileSync(join(f.root, "note.txt"), "utf8"),
    "SYNTHETIC revised",
  );
  assert.equal(
    (
      await f.json(url, "POST", {
        revision: (await f.latest()).revision,
        decision: "approve",
      })
    ).status,
    409,
  );
});

test("external edits and revoked permissions prevent pending writes", async (t) => {
  const f = await setup(t);
  await f.writable();
  const files = new WorkspaceFiles(f.root);
  const p = (
    await f.json(f.base + "/tools", "POST", {
      tool: "propose_file_write",
      arguments: {
        path: "note.txt",
        content: "new",
        expectedHash: files.read("note.txt").hash,
      },
    })
  ).data;
  writeFileSync(join(f.root, "note.txt"), "external change");
  assert.equal(
    (
      await f.json(f.base + "/approvals/" + p.approvalId, "POST", {
        revision: (await f.latest()).revision,
        decision: "approve",
      })
    ).status,
    409,
  );
  assert.equal(
    readFileSync(join(f.root, "note.txt"), "utf8"),
    "external change",
  );
  const p2 = (
    await f.json(f.base + "/tools", "POST", {
      tool: "propose_file_write",
      arguments: { path: "new.txt", content: "new" },
    })
  ).data;
  await f.json(f.base, "PATCH", {
    revision: (await f.latest()).revision,
    profile: "minimal",
    allowWrite: false,
  });
  assert.equal(
    (
      await f.json(f.base + "/approvals/" + p2.approvalId, "POST", {
        revision: (await f.latest()).revision,
        decision: "approve",
      })
    ).status,
    409,
  );
  assert.equal(existsSync(join(f.root, "new.txt")), false);
});

test("shared agent loop performs real scoped reads and persists stream, usage and private context", async (t) => {
  let calls = 0;
  const provider = {
    apiKey: "synthetic",
    model: "fixture",
    async complete(messages, tools) {
      assert.ok(!messages[0].content.includes("你是医疗"));
      assert.ok(tools.some((t) => t.function.name === "read_file"));
      if (++calls === 1)
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "read1",
                function: {
                  name: "read_file",
                  arguments: '{"path":"note.txt"}',
                },
              },
            ],
          },
        };
      assert.equal(
        JSON.parse(messages.at(-1).content).text,
        "SYNTHETIC original",
      );
      return {
        message: { role: "assistant", content: "Read completed" },
        usage: { total_tokens: 10 },
      };
    },
  };
  const f = await setup(t, { provider });
  const r = await f.request(f.base + "/run", "POST", {
    revision: (await f.latest()).revision,
    message: "Read file",
    externalConsent: true,
  });
  assert.equal(r.status, 200);
  const stream = await r.text();
  assert.match(stream, /message.complete/);
  assert.match(stream, /Read completed/);
  const w = await f.latest();
  assert.equal(w.runs[0].status, "completed");
  assert.equal(w.runs[0].usage.total_tokens, 10);
  assert.equal(w.runs[0].providerMessages, undefined);
  const events = (await f.json(f.base + "/events")).data;
  assert.ok(events.events.some((e) => e.type === "tool.complete"));
  assert.equal(
    (await f.json(f.base + "/events?after=" + events.cursor)).data.events
      .length,
    0,
  );
});

test("minimal mode fails closed on unsolicited tools and external consent is mandatory", async (t) => {
  let calls = 0;
  const f = await setup(t, {
    provider: {
      apiKey: "synthetic",
      model: "fixture",
      async complete(_messages, tools) {
        calls++;
        assert.deepEqual(tools, []);
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "escape",
                function: {
                  name: "read_file",
                  arguments: '{"path":"note.txt"}',
                },
              },
            ],
          },
        };
      },
    },
  });
  await f.json(f.base, "PATCH", {
    revision: (await f.latest()).revision,
    profile: "minimal",
    allowWrite: false,
  });
  const body = { message: "Hello", revision: (await f.latest()).revision };
  assert.equal((await f.request(f.base + "/run", "POST", body)).status, 412);
  assert.equal(calls, 0);
  const response = await f.request(f.base + "/run", "POST", {
    ...body,
    externalConsent: true,
  });
  await response.text();
  assert.equal((await f.latest()).runs[0].status, "failed");
  assert.equal(calls, 1);
  assert.equal(
    (await f.json(f.base + "/events")).data.events.some(
      (e) => e.type === "tool.start",
    ),
    false,
  );
});

test("completed-run history forks copy conversations, clear approvals and keep data independent", async (t) => {
  const f = await setup(t, {
    provider: {
      apiKey: "synthetic",
      model: "fixture",
      async complete() {
        return { message: { role: "assistant", content: "Synthetic answer" } };
      },
    },
  });
  const r = await f.request(f.base + "/run", "POST", {
    message: "hello",
    revision: (await f.latest()).revision,
    externalConsent: true,
  });
  await r.text();
  const w = await f.latest();
  const fork = (
    await f.json(f.base + "/fork", "POST", {
      revision: w.revision,
      runId: w.runs[0].id,
    })
  ).data;
  assert.equal(fork.messages.length, 2);
  assert.equal(fork.runs.length, 1);
  assert.deepEqual(fork.approvals, []);
  assert.equal(fork.forkedFrom.runId, w.runs[0].id);
  assert.notEqual(fork.id, w.id);
  const empty = (
    await f.json("/api/workspaces", "POST", {
      root: f.root,
      directoryConsent: true,
    })
  ).data;
  assert.equal(
    (
      await f.json("/api/workspaces/" + empty.id + "/fork", "POST", {
        revision: empty.revision,
      })
    ).status,
    201,
  );
});

test("workspace restart marks active execution and applying approval interrupted without reexecuting", (t) => {
  const root = mkdtempSync(join(tmpdir(), "generic-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = join(root, "test.sqlite");
  const store = new Store(database),
    workspaces = new WorkspaceStore(store.db);
  const w = workspaces.create({
    title: "test",
    root,
    permissions: { profile: "standard" },
  });
  workspaces.update(w.id, (w) => {
    w.runs.push({ status: "running", partial: "partial" });
    w.approvals.push({ status: "applying" });
  });
  store.close();
  const reopened = new Store(database);
  t.after(() => reopened.close());
  const restored = new WorkspaceStore(reopened.db).get(w.id);
  assert.equal(restored.runs[0].status, "interrupted");
  assert.equal(restored.runs[0].partial, "partial");
  assert.equal(restored.approvals[0].status, "interrupted");
});

test("local provider requires no API key, remains loopback-only and rejects redirects", async (t) => {
  const { createProvider } = await import("../server/provider.mjs");
  assert.throws(
    () =>
      createProvider({ provider: "local", baseUrl: "https://example.com/v1" }),
    /回环/,
  );
  const provider = createProvider({
    provider: "local",
    apiKey: "",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "synthetic",
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.redirect, "error");
      return new Response(
        'data: {"choices":[{"delta":{"content":"Local synthetic answer"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const f = await setup(t, { provider });
  assert.equal((await f.json("/api/bootstrap")).data.modelConfigured, true);
  const response = await f.request(f.base + "/run", "POST", {
    message: "hello",
    revision: (await f.latest()).revision,
    externalConsent: true,
  });
  assert.match(await response.text(), /Local synthetic answer/);
  assert.equal((await f.latest()).runs[0].status, "completed");
});

test("fork continuation retains visible history but never inherits pending approval authority", async (t) => {
  const seen = [];
  const f = await setup(t, {
    provider: {
      apiKey: "synthetic",
      model: "fixture",
      async complete(messages) {
        seen.push(structuredClone(messages));
        return {
          message: { role: "assistant", content: "Remember SYNTHETIC_42" },
        };
      },
    },
  });
  const response = await f.request(f.base + "/run", "POST", {
    message: "remember this",
    revision: (await f.latest()).revision,
    externalConsent: true,
  });
  await response.text();
  const w = await f.latest();
  const fork = (
    await f.json(f.base + "/fork", "POST", { revision: w.revision })
  ).data;
  const next = await f.request("/api/workspaces/" + fork.id + "/run", "POST", {
    message: "what did we say?",
    revision: fork.revision,
    externalConsent: true,
  });
  await next.text();
  assert.ok(seen[1].some((m) => m.content === "Remember SYNTHETIC_42"));
  assert.equal(fork.permissions.grants["filesystem.write"], false);
});

test("generic cancellation stops provider and rejects concurrent runs or authorization changes", async (t) => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = await setup(t, {
    provider: {
      apiKey: "synthetic",
      model: "fixture",
      async complete(_m, _t, { signal }) {
        started();
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    },
  });
  const handle = f.server.workspaces.prepare(f.id, {
    message: "wait",
    revision: (await f.latest()).revision,
    externalConsent: true,
  });
  const running = f.server.workspaces.execute(handle);
  await ready;
  assert.equal(
    (
      await f.json(f.base, "PATCH", {
        revision: (await f.latest()).revision,
        profile: "minimal",
        allowWrite: false,
      })
    ).status,
    409,
  );
  assert.throws(
    () => f.server.workspaces.prepare(f.id, { message: "again" }),
    /正在执行/,
  );
  assert.equal(
    (await f.json(f.base + "/cancel", "POST", {})).data.cancelled,
    true,
  );
  assert.equal((await running).status, "cancelled");
  assert.equal((await f.latest()).runs[0].status, "cancelled");
});

test("generic child tasks use isolated context, inherit read scope, cannot write or delegate, and aggregate usage", async (t) => {
  let rootRounds = 0;
  const f = await setup(t, {
    provider: {
      apiKey: "synthetic",
      model: "fixture",
      async complete(messages, tools) {
        if (messages[0].content.includes("独立子任务")) {
          assert.equal(messages.length, 2);
          assert.ok(tools.some((t) => t.function.name === "read_file"));
          assert.equal(
            tools.some((t) =>
              ["delegate_task", "propose_file_write"].includes(t.function.name),
            ),
            false,
          );
          return {
            message: { role: "assistant", content: "child result" },
            usage: { total_tokens: 4 },
          };
        }
        if (rootRounds++ === 0)
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "child1",
                  function: {
                    name: "delegate_task",
                    arguments: '{"task":"check synthetic file"}',
                  },
                },
              ],
            },
            usage: { total_tokens: 2 },
          };
        assert.equal(JSON.parse(messages.at(-1).content).status, "completed");
        return {
          message: { role: "assistant", content: "root done" },
          usage: { total_tokens: 3 },
        };
      },
    },
  });
  await f.writable();
  const response = await f.request(f.base + "/run", "POST", {
    message: "delegate",
    revision: (await f.latest()).revision,
    externalConsent: true,
  });
  await response.text();
  const w = await f.latest();
  assert.equal(w.runs[0].status, "completed");
  assert.equal(w.runs[0].children.length, 1);
  assert.equal(w.runs[0].children[0].text, "child result");
  assert.equal(w.runs[0].usage.total_tokens, 9);
});

test("scoped text search returns line citations and never scans protected files", async (t) => {
  const f = await setup(t);
  writeFileSync(join(f.root, ".env"), "private needle");
  writeFileSync(join(f.root, "data.txt"), "alpha\npublic needle\n");
  const r = await f.json(f.base + "/tools", "POST", {
    tool: "search_files",
    arguments: { query: "needle" },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.matches, [
    { path: "data.txt", line: 2, text: "public needle" },
  ]);
});

test("skill discovery and reading reject symlink escapes", async (t) => {
  const { mkdirSync } = await import("node:fs");
  const { SkillRegistry } = await import("../server/core/skills.mjs");
  const f = await setup(t);
  const skillRoot = join(f.root, "skills");
  mkdirSync(join(skillRoot, "valid"), { recursive: true });
  writeFileSync(
    join(skillRoot, "valid/SKILL.md"),
    "---\nname: valid\ndescription: synthetic skill\n---\nUse file tools.",
  );
  writeFileSync(
    join(f.root, "outside.md"),
    "---\nname: escape\ndescription: outside\n---\nNot allowed",
  );
  mkdirSync(join(skillRoot, "escape"));
  symlinkSync(join(f.root, "outside.md"), join(skillRoot, "escape/SKILL.md"));
  const registry = new SkillRegistry([skillRoot]);
  assert.deepEqual(
    registry.list().map((s) => s.id),
    ["valid"],
  );
  assert.throws(() => registry.get("escape"), /不存在/);
  assert.equal(
    (
      await f.json(f.base + "/tools", "POST", {
        tool: "read_skill",
        arguments: { skillId: "valid" },
      })
    ).data.body,
    "Use file tools.",
  );
});

test("generic schedules persist, run once per occurrence, and pause after authority changes", async (t) => {
  let calls = 0;
  const f = await setup(t, {
    provider: {
      apiKey: "synthetic",
      model: "fixture",
      async complete(messages) {
        calls++;
        assert.equal(messages.length, 2);
        return { message: { role: "assistant", content: "scheduled result" } };
      },
    },
  });
  const scheduler = f.server.workspaces.scheduler;
  scheduler.stop();
  let now = Date.now();
  scheduler.now = () => now;
  const plan = await f.json(f.base + "/schedules", "POST", {
    revision: (await f.latest()).revision,
    message: "Scheduled synthetic",
    runAt: now + 1000,
    intervalMinutes: 1,
    externalConsent: true,
  });
  assert.equal(plan.status, 201);
  now += 2000;
  scheduler.tick();
  scheduler.tick();
  await scheduler.drain();
  assert.equal(calls, 1);
  const w = await f.latest();
  assert.equal(w.schedules[0].status, "active");
  assert.ok(w.schedules[0].nextRunAt > now);
  await f.json(f.base, "PATCH", {
    revision: w.revision,
    profile: "minimal",
    allowWrite: false,
  });
  now += 120000;
  scheduler.tick();
  await scheduler.drain();
  assert.equal(calls, 1);
  assert.equal((await f.latest()).schedules[0].status, "paused");
});

test("applied edits can generate a version-checked rollback proposal requiring a new approval", async (t) => {
  const f = await setup(t);
  await f.writable();
  const files = new WorkspaceFiles(f.root);
  const p = (
    await f.json(f.base + "/tools", "POST", {
      tool: "propose_file_write",
      arguments: {
        path: "note.txt",
        content: "modified",
        expectedHash: files.read("note.txt").hash,
      },
    })
  ).data;
  await f.json(f.base + "/approvals/" + p.approvalId, "POST", {
    revision: (await f.latest()).revision,
    decision: "approve",
  });
  const response = await f.json(
    f.base + "/approvals/" + p.approvalId + "/revert",
    "POST",
    { revision: (await f.latest()).revision },
  );
  assert.equal(response.status, 200);
  const proposal = response.data.approvals.at(-1);
  assert.equal(proposal.status, "pending");
  assert.equal(files.read("note.txt").text, "modified");
  await f.json(f.base + "/approvals/" + proposal.id, "POST", {
    revision: response.data.revision,
    decision: "approve",
  });
  assert.equal(files.read("note.txt").text, "SYNTHETIC original");
});

test("task organization persists without copying conversation or write authority", async (t) => {
  const f = await setup(t);
  await f.writable();
  let response = await f.json(f.base + "/organization", "PATCH", { title: "重命名任务", pinned: true });
  assert.equal(response.status, 200);
  assert.equal(response.data.title, "重命名任务");
  const revision = response.data.revision;
  response = await f.json(f.base + "/organization", "PATCH", { archived: true, revision });
  assert.equal(response.status, 200);
  const list = (await f.json("/api/workspaces")).data.workspaces;
  assert.equal(list.find((w) => w.id === f.id).archived, true);
  assert.equal(list.find((w) => w.id === f.id).pinned, true);
  assert.equal((await f.json(f.base + "/organization", "PATCH", { title: " " })).status, 400);
  assert.equal((await f.json(f.base + "/organization", "PATCH", { pinned: "yes" })).status, 400);
  assert.equal((await f.json(f.base + "/organization", "PATCH", { root: "/tmp" })).status, 400);
  const task = await f.json(f.base + "/tasks", "POST", {});
  assert.equal(task.status, 201);
  assert.notEqual(task.data.id, f.id);
  assert.equal(task.data.root, (await f.latest()).root);
  assert.equal(task.data.title, "新任务");
  assert.deepEqual(task.data.messages, []);
  assert.equal(task.data.permissions.grants["filesystem.read"], true);
  assert.equal(task.data.permissions.grants["filesystem.write"], false);
  assert.equal(task.data.permissions.grants["git.write"] === true, false);
  assert.deepEqual(task.data.approvals, []);
});

test("uploaded images stay in task artifacts, validate bytes, and cannot be read from another task", async (t) => {
  const f = await setup(t);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
  const uploaded = await f.json(f.base + "/images", "POST", { name:"paste.png", data:png });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.data.mime, "image/png");
  assert.equal(uploaded.data.runId, "input-image");
  assert.equal(existsSync(join(f.root, "paste.png")), false);
  assert.equal((await f.json(f.base + "/images", "POST", { name:"../escape.png", data:png })).status, 400);
  assert.equal((await f.json(f.base + "/images", "POST", { name:"fake.png", data:Buffer.from("not an image").toString("base64") })).status, 400);
  assert.equal((await f.json(f.base + "/images", "POST", { name:"large.png", data:"a".repeat(800004) })).status, 400);
  const other = await f.json(f.base + "/tasks", "POST", {});
  assert.equal((await f.json(`/api/workspaces/${other.data.id}/artifacts/${uploaded.data.id}`)).status, 404);
});
