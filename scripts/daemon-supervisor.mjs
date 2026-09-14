import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, renameSync, appendFileSync, existsSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const directory = process.env.AGENT_DAEMON_DIRECTORY;
if (!directory || !process.env.AGENT_INSTANCE_ID) throw new Error("Launch through agent-daemon.mjs");
const statePath = join(directory, "supervisor.json"), log = join(directory, "daemon.log");
const state = { instanceId: process.env.AGENT_INSTANCE_ID, pid: process.pid, restarts: 0, status: "starting" };
let child, stopping = false, restartTimer, killTimer, healthTimer, checking = false, unhealthy = 0;
const failures = [];
function save(extra) {
  Object.assign(state, extra, { updatedAt: Date.now() });
  const temp = statePath + ".tmp";
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, statePath);
}
function output(data) {
  if (existsSync(log) && statSync(log).size + data.length > 2_000_000) {
    rmSync(log + ".3", { force: true });
    for (let n = 2; n >= 1; n--)
      if (existsSync(log + "." + n)) renameSync(log + "." + n, log + "." + (n + 1));
    renameSync(log, log + ".1");
  }
  appendFileSync(log, data, { mode: 0o600 });
}
function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  clearInterval(healthTimer);
  clearInterval(controlTimer);
  save({ status: "stopping" });
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child?.kill("SIGKILL"), 10000);
  } else save({ status: "stopped", serverPid: null });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
function launch() {
  if (stopping) return;
  unhealthy = 0;
  child = spawn(process.execPath, [resolve(import.meta.dirname, "../server/platform.mjs")], {
    cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: process.env, windowsHide: true,
  });
  const current = child;
  save({ status: "starting", serverPid: child.pid });
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  child.on("error", (error) => output(Buffer.from("Supervisor spawn failure: " + error.code + "\n")));
  child.once("close", (code, signal) => {
    clearTimeout(killTimer);
    if (stopping) { save({ status: "stopped", serverPid: null }); return; }
    const now = Date.now();
    failures.push(now);
    while (failures[0] < now - 300000) failures.shift();
    if (failures.length >= 5) {
      clearInterval(healthTimer);
      clearInterval(controlTimer);
      save({ status: "failed", serverPid: null, error: "服务在五分钟内退出五次，停止自动重启", code, signal });
      process.exitCode = 1;
      return;
    }
    save({ status: "restarting", serverPid: null, restarts: state.restarts + 1, code, signal });
    restartTimer = setTimeout(launch, Math.min(30000, 250 * 2 ** (failures.length - 1)));
  });
  // Probe is owned by this supervisor, so an unrelated listener is never killed.
  current.startedAt = Date.now();
}
healthTimer = setInterval(async () => {
  const target = child;
  if (stopping || checking || !target || target.exitCode !== null || target.signalCode !== null) return;
  checking = true;
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.AGENT_PORT}/api/bootstrap`, {
      signal: AbortSignal.timeout(2000), redirect: "error",
    });
    const data = await response.json();
    if (!response.ok || data.instanceId !== state.instanceId) throw new Error("Instance unavailable");
    unhealthy = 0;
    if (state.status !== "running") save({ status: "running" });
  } catch {
    if (Date.now() - target.startedAt > 15000 && ++unhealthy >= 3 && child === target) target.kill("SIGKILL");
  } finally { checking = false; }
}, 5000);
const controlTimer = setInterval(() => {
  try {
    const request = JSON.parse(readFileSync(join(directory, "daemon-stop.json"), "utf8"));
    if (request.instanceId === state.instanceId) stop();
  } catch {}
}, 250);
launch();
