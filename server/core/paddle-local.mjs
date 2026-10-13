import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AppError, check } from "../errors.mjs";

// 本机 PaddleOCR 引擎管理器：把「装一套本机 PaddleOCR」从部署文档变成一个
// 用户点一下的按钮。只在用户明确点击时执行（绝不后台强装），每一步结果都
// 上报；任何一步失败如实报错并给出下一步建议——装不上不是错误状态，医生
// 仍可手填 gpu-worker 服务地址或继续用系统组件。
//
// 产物布局（数据目录下，随库走、可整体删除）：
//   <dataDir>/paddle-ocr/venv/        Python 虚拟环境（不污染系统 Python）
//   <dataDir>/paddle-ocr/worker.py    讲 /v1/ocr 契约的回环 HTTP 服务
//   <dataDir>/paddle-ocr/install.json 安装记录（python 版本、端口）
//
// 服务契约与 medagent-gpu-worker 完全一致（POST /v1/ocr/records、GET
// /health），因此上层 recognizeViaService 无需知道对面是远端 worker 还是
// 本机引擎。

const PINNED_PACKAGES = ["paddleocr==2.7.3", "paddlepaddle==2.6.2", "numpy<2"];
// 国内网络下 pypi 官方源常不可达；镜像逐个试，最后回退官方。
const PIP_MIRRORS = [
  "https://pypi.tuna.tsinghua.edu.cn/simple",
  "https://mirrors.aliyun.com/pypi/simple",
  "",
];
const HEALTH_TIMEOUT = 300000; // 首次启动要下载识别模型，给足 5 分钟
const PYTHON_SCRIPT = "import sys,platform;print(platform.python_version())";

const venvPythonPath = (root) =>
  process.platform === "win32"
    ? join(root, "venv", "Scripts", "python.exe")
    : join(root, "venv", "bin", "python");

function parseVersion(text) {
  const match = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? { major: +match[1], minor: +match[2], text: match[0] } : null;
}

const versionOk = (v) => v && (v.major > 3 || (v.major === 3 && v.minor >= 9)) && (v.major < 3 || (v.major === 3 && v.minor <= 12));

export class PaddleLocal {
  // pythonLocator/runner/healthCheck 供测试注入，保持 hermetic：
  //   pythonLocator(): Promise<[{cmd,args[]}]|null>  可用的 Python 命令
  //   runner({cmd,args}, {timeoutMs, onOutput}): Promise<{stdout,stderr}>
  //   healthCheck(url, timeoutMs): Promise<bool>
  constructor({ dataDir, port = 18095, pythonLocator, runner, healthCheck, spawner, healthTimeoutMs = HEALTH_TIMEOUT } = {}) {
    check(dataDir, "INVALID_INPUT", "本机引擎需要数据目录");
    this.root = join(dataDir, "paddle-ocr");
    this.port = port;
    this.healthTimeoutMs = healthTimeoutMs;
    this.spawner = spawner || spawn;
    this.pythonLocator =
      pythonLocator || (async () => {
        const candidates =
          process.platform === "win32"
            ? [["py"], ["python3"], ["python"]]
            : [["python3"], ["python"]];
        for (const cmd of candidates) {
          try {
            const result = await this.run({ cmd: cmd[0], args: [...cmd.slice(1), "-c", PYTHON_SCRIPT] }, { timeoutMs: 15000 });
            const version = parseVersion(result.stdout);
            if (version) return [{ cmd: cmd[0], args: cmd.slice(1), version: version.text }];
          } catch {}
        }
        return null;
      });
    this.runner =
      runner ||
      ((spec, options = {}) =>
        new Promise((done, reject) => {
          const child = spawn(spec.cmd, spec.args, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
          let stdout = "", stderr = "";
          const timer = setTimeout(() => child.kill(), options.timeoutMs || 600000);
          child.stdout.on("data", (part) => {
            stdout += part;
            options.onOutput?.(part.toString());
          });
          child.stderr.on("data", (part) => {
            stderr += part;
            options.onOutput?.(part.toString());
          });
          child.on("error", (error) => { clearTimeout(timer); reject(error); });
          child.on("close", (code) => {
            clearTimeout(timer);
            code === 0 ? done({ stdout, stderr }) : reject(Object.assign(new Error(stderr || stdout || `退出码 ${code}`), { code, stdout, stderr }));
          });
        }));
    this.healthCheck =
      healthCheck ||
      (async (url, timeoutMs) => {
        const bounded = AbortSignal.timeout(3000);
        try {
          const response = await fetch(join2(url, "/health"), { signal: bounded });
          return response.ok;
        } catch {
          void timeoutMs;
          return false;
        }
      });
    this.child = null;
    this.baseUrl = null;
    this.install = null; // { promise, step, detail, error }
  }

  run(spec, options) {
    return this.runner(spec, options);
  }

  manifest() {
    try {
      return JSON.parse(readFileSync(join(this.root, "install.json"), "utf-8"));
    } catch {
      return null;
    }
  }

  workerPath() {
    return join(this.root, "worker.py");
  }

  venvReady() {
    return existsSync(venvPythonPath(this.root));
  }

  // 供「保存服务配置」时识别这是不是本机引擎的地址。
  ownsBaseUrl(baseUrl) {
    const manifest = this.manifest();
    return Boolean(manifest?.port) && String(baseUrl || "").includes(`:${manifest.port}`);
  }

  async probeRunning(port) {
    return this.healthCheck(`http://127.0.0.1:${port}`, 3000);
  }

  status() {
    const manifest = this.manifest();
    return {
      root: this.root,
      installed: Boolean(manifest?.ready && this.venvReady()),
      python: manifest?.python || null,
      port: manifest?.port || this.port,
      baseUrl: manifest?.port ? `http://127.0.0.1:${manifest.port}` : null,
      running: Boolean(this.child && !this.child.killed),
      installing: Boolean(this.install?.promise),
      step: this.install?.step || null,
      detail: this.install?.detail || null,
      error: this.install?.error || manifest?.lastError || null,
      packages: PINNED_PACKAGES,
    };
  }

  // 应用重启后接续：装过且服务配置仍指向本机引擎时，拉起或收养残留进程。
  async resume({ wantsService } = {}) {
    const manifest = this.manifest();
    if (!manifest?.ready || !this.venvReady()) return false;
    const url = `http://127.0.0.1:${manifest.port}`;
    if (wantsService && !wantsService(url)) return false;
    if (await this.probeRunning(manifest.port)) {
      this.baseUrl = url;
      this.child = { killed: false, adopted: true }; // 上次退出没杀干净，直接用
      return true;
    }
    try {
      await this.startWorker(manifest.port);
      return true;
    } catch {
      return false;
    }
  }

  async startInstall() {
    check(!this.install?.promise, "OCR_LOCAL_BUSY", "本机引擎正在安装中", 409);
    this.install = { promise: null, step: "准备", detail: null, error: null };
    const promise = this.runInstall()
      .then((status) => {
        this.install = { ...this.install, step: "完成", error: null };
        return status;
      })
      .catch((error) => {
        const message = error instanceof AppError ? error.message : `安装失败：${error.message}`;
        this.install = { ...this.install, error: message };
        // 失败原因留在 install.json，重启后设置页仍能看到上次为什么没装成。
        try {
          mkdirSync(this.root, { recursive: true });
          const manifest = this.manifest();
          writeFileSync(
            join(this.root, "install.json"),
            JSON.stringify({ ...(manifest || { port: this.port }), partial: true, lastError: message }, null, 2),
          );
        } catch {}
        throw error;
      });
    this.install.promise = promise;
    // 调用方（HTTP 路由）拿 202 后轮询 status；这里把异常转成可读拒绝原因。
    promise.catch(() => {});
    return promise;
  }

  async runInstall() {
    const step = (name, detail) => {
      this.install = { ...this.install, step: name, detail: detail || null };
    };
    // ① Python：没有就明确告知怎么装，不越权代装系统级软件。
    step("检测 Python");
    const found = await this.pythonLocator();
    check(found?.length, "OCR_LOCAL_PYTHON",
      "未检测到 Python。请先安装 Python 3.9–3.12（python.org 安装包勾选 Add python.exe to PATH，或用 Microsoft Store 版），装好后回到这里点「在本机安装」重试；也可以继续用系统识别组件，或在有 GPU 的机器上部署 gpu-worker 服务后填入上方接口地址。");
    const python = found[0];
    const version = parseVersion(python.version || (await this.run({ cmd: python.cmd, args: [...python.args, "-c", PYTHON_SCRIPT] }, { timeoutMs: 15000 })).stdout);
    check(versionOk(version), "OCR_LOCAL_PYTHON",
      `检测到 Python ${version?.text || "版本未知"}，PaddleOCR 目前需要 3.9–3.12。请安装受支持版本后重试；也可以继续用系统识别组件或远程 gpu-worker 服务。`);
    step("检测 Python", `找到 Python ${version.text}（${python.cmd}）`);

    mkdirSync(this.root, { recursive: true });
    const port = this.port;
    // ② 虚拟环境：隔离安装，不碰系统 Python 的任何包。
    if (!this.venvReady()) {
      step("创建虚拟环境", python.cmd);
      try {
        await this.run({ cmd: python.cmd, args: [...python.args, "-m", "venv", join(this.root, "venv")] }, { timeoutMs: 300000 });
      } catch (error) {
        throw new AppError("OCR_LOCAL_VENV",
          `创建虚拟环境失败：${String(error.stderr || error.stdout || error.message).trim().slice(0, 300)}。可删除 <数据目录>/paddle-ocr 后重试；也可以继续用系统识别组件或远程 gpu-worker 服务。`);
      }
    } else {
      step("创建虚拟环境", "已存在，复用");
    }
    const venvPython = venvPythonPath(this.root);

    // ③ 依赖：固定版本 + 逐镜像尝试；失败把 pip 的尾巴带出来。
    let pipError = null;
    for (const mirror of PIP_MIRRORS) {
      step("安装 PaddleOCR 依赖", mirror ? `镜像 ${new URL(mirror).host}` : "官方 pypi（约 300MB，视网络可能要几分钟）");
      try {
        await this.run(
          {
            cmd: venvPython,
            args: ["-m", "pip", "install", "--disable-pip-version-check", ...PINNED_PACKAGES, ...(mirror ? ["-i", mirror] : [])],
          },
          { timeoutMs: 3600000, onOutput: () => {} },
        );
        pipError = null;
        break;
      } catch (error) {
        pipError = error;
      }
    }
    if (pipError) {
      const tail = String(pipError.stderr || pipError.stdout || pipError.message || "").trim().split("\n").slice(-3).join("；").slice(0, 400);
      throw new AppError("OCR_LOCAL_PIP",
        `依赖安装失败（已试过清华/阿里镜像与官方源）：${tail || pipError.message}。多为网络波动，可稍后重试（已下载的部分会复用）；也可以继续用系统识别组件，或部署 gpu-worker 服务后填入接口地址。`);
    }

    // ④ 服务脚本 + 启动 + 健康检查（首次要下载识别模型）。
    step("写入识别服务");
    writeFileSync(this.workerPath(), workerScript());
    step("启动识别服务", "首次启动需下载识别模型（约 20MB）");
    await this.startWorker(port);

    const manifest = {
      installedAt: new Date().toISOString(),
      python: { version: version.text, command: python.cmd },
      port,
      ready: true,
    };
    writeFileSync(join(this.root, "install.json"), JSON.stringify(manifest, null, 2));
    step("完成", `本机引擎已运行：http://127.0.0.1:${port}`);
    return this.status();
  }

  async startWorker(port) {
    check(this.venvReady(), "OCR_LOCAL_PYTHON", "本机引擎尚未安装，请先安装", 400);
    if (await this.probeRunning(port)) {
      this.baseUrl = `http://127.0.0.1:${port}`;
      this.child = { killed: false, adopted: true };
      return this.baseUrl;
    }
    const venvPython = venvPythonPath(this.root);
    this.child = this.spawner(venvPython, [this.workerPath(), String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderrTail = "";
    this.child.stderr.on("data", (part) => {
      stderrTail = (stderrTail + part).slice(-4000);
    });
    const started = await this.waitHealth(port, this.healthTimeoutMs);
    if (!started) {
      const child = this.child;
      this.child = null;
      try { child.kill(); } catch {}
      const tail = stderrTail.trim().split("\n").slice(-3).join("；").slice(0, 400);
      throw new AppError("OCR_LOCAL_START",
        `本机识别服务未能在 ${HEALTH_TIMEOUT / 1000} 秒内就绪${tail ? `：${tail}` : ""}。可在设置里重试启动；若反复失败，删除 <数据目录>/paddle-ocr 后重新安装，或改用远程 gpu-worker 服务。`);
    }
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  async waitHealth(port, timeoutMs = HEALTH_TIMEOUT) {
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.install) this.install = { ...this.install, detail: `等待识别服务就绪（剩余 ${Math.ceil((deadline - Date.now()) / 1000)} 秒）` };
      if (await this.healthCheck(url, 3000)) return true;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return false;
  }

  stop() {
    if (this.child && !this.child.adopted) {
      try { this.child.kill(); } catch {}
    }
    this.child = null;
    this.baseUrl = null;
    return this.status();
  }

  // 彻底卸载：连 venv 带脚本整体删除（服务配置由调用方决定是否清除）。
  uninstall() {
    this.stop();
    try { rmSync(this.root, { recursive: true, force: true }); } catch {}
    return this.status();
  }
}

function join2(base, path) {
  return `${String(base).replace(/\/+$/, "")}${path}`;
}

// 识别服务本体：stdlib HTTP + PaddleOCR，无 FastAPI 依赖。首次运行在构造
// PaddleOCR 时下载模型，完成后 /health 才会 200（管理器据此判断就绪）。
export function workerScript() {
  return String.raw`
# -*- coding: utf-8 -*-
# 本机 PaddleOCR 识别服务（由工作台写入并管理；讲 /v1/ocr 契约）。
import io, json, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18095

def build_ocr():
    from paddleocr import PaddleOCR
    try:
        return PaddleOCR(use_angle_cls=True, lang="ch", show_log=False)
    except TypeError:
        return PaddleOCR(lang="ch")

def read_records(ocr, image):
    import numpy as np, cv2
    data = np.frombuffer(image, np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        return None
    try:
        result = ocr.ocr(img, cls=True)
    except TypeError:
        result = ocr.ocr(img)
    if not result or not result[0]:
        return []
    records = []
    for line in result[0]:
        try:
            box, (text, score) = line[0], line[1]
            records.append({"text": str(text), "box": box, "score": float(score) if score is not None else None})
        except Exception:
            continue
    return records

def extract_upload(body, content_type):
    match = re.search(r'boundary=("?)([^";]+)\1', content_type or "")
    if not match:
        return body
    boundary = b"--" + match.group(2).encode()
    for part in body.split(boundary):
        chunk = part.strip(b"\r\n")
        if not chunk or chunk == b"--":
            continue
        head, _, payload = chunk.partition(b"\r\n\r\n")
        if re.search(rb'name="file"', head) or b"filename=" in head:
            return payload
    return body

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"detail": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length)
            if self.path.rstrip("/") == "/v1/ocr/records":
                image = extract_upload(body, self.headers.get("content-type"))
                records = read_records(OCR, image)
                if records is None:
                    self._send(422, {"detail": "图片无法解码"})
                else:
                    self._send(200, {"records": records})
            elif self.path.rstrip("/") == "/v1/ocr":
                image = extract_upload(body, self.headers.get("content-type"))
                records = read_records(OCR, image)
                if records is None:
                    self._send(422, {"detail": "图片无法解码"})
                else:
                    self._send(200, {"text": "\n".join(r["text"] for r in records)})
            else:
                self._send(404, {"detail": "not found"})
        except Exception as error:
            self._send(500, {"detail": str(error)[:300]})

OCR = build_ocr()
server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
server.serve_forever()
`;
}
