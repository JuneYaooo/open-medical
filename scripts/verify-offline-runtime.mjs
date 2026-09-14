// Run inside a fresh Linux container with --network=none, using packaged resources only.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
const root = process.env.OFFLINE_APP_ROOT || "/package";
const { createServer } = await import(
  pathToFileURL(join(root, "server/agent.mjs"))
);
const dir = mkdtempSync(join(tmpdir(), "offline-acceptance-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace);
writeFileSync(join(workspace, "note.txt"), "离线工作区：病历整理与研究资料");
const server = createServer({
  database: join(dir, "agent.sqlite"),
  allowedOrigins: [],
});
try {
  assert.ok(
    Object.values(networkInterfaces())
      .flat()
      .every((i) => i.internal),
    "Non-loopback interface exists",
  );
  const blocked = await new Promise((resolve) => {
    const socket = createConnection({ host: "1.1.1.1", port: 443 });
    socket.setTimeout(1500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(true);
    });
  });
  assert.equal(blocked, true);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await (await fetch(origin + "/api/bootstrap")).json();
  const request = async (path, method = "GET", body) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-medical-token": bootstrap.token,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };
  const w = await request("/api/workspaces", "POST", {
      root: workspace,
      title: "断网验收",
      directoryConsent: true,
    }),
    base = "/api/workspaces/" + w.id;
  await request(base + "/extensions", "POST", {
    action: "configure",
    revision: w.revision,
    consent: true,
    terminal: false,
    browser: false,
    plugins: true,
    mcp: false,
    memoryRead: true,
    memoryWrite: true,
    origins: [],
    memory: { provider: "lsa" },
  });
  const tool = (tool, args = {}) =>
    request(base + "/tools", "POST", { tool, arguments: args });
  assert.match(
    (await tool("read_file", { path: "note.txt" })).text,
    /离线工作区/,
  );
  await tool("memory_add", { path: "note.txt" });
  assert.ok(
    (await tool("memory_search", { query: "病历整理" })).results.length,
  );
  const inspection = await request(base + "/extensions", "POST", {
    action: "inspect-plugin",
    path: join(root, "examples/plugins/local-tools"),
  });
  await request(base + "/extensions", "POST", {
    action: "install-plugin",
    path: join(root, "examples/plugins/local-tools"),
    hash: inspection.hash,
    consent: true,
    revision: (await request(base)).revision,
  });
  const status = await request(base + "/extensions");
  assert.equal(status.config.plugins.length, 1);
  assert.equal(status.sandbox.available, false);
  assert.ok((await fetch(origin)).ok);
  const cli = spawnSync(
    process.execPath,
    [
      join(root, "scripts/workspace-cli.mjs"),
      "list",
      "--database=" + join(dir, "cli.sqlite"),
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), []);
  console.log(
    JSON.stringify({
      passed: true,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      network: "none",
      freshDatabase: true,
      packagedDependencies: true,
      fileRead: true,
      offlineMemory: true,
      offlinePluginInstall: true,
      missingSandboxFailsClosed: true,
      offlineCLI: true,
      desktopInstallTested: false,
    }),
  );
} finally {
  await server.shutdown();
  rmSync(dir, { recursive: true, force: true });
}
