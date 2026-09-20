import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/agent.mjs";
import { ProcessRunner } from "../server/core/process-runner.mjs";
import { fixture } from "./helpers.mjs";

// W6 能力分层快照：已授权（权限引擎）/ 环境就绪（容器后端等运行事实）/
// 当前可执行三态与不可用原因。复用 ProcessRunner.status 的 Docker daemon
// 探测语义（0.9.7 起区分 docker-down 与 missing image）；此处用可注入的
// runner 桩固定 daemon 状态，保证断言确定性。

class StubRunner extends ProcessRunner {
  constructor(status) {
    super({ docker: "docker" });
    this.stubStatus = status;
  }
  status() {
    return this.stubStatus;
  }
}

const dockerDown = new StubRunner({
  available: false,
  backend: "docker-linux",
  host: process.platform,
  reason:
    "请安装并启动 Docker（Linux 容器模式），导入离线运行时镜像。不会退回宿主机执行。",
});
const dockerUp = new StubRunner({
  available: true,
  backend: "docker-linux",
  host: process.platform,
  network: false,
  hostFilesystem: false,
});

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

test("snapshot separates authorized from environment-ready (docker daemon down)", async (t) => {
  const f = await setup(t, dockerDown);
  // Arrange: grant the container-execution permission the way the extensions
  // configuration would, without depending on a real daemon for the grant.
  f.server.workspaces.store.update(f.id, (w) => {
    w.permissions.grants["process.spawn"] = true;
  });

  const snapshot = await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  assert.equal(snapshot.status, 200);
  const byName = Object.fromEntries(
    snapshot.data.tools.map((tool) => [tool.name, tool]),
  );

  // Authorized AND ready → executable.
  assert.equal(byName.read_file.authorized, true);
  assert.equal(byName.read_file.ready, true);
  assert.equal(byName.read_file.executable, true);
  assert.equal(byName.read_file.reason, undefined);

  // Container tools: authorized but environment not ready, with reason and
  // remedy — this is the docker-down fact the snapshot must surface.
  for (const name of [
    "terminal_start",
    "terminal_run",
    "terminal_wait",
    "document_create",
    "document_read",
    "document_render",
  ]) {
    assert.ok(byName[name], `缺少工具 ${name}`);
    assert.equal(byName[name].authorized, true, name);
    assert.equal(byName[name].ready, false, name);
    assert.equal(byName[name].executable, false, name);
    assert.match(byName[name].reason, /Docker/);
    assert.ok(byName[name].remedy.length > 5, name);
  }

  // code_execute shares the process.spawn permission but orchestrates tools
  // in the in-process Node sandbox: it is not gated on the container backend.
  assert.equal(byName.code_execute.permission, "process.spawn");
  assert.equal(byName.code_execute.ready, true);
  assert.equal(byName.code_execute.executable, true);

  // Environment facts + counts stay internally consistent.
  assert.equal(snapshot.data.environment.container.available, false);
  assert.match(snapshot.data.environment.container.reason, /Docker/);
  assert.equal(snapshot.data.counts.total, snapshot.data.tools.length);
  assert.equal(
    snapshot.data.counts.executable,
    snapshot.data.tools.filter((tool) => tool.executable).length,
  );
  assert.ok(snapshot.data.counts.executable < snapshot.data.counts.authorized);
});

test("container tools become executable once the backend is ready", async (t) => {
  const f = await setup(t, dockerUp);
  f.server.workspaces.store.update(f.id, (w) => {
    w.permissions.grants["process.spawn"] = true;
  });
  const { data } = await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  const terminal = data.tools.find((tool) => tool.name === "terminal_start");
  assert.equal(terminal.authorized, true);
  assert.equal(terminal.ready, true);
  assert.equal(terminal.executable, true);
  assert.equal(data.environment.container.available, true);
});

test("unauthorized tools report the missing permission, not the environment", async (t) => {
  const f = await setup(t, dockerUp);
  const { data } = await f.json(`/api/workspaces/${f.id}/capability-snapshot`);
  const terminal = data.tools.find((tool) => tool.name === "terminal_start");
  assert.equal(terminal.authorized, false);
  assert.equal(terminal.executable, false);
  assert.match(terminal.reason, /process\.spawn/);
  assert.ok(terminal.remedy);
});

test("snapshot mirrors the on-demand medical layer state", async (t) => {
  const f = await setup(t, dockerUp);
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
  const session = (
    await f.json("/api/sessions", "POST", { title: "医疗会话" })
  ).data;
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
