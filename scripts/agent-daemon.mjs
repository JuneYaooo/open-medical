import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createServer } from "node:net";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    directory: { type: "string" },
    port: { type: "string", default: "8788" },
  },
});
const directory = resolve(
  values.directory || join(homedir(), ".open-medical-workbench"),
);
const file = join(directory, "daemon.json"),
  command = positionals[0] || "status";
mkdirSync(directory, { recursive: true, mode: 0o700 });
async function probe(record) {
  if (
    !record ||
    !Number.isInteger(record.port) ||
    record.port < 1024 ||
    record.port > 65535
  )
    return false;
  try {
    const response = await fetch(
      `http://127.0.0.1:${record.port}/api/bootstrap`,
      { signal: AbortSignal.timeout(1000), redirect: "error" },
    );
    const result = await response.json();
    return (
      result.engine === "generic-runtime" &&
      result.instanceId === record.instanceId
    );
  } catch {
    return false;
  }
}
let record = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
let operationLock;
try {
  if (["start", "stop"].includes(command)) {
    const lock = join(directory, "daemon-operation.lock");
    try {
      const old = JSON.parse(readFileSync(lock, "utf8"));
      if (Number.isSafeInteger(old.pid) && old.pid > 0) {
        try { process.kill(old.pid, 0); }
        catch (error) { if (error.code === "ESRCH") unlinkSync(lock); }
      }
    } catch {}
    const fd = openSync(lock, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    closeSync(fd);
    operationLock = lock;
    record = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }
  const running = await probe(record);
  let supervisor;
  try {
    const saved = JSON.parse(readFileSync(join(directory, "supervisor.json"), "utf8"));
    if (saved.instanceId === record?.instanceId) supervisor = saved;
  } catch {}
  if (command === "status")
    console.log(
      JSON.stringify({
        running,
        ...(record ? { pid: record.pid, port: record.port, directory } : {}),
        ...(supervisor ? { supervisor } : {}),
      }),
    );
  else if (command === "stop") {
    if (!running && (!supervisor || ["stopped", "failed"].includes(supervisor.status)))
      throw new Error("没有匹配的运行实例；不会终止未知 PID");
    if (supervisor) {
      writeFileSync(join(directory, "daemon-stop.json"), JSON.stringify({ instanceId: record.instanceId }), { mode: 0o600 });
      for (let i = 0; i < 150; i++) {
        const saved = JSON.parse(readFileSync(join(directory, "supervisor.json"), "utf8"));
        if (saved.instanceId === record.instanceId && saved.status === "stopped") break;
        await delay(100);
        if (i === 149) throw new Error("后台守护进程未确认停止，请查看 supervisor.json");
      }
    } else process.kill(record.pid, "SIGTERM");
    for (let i = 0; i < 50 && (await probe(record)); i++) await delay(100);
    if (await probe(record)) throw new Error("服务仍在停止中，请稍后检查");
    unlinkSync(file);
    console.log("后台服务已停止，执行检查点已保留。");
  } else if (command === "start") {
    if (running) {
      console.log(JSON.stringify({ running: true, port: record.port }));
    } else {
      if (supervisor && !["stopped", "failed"].includes(supervisor.status)) {
        let alive = true;
        try { process.kill(supervisor.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
        if (alive) throw new Error("后台守护进程仍在启动或恢复中，请查看 status，不会创建重复实例");
      }
      const preferred = Number(values.port);
      if (!Number.isInteger(preferred) || preferred < 1024 || preferred > 65535)
        throw new Error("Invalid port");
      // If the preferred port is held by an unrelated service, fall back to an
      // ephemeral port instead of letting the runtime crash-loop on EADDRINUSE.
      const port = await new Promise((resolve) => {
        const probe = createServer();
        probe.once("error", () => {
          const random = createServer();
          random.listen(0, "127.0.0.1", () => {
            const { port: free } = random.address();
            random.close(() => resolve(free));
          });
        });
        probe.listen(preferred, "127.0.0.1", () =>
          probe.close(() => resolve(preferred)),
        );
      });
      const instanceId = randomUUID(),
        log = openSync(join(directory, "supervisor.log"), "a", 0o600);
      const child = spawn(
        process.execPath,
        [resolve(import.meta.dirname, "daemon-supervisor.mjs")],
        {
          cwd: resolve(import.meta.dirname, ".."),
          detached: true,
          stdio: ["ignore", log, log],
          env: {
            ...process.env,
            AGENT_PORT: String(port),
            AGENT_DATABASE: join(directory, "platform.sqlite"),
            AGENT_INSTANCE_ID: instanceId,
            AGENT_DAEMON_DIRECTORY: directory,
          },
          windowsHide: true,
        },
      );
      closeSync(log);
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      record = { pid: child.pid, port, instanceId };
      writeFileSync(file + ".tmp", JSON.stringify(record), { mode: 0o600 });
      renameSync(file + ".tmp", file);
      for (let i = 0; i < 50 && !(await probe(record)); i++) await delay(100);
      if (!(await probe(record)))
        throw new Error("后台启动未确认，请查看目录中的 daemon.log");
      console.log(
        `后台 Agent 已运行：http://127.0.0.1:${port}（关闭终端或桌面窗口后继续；系统关机后需重新启动）`,
      );
    }
  } else
    throw new Error(
      "用法：npm run daemon -- start|stop|status [--directory=路径] [--port=8788]",
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (operationLock) unlinkSync(operationLock);
}
