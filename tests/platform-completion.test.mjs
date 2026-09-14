import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer } from "../server/platform.mjs";
import { githubRepository, GitRemote } from "../server/core/git-remote.mjs";
import { ModelSettings } from "../server/core/model-settings.mjs";
import { ModelProfiles } from "../server/core/model-profiles.mjs";
import { AgentTeam } from "../server/core/agent-team.mjs";
const provider = {
  provider: "local",
  local: true,
  model: "test",
  baseUrl: "http://127.0.0.1:11434/v1",
  async complete() {
    return { message: { role: "assistant", content: "OK" }, usage: {} };
  },
};
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "platform-completion-"));
  const server = createWorkspaceServer({
    database: join(dir, "app.sqlite"),
    provider,
  });
  t.after(async () => {
    await server.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, server };
}
test("GitHub repository parsing rejects credential URLs and command transports", () => {
  assert.equal(githubRepository("git@github.com:org/repo.git"), "org/repo");
  assert.equal(githubRepository("https://github.com/org/repo.git"), "org/repo");
  for (const value of [
    "https://evil.test/a/b",
    "https://token@github.com/a/b",
    "ext::sh -c hi",
    "https://github.com/a/..",
  ])
    assert.throws(() => githubRepository(value));
});
test("saved team profiles hide credentials and do not replace primary model", async (t) => {
  const { dir, server } = setup(t);
  const models = new ModelSettings(server.database.db, dir, provider),
    profiles = new ModelProfiles(models);
  profiles.save("reviewer", {
    provider: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "review-model",
  });
  assert.equal(profiles.resolve("reviewer").model, "review-model");
  assert.equal(models.provider().model, "test");
  assert.equal(JSON.stringify(profiles.list()).includes("apiKey"), false);
  assert.throws(() => profiles.save("../escape", {}));
  profiles.remove("reviewer");
  assert.throws(() => profiles.resolve("reviewer"));
});
test("team model authorization is explicit and selected provider is actually used", async (t) => {
  const { dir, server } = setup(t),
    service = server.service;
  const w = service.create({
    root: dir,
    directoryConsent: true,
    title: "team",
  });
  let calls = 0;
  service.modelProfiles = {
    list: () => [{ id: "reviewer" }],
    resolve: () => ({
      ...provider,
      async complete() {
        calls++;
        return {
          message: { role: "assistant", content: "alternate model" },
          usage: {},
        };
      },
    }),
  };
  assert.throws(() =>
    service.configureTeam(w.id, { profiles: ["reviewer"], consent: false }),
  );
  service.configureTeam(w.id, {
    profiles: ["reviewer"],
    consent: true,
    revision: w.revision,
  });
  const runId = "test-run";
  service.store.update(w.id, (x) =>
    x.runs.push({ id: runId, status: "running", children: [] }),
  );
  const team = new AgentTeam(
    service,
    w.id,
    runId,
    new AbortController().signal,
    () => {},
    () => {},
  );
  const job = team.spawn({ task: "Read only", modelProfile: "reviewer" });
  await team.wait([job.id], 5000);
  assert.equal(team.jobs.get(job.id).status, "completed");
  assert.equal(calls, 1);
  assert.equal(team.describe(team.jobs.get(job.id)).modelProfile, "reviewer");
  assert.throws(() => team.spawn({ task: "no", modelProfile: "unknown" }));
});
test("PR creation checks published HEAD and deduplicates existing requests", async () => {
  const remote = new GitRemote("/tmp");
  remote.repository = async () => "org/repo";
  remote.git.status = async () => ({ head: "abc", branch: "agent/fix" });
  const calls = [];
  remote.api = async (path, method, body) => {
    calls.push({ path, method, body });
    if (path.includes("?head=")) return [];
    if (path.includes("/git/ref/")) return { object: { sha: "different" } };
    throw new Error("must not publish");
  };
  await assert.rejects(
    () =>
      remote.create({
        expectedHead: "abc",
        base: "main",
        title: "test",
        body: "test",
      }),
    /推送/,
  );
  assert.equal(
    calls.some((c) => c.method === "POST"),
    false,
  );
  remote.api = async () => [
    { html_url: "https://github.com/org/repo/pull/1", number: 1 },
  ];
  assert.equal(
    (
      await remote.create({
        expectedHead: "abc",
        base: "main",
        title: "test",
        body: "test",
      })
    ).existing,
    true,
  );
});
test(
  "PTY opens real isolated shell, accepts input and resizes",
  { skip: process.env.TEST_REAL_PTY !== "1" },
  async (t) => {
    const { dir, server } = setup(t),
      service = server.service;
    writeFileSync(join(dir, "note.txt"), "SYNTHETIC");
    let w = service.create({ root: dir, directoryConsent: true, title: "pty" });
    service.store.update(w.id, (x) => {
      x.permissions.grants["process.spawn"] = true;
      x.extensions = {
        ...(x.extensions || {}),
        image: "open-medical-runtime:0.8-full",
      };
    });
    const s = await service.pty.start(w.id, {
      consent: true,
      cols: 80,
      rows: 24,
    });
    service.pty.write(w.id, s.id, "printf 'PTY_%s\\n' 'TEST_OK'\r");
    service.pty.resize(w.id, s.id, 100, 30);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (service.pty.read(w.id, s.id).output.includes("PTY_TEST_OK\r\n"))
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const output = service.pty.read(w.id, s.id);
    assert.match(output.output, /PTY_TEST_OK/);
    assert.equal(output.cols, 100);
    assert.throws(() => service.pty.read("wrong", s.id));
    service.pty.stop(w.id, s.id);
  },
);

test("local merge exposes three-way conflicts and commits a hash-checked resolution", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { GitConflicts } = await import("../server/core/git-conflicts.mjs");
  const dir = mkdtempSync(join(tmpdir(), "git-conflict-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(dir, "note.txt"), "base\n");
  git("add", "note.txt");
  git("commit", "-m", "base");
  git("checkout", "-b", "topic");
  writeFileSync(join(dir, "note.txt"), "topic\n");
  git("commit", "-am", "topic");
  git("checkout", "main");
  writeFileSync(join(dir, "note.txt"), "main\n");
  git("commit", "-am", "main");
  const head = git("rev-parse", "HEAD");
  const conflicts = new GitConflicts(dir);
  const result = await conflicts.merge({ ref: "topic", expectedHead: head });
  assert.equal(result.status, "conflicts");
  assert.equal(result.conflicts[0].ours, "main\n");
  assert.equal(result.conflicts[0].theirs, "topic\n");
  await assert.rejects(() =>
    conflicts.resolve({ path: "note.txt", expectedHash: "stale" }),
  );
  writeFileSync(join(dir, "note.txt"), "resolved\n");
  await conflicts.resolve({
    path: "note.txt",
    expectedHash: conflicts.files.read("note.txt").hash,
  });
  assert.equal((await conflicts.conflicts()).length, 0);
  const finish = await conflicts.finish({
    expectedHead: head,
    message: "resolve",
  });
  assert.equal(finish.status, "committed");
  assert.equal(
    git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length,
    3,
  );
});

test("media uses the selected endpoint, validates authorization and saves returned bytes", async (t) => {
  const { dir, server } = setup(t),
    service = server.service;
  const w = service.create({ root: dir, directoryConsent: true });
  const config = {
    provider: "openai-compatible",
    baseUrl: "https://media.example.invalid/v1",
    model: "image-test",
    apiKey: "synthetic-secret",
  };
  service.modelProfiles = { all: () => ({ media: config }) };
  let called = false;
  service.media.fetch = async (url, options) => {
    called = true;
    assert.equal(url, "https://media.example.invalid/v1/images/generations");
    assert.equal(options.redirect, "error");
    assert.equal(JSON.parse(options.body).model, "image-test");
    return new Response(
      JSON.stringify({
        data: [
          {
            b64_json:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  await assert.rejects(() =>
    service.media.execute(w.id, {
      action: "image",
      modelProfile: "media",
      text: "test",
    }),
  );
  assert.equal(called, false);
  service.store.update(w.id, (x) => {
    x.teamModels = ["media"];
  });
  const result = await service.media.execute(w.id, {
    action: "image",
    modelProfile: "media",
    text: "test",
  });
  assert.equal(result.artifact.mime, "image/png");
  assert.equal(service.artifacts.read(w.id, result.artifact.id).data[0], 137);
  assert.equal(
    JSON.stringify(service.get(w.id)).includes("synthetic-secret"),
    false,
  );
});

test("desktop daemon discovery rejects an unrelated process on the saved port", async (t) => {
  const { createRequire } = await import("node:module");
  const { discover } = createRequire(import.meta.url)(
    "../desktop/daemon-connection.cjs",
  );
  const dir = mkdtempSync(join(tmpdir(), "daemon-discovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "daemon.json"),
    JSON.stringify({ port: 18788, instanceId: "expected" }),
  );
  assert.equal(
    await discover(
      dir,
      async () =>
        new Response(
          JSON.stringify({ engine: "generic-runtime", instanceId: "other" }),
        ),
    ),
    null,
  );
  const found = await discover(
    dir,
    async () =>
      new Response(
        JSON.stringify({ engine: "generic-runtime", instanceId: "expected" }),
      ),
  );
  assert.equal(found.origin, "http://127.0.0.1:18788");
});

test("failed child resumes independently without replacing its task identity", async (t) => {
  const { dir, server } = setup(t),
    service = server.service;
  let calls = 0;
  service.provider = {
    ...provider,
    async complete() {
      if (++calls === 1) throw new Error("synthetic interruption");
      return {
        message: { role: "assistant", content: "recovered" },
        usage: {},
      };
    },
  };
  const w = service.create({ root: dir, directoryConsent: true });
  service.store.update(w.id, (x) =>
    x.runs.push({ id: "resume-test", children: [] }),
  );
  const team = new AgentTeam(
    service,
    w.id,
    "resume-test",
    new AbortController().signal,
    () => {},
    () => {},
  );
  const child = team.spawn({ task: "recover me" });
  await team.wait([child.id], 5000);
  assert.equal(team.jobs.get(child.id).status, "failed");
  team.resume(child.id);
  await team.wait([child.id], 5000);
  assert.equal(team.jobs.get(child.id).status, "completed");
  assert.equal(team.jobs.size, 1);
  assert.throws(() => team.resume(child.id));
});

test("push binds exact HEAD and sends credentials only through scoped environment", async () => {
  let tokenCalls = 0,
    push;
  const remote = new GitRemote("/tmp", {
    run: async () => {
      tokenCalls++;
      return { stdout: "SYNTHETIC_TOKEN" };
    },
  });
  remote.repository = async () => "org/repo";
  remote.git.status = async () => ({
    head: "expected",
    branch: "agent/test",
    entries: [],
  });
  remote.git.command = async (args, options) => {
    if (args[0] === "push") push = { args, options };
    return "";
  };
  await assert.rejects(() => remote.push("stale"));
  assert.equal(tokenCalls, 0);
  await remote.push("expected");
  assert.equal(push.args.at(-1), "expected:refs/heads/agent/test");
  assert.equal(JSON.stringify(push.args).includes("SYNTHETIC_TOKEN"), false);
  assert.equal(
    push.options.inputEnv.GIT_CONFIG_KEY_0,
    "http.https://github.com/.extraheader",
  );
  remote.git.status = async () => ({
    head: "expected",
    branch: "main",
    entries: [],
  });
  await assert.rejects(() => remote.push("expected"));
});

test("nested read helpers release waiting slots and cannot escalate to writers", async (t) => {
  const { dir, server } = setup(t),
    service = server.service;
  service.provider = {
    ...provider,
    async complete(messages) {
      const task = messages.find((m) => m.role === "user")?.content || "";
      const outputs = messages.filter((m) => m.role === "tool");
      if (task.startsWith("parent-") && !outputs.length)
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "spawn-helper",
                function: {
                  name: "spawn_agent",
                  arguments: JSON.stringify({ task: "nested read helper" }),
                },
              },
            ],
          },
        };
      if (task.startsWith("parent-") && outputs.length === 1) {
        const child = JSON.parse(outputs[0].content);
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "wait-helper",
                function: {
                  name: "wait_agents",
                  arguments: JSON.stringify({
                    ids: [child.id],
                    timeoutMs: 2000,
                  }),
                },
              },
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "done" }, usage: {} };
    },
  };
  const w = service.create({ root: dir, directoryConsent: true });
  service.store.update(w.id, (x) =>
    x.runs.push({ id: "nested-run", children: [] }),
  );
  const team = new AgentTeam(
    service,
    w.id,
    "nested-run",
    new AbortController().signal,
    () => {},
    () => {},
  );
  service.teams.set(w.id, team);
  const parents = [1, 2, 3].map((i) => team.spawn({ task: "parent-" + i }));
  await team.wait(
    parents.map((p) => p.id),
    10000,
  );
  assert.equal(team.jobs.size, 6);
  assert.ok([...team.jobs.values()].every((j) => j.status === "completed"));
  assert.ok(
    [...team.jobs.values()]
      .filter((j) => j.parentId)
      .every((j) => j.depth === 1 && j.role === "reader"),
  );
  assert.equal(team.modelCalls, 0);
  assert.throws(() =>
    team.spawn({
      task: "bad",
      parentId: parents[0].id,
      role: "writer",
      writePaths: ["note.txt"],
    }),
  );
});

test('PTY preview publishes container service only on loopback', {skip:process.env.TEST_REAL_PTY!=='1'},async t=>{
  const {dir,server}=setup(t),service=server.service;writeFileSync(join(dir,'hello.txt'),'PREVIEW_SYNTHETIC');const w=service.create({root:dir,directoryConsent:true});service.store.update(w.id,x=>{x.permissions.grants['process.spawn']=true;x.permissions.grants.network=true;x.extensions={...(x.extensions||{}),image:'open-medical-runtime:0.8-full',terminalNetwork:true};});const session=await service.pty.start(w.id,{consent:true,previewPort:3000});service.pty.write(w.id,session.id,'python3 -m http.server 3000\r');const deadline=Date.now()+10000;let content;while(Date.now()<deadline){const state=service.pty.read(w.id,session.id);if(state.previewUrl){assert.match(state.previewUrl,/^http:\/\/127\.0\.0\.1:\d+$/);try{content=await(await fetch(state.previewUrl+'/hello.txt',{signal:AbortSignal.timeout(1000)})).text();if(content==='PREVIEW_SYNTHETIC')break;}catch{}}await new Promise(r=>setTimeout(r,100));}service.pty.stop(w.id,session.id);assert.equal(content,'PREVIEW_SYNTHETIC');
});
