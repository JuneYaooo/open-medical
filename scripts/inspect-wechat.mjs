#!/usr/bin/env node
// Dump the accessibility tree of the WeChat front window so bridge selectors
// can be calibrated against the installed WeChat version.
// Requires: System Settings → Privacy & Security → Accessibility/Automation
// granted to the terminal that runs this script.
import { spawn } from "node:child_process";

const names = (process.env.MEDICAL_WECHAT_PROCESS || "微信,WeChat")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const script = `
function run() {
  const se = Application("System Events");
  const names = ${JSON.stringify(names)};
  let proc = null, procName = "";
  for (const n of names) {
    try { if (se.processes[n].exists()) { proc = se.processes[n]; procName = n; break; } } catch (e) {}
  }
  if (!proc) return JSON.stringify({ ok: false, reason: "wechat-not-running" });
  let lines = [];
  let visited = 0;
  const walk = (el, depth) => {
    if (visited > 6000 || depth > 22) return;
    visited++;
    let role = "", value = "", title = "";
    try { role = el.role(); } catch (e) { return; }
    try { value = String(el.value() || ""); } catch (e) {}
    try { title = String(el.title() || ""); } catch (e) {}
    const desc = [role, title && "title=" + title, value && "value=" + value.slice(0, 80)]
      .filter(Boolean).join(" ");
    if (desc) lines.push("  ".repeat(depth) + desc);
    let kids = [];
    try { kids = el.uiElements(); } catch (e) {}
    for (const k of kids) walk(k, depth + 1);
  };
  try { walk(proc.windows[0], 0); } catch (e) {
    return JSON.stringify({ ok: false, reason: "read-failed", error: String(e) });
  }
  return JSON.stringify({ ok: true, process: procName, lines: lines.slice(0, 800) });
}
`;
const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
  stdio: ["ignore", "pipe", "inherit"],
});
let out = "";
child.stdout.on("data", (c) => (out += c));
child.once("close", (code) => {
  if (code !== 0) {
    console.error("osascript 失败——请确认已在系统设置中授权辅助功能/自动化。");
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(out);
    if (!parsed.ok) {
      console.error(`无法读取：${parsed.reason} ${parsed.error || ""}`);
      process.exit(1);
    }
    console.log(`进程：${parsed.process} · 可见元素 ${parsed.lines.length} 条`);
    console.log(parsed.lines.join("\n"));
  } catch (e) {
    console.error("输出解析失败：", out.slice(0, 400));
    process.exit(1);
  }
});
