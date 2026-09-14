import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { AppError, check, string } from "./errors.mjs";

// macOS WeChat bridge via System Events UI automation (the Mac analogue of
// Windows UIA tooling): no injection, no protocol work. Every capability is
// opt-in, fail-closed, and doctor-initiated; the bridge never sends a message
// on its own and never runs without an explicit configuration flag.
const READ_SCRIPT = `
function run() {
  const se = Application("System Events");
  const names = __NAMES__;
  let proc = null, procName = "";
  for (const n of names) {
    try { if (se.processes[n].exists()) { proc = se.processes[n]; procName = n; break; } } catch (e) {}
  }
  if (!proc) return JSON.stringify({ ok: false, reason: "wechat-not-running" });
  let windows;
  try { windows = proc.windows(); } catch (e) {
    return JSON.stringify({ ok: false, reason: "permission", error: String(e) });
  }
  if (!windows || !windows.length)
    return JSON.stringify({ ok: false, reason: "no-window" });
  const texts = [];
  let visited = 0;
  const walk = (el, depth) => {
    if (visited > 5000 || depth > 20) return;
    visited++;
    let role = "";
    try { role = el.role(); } catch (e) { return; }
    if (role === "AXStaticText") {
      let v = "";
      try { v = String(el.value() || ""); } catch (e) {}
      if (v.trim()) texts.push(v.trim());
      return;
    }
    let kids = [];
    try { kids = el.uiElements(); } catch (e) {}
    for (const k of kids) walk(k, depth + 1);
  };
  try { walk(windows[0], 0); } catch (e) {
    return JSON.stringify({ ok: false, reason: "read-failed", error: String(e) });
  }
  return JSON.stringify({ ok: true, process: procName, texts: texts.slice(0, 300) });
}
`;
const SEND_SCRIPT = `
function run(argv) {
  const contact = argv[0], text = argv[1];
  const names = JSON.parse(argv[2]);
  const se = Application("System Events");
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  let proc = null;
  for (const n of names) {
    try { if (se.processes[n].exists()) { proc = se.processes[n]; break; } } catch (e) {}
  }
  if (!proc) return JSON.stringify({ ok: false, reason: "wechat-not-running" });
  let saved = "";
  try { saved = app.theClipboard(); } catch (e) {}
  const fail = (reason, error) => JSON.stringify({ ok: false, reason, error: String(error || "") });
  try {
    proc.frontmost = true;
    app.delay(0.6);
    app.setTheClipboardTo(contact);
    se.keystroke("f", { using: ["command down"] });
    app.delay(0.8);
    se.keystroke("v", { using: ["command down"] });
    app.delay(1.0);
    se.keystroke("\\r");
    app.delay(1.2);
    app.setTheClipboardTo(text);
    se.keystroke("v", { using: ["command down"] });
    app.delay(0.6);
    se.keystroke("\\r");
    app.delay(0.5);
  } catch (e) {
    return fail("send-failed", e);
  }
  if (saved) try { app.setTheClipboardTo(saved); } catch (e) {}
  return JSON.stringify({ ok: true });
}
`;
const PROBE_SCRIPT = `
function run() {
  const se = Application("System Events");
  const names = __NAMES__;
  for (const n of names) {
    try {
      if (se.processes[n].exists())
        return JSON.stringify({ ok: true, process: n, running: true });
    } catch (e) {
      return JSON.stringify({ ok: false, reason: "permission", error: String(e) });
    }
  }
  return JSON.stringify({ ok: true, running: false });
}
`;
const defaultRunner = (script, args = []) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script, ...args.map(String)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new AppError("WECHAT_TIMEOUT", "微信自动化脚本执行超时", 504));
    }, 25000);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        if (/-1743|未获得授权|not allowed to send|assistive/i.test(err))
          reject(
            new AppError(
              "WECHAT_PERMISSION",
              "需要在 系统设置 → 隐私与安全性 → 辅助功能/自动化 中为运行本服务的终端授权",
              503,
            ),
          );
        else
          reject(
            new AppError(
              "WECHAT_SCRIPT",
              `微信自动化脚本失败：${err.slice(-400)}`,
              502,
            ),
          );
        return;
      }
      resolve(out.trim());
    });
  });
export class WeChatMacBridge {
  constructor({
    patients,
    enabled = false,
    processNames = ["微信", "WeChat"],
    runner = defaultRunner,
    probeCacheMs = 30000,
  } = {}) {
    Object.assign(this, {
      patients,
      enabled: Boolean(enabled),
      processNames,
      runner,
      probeCacheMs,
    });
    this.probe = null;
  }
  status() {
    return {
      enabled: this.enabled,
      platform: process.platform,
      backend: "macos-ui-automation",
      processNames: this.processNames,
      ...(this.enabled
        ? this.probe || {
            available: false,
            reason: "尚未探测；点击同步或发送时会自动探测",
          }
        : { available: false, reason: "未启用：在 .env 设置 MEDICAL_WECHAT_BRIDGE=on" }),
    };
  }
  async ensureAvailable() {
    check(this.enabled, "BRIDGE_DISABLED", "微信桥接未启用", 503);
    check(
      process.platform === "darwin",
      "BRIDGE_UNAVAILABLE",
      "微信桥接只支持 macOS",
      503,
    );
    if (this.probe && Date.now() - this.probe.at < this.probeCacheMs) {
      check(
        this.probe.available,
        "BRIDGE_UNAVAILABLE",
        this.probe.reason,
        503,
      );
      return;
    }
    let result;
    try {
      result = await this.run(PROBE_SCRIPT, []);
    } catch (error) {
      this.probe = {
        at: Date.now(),
        available: false,
        reason: error instanceof AppError ? error.message : "探测失败",
      };
      throw error;
    }
    const parsed = this.parse(result);
    if (!parsed.ok)
      this.probe = {
        at: Date.now(),
        available: false,
        reason: this.reasonFor(parsed),
      };
    else if (!parsed.running)
      this.probe = {
        at: Date.now(),
        available: false,
        reason: "微信客户端未运行",
      };
    else
      this.probe = {
        at: Date.now(),
        available: true,
        reason: null,
        process: parsed.process,
      };
    check(
      this.probe.available,
      "BRIDGE_UNAVAILABLE",
      this.probe.reason,
      503,
    );
  }
  reasonFor(parsed) {
    if (parsed.reason === "permission")
      return "需要授权：系统设置 → 隐私与安全性 → 辅助功能/自动化";
    if (parsed.reason === "wechat-not-running") return "微信客户端未运行";
    return parsed.error ? `读取失败：${parsed.error}` : "微信窗口不可读";
  }
  async run(script, args) {
    const body = script.replace("__NAMES__", JSON.stringify(this.processNames));
    try {
      return await this.runner(body, args);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "WECHAT_SCRIPT",
        `微信自动化执行失败：${error.message}`,
        502,
      );
    }
  }
  parse(output) {
    try {
      const value = JSON.parse(output);
      check(
        value && typeof value === "object",
        "WECHAT_SCRIPT",
        "微信自动化返回格式无效",
        502,
      );
      return value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("WECHAT_SCRIPT", "微信自动化返回不是 JSON", 502);
    }
  }
  externalId(patientId, direction, text) {
    return `wxmac-${createHash("sha256").update(`${patientId}|${direction}|${text}`).digest("hex").slice(0, 32)}`;
  }
  // Doctor switches WeChat to the patient's chat window, then triggers this.
  // The front window's visible texts are archived for that patient only.
  async readFrontChat(patientId) {
    await this.ensureAvailable();
    this.patients.row(patientId);
    const result = this.parse(
      await this.run(READ_SCRIPT, []),
    );
    check(result.ok, "BRIDGE_UNAVAILABLE", this.reasonFor(result), 503);
    const messages = result.texts
      .filter((t) => t.length >= 2 && t.length <= 2000)
      .map((text) => ({
        externalId: this.externalId(patientId, "in", text),
        direction: "in",
        time: new Date().toISOString(),
        text,
      }));
    if (!messages.length)
      return { stored: 0, duplicates: 0, captured: 0, window: result.process };
    const outcome = this.patients.ingest(messages, {
      patientId,
      fallbackChannel: "wechat-mac",
    });
    return { ...outcome, captured: messages.length, window: result.process };
  }
  // Sends one reviewed draft through the local WeChat client. Called only
  // from an explicit doctor action; never scheduled, never batched.
  async send(patientId, text) {
    await this.ensureAvailable();
    const patient = this.patients.row(patientId);
    const message = string(text, "回复内容", 2000);
    check(message.trim().length > 0, "INVALID_INPUT", "回复内容不能为空");
    const contact = (patient.phone || "").trim() || patient.name.trim();
    const result = this.parse(
      await this.run(SEND_SCRIPT, [contact, message, JSON.stringify(this.processNames)]),
    );
    check(result.ok, "WECHAT_SEND_FAILED", this.reasonFor(result), 502);
    this.patients.ingest(
      [
        {
          externalId: this.externalId(patientId, "out", message),
          direction: "out",
          time: new Date().toISOString(),
          text: message,
        },
      ],
      { patientId, fallbackChannel: "wechat-mac" },
    );
    return { sent: true, contact };
  }
}
