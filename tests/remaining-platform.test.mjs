import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceDatabase, WorkspaceService } from "../server/core/index.mjs";
import { AdvancedMedia } from "../server/core/advanced-media.mjs";
import { DesktopControl } from "../server/core/desktop-control.mjs";
import { RemoteQueue } from "../server/core/remote-queue.mjs";
import { RemoteClient } from "../server/core/remote-client.mjs";
import { PluginPackages } from "../server/core/plugins.mjs";
import { importMcpConfig } from "../server/core/plugin-compatibility.mjs";
import { coordinator } from "../scripts/remote-coordinator.mjs";
import { runWorker } from "../scripts/remote-worker.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "remaining-platform-")),
    root = join(directory, "project");
  mkdirSync(root);
  const db = new WorkspaceDatabase(join(directory, "db.sqlite"));
  const config = {
    provider: "openai",
    baseUrl: "https://provider.test/v1",
    model: "media",
    apiKey: "synthetic",
  };
  const vault = new Map(),
    profiles = {
      settings: {
        vault: {
          get: (key) => vault.get(key) || {},
          set: (key, value) => vault.set(key, value),
        },
      },
      all: () => ({ media: config }),
    };
  const service = new WorkspaceService(
    db.db,
    { model: "test" },
    { modelProfiles: profiles },
  );
  service.modelProfiles = profiles;
  const w = service.create({ root, directoryConsent: true });
  service.store.update(w.id, (current) => {
    current.teamModels = ["media"];
  });
  t.after(async () => {
    await service.extensions.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, root, service, owner: w.id, config };
}
test("video jobs persist, unknown submissions do not replay, profiles and owners remain scoped", async (t) => {
  const f = fixture(t),
    calls = [];
  const media = new AdvancedMedia(f.service, {
    fetchImpl: async (url, options) => {
      calls.push([url, options.method]);
      if (url.endsWith("/videos"))
        return Response.json({ id: "video_1", status: "queued" });
      if (url.endsWith("/content"))
        return new Response(
          Buffer.concat([
            Buffer.from([0, 0, 0, 20]),
            Buffer.from("ftypisom"),
            Buffer.alloc(16),
          ]),
        );
      return Response.json({ status: "completed", progress: 100 });
    },
  });
  await assert.rejects(
    media.video(f.owner, {
      action: "create",
      modelProfile: "media",
      text: "test",
    }),
    /授权/,
  );
  const job = await media.video(f.owner, {
    action: "create",
    modelProfile: "media",
    text: "test",
    consent: true,
  });
  const restarted = new AdvancedMedia(f.service, { fetchImpl: media.fetch });
  assert.equal(restarted.list(f.owner)[0].remoteId, "video_1");
  await restarted.video(f.owner, { action: "refresh", jobId: job.id });
  const result = await restarted.video(f.owner, {
    action: "download",
    jobId: job.id,
  });
  assert.ok(result.artifact);
  await restarted.video(f.owner, { action: "download", jobId: job.id });
  assert.equal(calls.filter((c) => c[0].endsWith("/content")).length, 1);
  f.config.apiKey = "changed";
  await assert.rejects(
    restarted.video(f.owner, { action: "refresh", jobId: job.id }),
    /改变/,
  );
  const unknown = new AdvancedMedia(f.service, {
    fetchImpl: async () => {
      throw new Error("network disconnected");
    },
  });
  await assert.rejects(
    unknown.video(f.owner, {
      action: "create",
      modelProfile: "media",
      text: "test",
      consent: true,
    }),
  );
  assert.equal(unknown.list(f.owner)[0].status, "unknown");
});
test("realtime SDP exchange keeps API keys on server and requires explicit consent", async (t) => {
  const f = fixture(t);
  let request;
  const media = new AdvancedMedia(f.service, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response("v=0\r\nanswer");
    },
  });
  await assert.rejects(
    media.realtime(f.owner, { sdp: "v=0", modelProfile: "media" }),
    /授权/,
  );
  const answer = await media.realtime(f.owner, {
    sdp: "v=0\r\noffer",
    modelProfile: "media",
    consent: true,
  });
  assert.equal(answer.sdp, "v=0\r\nanswer");
  assert.equal(request.options.headers.Authorization, "Bearer synthetic");
  assert.equal(request.options.body.get("sdp"), "v=0\r\noffer");
  assert.ok(!JSON.stringify(answer).includes("synthetic"));
});
test("desktop mutations need expiring app-specific approval; coordinates outside selected window rejected", async (t) => {
  const f = fixture(t),
    calls = [];
  const desktop = new DesktopControl(f.service, {
    invoke: async (input) => {
      calls.push(input);
      return {
        text: "window",
        bounds: { X: 100, Y: 100, Width: 200, Height: 100 },
      };
    },
  });
  assert.throws(
    () => desktop.propose(f.owner, { action: "type", text: "hello" }),
    /授权/,
  );
  await desktop.execute(f.owner, {
    action: "authorize",
    app: "org.test.app",
    consent: true,
  });
  const { proposal } = desktop.propose(f.owner, {
    action: "type",
    text: "hello",
  });
  assert.equal(calls.length, 0);
  await desktop.execute(f.owner, {
    action: "approve",
    proposalId: proposal.id,
  });
  assert.equal(calls[0].app, "org.test.app");
  await assert.rejects(
    desktop.execute(f.owner, { action: "approve", proposalId: proposal.id }),
    /不存在/,
  );
  await assert.rejects(
    desktop.perform(f.owner, { action: "click", x: 99, y: 100 }),
    /坐标/,
  );
  desktop.sessions.get(f.owner).expires = 0;
  await assert.rejects(
    desktop.perform(f.owner, { action: "snapshot" }),
    /过期/,
  );
});
test("remote leases prevent duplicate claims, reject stale completion, and never replay expired work automatically", () => {
  const db = new DatabaseSync(":memory:");
  let now = 1000;
  const q = new RemoteQueue(db, { now: () => now, leaseMs: 100 });
  const job = q.create({ requestId: "one", prompt: "test", files: [] });
  assert.equal(
    q.create({ requestId: "one", prompt: "test", files: [] }).id,
    job.id,
  );
  const claimed = q.claim("worker1");
  assert.equal(q.claim("worker2"), null);
  now = 1200;
  q.expire();
  assert.equal(q.get(job.id).status, "interrupted");
  assert.equal(q.claim("worker2"), null);
  assert.throws(
    () => q.complete(job.id, claimed.lease, { status: "completed" }),
    /失效/,
  );
  q.retry(job.id);
  const next = q.claim("worker2");
  assert.notEqual(next.lease, claimed.lease);
  q.cancel(job.id);
  assert.throws(() => q.heartbeat(job.id, next.lease), /取消/);
  assert.throws(
    () =>
      q.create({
        requestId: "escape",
        prompt: "x",
        files: [{ path: "../escape", text: "x" }],
      }),
    /路径/,
  );
  db.close();
});
test("real coordinator and worker return edits for local approval without modifying source", async (t) => {
  const f = fixture(t),
    db = new DatabaseSync(":memory:"),
    server = coordinator({
      db,
      clientToken: "c".repeat(32),
      workerToken: "w".repeat(32),
    });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    db.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/`,
    client = new RemoteClient(f.service);
  f.service.update(f.owner, {
    revision: f.service.get(f.owner).revision,
    profile: "code",
    allowWrite: true,
  });
  await client.execute(f.owner, {
    action: "configure",
    url,
    token: "c".repeat(32),
    consent: true,
  });
  writeFileSync(join(f.root, "hello.txt"), "before");
  const submitted = await client.execute(f.owner, {
    action: "submit",
    prompt: "change hello",
    paths: ["hello.txt"],
    consent: true,
  });
  let turn = 0;
  const provider = {
    model: "test",
    apiKey: "synthetic",
    complete: async (messages) => {
      turn++;
      if (turn === 1)
        return {
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "read",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "hello.txt" }),
                },
              },
            ],
          },
        };
      if (turn === 2) {
        const read = JSON.parse(messages.at(-1).content);
        return {
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "write",
                function: {
                  name: "propose_file_write",
                  arguments: JSON.stringify({
                    path: "hello.txt",
                    content: "after",
                    expectedHash: read.hash,
                  }),
                },
              },
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "finished" } };
    },
  };
  await runWorker({
    terminal: process.env.TEST_REMOTE_DOCKER === "1",
    url,
    token: "w".repeat(32),
    directory: join(f.directory, "worker"),
    provider,
    once: true,
  });
  const id = submitted.jobs[0].id;
  const finished = await client.execute(f.owner, { action: "refresh", id });
  assert.equal(finished.jobs[0].status, "completed");
  await client.execute(f.owner, { action: "import", id, consent: true });
  assert.equal(readFileSync(join(f.root, "hello.txt"), "utf8"), "before");
  const proposal = f.service
    .get(f.owner)
    .approvals.find((a) => a.path === "hello.txt");
  assert.equal(proposal.content, "after");
  assert.equal(proposal.status, "pending");
});
test("third-party skills and MCP import preserve digest verification and never enable unsupported hooks", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-compat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source");
  mkdirSync(join(source, ".claude-plugin"), { recursive: true });
  mkdirSync(join(source, "skills/demo"), { recursive: true });
  writeFileSync(
    join(source, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", hooks: {} }),
  );
  writeFileSync(join(source, "skills/demo/SKILL.md"), "# Test skill");
  const packages = new PluginPackages(join(dir, "installed"));
  const inspection = packages.inspect(source);
  assert.equal(inspection.compatibility.format, "claude");
  assert.equal(inspection.manifest.hooks.length, 0);
  const installed = packages.install("owner", source, inspection.hash);
  assert.equal(packages.verify("owner", installed).hash, inspection.hash);
  const imported = importMcpConfig({
    mcpServers: { demo: { url: "https://example.com/mcp" } },
  });
  assert.deepEqual(imported[0].allowedTools, []);
  assert.throws(
    () =>
      importMcpConfig({
        demo: {
          url: "https://example.com/mcp",
          headers: { Authorization: "secret" },
        },
      }),
    /凭据/,
  );
});

test("realtime project tools obey directory scope and become unusable after hangup", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "note.txt"), "project note");
  const requests = [];
  const media = new AdvancedMedia(f.service, {
    fetchImpl: async (url) => {
      requests.push(url);
      return url.endsWith("/hangup")
        ? new Response(null, { status: 200 })
        : new Response("v=0\r\nanswer", {
            headers: { location: "/v1/realtime/calls/rtc_1" },
          });
    },
  });
  const session = await media.realtime(f.owner, {
    sdp: "v=0",
    consent: true,
    modelProfile: "media",
    workspaceReadConsent: true,
  });
  const read = await media.realtimeTool(f.owner, {
    sessionId: session.sessionId,
    tool: "read_file",
    arguments: { path: "note.txt" },
  });
  assert.equal(read.text, "project note");
  await assert.rejects(
    media.realtimeTool(f.owner, {
      sessionId: session.sessionId,
      tool: "terminal_run",
      arguments: { command: "pwd" },
    }),
    /仅允许/,
  );
  await assert.rejects(
    media.realtimeTool(f.owner, {
      sessionId: session.sessionId,
      tool: "read_file",
      arguments: { path: "../escape" },
    }),
  );
  await media.endCall(f.owner, session.sessionId);
  assert.ok(requests.at(-1).endsWith("/rtc_1/hangup"));
  await assert.rejects(
    media.realtimeTool(f.owner, {
      sessionId: session.sessionId,
      tool: "read_file",
      arguments: { path: "note.txt" },
    }),
    /过期/,
  );
});
