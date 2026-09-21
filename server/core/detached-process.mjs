import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";

// One container execution, with independently bounded control/log connections.
// No command is replayed when a Docker connection fails.
export function createDetachedProcess({ docker, args, name, environment, timeoutMs,
  cleanupTimeoutMs = 2000, spawnProcess = spawn }) {
  const process = new EventEmitter();
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  const controller = new AbortController();
  const deadline = Date.now() + Math.min(timeoutMs || 60000, 300000);
  let container = name, cleanupPromise;
  const ownership = randomUUID();
  const record = (event, details = {}) => process.emit("lifecycle", event, details);
  const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

  function cli(arguments_, { phase, limitMs = 4000, outputLimit = 65536, cleanup = false } = {}) {
    const remaining = cleanup ? limitMs : Math.min(limitMs, deadline - Date.now());
    if (remaining <= 0 || (!cleanup && controller.signal.aborted))
      return Promise.reject(failure("PROCESS_DEADLINE", "容器操作已超过任务时限或被取消"));
    record(`detached.${phase}.start`);
    return new Promise((resolve, reject) => {
      const child = spawnProcess(docker, arguments_, { env: environment,
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const stdout = [], stderr = [];
      let bytes = 0, settled = false, timer;
      const finish = (error, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
        if (error) {
          child.kill("SIGKILL");
          child.stdout.destroy(); child.stderr.destroy();
          record(`detached.${phase}.failed`, { code: error.code });
          reject(error);
        } else {
          record(`detached.${phase}.end`, { code, bytes });
          resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
        }
      };
      const abort = () => finish(failure("PROCESS_CANCELLED", "容器操作已取消"));
      if (!cleanup) controller.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish(failure("DOCKER_STAGE_TIMEOUT", `${phase}连接未在限定时间内完成`)), remaining);
      for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
        stream.on("data", (data) => {
          bytes += data.length;
          if (bytes > outputLimit) finish(failure("DOCKER_OUTPUT_LIMIT", "容器连接输出超过限制"));
          else chunks.push(data);
        });
        stream.on("error", (error) => finish(error));
      }
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        if (!child.stdout.readableEnded || !child.stderr.readableEnded)
          finish(failure("DOCKER_INCOMPLETE_OUTPUT", `${phase}输出未完整关闭`));
        else finish(undefined, code);
      });
    });
  }
  const requireSuccess = (result, phase) => {
    if (result.code !== 0) throw failure("DOCKER_CONTROL_FAILED", `${phase}连接失败（退出码${result.code}）`);
    return result;
  };
  process.kill = () => { controller.abort(); return true; };
  process.cleanup = () => {
    cleanupPromise ||= (async () => {
      const cleanupDeadline = Date.now() + cleanupTimeoutMs;
      const cleanupCall = (args, phase) => cli(args, { phase, cleanup: true,
        limitMs: Math.max(1, cleanupDeadline - Date.now()) });
      if (container === name) {
        // An interrupted create may have reached the daemon. Never delete an
        // existing name-conflict container: first prove our per-attempt label.
        let owned = false;
        for (let attempt = 0; attempt < 2 && Date.now() < cleanupDeadline; attempt++) {
          const inspected = await cleanupCall(["inspect", "--format", '{{.Id}} {{index .Config.Labels "omw.execution"}}', name], "cleanup-inspect");
          const [id, label] = inspected.stdout.toString().trim().split(/\s+/);
          if (inspected.code === 0 && /^[a-f0-9]{64}$/.test(id) && label === ownership) {
            container = id; owned = true; break;
          }
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, cleanupDeadline - Date.now()))));
        }
        if (!owned) throw failure("DOCKER_CLEANUP_UNCONFIRMED", "创建连接中断，未确认本次容器身份；未删除其它容器");
      }
      requireSuccess(await cleanupCall(["rm", "-f", container], "cleanup"), "cleanup");
    })();
    return cleanupPromise;
  };
  process.detached = true;
  queueMicrotask(async () => {
    try {
      // Reuse every resource/mount/network constraint from the regular runner.
      const createArgs = ["create", "--label", "omw.managed=true", "--label", `omw.execution=${ownership}`,
        ...args.slice(args[1] === "--rm" ? 2 : 1)];
      const created = requireSuccess(await cli(createArgs, { phase: "create" }), "create");
      const id = created.stdout.toString().trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw failure("DOCKER_IDENTITY", "创建容器未返回有效身份");
      container = id;
      requireSuccess(await cli(["start", container], { phase: "start" }), "start");
      let state;
      while (true) {
        let waited;
        try {
          waited = requireSuccess(await cli(["wait", container], { phase: "wait", limitMs: 10000 }), "wait");
        } catch (error) {
          if (controller.signal.aborted || Date.now() >= deadline) throw error;
          // A wait connection is not execution. Inspect the same immutable
          // container to recover its authoritative state; never start again.
          record("detached.wait.inspect-recovery", { code: error.code });
        }
        const inspected = requireSuccess(await cli(["inspect", "--format", "{{json .State}}", container], { phase: "inspect" }), "inspect");
        state = JSON.parse(inspected.stdout.toString());
        if (!waited && state.Running === true) continue;
        const waitCode = waited?.stdout.toString().trim();
        if (state.Running !== false || !["exited", "dead"].includes(state.Status) ||
            !Number.isInteger(state.ExitCode) || state.ExitCode < 0 || state.ExitCode > 255 ||
            (waited && String(state.ExitCode) !== waitCode))
          throw failure("DOCKER_EXIT_EVIDENCE", "容器退出证据不完整或不一致");
        break;
      }
      process.containerExitCode = state.ExitCode;
      record("container.exited", { code: state.ExitCode });
      let logs;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          logs = requireSuccess(await cli(["logs", container], { phase: "logs", limitMs: 10000, outputLimit: 32_000_000 }), "logs");
          break;
        } catch (error) {
          if (attempt === 2 || controller.signal.aborted || Date.now() >= deadline || error.code === "DOCKER_OUTPUT_LIMIT") throw error;
          record("detached.logs.retry", { attempt: attempt + 1 });
        }
      }
      // Only a complete log response reaches the archive parser. Failed reads
      // cannot leave partial or duplicated archive frames in its accumulator.
      process.stdout.end(logs.stdout);
      process.stderr.end(logs.stderr);
      process.emit("exit", state.ExitCode, null);
      await Promise.all([process.stdout, process.stderr].map((stream) => stream.readableEnded
        ? Promise.resolve() : new Promise((resolve) => stream.once("end", resolve))));
      process.emit("close", state.ExitCode, null);
    } catch (error) {
      process.stdout.end(); process.stderr.end();
      process.emit("error", error);
    }
  });
  return process;
}
