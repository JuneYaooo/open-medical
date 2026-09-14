import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { check } from "../errors.mjs";
const exec = promisify(execFile);
export class DesktopControl {
  constructor(service, { invoke } = {}) {
    this.service = service;
    this.sessions = new Map();
    this.pending = new Map();
    this.invoke = invoke || this.native;
  }
  native(input) {
    check(
      process.platform === "darwin",
      "DESKTOP_PLATFORM",
      "当前原生控制支持 macOS",
    );
    return new Promise((resolve, reject) => {
      const child = spawn(
        fileURLToPath(
          new URL("../../desktop/bin/native-control", import.meta.url),
        ),
        [],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let output = "";
      const timer = setTimeout(() => child.kill(), 10000);
      child.stdout.on("data", (data) => {
        output += data;
        if (output.length > 200000) child.kill();
      });
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("请先运行 npm run build:native-control"));
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(output);
          if (code || result.error)
            reject(new Error(result.error || "桌面控制失败"));
          else resolve(result);
        } catch {
          reject(new Error("桌面控制未返回有效结果"));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(input));
    });
  }
  session(owner) {
    const session = this.sessions.get(owner);
    check(
      session &&
        session.expires > Date.now() &&
        this.service.store.get(owner).revision === session.revision,
      "DESKTOP_CONSENT",
      "桌面授权已过期或变更，请重新选择应用",
      403,
    );
    return session;
  }
  async execute(owner, input) {
    this.service.store.get(owner);
    if (input.action === "status")
      return {
        ...(await this.invoke({ action: "status" })),
        session: this.sessions.get(owner),
        pending: [...this.pending.values()].filter((p) => p.owner === owner),
      };
    if (input.action === "stop") {
      this.sessions.delete(owner);
      for (const [id, p] of this.pending)
        if (p.owner === owner) this.pending.delete(id);
      return { stopped: true };
    }
    if (input.action === "authorize") {
      check(
        input.consent === true &&
          typeof input.app === "string" &&
          /^[\w.-]{1,200}$/.test(input.app),
        "DESKTOP_CONSENT",
        "请选择并授权应用",
        412,
      );
      this.sessions.set(owner, {
        app: input.app,
        expires: Date.now() + 15 * 60000,
        revision: this.service.store.get(owner).revision,
      });
      return { authorized: true };
    }
    const session = this.session(owner);
    if (input.action === "approve") {
      const proposal = this.pending.get(input.proposalId);
      check(proposal?.owner === owner, "DESKTOP_PROPOSAL", "操作提案不存在");
      this.pending.delete(input.proposalId);
      check(
        proposal.app === session.app && proposal.expires > Date.now(),
        "DESKTOP_PROPOSAL",
        "操作提案已过期",
      );
      return this.perform(owner, proposal.input);
    }
    if (input.action === "reject") {
      check(
        this.pending.get(input.proposalId)?.owner === owner,
        "DESKTOP_PROPOSAL",
        "操作提案不存在",
      );
      this.pending.delete(input.proposalId);
      return { rejected: true };
    }
    check(input.consent === true, "DESKTOP_CONSENT", "请确认执行桌面操作", 412);
    return this.perform(owner, input);
  }
  propose(owner, input) {
    const session = this.session(owner);
    check(
      ["focus", "click", "move", "type", "key", "scroll"].includes(
        input.action,
      ),
      "DESKTOP_ACTION",
      "未知桌面操作",
    );
    check(this.pending.size < 30, "DESKTOP_BUSY", "待审批操作过多");
    const proposal = {
      id: randomUUID(),
      owner,
      app: session.app,
      input,
      expires: Date.now() + 120000,
    };
    this.pending.set(proposal.id, proposal);
    return { approvalRequired: true, proposal };
  }
  async perform(owner, input) {
    const session = this.session(owner);
    check(
      ["focus", "snapshot", "click", "move", "type", "key", "scroll"].includes(
        input.action,
      ),
      "DESKTOP_ACTION",
      "未知桌面操作",
    );
    if (["click", "move"].includes(input.action)) {
      const snapshot = await this.invoke({
        action: "snapshot",
        app: session.app,
      });
      const b = snapshot.bounds;
      check(
        b &&
          Number.isFinite(input.x) &&
          Number.isFinite(input.y) &&
          input.x >= b.X &&
          input.x < b.X + b.Width &&
          input.y >= b.Y &&
          input.y < b.Y + b.Height,
        "DESKTOP_BOUNDS",
        "坐标不在授权应用窗口内",
      );
    }
    const result = await this.invoke({ ...input, app: session.app });
    if (
      input.action === "snapshot" &&
      result.windowId &&
      result.screenRecording
    ) {
      const dir = await mkdtemp(join(tmpdir(), "desktop-capture-"));
      try {
        const path = join(dir, "window.png");
        await exec(
          "/usr/sbin/screencapture",
          ["-x", "-o", "-l", String(result.windowId), path],
          { timeout: 10000 },
        );
        this.session(owner);
        result.artifact = this.service.artifacts.save(
          owner,
          "应用窗口.png",
          await readFile(path),
          "desktop",
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    this.service.store.event(owner, "manual", "desktop.action", {
      action: input.action,
      app: session.app,
    });
    return result;
  }
}
