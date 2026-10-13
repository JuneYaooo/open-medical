import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PaddleLocal } from "../server/core/paddle-local.mjs";
import { fixture } from "./helpers.mjs";

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "paddle-local-"));
  t.after(() => {
    try { rmSyncDir(dir); } catch {}
  });
  return dir;
};
import { rmSync } from "node:fs";
const rmSyncDir = (dir) => rmSync(dir, { recursive: true, force: true });

const makeVenv = (dir) => {
  const python = venvPython(dir);
  mkdirSync(join(python, ".."), { recursive: true });
  writeFileSync(python, "#!/bin/sh\necho fake\n", { mode: 0o755 });
};

// 没装 Python（或版本不支持）是最常见的失败形态：必须给可执行的指引，
// 且不能悄悄装系统级软件，也不能留下「已安装」的假状态。
test("install without python fails with actionable message and persists the reason", async (t) => {
  const dir = scratch(t);
  const engine = new PaddleLocal({
    dataDir: dir,
    pythonLocator: async () => null,
  });
  await assert.rejects(
    () => engine.startInstall(),
    (error) => error.code === "OCR_LOCAL_PYTHON" && error.message.includes("3.9–3.12"),
  );
  const status = engine.status();
  assert.equal(status.installed, false);
  assert.match(status.error, /Python/);
  assert.match(readFileSync(join(dir, "paddle-ocr", "install.json"), "utf-8"), /lastError/);
});

// 装不上不算错误状态：partial 标记 + 上次原因可查；重试入口保持可用。
test("failed pip install reports mirror exhaustion with pip tail", async (t) => {
  const dir = scratch(t);
  const engine = new PaddleLocal({
    dataDir: dir,
    pythonLocator: async () => [{ cmd: "py", args: [], version: "3.11.8" }],
    runner: async (spec) => {
      if (spec.args.includes("venv")) makeVenv(dir);
      if (spec.args.includes("pip"))
        throw new Error("Collecting paddleocr==2.7.3\nWARNING: Retrying\nERROR: Could not find a version that satisfies the requirement");
      return { stdout: "ok", stderr: "" };
    },
  });
  await assert.rejects(
    () => engine.startInstall(),
    (error) => error.code === "OCR_LOCAL_PIP" && /清华|镜像|网络波动/.test(error.message),
  );
  const manifest = JSON.parse(readFileSync(join(dir, "paddle-ocr", "install.json"), "utf-8"));
  assert.equal(manifest.ready, undefined);
  assert.match(manifest.lastError, /依赖安装失败/);
  assert.equal(engine.status().installed, false);
});

function venvPython(dir) {
  return process.platform === "win32"
    ? join(dir, "paddle-ocr", "venv", "Scripts", "python.exe")
    : join(dir, "paddle-ocr", "venv", "bin", "python");
}

// 快乐路径：定位 Python → venv → pip → 写 worker → 启动健康检查通过，
// 全程不碰真实网络与真实 Python。
test("install succeeds end to end with fake runner and starts worker", async (t) => {
  const dir = scratch(t);
  const spawned = [];
  const engine = new PaddleLocal({
    dataDir: dir,
    pythonLocator: async () => [{ cmd: "py", args: [], version: "3.11.8" }],
    runner: async (spec) => {
      if (spec.args.includes("venv")) makeVenv(dir);
      return { stdout: "ok", stderr: "" };
    },
    healthCheck: async () => spawned.length > 0, // 启动前的探测视为未就绪
    spawner: () => {
      const child = new EventEmitter();
      child.killed = false;
      child.kill = () => { child.killed = true; };
      child.stderr = new EventEmitter();
      spawned.push(child);
      return child;
    },
  });
  const status = await engine.startInstall();
  assert.equal(status.installed, true);
  assert.ok(status.baseUrl?.startsWith("http://127.0.0.1:"));
  assert.ok(existsSync(engine.workerPath()));
  const manifest = JSON.parse(readFileSync(join(dir, "paddle-ocr", "install.json"), "utf-8"));
  assert.equal(manifest.ready, true);
  assert.equal(manifest.python.version, "3.11.8");
  assert.equal(engine.status().running, true);
  assert.equal(spawned.length, 1);

  // 重启接续：同 URL 且服务配置指向本机时收养/拉起；指向别处则不动。
  const resumed = new PaddleLocal({
    dataDir: dir,
    healthCheck: async () => true,
    spawner: () => { throw new Error("不应重复拉起"); },
  });
  assert.equal(await resumed.resume({ wantsService: () => false }), false);
  assert.equal(await resumed.resume({ wantsService: () => true }), true);
});

// 启动后健康检查一直不过：进程要被杀掉，报错带 stderr 尾巴。
test("start failure kills the worker and surfaces stderr tail", async (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, "paddle-ocr", "venv", process.platform === "win32" ? "Scripts" : "bin"), { recursive: true });
  writeFileSync(venvPython(dir), "#!/bin/sh\necho fake\n", { mode: 0o755 });
  writeFileSync(join(dir, "paddle-ocr", "install.json"), JSON.stringify({ ready: true, port: 18095 }), "utf-8");
  const killed = [];
  const engine = new PaddleLocal({
    dataDir: dir,
    healthTimeoutMs: 3000,
    healthCheck: async () => false,
    spawner: () => {
      const child = new EventEmitter();
      child.killed = false;
      child.kill = () => { child.killed = true; killed.push(1); };
      child.stderr = new EventEmitter();
      setImmediate(() => child.stderr.emit("data", Buffer.from("ModuleNotFoundError: No module named 'paddleocr'")));
      return child;
    },
  });
  await assert.rejects(
    () => engine.startWorker(18095),
    (error) => error.code === "OCR_LOCAL_START" && /paddleocr/.test(error.message),
  );
  assert.equal(killed.length, 1);
  assert.equal(engine.status().running, false);
});

// HTTP 面：状态可读、安装入口存在；注入「没有 Python」的引擎后安装以
// 可读错误收场，不会把服务端拖死。
test("local engine routes expose status and install without blocking", async (t) => {
  const dir = scratch(t);
  const f = await fixture(t, {
    paddleLocal: new PaddleLocal({ dataDir: dir, pythonLocator: async () => null }),
  });
  const boot = (await f.json("/api/bootstrap")).data;
  void boot;
  const status = (await f.json("/api/ocr-settings/local-engine")).data;
  assert.equal(status.installed, false);
  assert.ok(Array.isArray(status.packages) && status.packages.length >= 2);

  const kicked = await f.json("/api/ocr-settings/local-engine/install", "POST");
  assert.equal(kicked.status, 202);
  // 安装是后台任务：立刻再查状态应能拿到失败原因（缺 Python 秒失败）。
  for (let i = 0; i < 50; i++) {
    const s = (await f.json("/api/ocr-settings/local-engine")).data;
    if (s.error) {
      assert.match(s.error, /Python/);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("install should settle with an error quickly");
});
