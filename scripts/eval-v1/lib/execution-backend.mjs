// N1 评测专用受控执行后端:
// 验收器运行被测模块必须经此接口,在真实 OS 隔离边界内执行;后端不可用时
// 明确 blocked,绝不静默回退宿主 Node(复核报告 R1:宿主 spawn 继承仓库
// cwd/环境/权限,可读取评估答案,可无限挂起)。
//
// 协议(防伪造,验收条目 N1-08):
// - 断言值由被测进程内的微型 harness 求值,但判定全部在控制器完成。
// - 结果行以每次运行随机的 32 hex nonce 标记,经 stdin 交给 harness
//   (不出现在 argv/cmdline,被测模块无法靠扫描 /proc 或 env 拿到);
//   控制器只接受恰好一行格式正确且 nonce 匹配的结果,多个/零个/不匹配
//   一律按异常处理,不采信被测代码自行输出的"断言通过"。
// - 每次执行有截止时间、输出上限;超时 kills 整个进程树并报告 timeout。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export const RESULT_PREFIX = "__EVAL_RESULT__";

/** 后端不可用异常:验收器据此把执行类检查记为 blocked,不是 fail。 */
export class BackendUnavailableError extends Error {}

// 有界子进程:截止时间、输出上限、stdin 注入;超时/超限 kill(进程树由
// 后端负责:docker 用容器名 kill,测试适配器是单进程直接 kill)。
function execFileBounded(cmd, args, { timeoutMs, maxOutput, input }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, overflow, ...extra });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish({ timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (c) => {
      if (stdout.length < maxOutput) stdout += c;
      else if (!overflow) {
        overflow = true;
        try {
          child.kill("SIGKILL");
        } catch {}
        finish({ timedOut: false });
      }
    });
    child.stderr?.on("data", (c) => {
      if (stderr.length < maxOutput) stderr += c;
    });
    child.on("error", (error) => finish({ spawnError: error.message }));
    child.on("close", (exitCode) => finish({ exitCode }));
    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    } else child.stdin?.end();
  });
}

/** 解析被测进程输出:必须恰好一行 nonce 匹配的结果;否则视为协议异常。 */
export function parseResultLine(stdout, nonce) {
  const lines = String(stdout)
    .split(/\r?\n/)
    .filter((l) => l.startsWith(RESULT_PREFIX));
  if (lines.length !== 1)
    throw new Error(
      `结果协议异常:期望恰好1条结果行,实际 ${lines.length} 条(疑似伪造或 harness 未输出)`,
    );
  const m = /^__EVAL_RESULT__([0-9a-f]{32}) (.*)$/s.exec(lines[0]);
  if (!m) throw new Error("结果协议异常:结果行格式无效");
  if (m[1] !== nonce) throw new Error("结果协议异常:nonce 不匹配(结果不可信)");
  try {
    return JSON.parse(m[2]);
  } catch (error) {
    throw new Error(`结果协议异常:JSON 解析失败(${error.message})`);
  }
}

/** 构造被测进程内 harness 脚本:只求值,不断言;结果行带 stdin 给出的 nonce。 */
export function buildHarnessScript(moduleUrl, statements) {
  const urlLiteral = JSON.stringify(String(moduleUrl));
  const sets = statements
    .map(
      ([key, expr]) =>
        `try{out[${JSON.stringify(key)}]=${expr}}catch(e){out[${JSON.stringify(key)}]={__throw:String(e && e.message || e)}}`,
    )
    .join(";");
  return [
    `import { readFileSync } from "node:fs";`,
    `const nonce = readFileSync(0, "utf8").trim();`,
    `import(${urlLiteral}).then((m)=>{const out={};${sets};` +
      `process.stdout.write("\\n${RESULT_PREFIX}"+nonce+" "+JSON.stringify(out)+"\\n");` +
      `}).catch((e)=>{process.stdout.write("\\n${RESULT_PREFIX}"+nonce+" "+JSON.stringify({__importError:String(e && e.message || e)})+"\\n");})`,
  ].join("\n");
}

// ---------- Docker 后端(默认;真实 OS 边界) ----------
export class DockerExecBackend {
  constructor({
    image = "open-medical-runtime:0.8-full",
    timeoutMs = 60_000,
    outputLimitBytes = 1_000_000,
  } = {}) {
    this.id = `docker:${image}`;
    this.image = image;
    this.timeoutMs = timeoutMs;
    this.outputLimitBytes = outputLimitBytes;
  }
  async available() {
    const probe = await execFileBounded("docker", ["info", "--format", "ok"], {
      timeoutMs: 15_000,
      maxOutput: 10_000,
    });
    if (probe.spawnError)
      return { ok: false, reason: `docker CLI 不可用:${probe.spawnError}` };
    if (probe.timedOut) return { ok: false, reason: "docker info 超时(daemon 未响应)" };
    if (probe.exitCode !== 0)
      return {
        ok: false,
        reason: "Docker daemon 未运行或无权访问(docker info 失败)",
      };
    const img = await execFileBounded(
      "docker",
      ["image", "inspect", this.image, "--format", "ok"],
      { timeoutMs: 15_000, maxOutput: 10_000 },
    );
    if (img.exitCode !== 0)
      return {
        ok: false,
        reason: `执行镜像缺失:${this.image}(docker image inspect 失败)`,
      };
    return { ok: true };
  }
  // 只挂载测试工作区;不挂载仓库/用户目录/Docker socket;断网;最小环境。
  async run({ root, script, nonce, timeoutMs, outputLimitBytes, workDirName = "work" }) {
    const name = `eval-v1-exec-${randomBytes(6).toString("hex")}`;
    const containerTimeout = Math.min(timeoutMs ?? this.timeoutMs, 120_000);
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "--interactive",
      "--workdir",
      `/mnt/${workDirName}`,
      "--mount",
      `type=bind,src=${root},dst=/mnt/${workDirName}`,
      "--tmpfs",
      "/tmp:rw,size=16m",
      "--env",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      this.image,
      "node",
      "--input-type=module",
      "-e",
      script,
    ];
    const result = await execFileBounded("docker", args, {
      timeoutMs: containerTimeout + 10_000,
      maxOutput: outputLimitBytes ?? this.outputLimitBytes,
      input: nonce,
    });
    if (result.timedOut || result.overflow)
      await this.#killContainer(name); // 进程树/容器整体清理,不留工作进程
    return {
      status: result.timedOut
        ? "timeout"
        : result.overflow
          ? "output_limit"
          : result.spawnError
            ? "error"
            : "completed",
      stdout: result.stdout || "",
      stderr: (result.stderr || "").slice(0, 4000),
      exitCode: result.exitCode,
      spawnError: result.spawnError,
    };
  }
  async #killContainer(name) {
    await execFileBounded("docker", ["kill", name], {
      timeoutMs: 10_000,
      maxOutput: 1000,
    });
    await execFileBounded("docker", ["rm", "-f", name], {
      timeoutMs: 10_000,
      maxOutput: 1000,
    });
  }
}

// ---------- 不可用后端:显式 blocked,不做宿主回退 ----------
export class UnavailableBackend {
  constructor(reason) {
    this.id = "unavailable";
    this.reason = reason;
  }
  async available() {
    return { ok: false, reason: this.reason };
  }
  async run() {
    throw new BackendUnavailableError(this.reason);
  }
}

// ---------- 测试适配器(仅自测使用;必须标记 mock,不冒充隔离) ----------
// 复核报告与任务书明确:全通过样例需要显式测试适配器并标记 mock。
export class InProcessNodeBackend {
  constructor({ timeoutMs = 20_000, outputLimitBytes = 1_000_000 } = {}) {
    this.id = "mock:in-process-node";
    this.mock = true;
    this.isolation = "none"; // 如实标注:无 OS 隔离,只用于断言逻辑自测
    this.timeoutMs = timeoutMs;
    this.outputLimitBytes = outputLimitBytes;
  }
  async available() {
    return { ok: true, mock: true };
  }
  async run({ script, nonce, timeoutMs, outputLimitBytes }) {
    const r = await execFileBounded(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        timeoutMs: Math.min(timeoutMs ?? this.timeoutMs, 30_000),
        maxOutput: outputLimitBytes ?? this.outputLimitBytes,
        input: nonce,
      },
    );
    return {
      status: r.timedOut
        ? "timeout"
        : r.overflow
          ? "output_limit"
          : r.spawnError
            ? "error"
            : "completed",
      stdout: r.stdout || "",
      stderr: (r.stderr || "").slice(0, 4000),
      exitCode: r.exitCode,
      spawnError: r.spawnError,
    };
  }
}

// ---------- 脚本化后端(纯协议测试;不执行任何代码) ----------
export class ScriptedBackend {
  constructor(responses) {
    this.id = "mock:scripted";
    this.mock = true;
    this.isolation = "none";
    this.responses = responses; // 数组:依次弹出;或函数({script, nonce}) => result
    this.calls = [];
  }
  async available() {
    return { ok: true, mock: true };
  }
  async run(input) {
    this.calls.push(input);
    if (typeof this.responses === "function") return this.responses(input);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

export async function createEvalBackend({ image } = {}) {
  const backend = new DockerExecBackend({ image });
  const probe = await backend.available();
  if (probe.ok) return backend;
  return new UnavailableBackend(probe.reason);
}
