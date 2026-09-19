import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  cpSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceService } from "../server/core/workspace-service.mjs";
import { ProcessRunner } from "../server/core/process-runner.mjs";
import { PluginPackages } from "../server/core/plugins.mjs";
import {
  SemanticMemory,
  latentSearch,
} from "../server/core/semantic-memory.mjs";
import { permittedURL } from "../server/core/browser-tools.mjs";

function setup(t, options = {}) {
  const root = mkdtempSync(resolve("output/extension-test-")),
    db = new DatabaseSync(":memory:");
  const service = new WorkspaceService(
    db,
    {},
    { extensions: { directory: join(root, "installed"), ...options } },
  );
  const w = service.create({ root, directoryConsent: true });
  t.after(async () => {
    await service.extensions.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const manage = (body) =>
    service.extensions.operation(w.id, {
      revision: service.get(w.id).revision,
      ...body,
    });
  const configure = (body) =>
    manage({
      action: "configure",
      consent: true,
      terminal: false,
      browser: false,
      plugins: false,
      mcp: false,
      memoryRead: false,
      memoryWrite: false,
      origins: [],
      memory: { provider: "lsa" },
      ...body,
    });
  const tool = (tool, arguments_ = {}) =>
    service.tool(w.id, { tool, arguments: arguments_ });
  return { root, db, service, id: w.id, manage, configure, tool };
}

test("advanced capabilities default denied and require explicit consent, revisions and constrained endpoints", async (t) => {
  const f = setup(t);
  for (const name of [
    "terminal_start",
    "mcp_list",
    "plugin_list",
    "memory_list",
  ])
    await assert.rejects(
      f.tool(name, {}),
      (e) => e.code === "PERMISSION_DENIED",
    );
  // 0.9.4 起：项目工作区默认放开联网读取（browser.read / network），无
  // 需逐项授权；显式关闭扩展浏览开关后仍回到 PERMISSION_DENIED。
  const grantsNow = f.service.get(f.id).permissions.grants;
  assert.equal(grantsNow["browser.read"], true);
  assert.equal(grantsNow.network, true);
  await f.configure({ browser: false });
  await assert.rejects(
    f.tool("browser_open", { url: "https://example.com/" }),
    (e) => e.code === "PERMISSION_DENIED",
  );
  await assert.rejects(
    f.manage({ action: "configure", consent: false }),
    (e) => e.code === "EXTENSION_CONSENT",
  );
  await assert.rejects(
    f.configure({
      memory: { provider: "ollama", url: "https://example.com", model: "m" },
    }),
    (e) => e.code === "MEMORY_CONFIG",
  );
  await f.configure({ memoryRead: true, memoryWrite: true });
  await f.tool("memory_add", { text: "User prefers concise explanations" });
  assert.equal((await f.tool("memory_list")).length, 1);
  await assert.rejects(
    f.service.extensions.configure(f.id, { revision: 0, consent: true }),
    (e) => e.code === "REVISION_CONFLICT",
  );
});

test("offline plugin installation binds reviewed digest, supports grants, upgrade revocation and uninstall", async (t) => {
  const f = setup(t),
    source = join(f.root, "source");
  cpSync(resolve("examples/plugins/local-tools"), source, { recursive: true });
  const inspection = await f.manage({ action: "inspect-plugin", path: source });
  writeFileSync(join(source, "hello.py"), 'print("changed")');
  await assert.rejects(
    f.manage({
      action: "install-plugin",
      path: source,
      hash: inspection.hash,
      consent: true,
    }),
    (e) => e.code === "PLUGIN_CHANGED",
  );
  const current = await f.manage({ action: "inspect-plugin", path: source });
  await f.manage({
    action: "install-plugin",
    path: source,
    hash: current.hash,
    consent: true,
  });
  await f.configure({ plugins: true });
  assert.equal((await f.tool("plugin_list")).length, 0);
  await f.manage({
    action: "plugin-state",
    pluginId: "local-tools",
    enabled: true,
    allowedSkills: ["guide"],
    allowedCommands: [],
  });
  assert.match(
    (
      await f.tool("plugin_skill", {
        pluginId: "local-tools",
        skillId: "guide",
      })
    ).body,
    /mcp_list/,
  );
  await assert.rejects(
    f.tool("plugin_command", { pluginId: "local-tools", commandId: "hello" }),
  );
  await f.manage({
    action: "install-plugin",
    path: source,
    hash: current.hash,
    consent: true,
  });
  assert.equal((await f.tool("plugin_list")).length, 0);
  await f.manage({ action: "uninstall-plugin", pluginId: "local-tools" });
  assert.equal(f.service.extensions.current(f.id).config.plugins.length, 0);
  symlinkSync("/etc/passwd", join(source, "escape"));
  assert.throws(
    () => new PluginPackages(join(f.root, "other")).inspect(source),
    (e) => e.code === "PLUGIN_SYMLINK",
  );
});

test("memory is isolated, persistent, source checked and deletion removes entire indexed batch", async (t) => {
  const f = setup(t);
  await f.configure({ memoryRead: true, memoryWrite: true });
  writeFileSync(
    join(f.root, "notes.txt"),
    "苹果 苹果 水果 果园 采摘 营养\n".repeat(180),
  );
  const added = await f.tool("memory_add", { path: "notes.txt" });
  assert.ok(added.chunks > 1);
  const result = await f.tool("memory_search", { query: "苹果 营养" });
  assert.ok(result.results.length > 0);
  assert.equal(result.provider, "lsa");
  const other = f.service.create({ root: f.root, directoryConsent: true });
  assert.deepEqual(f.service.extensions.memory.list(other.id), []);
  const reopened = new SemanticMemory(f.db, f.service.store);
  assert.equal(reopened.list(f.id).length, added.chunks);
  writeFileSync(join(f.root, "notes.txt"), "revised");
  const stale = await f.tool("memory_search", { query: "苹果" });
  assert.equal(stale.results.length, 0);
  assert.equal(stale.stale, added.chunks);
  await f.tool("memory_delete", { id: reopened.list(f.id)[0].id });
  assert.equal(reopened.list(f.id).length, 0);
});

test("local embedding validation and cosine retrieval preserve model namespace and reject malformed vectors", async (t) => {
  const seen = [];
  const f = setup(t, {
    memory: {
      fetchImpl: async (url, init) => {
        seen.push(String(url));
        const { input } = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            embeddings: input.map((s) =>
              s.includes("病") ? [1, 0, 0] : [0, 1, 0],
            ),
          }),
        );
      },
    },
  });
  await f.configure({
    memoryRead: true,
    memoryWrite: true,
    memory: {
      provider: "ollama",
      url: "http://127.0.0.1:11434",
      model: "synthetic",
    },
  });
  await f.tool("memory_add", { text: "疾病资料" });
  await f.tool("memory_add", { text: "旅游资料" });
  const result = await f.tool("memory_search", { query: "病史" });
  assert.equal(result.results[0].text, "疾病资料");
  assert.ok(seen.every((s) => s === "http://127.0.0.1:11434/api/embed"));
  await f.configure({
    memoryRead: true,
    memoryWrite: true,
    memory: {
      provider: "ollama",
      url: "http://127.0.0.1:11434",
      model: "changed",
    },
  });
  assert.equal((await f.tool("memory_search", { query: "病史" })).stale, 2);
  f.service.extensions.memory.fetch = async () =>
    new Response(JSON.stringify({ embeddings: [[0, 0]] }));
  await assert.rejects(
    f.tool("memory_add", { text: "invalid" }),
    (e) => e.code === "MEMORY_EMBEDDING",
  );
});

test("browser actions stay pending until approved, reject changed pages and never replay", async (t) => {
  let clicks = 0,
    content = "original";
  const f = setup(t, {
    browserFactory: async () => ({
      navigate: async (url) => ({ url }),
      snapshot: async () => ({ url: "https://example.com/", text: content }),
      act: async () => {
        clicks++;
        return { clicked: true };
      },
      close: async () => {},
    }),
  });
  await f.configure({ browser: true, origins: ["https://example.com"] });
  assert.throws(() =>
    permittedURL("https://evil.example/", ["https://example.com"]),
  );
  assert.throws(() => permittedURL("file:///etc/passwd", ["null"]));
  await f.tool("browser_open", { url: "https://example.com/" });
  const a = await f.tool("browser_action", {
    action: "click",
    selector: "#submit",
  });
  assert.equal(clicks, 0);
  content = "changed";
  await assert.rejects(
    f.manage({
      action: "browser-decision",
      approvalId: a.id,
      decision: "approve",
    }),
    (e) => e.code === "BROWSER_CHANGED",
  );
  assert.equal(clicks, 0);
  content = "original";
  await f.manage({
    action: "browser-decision",
    approvalId: a.id,
    decision: "approve",
  });
  assert.equal(clicks, 1);
  await assert.rejects(
    f.manage({
      action: "browser-decision",
      approvalId: a.id,
      decision: "approve",
    }),
    (e) => e.code === "APPROVAL_STATE",
  );
  assert.equal(clicks, 1);
});

const realDocker = process.env.TEST_DOCKER_IMAGE;
test(
  "real Docker terminal isolates host, network and credentials; returns proposals and supports stdin/cancel",
  { skip: !realDocker },
  async (t) => {
    const f = setup(t);
    f.service.update(f.id, {
      revision: f.service.get(f.id).revision,
      profile: "standard",
      allowWrite: true,
    });
    await f.configure({ terminal: true, image: realDocker });
    writeFileSync(join(f.root, "note.txt"), "original");
    const s = await f.tool("terminal_start", {
      command:
        'id -u; test ! -e /Users; test ! -e /input/.env; test -z "$AI_API_KEY"; echo revised > note.txt; echo new > new.txt; touch /blocked 2>/dev/null && exit 99; true',
      paths: ["note.txt"],
    });
    const done = await f.service.extensions.runner.get(f.id, s.id).done;
    assert.equal(done.exitCode, 0, JSON.stringify(done));
    assert.match(done.output, /65534/);
    assert.equal(readFileSync(join(f.root, "note.txt"), "utf8"), "original");
    assert.equal(done.result.proposals.length, 2);
    const a = f.service.get(f.id).approvals.find((a) => a.path === "note.txt");
    f.service.decide(f.id, a.id, {
      revision: f.service.get(f.id).revision,
      decision: "approve",
    });
    assert.equal(readFileSync(join(f.root, "note.txt"), "utf8"), "revised\n");
    const interactive = await f.tool("terminal_start", {
      command: 'read value; printf "INPUT:%s\\n" "$value"',
    });
    await f.tool("terminal_write", { id: interactive.id, input: "hello\n" });
    const inputDone = await f.service.extensions.runner.get(
      f.id,
      interactive.id,
    ).done;
    assert.match(inputDone.output, /INPUT:hello/);
    const slow = await f.tool("terminal_start", { command: "sleep 100" });
    await f.tool("terminal_stop", { id: slow.id });
    assert.equal(
      (await f.service.extensions.runner.get(f.id, slow.id).done).status,
      "cancelled",
    );
    assert.throws(
      () => f.service.extensions.runner.read("another-workspace", s.id),
      (e) => e.code === "PROCESS_NOT_FOUND",
    );
    const network = await f.tool("terminal_start", {
      command: `node -e 'const s=require("net").createConnection({host:"1.1.1.1",port:443});s.on("connect",()=>process.exit(10));s.on("error",()=>console.log("NETWORK_BLOCKED"));setTimeout(()=>{s.destroy();console.log("NETWORK_BLOCKED")},1000).unref()'`,
    });
    const isolated = await f.service.extensions.runner.get(f.id, network.id)
      .done;
    assert.equal(isolated.exitCode, 0);
    assert.match(isolated.output, /NETWORK_BLOCKED/);
    const runner = new ProcessRunner();
    const args = runner.args({
      image: runner.image(realDocker),
      command: ["sh"],
      mounts: [],
    }).args;
    assert.ok(args.includes("--network=none"));
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--memory=256m"));
  },
);

test(
  "real stdio MCP handshake, discovery, schema, tool grants, resources and plugin teardown",
  { skip: !realDocker },
  async (t) => {
    const f = setup(t);
    await f.configure({ plugins: true, mcp: true, image: realDocker });
    const source = resolve("examples/plugins/local-tools"),
      inspection = await f.manage({ action: "inspect-plugin", path: source });
    await f.manage({
      action: "install-plugin",
      path: source,
      hash: inspection.hash,
      consent: true,
    });
    await f.manage({
      action: "plugin-state",
      pluginId: "local-tools",
      enabled: true,
      allowedSkills: [],
      allowedCommands: [],
    });
    await f.manage({
      action: "save-mcp",
      consent: true,
      server: {
        id: "calculator",
        transport: "stdio",
        pluginId: "local-tools",
        entryId: "tools",
        allowedTools: ["sum_numbers"],
        allowResources: true,
      },
    });
    const connected = await f.manage({
      action: "connect-mcp",
      serverId: "calculator",
    });
    assert.equal(connected.tools[0].name, "sum_numbers");
    assert.equal(
      (
        await f.tool("mcp_call", {
          serverId: "calculator",
          tool: "sum_numbers",
          argumentsJson: '{"values":[2,5]}',
        })
      ).content[0].text,
      "7",
    );
    await assert.rejects(
      f.tool("mcp_call", {
        serverId: "calculator",
        tool: "sum_numbers",
        argumentsJson: '{"values":["bad"]}',
      }),
      (e) => e.code === "MCP_ARGUMENTS",
    );
    await assert.rejects(
      f.tool("mcp_call", {
        serverId: "calculator",
        tool: "delete_everything",
        argumentsJson: "{}",
      }),
      (e) => e.code === "MCP_TOOL_DENIED",
    );
    assert.equal(
      (
        await f.tool("mcp_resource", {
          serverId: "calculator",
          action: "read",
          argumentsJson: '{"uri":"example://about"}',
        })
      ).contents[0].text,
      "Offline MCP sample",
    );
    await f.manage({
      action: "plugin-state",
      pluginId: "local-tools",
      enabled: false,
      allowedSkills: [],
      allowedCommands: [],
    });
    assert.equal(f.service.extensions.mcp.connections.size, 0);
  },
);

test("offline LSA retrieves a related document without exact query-word overlap", () => {
  const scores = latentSearch(
    [
      "car automobile engine highway",
      "automobile road driver",
      "banana fruit orchard",
      "apple fruit orchard",
    ],
    "car",
  );
  assert.ok(scores[1] > 0.5);
  assert.ok(scores[1] > scores[2]);
});

test("sandbox never permits writable host mounts", () => {
  assert.throws(
    () =>
      new ProcessRunner().args({
        image: "sha256:" + "a".repeat(64),
        command: ["sh"],
        mounts: [{ source: "/tmp", target: "/work", readonly: false }],
      }),
    (e) => e.code === "SANDBOX_MOUNT",
  );
});
