import { spawn, execFile, execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { AppError, check, string } from "../errors.mjs";

// No JavaScript VM or subprocess alone is treated as a security boundary.
// Python executes only behind an OS policy. Unsupported hosts fail closed.
const WRAPPER = `import sys,json,resource,os
resource.setrlimit(resource.RLIMIT_CPU,(3,3))
resource.setrlimit(resource.RLIMIT_FSIZE,(0,0))
resource.setrlimit(resource.RLIMIT_CORE,(0,0))
resource.setrlimit(resource.RLIMIT_NOFILE,(32,32))
request=json.load(sys.stdin)
scope={"sources":request["sources"],"__name__":"__workspace_sandbox__"}
exec(compile(request["code"],"<workspace-sandbox>","exec"),scope)
print(json.dumps({"result":scope.get("result")},ensure_ascii=False,allow_nan=False))
`;

export class PythonSandbox {
  constructor({
    python,
    timeoutMs = 5000,
    maxOutput = 65536,
    maxActive = 2,
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxOutput = maxOutput;
    this.maxActive = maxActive;
    this.active = 0;
    this.backend = "unavailable";
    this.reason = "当前主机没有受支持的 OS 沙箱；代码执行已关闭";
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
      return;
    try {
      this.python = realpathSync(
        python ||
          process.env.MEDICAL_SANDBOX_PYTHON ||
          [
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            "/usr/bin/python3",
          ].find(existsSync) ||
          "/missing/python3",
      );
      const info = JSON.parse(
        execFileSync(
          this.python,
          [
            "-I",
            "-S",
            "-c",
            "import sys,json;print(json.dumps([sys.executable,sys.base_prefix]))",
          ],
          { encoding: "utf8", timeout: 5000, env: {} },
        ),
      );
      this.python = realpathSync(info[0]);
      this.pythonRoot = realpathSync(info[1]);
      const frameworkExecutable = join(
        this.pythonRoot,
        "Resources/Python.app/Contents/MacOS/Python",
      );
      if (existsSync(frameworkExecutable))
        this.python = realpathSync(frameworkExecutable);
      // Only a fixed startup probe runs here. Full boundary tests live in tests/.
      execFileSync(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          this.profile(),
          this.python,
          "-I",
          "-S",
          "-B",
          "-c",
          "print('ready')",
        ],
        { timeout: 5000, env: {}, stdio: "pipe" },
      );
      this.backend = "macos-seatbelt";
      this.reason = null;
    } catch {
      this.reason = "Python 或 macOS Seatbelt 探测失败；不会回退到无沙箱执行";
    }
  }
  profile() {
    const quote = (value) => JSON.stringify(value);
    return `(version 1)
(deny default)
(allow process-exec (literal ${quote(this.python)}))
(allow sysctl-read)
(allow file-read* (literal "/") (subpath "/System/Library") (subpath "/usr/lib")
  (subpath ${quote(this.pythonRoot)}) (literal ${quote(this.python)})
  (subpath "/opt/homebrew/Cellar/gettext")
  (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write* (literal "/dev/null"))`;
  }
  status() {
    return {
      available: this.backend !== "unavailable",
      backend: this.backend,
      reason: this.reason,
      network: false,
      filesystemWrite: false,
      childProcesses: false,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutput,
      maxConcurrent: this.maxActive,
      memoryLimit: "256MiB RSS watchdog (sampled, not a hard quota)",
    };
  }
  async run({ code, sources = [], signal }) {
    check(
      this.backend !== "unavailable",
      "SANDBOX_UNAVAILABLE",
      this.reason,
      503,
    );
    string(code, "Python 代码", 12000);
    check(
      this.active < this.maxActive,
      "SANDBOX_CAPACITY",
      "沙箱并发已满",
      429,
    );
    signal?.throwIfAborted();
    const input = JSON.stringify({ code, sources });
    check(
      Buffer.byteLength(input) <= 512000,
      "SANDBOX_INPUT",
      "沙箱资料超过 500KB",
      413,
    );
    this.active++;
    let directory;
    try {
      directory = await mkdtemp(join(tmpdir(), "workspace-sandbox-"));
      signal?.throwIfAborted();
      const output = await new Promise((resolve, reject) => {
        const child = spawn(
          "/usr/bin/sandbox-exec",
          ["-p", this.profile(), this.python, "-I", "-S", "-B", "-c", WRAPPER],
          {
            cwd: directory,
            env: { LANG: "en_US.UTF-8" },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const outDecoder = new StringDecoder("utf8"),
          errDecoder = new StringDecoder("utf8");
        let closed = false;
        let stdout = "",
          stderr = "",
          bytes = 0,
          failure;
        const stop = (error) => {
          if (closed) return;
          failure ||= error;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        const abort = () => stop(new AppError("CANCELLED", "沙箱已停止", 409));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const timer = setTimeout(
          () =>
            stop(new AppError("SANDBOX_TIMEOUT", "沙箱达到执行时间上限", 422)),
          this.timeoutMs,
        );
        let sampling = false;
        const memoryTimer = setInterval(() => {
          if (sampling || !child.pid) return;
          sampling = true;
          execFile(
            "/bin/ps",
            ["-o", "rss=", "-p", String(child.pid)],
            { timeout: 1000, maxBuffer: 1024 },
            (error, rss) => {
              sampling = false;
              if (!error && Number(rss.trim()) > 256 * 1024)
                stop(
                  new AppError("SANDBOX_MEMORY", "沙箱达到内存监测上限", 422),
                );
            },
          );
        }, 100);
        const collect = (chunk, target) => {
          bytes += chunk.length;
          if (bytes > this.maxOutput)
            return stop(
              new AppError("SANDBOX_OUTPUT", "沙箱输出超过上限", 422),
            );
          if (target === "out") stdout += outDecoder.write(chunk);
          else stderr += errDecoder.write(chunk);
        };
        child.stdout.on("data", (chunk) => collect(chunk, "out"));
        child.stderr.on("data", (chunk) => collect(chunk, "err"));
        child.stdin.on("error", () => {});
        child.once("error", (error) => {
          failure = error;
        });
        child.once("close", (exitCode) => {
          closed = true;
          stdout += outDecoder.end();
          stderr += errDecoder.end();
          clearTimeout(timer);
          clearInterval(memoryTimer);
          signal?.removeEventListener("abort", abort);
          if (failure) return reject(failure);
          if (exitCode !== 0)
            return reject(
              new AppError(
                "SANDBOX_EXECUTION",
                `沙箱执行失败：${stderr.slice(-1500)}`,
                422,
              ),
            );
          resolve(stdout);
        });
        child.stdin.end(input);
      });
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch {
        throw new AppError(
          "SANDBOX_RESULT",
          "请将 JSON 兼容结果赋给 result，不要额外打印内容",
          422,
        );
      }
      check(
        parsed && Object.hasOwn(parsed, "result"),
        "SANDBOX_RESULT",
        "沙箱没有返回结果",
        422,
      );
      return {
        result: parsed.result,
        backend: this.backend,
        provenance: "sandbox_draft",
        status: "draft",
      };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      this.active--;
    }
  }
}
