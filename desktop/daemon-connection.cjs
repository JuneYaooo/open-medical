const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
async function discover(directory, fetcher = fetch) {
  let record;
  try {
    record = JSON.parse(readFileSync(join(directory, "daemon.json"), "utf8"));
  } catch {
    return null;
  }
  if (
    !Number.isInteger(record.port) ||
    record.port < 1024 ||
    record.port > 65535 ||
    typeof record.instanceId !== "string"
  )
    return null;
  const origin = `http://127.0.0.1:${record.port}`;
  try {
    const response = await fetcher(origin + "/api/bootstrap", {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    const config = await response.json();
    if (
      response.ok &&
      config.engine === "generic-runtime" &&
      config.instanceId === record.instanceId
    )
      return { origin, config };
  } catch {}
  return null;
}
async function connect({ directory, root, executable = process.execPath }) {
  const existing = await discover(directory);
  if (existing) return existing;
  try {
    const response = await fetch("http://127.0.0.1:8788/api/bootstrap", {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    const config = await response.json();
    const key = createHash("sha256")
      .update(resolve(directory, "platform.sqlite"))
      .digest("hex");
    if (
      response.ok &&
      config.engine === "generic-runtime" &&
      config.runtimeKey === key
    )
      return { origin: "http://127.0.0.1:8788", config };
  } catch {}
  await promisify(execFile)(
    executable,
    [join(root, "scripts/agent-daemon.mjs"), "start", "--directory", directory],
    {
      cwd: root,
      timeout: 20000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        AGENT_SKIP_ENV_FILE: "1",
      },
      windowsHide: true,
      maxBuffer: 10000,
    },
  );
  const started = await discover(directory);
  if (!started)
    throw new Error(
      "后台服务未能启动，请检查 ~/.open-medical-workbench/supervisor.log",
    );
  return started;
}
module.exports = { discover, connect };
