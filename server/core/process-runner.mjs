import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { check, AppError } from "../errors.mjs";

// Every process exposed to tools goes through a container. Never fall back to a host shell.
export class ProcessRunner {
  constructor({ docker, limit = 3 } = {}) {
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
  start(owner, config, { signal, onExit, stdoutTransform } = {}) {
    check(
      [...this.sessions.values()].filter((s) => s.status === "running").length <
        this.limit,
      "PROCESS_LIMIT",
      "并发终端已达上限",
      429,
    );
    signal?.throwIfAborted();
    const { name, args } = this.args(config);
    const child = spawn(this.docker, args, {
      env: this.environment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // Non-interactive commands must receive EOF; Docker's `-i` is reserved
    // for terminal sessions and otherwise leaves the client waiting on stdin.
    if (!config.interactive) child.stdin.end();
    const id = randomUUID();
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
    };
    this.sessions.set(id, s);
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
    s.done = new Promise((resolve) => {
      const finish = async (code, error) => {
        if (s.finished) return;
        s.finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        s.exitCode = code;
        const finalStatus =
          s.status === "cancelled"
            ? "cancelled"
            : error || code !== 0
              ? "failed"
              : "completed";
        if (error) append(error.message);
        s.status = finalStatus === "cancelled" ? "cancelled" : "finalizing";
        try {
          s.result = await onExit?.(s);
          s.status = finalStatus;
        } catch (e) {
          s.status = "failed";
          s.error = e.message;
        }
        resolve(this.read(owner, id));
        // Bound retained scrollback; running sessions are never evicted.
        for (const [key, value] of this.sessions)
          if (this.sessions.size > 30 && ["completed", "failed", "cancelled"].includes(value.status) && value.finished && key !== id)
            this.sessions.delete(key);
      };
      child.on("error", (e) => finish(null, e));
      child.on("close", (code) => finish(code));
    });
    return this.read(owner, id);
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
  stop(owner, id) {
    const s = this.get(owner, id);
    if (s.status !== "running") return this.read(owner, id);
    s.status = "cancelled";
    const killer = spawn(this.docker, ["rm", "-f", s.name], {
      env: this.environment(),
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {});
    s.child.kill();
    return this.read(owner, id);
  }
  async close(owner) {
    const sessions = [...this.sessions.values()].filter(
      (s) => !owner || s.owner === owner,
    );
    for (const s of sessions)
      if (s.status === "running") this.stop(s.owner, s.id);
    await Promise.allSettled(sessions.map((s) => s.done));
  }
}
