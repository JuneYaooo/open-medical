import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, execFileSync } from "node:child_process";
import { dockerEndpoint, recoveryCli, bindInteractiveExecution } from "./container-journal.mjs";
import { createDetachedProcess } from "./detached-process.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { check, AppError } from "../errors.mjs";

// Every process exposed to tools goes through a container. Never fall back to a host shell.
export class ProcessRunner {
  constructor({ journal, docker, limit = 3, drainTimeoutMs = 5000, cleanupTimeoutMs = 2000, finalizationTimeoutMs = 15000, detachedFactory = createDetachedProcess } = {}) {
    this.journal = journal;
    this.detachedFactory = detachedFactory;
    this.drainTimeoutMs = drainTimeoutMs;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.finalizationTimeoutMs = finalizationTimeoutMs;
    this.docker =
      docker ||
      [
        process.env.AGENT_DOCKER_EXECUTABLE,
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      ].find((path) => path && existsSync(path)) ||
      "docker";
    this.limit = limit;
    this.sessions = new Map();
  }
  status() {
    try {
      const platform = execFileSync(
        this.docker,
        ["info", "--format", "{{.OSType}}"],
        {
          timeout: 4000,
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8",
        },
      ).trim();
      check(
        platform === "linux",
        "SANDBOX_BACKEND",
        "需要 Docker Linux 容器后端",
      );
      return {
        available: true,
        backend: "docker-linux",
        host: process.platform,
        network: false,
        hostFilesystem: false,
      };
    } catch {
      return {
        available: false,
        backend: "docker-linux",
        host: process.platform,
        reason:
          "请安装并启动 Docker（Linux 容器模式），导入离线运行时镜像。不会退回宿主机执行。",
      };
    }
  }
  image(reference) {
    check(
      typeof reference === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,200}$/.test(reference),
      "SANDBOX_IMAGE",
      "镜像名称无效",
    );
    try {
      return execFileSync(
        this.docker,
        ["image", "inspect", "--format", "{{.Id}}", reference],
        {
          timeout: 4000,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
    } catch {
      // 「Docker 没在运行」和「镜像没导入」的解法完全不同：先探测 daemon，
      // 避免把 daemon 未启动误报成镜像缺失，引导用户去导入镜像。
      let daemon = null;
      try {
        daemon = execFileSync(
          this.docker,
          ["info", "--format", "{{.OSType}}"],
          {
            timeout: 4000,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
          },
        ).trim();
      } catch {}
      check(
        daemon === "linux",
        "SANDBOX_BACKEND",
        "Docker 未运行或未提供 Linux 容器后端：请先启动 Docker（macOS 可执行 colima start）再重试；不会回退宿主机执行",
        412,
      );
      throw new AppError(
        "SANDBOX_IMAGE",
        "本地镜像不存在，请先离线导入；不会自动下载",
        412,
      );
    }
  }
  args({
    image,
    mounts = [],
    command,
    name = "omw-" + randomUUID(),
    interactive = true,
    resources = "default",
    network = false,
  }) {
    check(
      /^sha256:[a-f0-9]{64}$/.test(image),
      "SANDBOX_IMAGE",
      "必须绑定本地镜像摘要",
    );
    const args = [
      "run",
      "--rm",
      "--pull=never",
      "--name",
      name,
      network ? "--network=bridge" : "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=64",
      resources === "code" ? "--memory=1g" : "--memory=256m",
      resources === "code" ? "--memory-swap=1g" : "--memory-swap=256m",
      "--cpus=1",
      "--user=65534:65534",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
      "--workdir=/work",
      "--env",
      "HOME=/tmp",
    ];
    if (!mounts.some((m) => m.target === "/work"))
      args.push(
        "--tmpfs",
        resources === "code"
          ? "/work:rw,nosuid,nodev,size=256m,mode=1777,uid=65534,gid=65534"
          : "/work:rw,nosuid,nodev,size=32m,mode=1777,uid=65534,gid=65534",
      );
    if (interactive) args.push("-i");
    for (const mount of mounts) {
      check(
        mount.readonly === true,
        "SANDBOX_MOUNT",
        "不允许可写的宿主机挂载",
        403,
      );
      check(
        !mount.source.includes(","),
        "SANDBOX_PATH",
        "挂载路径不能包含逗号",
      );
      args.push(
        "--mount",
        `type=bind,src=${mount.source},dst=${mount.target}${mount.readonly ? ",readonly" : ""}`,
      );
    }
    args.push("--entrypoint", command[0], image, ...command.slice(1));
    return { name, args };
  }
  start(owner, config, { signal, onExit, onSettled, stdoutTransform } = {}) {
    check(
      [...this.sessions.values()].filter((s) => s.status === "running").length <
        this.limit,
      "PROCESS_LIMIT",
      "并发终端已达上限",
      429,
    );
    signal?.throwIfAborted();
    const { name, args } = this.args(config);
    const id = randomUUID();
    let endpoint, preflightError;
    if (this.journal) {
      try { endpoint = dockerEndpoint(this.docker, this.environment()); }
      catch (error) { preflightError = Object.assign(new Error(`${error.code || "DOCKER_ENDPOINT_UNKNOWN"}: Docker endpoint unavailable; no container started`), { code: error.code }); }
    }
    // Persist failures before create differently from a launched process. A
    // storage failure still throws; it must never allow a container to start.
    const execution = this.journal && !preflightError ? this.journal.create({ owner,
      runId: config.runId, sessionId: id, name, endpoint,
      deadline: Date.now() + Math.min(config.timeoutMs || 60000, 300000) }) : undefined;
    const failedChild = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => false;
      queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit("error", preflightError); });
      return child;
    };
    let identityDirectory, cidfile;
    if (execution && config.interactive !== false) {
      identityDirectory = mkdtempSync(join(tmpdir(), "omw-container-id-"));
      cidfile = join(identityDirectory, "id");
      args.splice(2, 0, "--cidfile", cidfile, "--label", `omw.execution=${execution.nonce}`,
        "--label", `omw.installation=${execution.installation}`, "--label", "omw.protocol=1", "--label", "omw.managed=true");
    }
    const child = preflightError ? failedChild() : config.interactive === false
      ? this.detachedFactory({ docker: this.docker, args, name, environment: this.environment(),
          timeoutMs: config.timeoutMs, cleanupTimeoutMs: this.cleanupTimeoutMs, execution, journal: this.journal })
      : spawn(this.docker, args, { env: this.environment(),
          stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    if (execution && config.interactive !== false) bindInteractiveExecution(child, {
      journal: this.journal, execution, docker: this.docker, environment: this.environment(), cidfile,
      cleanupFile: () => rmSync(identityDirectory, { recursive: true, force: true }), timeoutMs: this.cleanupTimeoutMs,
    });
    // Interactive sessions (terminal input via terminal_write, code SDK tool
    // replies on stdin) keep the pipe open; only explicit non-interactive
    // callers get EOF on launch, or reply frames can never be delivered.
    const s = {
      id,
      owner,
      runId: config.runId,
      name,
      child,
      status: "running",
      output: "",
      offset: 0,
      startedAt: Date.now(),
      exitCode: null,
      phase: "running",
      lifecycle: [],
      outputComplete: false,
      finalizationController: new AbortController(),
    };
    this.sessions.set(id, s);
    s.record = (event, details = {}) => {
      // Preserve the spawn record and the latest transitions, including final
      // failure/cleanup evidence after a long series of wait-state probes.
      if (s.lifecycle.length >= 40) s.lifecycle.splice(1, 1);
      s.lifecycle.push({ event, elapsedMs: Date.now() - s.startedAt, ...details });
    };
    s.record("spawned", { interactive: config.interactive !== false });
    child.on("lifecycle", (event, details) => s.record(event, details));
    child.stdin.on("error", (error) => s.record("stdin.error", { code: error.code }));
    s.stdinErrorHandled = true;
    for (const [name, stream] of [["stdin", child.stdin], ["stdout", child.stdout], ["stderr", child.stderr]])
      for (const event of ["end", "finish", "close"])
        stream.once(event, () => s.record(`${name}.${event}`));
    if (config.interactive === false) child.stdin.end();
    const append = (data) => {
      s.output += data.toString();
      if (s.output.length > 128000) {
        s.offset += s.output.length - 128000;
        s.output = s.output.slice(-128000);
      }
    };
    child.stdout.on("data", (data) => {
      try {
        append(stdoutTransform ? stdoutTransform(data) : data);
      } catch (e) {
        s.error = e.message;
        this.stop(owner, id);
      }
    });
    child.stderr.on("data", append);
    const stop = () => this.stop(owner, id);
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, Math.min(config.timeoutMs || 60000, 300000));
    let drainTimer;
    s.done = new Promise((resolve) => {
      const finish = async (code, error, outputComplete = false) => {
        if (s.finishing) return;
        s.finishing = true;
        clearTimeout(timer);
        clearTimeout(drainTimer);
        clearTimeout(s.killTimer);
        s.exitCode = code;
        s.outputComplete = outputComplete;
        if (error) { s.error = error.message; append(error.message); }
        const finalStatus = s.status === "cancelled" ? "cancelled"
          : error || s.error || code !== 0 || !outputComplete ? "failed" : "completed";
        s.status = finalStatus === "cancelled" ? "cancelled" : "finalizing";
        s.phase = "finalizing";
        s.record("finalization.start");
        let finalizerTimer, outcome = finalStatus;
        try {
          s.result = await Promise.race([
            Promise.resolve().then(() => onExit?.(s)),
            new Promise((_, reject) => {
              finalizerTimer = setTimeout(() => {
                const error = new Error("PROCESS_FINALIZATION_TIMEOUT: 文件收尾未在限定时间内完成");
                s.finalizationController.abort(error);
                reject(error);
              }, this.finalizationTimeoutMs);
            }),
          ]);
        } catch (e) {
          outcome = "failed";
          s.error = e.message;
        } finally {
          clearTimeout(finalizerTimer);
        }
        if (child.cleanup) {
          try { await child.cleanup(); }
          catch (error) {
            outcome = "failed";
            s.error = error.message;
          }
        }
        signal?.removeEventListener("abort", stop);
        s.status = s.status === "cancelled" ? "cancelled" : outcome;
        // Synchronous durable reconciliation runs even when onExit is still
        // blocked in cleanup. It must not introduce another asynchronous wait.
        try {
          if (execution) this.journal.update(execution.nonce, { status: s.status, outputComplete: s.outputComplete,
            verificationId: id, exitCode: s.exitCode });
          onSettled?.(s);
        } catch (error) {
          s.status = "failed";
          s.error = error.message;
          s.record("settlement.error");
        }
        s.finished = true;
        s.phase = "finished";
        s.record("finalization.end", { status: s.status });
        resolve(this.read(owner, id));
        for (const [key, value] of this.sessions)
          if (this.sessions.size > 30 && value.finished && key !== id)
            this.sessions.delete(key);
      };
      s.forceFinish = (error) => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        return finish(s.exitCode, error, false);
      };
      child.once("exit", (code, signal) => {
        s.exitCode = code;
        s.record("child.exit", { code, signal });
        clearTimeout(timer);
        if (s.finishing) return;
        s.phase = "draining";
        if (s.status !== "cancelled") s.status = "finalizing";
        drainTimer = setTimeout(() => {
          s.record("drain.timeout");
          this.cleanup(s);
          s.forceFinish(new Error("PROCESS_DRAIN_TIMEOUT: 进程已退出但输出流未完整关闭"));
        }, this.drainTimeoutMs);
      });
      child.once("error", (error) => { s.record("child.error", { code: error.code }); finish(child.containerExitCode ?? null, error); });
      child.once("close", (code, signal) => {
        s.record("child.close", { code, signal });
        finish(code, undefined, child.stdout.readableEnded && child.stderr.readableEnded);
      });
    });
    return this.read(owner, id);
  }
  async recoverContainers() {
    if (!this.journal || !this.journal.db.prepare("SELECT 1 FROM container_executions WHERE json_extract(data, '$.phase') != 'removed' LIMIT 1").get()) return [];
    try {
      const environment = this.environment(), endpoint = dockerEndpoint(this.docker, environment);
      return await this.journal.recover({ endpoint,
        cli: (args, timeout) => recoveryCli(this.docker, environment, args, timeout) });
    } catch (error) { return [{ phase: "cleanup_pending", code: error.code || "RECOVERY_UNAVAILABLE" }]; }
  }
  environment() {
    // Docker needs its context location; no model credentials are inherited by child processes.
    return Object.fromEntries(
      [
        "PATH",
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_CONFIG",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
      ]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    );
  }
  get(owner, id) {
    const s = this.sessions.get(id);
    check(
      s && s.owner === owner,
      "PROCESS_NOT_FOUND",
      "终端不存在或不属于当前工作区",
      404,
    );
    return s;
  }
  read(owner, id, cursor = 0) {
    const s = this.get(owner, id);
    check(
      Number.isSafeInteger(cursor) && cursor >= 0,
      "INVALID_INPUT",
      "游标无效",
    );
    return {
      id,
      status: s.status,
      exitCode: s.exitCode,
      output: s.output.slice(Math.max(0, cursor - s.offset)),
      cursor: s.offset + s.output.length,
      truncated: cursor < s.offset,
      result: s.result,
      error: s.error,
      phase: s.phase,
      outputComplete: s.outputComplete,
      ...(s.child?.execution ? { execution: { ...s.child.execution } } : {}),
      lifecycle: (Array.isArray(s.lifecycle) ? s.lifecycle : []).map((event) => ({ ...event })),
    };
  }
  write(owner, id, input, eof = false) {
    const s = this.get(owner, id);
    check(s.status === "running", "PROCESS_ENDED", "终端已结束");
    check(
      typeof input === "string" && input.length <= 10000,
      "INVALID_INPUT",
      "输入过长",
    );
    if (!s.stdinErrorHandled) {
      s.child.stdin.on("error", () => {});
      s.stdinErrorHandled = true;
    }
    if (eof) s.child.stdin.end(input);
    else s.child.stdin.write(input);
    return this.read(owner, id);
  }
  async wait(owner, id, timeoutMs = 10000, signal) {
    const session = this.get(owner, id);
    check(
      Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "PROCESS_WAIT",
      "等待时限为 1–30000ms",
    );
    signal?.throwIfAborted();
    let timer, abort;
    try {
      await Promise.race([
        session.done,
        new Promise((resolve, reject) => {
          timer = setTimeout(resolve, timeoutMs);
          abort = () => reject(signal.reason);
          signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
      signal?.throwIfAborted();
      return this.read(owner, id);
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  cleanup(s) {
    if (s.cleanupStarted) return;
    s.cleanupStarted = true;
    s.record("cleanup.start");
    if (s.child.cleanup) {
      s.child.cleanup().catch(() => {});
      return;
    }
    const killer = spawn(this.docker, ["rm", "-f", s.name], {
      env: this.environment(), stdio: "ignore", windowsHide: true,
    });
    const timer = setTimeout(() => {
      s.record("cleanup.timeout");
      killer.kill("SIGKILL");
    }, this.cleanupTimeoutMs);
    timer.unref();
    killer.once("error", () => clearTimeout(timer));
    killer.once("close", (code) => { clearTimeout(timer); s.record("cleanup.end", { code }); });
  }
  stop(owner, id) {
    const s = this.get(owner, id);
    if (s.finished || s.status === "cancelled") return this.read(owner, id);
    s.status = "cancelled";
    s.record("cancel.requested");
    s.finalizationController.abort(new Error("执行已取消"));
    if (!s.finishing) {
      if (!s.child.detached) this.cleanup(s);
      s.child.kill();
      s.killTimer = setTimeout(() => {
        s.record("kill.escalated");
        s.child.kill("SIGKILL");
        s.forceFinish(new Error("PROCESS_CLEANUP_TIMEOUT: 取消后强制关闭进程连接"));
      }, this.cleanupTimeoutMs);
    }
    return this.read(owner, id);
  }
  async close(owner) {
    const sessions = [...this.sessions.values()].filter(
      (s) => !owner || s.owner === owner,
    );
    for (const s of sessions)
      if (!s.finished) this.stop(s.owner, s.id);
    await Promise.allSettled(sessions.map((s) => s.done));
  }
}
