import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, check, string } from "../errors.mjs";
import { PIP_MIRRORS, directChildEnv } from "./paddle-local.mjs";
import { runConfined, runSeatbelt } from "./python-sandbox.mjs";

// 科研计算环境：一套独立的 Python 虚拟环境（pandas / scipy / statsmodels /
// lifelines / scikit-learn / matplotlib），在系统级沙箱中运行分析代码：
// macOS 用 Seatbelt，Windows 用 AppContainer + Job 对象
// （assets/appcontainer-run.ps1）。
//
// 与 calculate_python 同样默认拒绝：禁网、禁子进程、只能读 Python 运行库，
// 只能写本次运行的临时目录（用来存图）。数据以 stdin JSON 传入并在沙箱内
// 变成 DataFrame；原始行不进模型上下文，模型只拿到代码赋给 result 的汇总。
// 安装只在用户点击后执行；不支持的平台失败关闭，不会无沙箱降级。
//
// 产物布局：<dataDir>/research-python/venv、install.json（含已装包版本，
// 写进每次分析的出处，便于复现）。MEDICAL_RESEARCH_PYTHON 可指定已装好
// 这些包的可信解释器（跳过安装）。

export const RESEARCH_PACKAGES = [
  "numpy>=1.24,<3",
  "pandas>=2.0,<3",
  "scipy>=1.10",
  "statsmodels>=0.14",
  "lifelines>=0.27",
  "scikit-learn>=1.3",
  "matplotlib>=3.7",
];
const MODULES = ["numpy", "pandas", "scipy", "statsmodels", "lifelines", "sklearn", "matplotlib"];
const VERSION_PROBE = `import json,importlib
out={}
for m in ${JSON.stringify(MODULES)}:
    try: out[m]=importlib.import_module(m).__version__
    except Exception as e: out[m]=None
import sys,platform
import sysconfig
paths=sysconfig.get_paths()
print(json.dumps({"python":platform.python_version(),"executable":sys.executable,"baseExecutable":getattr(sys,"_base_executable",sys.executable),"prefix":sys.prefix,"base":sys.base_prefix,"site":sorted({paths["purelib"],paths["platlib"]}),"modules":out}))`;

// 两种调用方式：macOS 经 stdin/stdout 传 JSON；Windows 经文件传
// （argv: 输入文件 输出文件 [site-packages...]），因为 Windows 上直接
// 用基础解释器启动（venv 的 python.exe 是会再起子进程的转发器，而 Job
// 对象禁止子进程），venv 的 site-packages 由这里加入。
const WRAPPER = String.raw`import sys,json,os,io,math,contextlib
if os.name!="nt":
    import resource
    resource.setrlimit(resource.RLIMIT_CPU,(__CPU__,__CPU__))
    resource.setrlimit(resource.RLIMIT_FSIZE,(20000000,20000000))
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
if len(sys.argv)>2:
    import site
    for p in sys.argv[3:]: site.addsitedir(p)
    with open(sys.argv[1],encoding="utf-8") as f: request=json.load(f)
else:
    request=json.load(sys.stdin)
import pandas as pd, numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.rcParams["font.sans-serif"]=["Hiragino Sans GB","PingFang SC","STHeiti","Heiti TC","Microsoft YaHei","SimHei","Arial Unicode MS","DejaVu Sans"]
plt.rcParams["axes.unicode_minus"]=False
tables={name:pd.DataFrame(rows) for name,rows in request["tables"].items()}
scope={"tables":tables,"pd":pd,"np":np,"plt":plt,"__name__":"__research_sandbox__"}
log=io.StringIO()
with contextlib.redirect_stdout(log):
    exec(compile(request["code"],"<research-analysis>","exec"),scope)
for i,num in enumerate(plt.get_fignums()):
    fig=plt.figure(num)
    name="figure_%d.png"%(i+1)
    if not os.path.exists(name): fig.savefig(name,dpi=144,bbox_inches="tight")
def clean(v):
    if isinstance(v,dict): return {str(k):clean(x) for k,x in v.items()}
    if isinstance(v,(list,tuple,set)): return [clean(x) for x in v]
    if isinstance(v,pd.DataFrame): return clean(v.reset_index().to_dict(orient="records") if not isinstance(v.index,pd.RangeIndex) else v.to_dict(orient="records"))
    if isinstance(v,pd.Series): return clean(v.to_dict())
    if isinstance(v,np.ndarray): return clean(v.tolist())
    if isinstance(v,np.generic): v=v.item()
    if isinstance(v,float) and not math.isfinite(v): return None
    if isinstance(v,(str,int,float,bool)) or v is None: return v
    return str(v)
payload=json.dumps({"result":clean(scope.get("result")),"log":log.getvalue()[-8000:]},ensure_ascii=False,allow_nan=False)
if len(sys.argv)>2:
    with open(sys.argv[2],"w",encoding="utf-8") as f: f.write(payload)
else:
    sys.stdout.write(payload)
`;

const WINDOWS = process.platform === "win32";
const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), "assets", "appcontainer-run.ps1");
const POWERSHELL = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const venvPython = (root) => (WINDOWS ? join(root, "venv", "Scripts", "python.exe") : join(root, "venv", "bin", "python"));
// Windows 命令行参数转义（CommandLineToArgvW 规则）。
export const quoteWindowsArg = (value) => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
const parseVersion = (text) => {
  const match = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? { major: +match[1], minor: +match[2], text: match[0] } : null;
};
const versionOk = (v) => v && v.major === 3 && v.minor >= 9 && v.minor <= 13;

function defaultRunner(spec, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(spec.cmd, spec.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(options.env ? { env: options.env } : {}) });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill(), options.timeoutMs || 600000);
    child.stdout.on("data", (part) => (stdout += part));
    child.stderr.on("data", (part) => (stderr += part));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? done({ stdout, stderr }) : reject(Object.assign(new Error(stderr || stdout || `退出码 ${code}`), { stdout, stderr }));
    });
  });
}

export class ResearchPython {
  constructor({ dataDir, python = process.env.MEDICAL_RESEARCH_PYTHON, runner = defaultRunner, timeoutMs = 120000, memoryMb = 2048, maxActive = 1 } = {}) {
    this.root = dataDir ? join(dataDir, "research-python") : null;
    this.override = python || null;
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.memoryMb = memoryMb;
    this.maxActive = maxActive;
    this.active = 0;
    this.install = null;
    this.env = null; // 探测结果缓存：{python, roots, modules}
  }

  manifest() {
    if (!this.root) return null;
    try {
      return JSON.parse(readFileSync(join(this.root, "install.json"), "utf8"));
    } catch {
      return null;
    }
  }

  interpreter() {
    if (this.override) return this.override;
    const manifest = this.manifest();
    return manifest?.ready && this.root && existsSync(venvPython(this.root)) ? venvPython(this.root) : null;
  }

  supported() {
    if (WINDOWS) return existsSync(POWERSHELL) && existsSync(LAUNCHER);
    return process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
  }

  status() {
    const manifest = this.manifest();
    return {
      supported: this.supported(),
      installed: Boolean(this.interpreter()),
      source: this.override ? "env" : manifest?.ready ? "managed" : null,
      python: manifest?.python || this.env?.python || null,
      modules: manifest?.modules || this.env?.modules || null,
      installing: Boolean(this.install?.promise),
      step: this.install?.step || null,
      error: this.install?.error || manifest?.lastError || null,
      packages: RESEARCH_PACKAGES,
      limits: { timeoutMs: this.timeoutMs, memoryMb: this.memoryMb, network: false, childProcesses: false, writes: "仅本次运行的临时目录" },
      backend: WINDOWS ? "windows-appcontainer" : "macos-seatbelt",
      ...(this.supported() ? {} : { reason: "科研计算沙箱目前只支持 macOS（Seatbelt）和 Windows（AppContainer）；其他平台不会无沙箱运行" }),
    };
  }

  // 解析解释器真实路径与需要放行读取的目录；venv 要按 venv 路径启动才能
  // 加载自己的 site-packages，所以执行路径和真实路径都要放行。
  async probe() {
    const python = this.interpreter();
    check(this.supported(), "RESEARCH_SANDBOX_UNAVAILABLE", this.status().reason, 503);
    check(python, "RESEARCH_PYTHON_MISSING", "科研计算环境尚未安装：请在「设置 → 科研计算环境」点击安装（约 300MB，需要联网一次）。", 503);
    if (this.env?.interpreter === python) return this.env;
    const info = JSON.parse(execFileSync(python, ["-I", "-c", VERSION_PROBE], { encoding: "utf8", timeout: 60000, env: {} }));
    const missing = MODULES.filter((m) => !info.modules[m]);
    check(!missing.length, "RESEARCH_PYTHON_MISSING", `科研计算环境缺少：${missing.join("、")}。请在设置里重新安装。`, 503);
    const real = (path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    };
    // macOS framework 版 Python 的 bin/python 会再 posix_spawn 包内的
    // Python.app 可执行文件，只放行这一个文件。
    const framework = join(real(info.base), "Resources/Python.app/Contents/MacOS/Python");
    if (WINDOWS) {
      const base = real(info.baseExecutable || info.executable);
      this.env = {
        interpreter: python,
        launcher: base,
        python: info.python,
        modules: info.modules,
        site: info.site,
        readDirs: [...new Set([dirname(base), real(info.base), ...info.site.map(real), real(info.prefix)])],
      };
      return this.env;
    }
    this.env = {
      launcher: python,
      python: info.python,
      modules: info.modules,
      exec: [...new Set([python, real(python), info.executable, real(info.executable), ...(existsSync(framework) ? [framework] : [])])],
      roots: [...new Set([real(info.prefix), real(info.base), info.prefix, info.base])],
    };
    this.env.interpreter = python;
    return this.env;
  }

  profile(workdir) {
    const q = (value) => JSON.stringify(value);
    const env = this.env;
    return `(version 1)
(deny default)
${env.exec.map((p) => `(allow process-exec (literal ${q(p)}))`).join("\n")}
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "/System/Library") (subpath "/usr/lib") (subpath "/Library/Fonts")
  ${env.roots.map((p) => `(subpath ${q(p)})`).join(" ")}
  ${env.exec.map((p) => `(literal ${q(p)})`).join(" ")}
  (subpath "/opt/homebrew/Cellar/gettext") (subpath "/opt/homebrew/opt")
  (subpath ${q(workdir)})
  (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write* (subpath ${q(workdir)}) (literal "/dev/null"))`;
  }

  async runWindows(env, workdir, input, signal) {
    const files = { wrapper: join(workdir, "wrapper.py"), input: join(workdir, "input.json"), output: join(workdir, "output.json") };
    writeFileSync(files.wrapper, WRAPPER.replace(/__CPU__/g, "0"));
    writeFileSync(files.input, input);
    const pythonArgs = ["-I", "-B", files.wrapper, files.input, files.output, ...env.site].map(quoteWindowsArg).join(" ");
    const stdout = await runConfined({
      command: POWERSHELL,
      args: [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", LAUNCHER,
        "-Python", env.launcher,
        "-WorkDir", workdir,
        "-ReadDirs", env.readDirs.join("|"),
        // PowerShell 5.1 的 -File 会吞掉参数里的引号，所以 base64 传递。
        "-ArgumentsBase64", Buffer.from(pythonArgs, "utf8").toString("base64"),
        "-MemoryMb", String(this.memoryMb),
      ],
      cwd: workdir,
      // 启动器本身需要的 Windows 基础变量（缺 PATHEXT 时 PowerShell 不认 .exe）；
      // 沙箱内 Python 另用最小环境，不继承这些。
      env: Object.fromEntries(
        ["SystemRoot", "windir", "PATH", "PATHEXT", "ComSpec", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PSModulePath"]
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      ),
      timeoutMs: this.timeoutMs + 30000, // 首次需编译启动器
      maxOutput: 4_000_000,
      signal,
    });
    void stdout;
    try {
      return readFileSync(files.output, "utf8");
    } catch {
      throw new AppError("SANDBOX_RESULT", "分析没有产出结果（沙箱进程可能被内存或时间限制终止）", 422);
    }
  }

  async run({ code, tables, signal }) {
    string(code, "分析代码", 40000);
    const env = await this.probe();
    check(this.active < this.maxActive, "SANDBOX_CAPACITY", "科研计算正在运行，请等上一项分析结束", 429);
    const input = JSON.stringify({ code, tables });
    check(Buffer.byteLength(input) <= 50_000_000, "SANDBOX_INPUT", "研究数据超过 50MB，请先缩小队列", 413);
    signal?.throwIfAborted();
    this.active++;
    let workdir;
    try {
      workdir = realpathSync(await mkdtemp(join(tmpdir(), "research-sandbox-")));
      const output = WINDOWS ? await this.runWindows(env, workdir, input, signal) : await runSeatbelt({
        profile: this.profile(workdir),
        argv: [env.launcher, "-I", "-B", "-c", WRAPPER.replace(/__CPU__/g, String(Math.ceil(this.timeoutMs / 1000)))],
        cwd: workdir,
        input,
        env: { LANG: "en_US.UTF-8", MPLCONFIGDIR: workdir, TMPDIR: workdir, HOME: workdir, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" },
        timeoutMs: this.timeoutMs,
        maxOutput: 4_000_000,
        memoryKb: this.memoryMb * 1024,
        signal,
      });
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch {
        throw new AppError("SANDBOX_RESULT", "分析代码不要直接写 stdout；把 JSON 兼容的汇总结果赋给 result", 422);
      }
      const figures = [];
      for (const name of (await readdir(workdir)).filter((n) => /\.png$/i.test(n)).sort().slice(0, 8)) {
        const path = join(workdir, name);
        if ((await stat(path)).size <= 4_000_000) figures.push({ name, data: await readFile(path) });
      }
      return { result: parsed.result ?? null, log: parsed.log || "", figures, environment: { python: env.python, modules: env.modules } };
    } finally {
      if (workdir) await rm(workdir, { recursive: true, force: true });
      this.active--;
    }
  }

  startInstall() {
    check(this.root, "INVALID_INPUT", "科研计算环境需要数据目录");
    check(!this.install?.promise, "RESEARCH_PYTHON_BUSY", "科研计算环境正在安装", 409);
    this.install = { promise: null, step: "准备", error: null };
    const promise = this.runInstall()
      .then((status) => {
        this.install = { promise: null, step: "完成", error: null };
        return status;
      })
      .catch((error) => {
        const message = error instanceof AppError ? error.message : `安装失败：${error.message}`;
        this.install = { promise: null, step: this.install?.step, error: message };
        try {
          mkdirSync(this.root, { recursive: true });
          writeFileSync(join(this.root, "install.json"), JSON.stringify({ ...(this.manifest() || {}), ready: false, lastError: message }, null, 2));
        } catch {}
        throw error;
      });
    this.install.promise = promise;
    promise.catch(() => {});
    return promise;
  }

  async runInstall() {
    const step = (name) => (this.install = { ...this.install, step: name });
    check(this.supported(), "RESEARCH_SANDBOX_UNAVAILABLE", this.status().reason, 503);
    step("检测 Python");
    let base = null;
    const candidates = WINDOWS
      ? [["py", "-3.12"], ["py", "-3.11"], ["py", "-3.13"], ["py", "-3.10"], ["python"]]
      : [["python3.12"], ["python3.11"], ["python3.13"], ["python3.10"], ["python3"]];
    for (const [cmd, ...prefix] of candidates) {
      try {
        const version = parseVersion((await this.runner({ cmd, args: [...prefix, "-c", "import platform;print(platform.python_version())"] }, { timeoutMs: 15000 })).stdout);
        if (versionOk(version)) {
          base = { cmd, prefix, version };
          break;
        }
      } catch {}
    }
    check(base, "RESEARCH_PYTHON_MISSING", `未检测到 Python 3.9–3.13。请先安装 Python（${WINDOWS ? "python.org 安装包，勾选 Add python.exe to PATH" : "python.org 或 Homebrew"}），再回到这里重试。`, 400);
    mkdirSync(this.root, { recursive: true });
    if (!existsSync(venvPython(this.root))) {
      step("创建虚拟环境");
      await this.runner({ cmd: base.cmd, args: [...base.prefix, "-m", "venv", join(this.root, "venv")] }, { timeoutMs: 300000 });
    }
    let pipError = null;
    for (const mirror of PIP_MIRRORS) {
      step(`安装科研依赖${mirror.url ? `（${new URL(mirror.url).host}）` : "（官方源）"}`);
      try {
        await this.runner(
          {
            cmd: venvPython(this.root),
            args: [
              "-m", "pip", "install", "--disable-pip-version-check", "--timeout", "30", "--retries", "1",
              ...RESEARCH_PACKAGES,
              ...(mirror.url ? ["-i", mirror.url] : []),
              ...(mirror.trustedHosts || []).flatMap((host) => ["--trusted-host", host]),
            ],
          },
          { timeoutMs: 3600000, env: directChildEnv() },
        );
        pipError = null;
        break;
      } catch (error) {
        pipError = error;
      }
    }
    if (pipError) {
      const tail = String(pipError.stderr || pipError.message).trim().split("\n").slice(-3).join("；").slice(0, 400);
      throw new AppError("RESEARCH_PYTHON_PIP", `依赖安装失败（已试过清华/阿里镜像与官方源）：${tail}。多为网络波动，可稍后重试。`);
    }
    step("验证沙箱");
    const info = JSON.parse((await this.runner({ cmd: venvPython(this.root), args: ["-I", "-c", VERSION_PROBE] }, { timeoutMs: 120000 })).stdout);
    writeFileSync(join(this.root, "install.json"), JSON.stringify({ ready: true, installedAt: new Date().toISOString(), python: info.python, modules: info.modules }, null, 2));
    this.env = null;
    await this.run({ code: "result=int(np.arange(4).sum())", tables: {} });
    return this.status();
  }
}
