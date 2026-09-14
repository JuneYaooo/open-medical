import { parseArgs } from "node:util";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, renameSync, openSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkspaceServer } from "../server/platform.mjs";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { checkSoakContinuity } from "./soak-continuity.mjs";

const { values } = parseArgs({ options: {
  hours: { type: "string", default: "48" }, iterations: { type: "string" },
  "interval-ms": { type: "string", default: "60000" }, directory: { type: "string" },
  background: { type: "boolean", default: false },
  image: { type: "string" },
} });
const hours = Number(values.hours), interval = Number(values["interval-ms"]),
  maximum = values.iterations ? Number(values.iterations) : Infinity;
if (!Number.isFinite(hours) || hours <= 0 || hours > 168 || !Number.isSafeInteger(interval) || interval < 0 || interval > 3600000 ||
  (maximum !== Infinity && (!Number.isSafeInteger(maximum) || maximum < 1))) throw new Error("Invalid soak budget");
const directory = resolve(values.directory || `output/soak-${Date.now()}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (values.background) {
  const log = openSync(join(directory, "worker.log"), "a", 0o600);
  const args = [process.argv[1], "--hours", String(hours), "--interval-ms", String(interval), "--directory", directory,
    ...(values.image ? ["--image", values.image] : []),
    ...(Number.isFinite(maximum) ? ["--iterations", String(maximum)] : [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log], windowsHide: true });
  closeSync(log);
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  console.log(JSON.stringify({ pid: child.pid, directory, report: join(directory, "report.json"), syntheticOnly: true }));
} else {
  const root = join(directory, "fixture");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sentinel.txt"), "SYNTHETIC_SOAK_SENTINEL");
  const report = { status: "running", pid: process.pid, startedAt: Date.now(), targetHours: hours,
    sourceFingerprint: sourceFingerprint(),
    syntheticOnly: true, realModelValidated: false, platform: process.platform, arch: process.arch,
    iterations: 0, serverRestarts: 0, forcedCrashChecks: 0, compactions: 0, maxRssBytes: 0, maxLatencyMs: 0, samples: [] };
  report.runtimeImage = values.image || null;
  report.containerChecks = 0;
  report.officeChecks = 0;
  report.maxSchedulingGapMs = 0;
  report.durationTargetMet = false;
  let lastIteration = report.startedAt;
  const checkContinuity = () => {
    const now = Date.now();
    report.maxSchedulingGapMs = Math.max(report.maxSchedulingGapMs, checkSoakContinuity(lastIteration, now, interval));
    lastIteration = now;
  };
  const reportPath = join(directory, "report.json");
  const persist = () => {
    report.updatedAt = Date.now(); report.elapsedHours = (report.updatedAt - report.startedAt) / 3600000;
    writeFileSync(reportPath + ".tmp", JSON.stringify(report, null, 2), { mode: 0o600 });
    renameSync(reportPath + ".tmp", reportPath);
  };
  const controller = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => controller.abort());
  const provider = { apiKey: "synthetic", model: "soak-fixture", provider: "soak",
    async complete(messages) {
      if (messages[0].content.includes("会话历史压缩器")) {
        report.compactions++;
        return { message: { role: "assistant", content: "历史为合成读文件任务，前序均已完成；继续当前任务。" } };
      }
      if (messages.at(-1).role === "user") return { message: { role: "assistant", content: null, tool_calls: [{
        id: `read-${report.iterations}`, function: { name: "read_file", arguments: '{"path":"sentinel.txt"}' },
      }] }, usage: { total_tokens: 10 } };
      if (!messages.at(-1).content.includes("SYNTHETIC_SOAK_SENTINEL")) throw new Error("Lost workspace context");
      return { message: { role: "assistant", content: "已验证合成资料。" }, usage: { total_tokens: 10 } };
    } };
  let server, workspaceId;
  const boot = async () => {
    server = createWorkspaceServer({ database: join(directory, "state.sqlite"), provider });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    if (!workspaceId) {
      workspaceId = server.service.create({ root, directoryConsent: true }).id;
      if (values.image) {
        server.service.update(workspaceId, { revision: server.service.get(workspaceId).revision, profile: "standard", allowWrite: true });
        await server.service.extensions.operation(workspaceId, { action: "configure", revision: server.service.get(workspaceId).revision,
          consent: true, terminal: true, image: values.image, origins: [], browser: false, plugins: false, mcp: false,
          memoryRead: false, memoryWrite: false, memory: { provider: "lsa" } });
      }
    }
  };
  persist();
  try {
    await boot();
    while (!controller.signal.aborted && report.iterations < maximum && Date.now() < report.startedAt + hours * 3600000) {
      checkContinuity();
      const start = Date.now(), service = server.service;
      const result = await service.execute(service.prepare(workspaceId, {
        revision: service.get(workspaceId).revision, message: `合成任务 ${report.iterations}：检查 sentinel.txt`,
        externalConsent: true, resumeOnRestart: true, limits: { maxContextChars: 10000, maxRounds: 8, timeoutMs: 30000 },
      }));
      if (result.status !== "completed") throw new Error("Task did not complete: " + result.error);
      if (service.active.size || service.teams.size || service.extensions.runner.sessions.size > 30 ||
        [...service.extensions.runner.sessions.values()].some((s) => ["running", "finalizing"].includes(s.status))) throw new Error("Execution resources leaked");
      if (service.get(workspaceId).runs.length > 50) throw new Error("Hot history grew beyond retention bound");
      if (service.store.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("SQLite integrity failure");
      const memory = process.memoryUsage(), latencyMs = Date.now() - start;
      report.maxRssBytes = Math.max(report.maxRssBytes, memory.rss);
      report.maxLatencyMs = Math.max(report.maxLatencyMs, latencyMs);
      if (memory.rss > 512 * 1024 * 1024) throw new Error("RSS exceeded 512 MiB");
      report.iterations++;
      if (values.image && report.iterations % 25 === 0) {
        const tool = async (name, args) => {
          let result = await service.tool(workspaceId, { tool: name, arguments: args });
          while (["running", "finalizing"].includes(result.status)) result = await service.tool(workspaceId, {
            tool: "terminal_wait", arguments: { id: result.id, timeoutMs: 30000 },
          });
          if (result.status !== "completed" || result.exitCode !== 0) throw new Error("Container acceptance failed: " + JSON.stringify(result));
          return result;
        };
        const result = await tool("terminal_run", { command: "node -e \"process.stdout.write(require('fs').readFileSync('sentinel.txt','utf8'))\"", paths: ["sentinel.txt"] });
        if (!result.output.includes("SYNTHETIC_SOAK_SENTINEL")) throw new Error("Container lost input snapshot");
        report.containerChecks++;
        if (report.iterations % 100 === 0) {
          const doc = await tool("document_create", { path: "soak.docx", contentJson: '{"title":"SYNTHETIC_SOAK","paragraphs":["Document pipeline verification"]}' });
          if (!doc.result.artifacts?.length) throw new Error("Office pipeline did not export an artifact");
          report.officeChecks++;
        }
      }
      if (report.iterations % 25 === 0) { await server.shutdown(); server = null; await boot(); report.serverRestarts++; }
      if (report.iterations % 100 === 0) {
        const crashRoot = join(directory, `fault-${report.iterations}`);
        mkdirSync(crashRoot);
        const args = [resolve(import.meta.dirname, "../tests/fixtures/recovery-worker.mjs"), crashRoot];
        let killed = false;
        try { await promisify(execFile)(process.execPath, [...args, "crash", "unknown"], { timeout: 15000 }); }
        catch (error) { if (error.signal !== "SIGKILL") throw error; killed = true; }
        if (!killed) throw new Error("Crash injection did not terminate process");
        const recovered = await promisify(execFile)(process.execPath, [...args, "recover", "unknown"], { timeout: 15000 });
        if (JSON.parse(recovered.stdout).status !== "completed") throw new Error("Crash recovery failed");
        report.forcedCrashChecks++;
      }
      report.samples = [...report.samples.slice(-999), { at: Date.now(), iteration: report.iterations, rss: memory.rss, latencyMs }];
      persist();
      if (interval && report.iterations < maximum) await delay(Math.min(interval, Math.max(1, report.startedAt + hours * 3600000 - Date.now())), undefined,
        { signal: controller.signal }).catch((error) => { if (!controller.signal.aborted) throw error; });
    }
    if (!controller.signal.aborted) checkContinuity();
    report.status = controller.signal.aborted ? "stopped" : "passed";
    report.durationTargetMet = Date.now() >= report.startedAt + hours * 3600000;
    report.stopReason = controller.signal.aborted ? "signal" : report.iterations >= maximum ? "iteration-budget" : "duration-budget";
  } catch (error) { report.status = "failed"; report.error = error.message; process.exitCode = 1; }
  finally {
    await server?.shutdown();
    report.endedAt = Date.now(); persist();
    console.log(readFileSync(reportPath, "utf8"));
  }
}
