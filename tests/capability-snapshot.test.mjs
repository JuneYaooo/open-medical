import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/agent.mjs";
import { ProcessRunner } from "../server/core/process-runner.mjs";
import { PermissionEngine } from "../server/core/permissions.mjs";
import { AppError } from "../server/errors.mjs";
import { fixture } from "./helpers.mjs";

// B1/B1-R1 能力分层快照：已授权（权限引擎）/ 环境就绪（daemon + 配置镜像
// 存在）/ 当前可执行三态与稳定原因码。真实依赖判定在 core/capability.mjs：
// 「新启动容器进程」的工具（terminal 启动、document、archive、code_execute——
// 其编排程序同样由 runner.start 在工作区镜像内运行）依赖 daemon 与镜像；
// 会话控制工具（terminal_read/wait/write/stop）作用于已存在会话，不依赖
// daemon，后端故障后仍可访问已完成结果。此处用可注入的 runner 桩固定
// daemon 与镜像状态，保证断言确定性；绝不安装或启动 Docker。
// 探测按工作区短缓存（配置身份=镜像引用 + TTL），配置变化换键失效、
// 依赖恢复用 invalidate 显式刷新，不依赖真实时钟。

const DOCKER_DOWN_REASON =
  "请安装并启动 Docker（Linux 容器模式），导入离线运行时镜像。不会退回宿主机执行。";
const IMAGE = "open-medical-runtime:0.8-full";

// 与真实 ProcessRunner 相同的错误语义：daemon 未运行 → SANDBOX_BACKEND，
// daemon 正常但镜像未导入 → SANDBOX_IMAGE。
class StubRunner extends ProcessRunner {
  constructor() {
    super({ docker: "docker" });
    this.state = { daemonUp: false, imagePresent: false };
    this.statusCalls = 0;
    this.imageCalls = 0;
  }
  status() {
    this.statusCalls++;
    return this.state.daemonUp
      ? {
          available: true,
          backend: "docker-linux",
          host: process.platform,
          network: false,
          hostFilesystem: false,
        }
      : {
          available: false,
          backend: "docker-linux",
          host: process.platform,
          reason: DOCKER_DOWN_REASON,
        };
  }
  image(_reference) {
    this.imageCalls++;
    if (!this.state.daemonUp)
      throw new AppError(
        "SANDBOX_BACKEND",
        "Docker 未运行或未提供 Linux 容器后端：请先启动 Docker（macOS 可执行 colima start）再重试；不会回退宿主机执行",
        412,
      );
    if (!this.state.imagePresent)
      throw new AppError(
        "SANDBOX_IMAGE",
        "本地镜像不存在，请先离线导入；不会自动下载",
        412,
      );
    return "sha256:" + "a".repeat(64);
  }
  // 会话控制测试不经过真实 docker CLI：stop 只标记取消并杀掉桩子进程
  // （真实实现里 docker rm -f 是尽力而为的清理，失败被吞掉）。
  stop(owner, id) {
    const s = this.get(owner, id);
    if (s.status === "running") {
      s.status = "cancelled";
      s.child?.kill?.();
    }
    return this.read(owner, id);
  }
}

const fakeChild = () => {
  const child = {
    stdin: { write() {}, end() {}, on() {} },
    killed: false,
    kill() {
      child.killed = true;
    },
  };
  return child;
};

// 直接种内会话，模拟 daemon 故障前留下的已完成/运行中终端。运行中会话
// 的 done 可经 resolveDone 解扣，避免 shutdown 在 runner.close 上悬挂。
function seedSession(
  f,
  { id, runId = "run-1", status = "completed", output = "" },
) {
  const runner = f.server.workspaces.extensions.runner;
  const session = {
    id,
    owner: f.id,
    runId,
    name: "omw-stub-" + id,
    child: fakeChild(),
    status,
    output,
    offset: 0,
    startedAt: Date.now(),
    exitCode: status === "completed" ? 0 : null,
  };
  if (status === "completed") session.done = Promise.resolve();
  else
    session.done = new Promise((resolve) => {
      session.resolveDone = resolve;
    });
  runner.sessions.set(id, session);
  return session;
}

// 直改存储：快照测的是运行事实判定，不依赖扩展配置入口的表单校验。
// configureImage 变换镜像引用 → 探测缓存换键失效（配置身份契约）。
function grantSpawn(f) {
  f.server.workspaces.store.update(f.id, (w) => {
    w.permissions.grants["process.spawn"] = true;
  });
}

function configureImage(f, reference = IMAGE) {
  f.server.workspaces.store.update(f.id, (w) => {
    w.extensions = {
      plugins: [],
      mcpServers: [],
      origins: [],
      memory: { provider: "lsa" },
      image: reference,
    };
  });
}

const byName = (snapshot) =>
  Object.fromEntries(snapshot.data.tools.map((tool) => [tool.name, tool]));

async function setup(t, runner) {
  const dir = mkdtempSync(join(tmpdir(), "omw-capability-"));
  // Cleanup ordering: shut the server down (sockets + sqlite) before rmSync,
  // otherwise Windows EPERM keeps the test process alive.
  const server = createServer({
    database: ":memory:",
    apiKey: "",
    ...(runner ? { extensions: { runner } } : {}),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Registration order matters: shutdown closes sockets/sqlite/vector dirs
  // first, rmSync runs after it — the reverse order EPERMs on Windows.
  t.after(() => server.shutdown());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const json = async (path, method = "GET", data) => {
    const r = await fetch(origin + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-medical-token": server.token,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  const created = await json("/api/workspaces", "POST", {
    title: "快照工作区",
    root: dir,
    directoryConsent: true,
  });
  assert.equal(created.status, 201);
  return { server, json, id: created.data.id, dir };
}

// 模型可调用列表：registry.definitions 经 readinessFilter 过滤后的口径。
function modelToolNames(f) {
  const w = f.server.workspaces.store.get(f.id);
  return f.server.workspaces
    .registry(f.id, "manual", { allowDelegate: true })
    .definitions(new PermissionEngine(w.permissions))
    .map((d) => d.function.name)
    .sort();
}

test("bootstrap declares the explicit capabilities contract (medical app)", async (t) => {
  const f = await fixture(t);
  const boot = (await f.json("/api/bootstrap")).data;
  assert.deepEqual(boot.capabilities, {
    workspaces: true,
    modelSettings: true,
    medical: true,
  });
  // Legacy fallback stays for old clients.
  assert.equal(boot.patientsEnabled, true);
});

test("docker down: container tools (incl. code_execute) are authorized but not ready with a stable reason code", async (t) => {
  const f = await setup(t, new StubRunner());
  grantSpawn(f);

  const snapshot = await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  assert.equal(snapshot.status, 200);
  const tools = byName(snapshot);

  // Non-container tools: authorized and ready, no environment dependency.
  assert.equal(tools.read_file.authorized, true);
  assert.equal(tools.read_file.ready, true);
  assert.equal(tools.read_file.executable, true);
  assert.equal(tools.read_file.reasonCode, "OK");

  // Container tools report the docker-down fact — code_execute included:
  // its bridge program runs via runner.start in the workspace image, so the
  // old "in-process sandbox" exclusion was a misjudgement (B1). Session
  // control tools are not in this list: they act on existing sessions
  // (B1-R1, covered below).
  for (const name of [
    "terminal_start",
    "terminal_run",
    "document_create",
    "document_read",
    "document_render",
    "code_execute",
  ]) {
    assert.ok(tools[name], `缺少工具 ${name}`);
    assert.equal(tools[name].authorized, true, name);
    assert.equal(tools[name].ready, false, name);
    assert.equal(tools[name].executable, false, name);
    assert.equal(tools[name].reasonCode, "BACKEND_UNAVAILABLE", name);
    assert.match(tools[name].reason, /Docker/);
    assert.ok(tools[name].remedy.length > 5, name);
  }
  assert.equal(tools.code_execute.permission, "process.spawn");

  // Environment facts: daemon down means the image was never probed.
  assert.equal(snapshot.data.environment.container.available, false);
  assert.match(snapshot.data.environment.container.reason, /Docker/);
  assert.equal(snapshot.data.environment.imagePresent, false);
  assert.equal(snapshot.data.environment.imageChecked, false);

  // Counts stay internally consistent.
  assert.equal(snapshot.data.counts.total, snapshot.data.tools.length);
  assert.equal(
    snapshot.data.counts.executable,
    snapshot.data.tools.filter((tool) => tool.executable).length,
  );
  assert.ok(snapshot.data.counts.executable < snapshot.data.counts.authorized);
});

test("daemon up but image not imported: IMAGE_MISSING with a distinct remedy", async (t) => {
  const runner = new StubRunner();
  runner.state.daemonUp = true;
  const f = await setup(t, runner);
  grantSpawn(f);
  configureImage(f);

  const { data } = await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  const tools = byName({ data });
  const terminal = tools.terminal_start;
  assert.equal(terminal.authorized, true);
  assert.equal(terminal.ready, false);
  assert.equal(terminal.executable, false);
  assert.equal(terminal.reasonCode, "IMAGE_MISSING");
  assert.match(terminal.reason, /镜像/);
  assert.match(terminal.remedy, /导入/);

  // The image fact is now probed (daemon was up) but absent.
  assert.equal(data.environment.container.available, true);
  assert.equal(data.environment.imageChecked, true);
  assert.equal(data.environment.imagePresent, false);
  assert.equal(data.environment.image, IMAGE);

  // Not-ready container tools stay out of the model-visible list, while the
  // snapshot keeps showing them with their tri-state.
  assert.ok(!modelToolNames(f).includes("terminal_start"));
  assert.ok(!modelToolNames(f).includes("code_execute"));
  assert.ok(data.tools.some((tool) => tool.name === "code_execute"));
});

test("configured image present: container tools become executable and enter the model list", async (t) => {
  const runner = new StubRunner();
  runner.state.daemonUp = true;
  runner.state.imagePresent = true;
  const f = await setup(t, runner);
  grantSpawn(f);
  configureImage(f);

  const { data } = await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  const tools = byName({ data });
  for (const name of ["terminal_start", "document_render", "code_execute"]) {
    assert.equal(tools[name].authorized, true, name);
    assert.equal(tools[name].ready, true, name);
    assert.equal(tools[name].executable, true, name);
    assert.equal(tools[name].reasonCode, "OK", name);
  }
  assert.equal(data.environment.imagePresent, true);
  assert.equal(data.environment.container.available, true);

  const model = modelToolNames(f);
  for (const name of ["terminal_start", "code_execute"])
    assert.ok(model.includes(name), `model list should include ${name}`);
});

test("no authorization: PERMISSION_MISSING, independent of environment state", async (t) => {
  const runner = new StubRunner();
  runner.state.daemonUp = true;
  runner.state.imagePresent = true;
  const f = await setup(t, runner);

  const { data } = await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  const tools = byName({ data });
  for (const name of ["terminal_start", "code_execute"]) {
    assert.equal(tools[name].authorized, false, name);
    assert.equal(tools[name].executable, false, name);
    assert.equal(tools[name].reasonCode, "PERMISSION_MISSING", name);
    assert.match(tools[name].reason, /process\.spawn/);
    assert.ok(tools[name].remedy);
  }
});

test("B1-R1: docker down keeps session-control tools ready, executable and model-visible", async (t) => {
  const f = await setup(t, new StubRunner());
  grantSpawn(f);

  const { data } = await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  const tools = byName({ data });
  for (const name of [
    "terminal_read",
    "terminal_wait",
    "terminal_write",
    "terminal_stop",
  ]) {
    assert.equal(tools[name].permission, "process.spawn", name);
    assert.equal(tools[name].ready, true, name);
    assert.equal(tools[name].executable, true, name);
    assert.equal(tools[name].reasonCode, "OK", name);
  }
  // 启动类工具仍然要求后端就绪。
  assert.equal(tools.terminal_start.ready, false);
  assert.equal(tools.code_execute.ready, false);
  // 控制工具在模型列表与通用入口保持可发现——不能隐藏已有结果访问。
  const model = modelToolNames(f);
  for (const name of [
    "terminal_read",
    "terminal_wait",
    "terminal_write",
    "terminal_stop",
  ])
    assert.ok(model.includes(name), `model list should include ${name}`);
  const caps = (await f.json(`/api/workspaces/${f.id}/capabilities`)).data;
  for (const name of ["terminal_read", "terminal_stop"])
    assert.ok(
      caps.tools.some((tool) => tool.name === name),
      name,
    );
});

test("B1-R1: finished session results stay readable/writable-to-wait after backend failure", async (t) => {
  const f = await setup(t, new StubRunner());
  grantSpawn(f);
  seedSession(f, { id: "sess-done", output: "hello from finished run" });
  const perms = new PermissionEngine({
    profile: "standard",
    grants: { "process.spawn": true },
  });
  const registry = f.server.workspaces.registry(f.id, "manual");

  const read = await registry.execute(
    "terminal_read",
    { id: "sess-done" },
    {},
    perms,
  );
  assert.equal(read.status, "completed");
  assert.equal(read.exitCode, 0);
  assert.match(read.output, /hello from finished run/);

  const wait = await registry.execute(
    "terminal_wait",
    { id: "sess-done" },
    {},
    perms,
  );
  assert.equal(wait.status, "completed");
  assert.equal(wait.exitCode, 0);

  // 执行时状态校验保留：不能向已结束会话写入。
  await assert.rejects(
    registry.execute(
      "terminal_write",
      { id: "sess-done", input: "late input" },
      {},
      perms,
    ),
    (e) => e.code === "PROCESS_ENDED",
  );
});

test("B1-R1: a running session stays cancellable while the backend is down", async (t) => {
  const f = await setup(t, new StubRunner());
  grantSpawn(f);
  const session = seedSession(f, { id: "sess-run", status: "running" });
  const perms = new PermissionEngine({
    profile: "standard",
    grants: { "process.spawn": true },
  });
  const stopped = await f.server.workspaces
    .registry(f.id, "manual")
    .execute("terminal_stop", { id: "sess-run" }, {}, perms);
  assert.equal(stopped.status, "cancelled");
  assert.equal(session.child.killed, true);
  // 解扣 done，让 shutdown 的 runner.close 正常收尾。
  session.resolveDone();
});

test("B1-R1: session control rejects foreign owners at execution time", async (t) => {
  const f = await setup(t, new StubRunner());
  grantSpawn(f);
  seedSession(f, { id: "sess-owned", runId: "run-1" });
  const perms = new PermissionEngine({
    profile: "standard",
    grants: { "process.spawn": true },
  });
  await assert.rejects(
    f.server.workspaces
      .registry(f.id, "manual")
      .execute(
        "terminal_read",
        { id: "sess-owned" },
        { agentId: "other-run" },
        perms,
      ),
    (e) => e.code === "AGENT_SCOPE",
  );
});

test("generic capabilities entry matches the model-visible tool list exactly", async (t) => {
  const runner = new StubRunner();
  runner.state.daemonUp = true;
  const f = await setup(t, runner);
  grantSpawn(f);
  configureImage(f);

  const caps = (await f.json(`/api/workspaces/${f.id}/capabilities`)).data;
  assert.deepEqual(
    caps.tools.map((tool) => tool.name).sort(),
    modelToolNames(f),
  );
  // 镜像缺失时容器工具两侧都不可见，通用文件工具两侧都在。
  for (const name of ["terminal_start", "code_execute"]) {
    assert.ok(!caps.tools.some((tool) => tool.name === name), name);
    assert.ok(!modelToolNames(f).includes(name), name);
  }
  assert.ok(caps.tools.some((tool) => tool.name === "read_file"));
  assert.ok(modelToolNames(f).includes("read_file"));
});

test("config change invalidates the probe cache; recovery flips state back", async (t) => {
  const runner = new StubRunner();
  runner.state.daemonUp = true;
  const f = await setup(t, runner);
  grantSpawn(f);

  // 无镜像配置 → IMAGE_NOT_CONFIGURED。
  let snapshot = await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  assert.equal(
    byName(snapshot).code_execute.reasonCode,
    "IMAGE_NOT_CONFIGURED",
  );

  // 配置镜像（镜像引用变化 → 缓存换键）→ 下一份快照反映新事实。
  configureImage(f);
  snapshot = await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  assert.equal(byName(snapshot).code_execute.reasonCode, "IMAGE_MISSING");

  // 依赖恢复（导入镜像）：同一配置下探测结果由 invalidate 驱动刷新。
  runner.state.imagePresent = true;
  f.server.workspaces.probe.invalidate(f.id);
  snapshot = await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  const tools = byName(snapshot);
  assert.equal(tools.code_execute.ready, true);
  assert.equal(tools.code_execute.executable, true);
  assert.equal(tools.terminal_start.executable, true);
});

test("B1-R1: run-state revision bumps do not re-probe; config identity change does", async (t) => {
  const runner = new StubRunner();
  runner.state.daemonUp = true;
  runner.state.imagePresent = true;
  const f = await setup(t, runner);
  grantSpawn(f);

  await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  const afterFirst = runner.statusCalls;
  assert.ok(afterFirst >= 1);

  // 普通运行状态推进 revision（每轮 run 都会发生）→ 不得重复探测。
  f.server.workspaces.store.update(f.id, (w) => {
    w.runs = w.runs || [];
  });
  await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  assert.equal(runner.statusCalls, afterFirst);

  // 配置身份变化（镜像引用）→ 工作区环境换键、重新探测镜像存在性；
  // daemon 状态是进程级缓存（按自身 TTL 刷新），不随工作区键重复探测。
  configureImage(f);
  const imageCallsAfterFirst = runner.imageCalls;
  await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  assert.ok(runner.imageCalls > imageCallsAfterFirst);
  assert.equal(runner.statusCalls, afterFirst);
});

test("snapshot mirrors the on-demand medical layer state", async (t) => {
  const f = await setup(t, new StubRunner());
  assert.equal(
    (await f.json(`/api/workspaces/${f.id}/capability-snapshot`)).data.medical,
    false,
  );
  const enabled = await f.json(`/api/workspaces/${f.id}/domain`, "POST", {
    enabled: true,
    revision: (await f.json(`/api/workspaces/${f.id}`)).data.revision,
  });
  assert.equal(enabled.status, 200);
  const after = (await f.json(`/api/workspaces/${f.id}/capability-snapshot`))
    .data;
  assert.equal(after.medical, true);
  assert.ok(after.tools.some((tool) => tool.name === "knowledge_search"));
  // Session workspaces are medical by construction.
  const session = (await f.json("/api/sessions", "POST", { title: "医疗会话" }))
    .data;
  assert.equal(
    (await f.json(`/api/workspaces/${session.id}/capability-snapshot`)).data
      .medical,
    true,
  );
});

test("newTask on a medical workspace inherits the medical mode flag", async (t) => {
  const f = await setup(t);
  const enabled = await f.json(`/api/workspaces/${f.id}/domain`, "POST", {
    enabled: true,
    revision: (await f.json(`/api/workspaces/${f.id}`)).data.revision,
  });
  assert.equal(enabled.status, 200);
  const task = await f.json(`/api/workspaces/${f.id}/tasks`, "POST", {});
  assert.equal(task.status, 201);
  const snapshot = await f.json(
    `/api/workspaces/${task.data.id}/capability-snapshot`,
  );
  assert.equal(snapshot.data.medical, true);
  // 反向:普通项目的 newTask 不得凭空带医疗层。
  const f2 = await setup(t);
  const task2 = await f2.json(`/api/workspaces/${f2.id}/tasks`, "POST", {});
  assert.equal(task2.status, 201);
  const snapshot2 = await f2.json(
    `/api/workspaces/${task2.data.id}/capability-snapshot`,
  );
  assert.equal(snapshot2.data.medical, false);
});

test("backend metadata, not permission spelling, identifies container dependencies", async (t) => {
  const f = await setup(t, new StubRunner());
  f.server.workspaces.store.update(f.id, (w) => {
    w.permissions.grants["plugins.execute"] = true;
  });
  let tools = byName(
    await f.json(`/api/workspaces/${f.id}/capability-snapshot`),
  );
  assert.equal(tools.plugin_command.authorized, false);
  assert.match(tools.plugin_command.reason, /process.spawn/);
  grantSpawn(f);
  tools = byName(await f.json(`/api/workspaces/${f.id}/capability-snapshot`));
  assert.equal(tools.plugin_command.authorized, true);
  assert.equal(tools.plugin_command.ready, false);
  assert.equal(tools.plugin_command.reasonCode, "BACKEND_UNAVAILABLE");
  assert.ok(!modelToolNames(f).includes("plugin_command"));
});

test("unavailable Python, browser and desktop backends remain visible but not executable", async (t) => {
  const f = await setup(t, new StubRunner());
  f.server.workspaces.sandbox = {
    status: () => ({ available: false, reason: "synthetic sandbox down" }),
  };
  f.server.workspaces.extensions.browser.status = () => ({
    available: false,
    reason: "synthetic browser down",
  });
  f.server.workspaces.store.update(f.id, (w) => {
    w.permissions.grants["sandbox.execute"] = true;
  });
  const tools = byName(
    await f.json(`/api/workspaces/${f.id}/capability-snapshot`),
  );
  for (const name of ["calculate_python", "browser_open", "desktop_control"]) {
    assert.ok(tools[name], name);
    assert.equal(tools[name].ready, false, name);
    assert.equal(tools[name].executable, false, name);
    assert.ok(!modelToolNames(f).includes(name), name);
  }
  f.server.workspaces.sandbox.status = () => ({ available: true });
  assert.ok(modelToolNames(f).includes("calculate_python"));
});

test("explicit invalidation refreshes a recovered daemon, including other cached workspaces", async () => {
  const { CapabilityProbe } = await import("../server/core/capability.mjs");
  const runner = new StubRunner();
  const probe = new CapabilityProbe({ runner, clock: () => 100 });
  assert.equal(probe.environment("a", IMAGE).backend.available, false);
  assert.equal(probe.environment("b", IMAGE).backend.available, false);
  assert.equal(runner.statusCalls, 1);
  runner.state.daemonUp = true;
  runner.state.imagePresent = true;
  probe.invalidate("a");
  assert.equal(probe.environment("a", IMAGE).image.present, true);
  assert.equal(probe.environment("b", IMAGE).image.present, true);
  assert.equal(runner.statusCalls, 2);
});

test("unknown capabilities fail discovery closed; explicit local and custom backend metadata work", async () => {
  const { CapabilityProbe } = await import("../server/core/capability.mjs");
  const { ToolRegistry } = await import("../server/core/tool-registry.mjs");
  const probe = new CapabilityProbe({ runner: new StubRunner() });
  const make = (name, capability, permission = "tools.execute") => ({
    definition: {
      type: "function",
      function: { name, parameters: { type: "object", properties: {} } },
    },
    execute: () => "done",
    capability,
    permission,
  });
  let available = false;
  const registry = new ToolRegistry([
    make("unknown_dependency"),
    make("local_executor", { backend: "local" }, "process.spawn"),
    make("external_executor", {
      backend: "custom",
      check: () => ({ available }),
    }),
    make("container_executor", { backend: "container" }),
  ]);
  const env = probe.environment("a", IMAGE);
  registry.readinessFilter = (tool) => probe.readiness(tool, env).ready;
  assert.equal(
    probe.readiness(registry.get("unknown_dependency"), env).reasonCode,
    "READINESS_UNKNOWN",
  );
  assert.equal(
    probe.readiness(registry.get("container_executor"), env).ready,
    false,
  );
  assert.deepEqual(
    registry.definitions().map((d) => d.function.name),
    ["local_executor"],
  );
  available = true;
  assert.deepEqual(
    registry.definitions().map((d) => d.function.name),
    ["local_executor", "external_executor"],
  );
  registry.get("external_executor").capability.check = () => ({
    available: "true",
  });
  assert.equal(
    probe.readiness(registry.get("external_executor"), env).reasonCode,
    "READINESS_UNKNOWN",
  );
});

test("service discovery and snapshot agree on unknown domain tools and incompatible media connections", async (t) => {
  const f = await setup(t, new StubRunner());
  f.server.workspaces.modelProfiles = {
    list: () => [{ id: "media", provider: "anthropic" }],
  };
  f.server.workspaces.store.update(f.id, (w) => {
    w.teamModels = ["media"];
  });
  f.server.workspaces.domain = {
    ...f.server.workspaces.domain,
    registerTools: ({ registry }) =>
      registry.register({
        permission: "tools.execute",
        definition: {
          type: "function",
          function: {
            name: "unverified_backend",
            parameters: { type: "object", properties: {} },
          },
        },
        execute: () => ({ ok: true }),
      }),
  };
  const tools = byName(
    await f.json(`/api/workspaces/${f.id}/capability-snapshot`),
  );
  assert.equal(tools.unverified_backend.reasonCode, "READINESS_UNKNOWN");
  assert.equal(tools.unverified_backend.ready, false);
  assert.equal(tools.media_generate.ready, false);
  const model = modelToolNames(f);
  assert.ok(!model.includes("unverified_backend"));
  assert.ok(!model.includes("media_generate"));
});

test("backend cache expires without explicit refresh and does not probe once per tool", async () => {
  const { CapabilityProbe } = await import("../server/core/capability.mjs");
  const runner = new StubRunner();
  let now = 0;
  const probe = new CapabilityProbe({ runner, ttlMs: 100, clock: () => now });
  probe.environment("a", IMAGE);
  runner.state.daemonUp = true;
  runner.state.imagePresent = true;
  now = 99;
  assert.equal(probe.environment("a", IMAGE).backend.available, false);
  assert.equal(runner.statusCalls, 1);
  now = 100;
  assert.equal(probe.environment("a", IMAGE).image.present, true);
  assert.equal(runner.statusCalls, 2);
  assert.equal(runner.imageCalls, 1);
});
