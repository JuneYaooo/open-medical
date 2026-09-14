import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { sourceSnapshot } from "./source-snapshot.mjs";
import { WorkspaceFiles } from "./workspace-files.mjs";
import { PermissionEngine } from "./permissions.mjs";
import { check, AppError } from "../errors.mjs";
export class PtySessions {
  constructor(service, { loadPty = () => import("node-pty") } = {}) {
    this.service = service;
    this.sessions = new Map();
    this.loadPty = loadPty;
  }
  dimensions(cols = 100, rows = 28) {
    check(
      Number.isInteger(cols) &&
        cols >= 20 &&
        cols <= 300 &&
        Number.isInteger(rows) &&
        rows >= 5 &&
        rows <= 150,
      "PTY_SIZE",
      "终端尺寸无效",
    );
    return { cols, rows };
  }
  get(owner, id) {
    const s = this.sessions.get(id);
    check(s && s.owner === owner, "PTY_NOT_FOUND", "终端不属于当前任务", 404);
    return s;
  }
  read(owner, id, cursor = 0) {
    const s = this.get(owner, id);
    check(
      Number.isSafeInteger(cursor) && cursor >= 0,
      "PTY_CURSOR",
      "游标无效",
    );
    return {
      id: s.id,
      status: s.status,
      exitCode: s.exitCode,
      output: s.output.slice(Math.max(0, cursor - s.offset)),
      cursor: s.offset + s.output.length,
      truncated: cursor < s.offset,
      cols: s.cols,
      rows: s.rows,
      previewUrl:s.previewUrl,
      previewError:s.previewError,
    };
  }
  async start(owner, body) {
    const w = this.service.store.get(owner),
      permissions = new PermissionEngine(w.permissions);
    permissions.require("process.spawn");
    permissions.require("filesystem.read");
    check(
      body.consent === true,
      "PTY_CONSENT",
      "请确认在项目隔离快照中打开交互终端",
      412,
    );
    check(
      !this.service.active.has(owner),
      "RUN_ACTIVE",
      "请等待 Agent 结束后打开手动终端",
      409,
    );
    check(
      [...this.sessions.values()].filter(
        (s) => s.status === "running" || s.status === "starting",
      ).length < 3,
      "PTY_LIMIT",
      "最多同时运行三个交互终端",
    );
    const size = this.dimensions(body.cols, body.rows),
      id = randomUUID();
    const record = {
      id,
      owner,
      status: "starting",
      output: "",
      offset: 0,
      ...size,
    };
    while (this.sessions.size >= 32) {
      const old = [...this.sessions.values()].find(
        (s) => !["running", "starting"].includes(s.status),
      );
      if (!old) break;
      this.sessions.delete(old.id);
    }
    this.sessions.set(id, record);
    let snapshot;
    try {
      let pty;
      try {
        pty = await this.loadPty();
      } catch {
        throw new AppError(
          "PTY_UNAVAILABLE",
          "当前系统没有可用的 node-pty 模块，请重新安装依赖或使用命令终端",
          503,
        );
      }
      const runner = this.service.extensions.runner,
        image = runner.image(w.extensions?.image);
      const paths = body.paths || new WorkspaceFiles(w.root).snapshot().paths;
      snapshot = await sourceSnapshot(w.root, paths, { maxFiles: 500 });
      check(
        this.service.store.get(owner).revision === w.revision &&
          !this.service.stopping,
        "REVISION_CONFLICT",
        "任务授权已变化，请重新打开终端",
        409,
      );
      const network =
        w.extensions?.terminalNetwork === true && permissions.can("network");
      if(body.previewPort !== undefined) check(network && Number.isInteger(body.previewPort) && body.previewPort>=1024 && body.previewPort<=65535,"PTY_PREVIEW","预览端口需为 1024–65535，并启用终端网络");
      const { name, args } = runner.args({
        image,
        network,
        resources: "code",
        mounts: [
          { source: snapshot.directory, target: "/input", readonly: true },
        ],
        command: ["/bin/sh", "-c", "cp -R /input/. /work/ && exec /bin/sh"],
      });
      if(body.previewPort) args.splice(1,0,"-p",`127.0.0.1::${body.previewPort}`);
      args.splice(1, 0, "-t", "--env", "TERM=xterm-256color");
      const child = pty.spawn(runner.docker, args, {
        ...size,
        name: "xterm-256color",
        env: runner.environment(),
      });
      Object.assign(record, {
        child,
        name,
        directory: snapshot.directory,
        status: "running",
      });
      if(body.previewPort) {
        let attempts=0;
        const probe=()=>execFile(runner.docker,["port",name,`${body.previewPort}/tcp`],{env:runner.environment(),timeout:2000,maxBuffer:2000},(error,stdout)=>{
          if(record.status!=="running")return;
          const match=/^127\.0\.0\.1:(\d+)\s*$/.exec(stdout || "");
          if(!error && match)record.previewUrl=`http://127.0.0.1:${match[1]}`;
          else if(++attempts<20)record.previewTimer=setTimeout(probe,250);
          else record.previewError="容器端口未就绪，请检查服务启动情况";
        });
        probe();
      }
      child.onData((data) => {
        record.output += data;
        if (record.output.length > 512000) {
          record.offset += record.output.length - 512000;
          record.output = record.output.slice(-512000);
        }
      });
      child.onExit(({ exitCode }) => {
        record.status = record.status === "cancelled" ? "cancelled" : "exited";
        record.exitCode = exitCode;
        clearTimeout(record.timer);
        clearTimeout(record.previewTimer);
        void rm(record.directory, { recursive: true, force: true });
      });
      record.timer = setTimeout(() => this.stop(owner, id), 3600000);
      record.timer.unref();
      this.service.store.event(owner, "manual", "pty.started", {
        id,
        files: paths.length,
        network,
      });
      return this.read(owner, id);
    } catch (error) {
      this.sessions.delete(id);
      if (snapshot)
        await rm(snapshot.directory, { recursive: true, force: true });
      throw error;
    }
  }
  write(owner, id, data) {
    new PermissionEngine(this.service.store.get(owner).permissions).require(
      "process.spawn",
    );
    const s = this.get(owner, id);
    check(s.status === "running", "PTY_ENDED", "终端已退出");
    check(
      typeof data === "string" && data.length <= 10000,
      "PTY_INPUT",
      "输入过长",
    );
    s.child.write(data);
    return { id };
  }
  resize(owner, id, cols, rows) {
    const s = this.get(owner, id);
    check(s.status === "running", "PTY_ENDED", "终端已退出");
    Object.assign(s, this.dimensions(cols, rows));
    s.child.resize(cols, rows);
    return { id, cols, rows };
  }
  stop(owner, id) {
    const s = this.get(owner, id);
    if (s.status === "running") {
      s.status = "cancelled";
      clearTimeout(s.timer);
      clearTimeout(s.previewTimer);
      const runner = this.service.extensions.runner;
      const child = spawn(runner.docker, ["rm", "-f", s.name], {
        env: runner.environment(),
        stdio: "ignore",
      });
      child.on("error", () => {});
      s.child.kill();
    }
    return this.read(owner, id);
  }
  close(owner) {
    for (const s of this.sessions.values())
      if (!owner || s.owner === owner) this.stop(s.owner, s.id);
  }
}
