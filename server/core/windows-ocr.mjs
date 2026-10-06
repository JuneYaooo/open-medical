import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "../errors.mjs";

const ocrScript = resolve(import.meta.dirname, "../../desktop/bin/native-ocr.ps1");
export const windowsOcrAvailable = () =>
  process.platform === "win32" && existsSync(ocrScript);

const MAX_STDOUT = 24_000_000;

function runScript(script, input, timeout, signal) {
  return new Promise((done, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let output = "",
      errors = "",
      settled = false;
    const timer = setTimeout(() => child.kill(), timeout);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else done(value);
    };
    const onAbort = () => child.kill();
    if (signal) {
      if (signal.aborted) child.kill();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (part) => {
      output += part.toString();
      if (output.length > MAX_STDOUT) child.kill();
    });
    child.stderr.on("data", (part) => {
      errors += part.toString();
      if (errors.length > 100000) errors = errors.slice(-50000);
    });
    child.on("error", () =>
      finish(
        new AppError(
          "WINDOWS_OCR",
          "Windows 本地文字识别组件不可用，请重新安装工作台",
          503,
        ),
      ),
    );
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (settled) return;
      let parsed = null;
      try {
        parsed = JSON.parse(output);
      } catch {}
      if (parsed?.error)
        return finish(new AppError("WINDOWS_OCR", parsed.error, 503));
      if (code || !parsed)
        return finish(
          new AppError(
            "WINDOWS_OCR",
            signal?.aborted
              ? "文字识别已取消"
              : `本地文字识别未完成${errors.trim() ? `：${errors.trim().split("\n")[0].slice(0, 160)}` : ""}`,
            503,
          ),
        );
      finish(null, parsed);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input), "utf8");
  });
}

export async function recognizeWindowsImage(data, signal, options = {}) {
  const result = await runScript(
    ocrScript,
    {
      image: data.toString("base64"),
      region: options.region,
      scale: options.scale,
    },
    45000,
    signal,
  );
  return {
    width: result.width,
    height: result.height,
    lines: result.lines,
    // 与 macOS OCR 一致:includeImage 时回传截图作为采集证据。
    image: options.includeImage ? data.toString("base64") : undefined,
  };
}
