import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { AppError } from "../errors.mjs";

// Windows 本地 OCR 已提升为 core/windows-ocr.mjs(资料建档等场景共用);此处保持兼容导出。
export {
  recognizeWindowsImage,
  windowsOcrAvailable as windowsWechatAvailable,
} from "../core/windows-ocr.mjs";

const controlScript = resolve(
  import.meta.dirname,
  "../../desktop/bin/native-control.ps1",
);

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
      if (signal.aborted) {
        child.kill();
      } else signal.addEventListener("abort", onAbort, { once: true });
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
          "WECHAT_WINDOWS_CONTROL",
          "Windows 桌面控制组件不可用，请重新安装工作台",
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
        return finish(
          new AppError("WECHAT_WINDOWS_CONTROL", parsed.error, 503),
        );
      if (code || !parsed)
        return finish(
          new AppError(
            "WECHAT_WINDOWS_CONTROL",
            signal?.aborted
              ? "桌面控制已取消"
              : `桌面控制未完成${errors.trim() ? `：${errors.trim().split("\n")[0].slice(0, 160)}` : ""}`,
            503,
          ),
        );
      finish(null, parsed);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input), "utf8");
  });
}

export class WindowsWechatControl {
  constructor({ app = "微信,WeChat,Weixin" } = {}) {
    this.app = app;
  }
  invoke(input, signal) {
    return runScript(controlScript, { ...input, app: this.app }, 20000, signal);
  }
  async capture(windowId, signal) {
    const result = await runScript(
      controlScript,
      { action: "capture", windowId: String(windowId) },
      30000,
      signal,
    );
    return Buffer.from(result.image, "base64");
  }
}

const FLAT_NOISE =
  /[\s，,。.!！?？:：;；、·"'“”‘’()（）【】[\]{}<>《》—\-–_…~～@#$%^&*+=|\\/`。〔〕［］]/gu;

// OCR 对小字号中文存在形近字与丢字，精确匹配不可行：归一化后用最长公共子序列比例，
// 并要求全部 ASCII 锚点词（如药名、编号）逐一出现。拉丁字母形近字（l/I、O/0、S/5
// 等）两侧同映射后再比对，避免 MedicaI/Medical 这类误判。
export function flattenForMatch(text) {
  return String(text)
    .toLowerCase()
    .replace(/[l|i]/g, "1")
    .replace(/[o]/g, "0")
    .replace(/[s]/g, "5")
    .replace(/[b]/g, "8")
    .replace(/[z]/g, "2")
    .replace(FLAT_NOISE, "");
}

function lcsLength(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      cur[j] =
        ca === b.charCodeAt(j - 1)
          ? prev[j - 1] + 1
          : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

export function ocrLinesText(lines) {
  return lines.map((l) => l.text).join(" ");
}

export function verifyOcrContains(probe, lines, { minRatio = 0.75 } = {}) {
  const haystack = flattenForMatch(ocrLinesText(lines));
  const needle = flattenForMatch(probe);
  if (!needle) return { ok: false, ratio: 0, missingAnchors: [] };
  // 锚点词从归一化后的探针提取；单个锚点允许 OCR 形近误读（如 Windows→\Mndows）:
  // 整词包含,或词级 LCS ≥ 0.7 视为命中。
  const anchors = needle.match(/[a-z0-9]{2,}/g) || [];
  const missingAnchors = anchors.filter(
    (a) => !haystack.includes(a) && lcsLength(a, haystack) / a.length < 0.7,
  );
  const ratio = lcsLength(needle, haystack) / needle.length;
  return {
    ok: missingAnchors.length === 0 && ratio >= minRatio,
    ratio: Math.round(ratio * 1000) / 1000,
    missingAnchors,
  };
}

// needle 相对 haystack 的有序覆盖率:发送核验用「当前画面与最近读取画面是否连续」。
export function matchRatio(needleText, haystackText) {
  const needle = flattenForMatch(needleText);
  if (!needle) return 0;
  const haystack = flattenForMatch(haystackText);
  return lcsLength(needle, haystack) / needle.length;
}

// 两个 16 位十六进制 aHash 的汉明距(0–64):≤8 视为同一头像。
export function hashDistance(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

// OCR 行文本的宽松归一(去空白、小写),用于顶栏/列表行名字比对。
export function flatName(text) {
  return String(text).toLowerCase().replace(/\s+/g, "");
}

// 顶栏名字的 OCR 分行不稳定:返回箭头、窗口饰件常被并进同一行("〈 June")。
// 比对前剥掉两端不属于文字的字符(箭头/括号/标点/图标误读),再精确相等;
// 两边同规则剥离,备注名本身带符号时依然成立,也不会把「June2」误当「June」。
export function flatHeaderName(text) {
  return flatName(text)
    .replace(/^[^a-z0-9\u4e00-\u9fff]+/, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+$/, "");
}

// 顶栏(y<.13、x .1–.7)是否显示指定会话名,供定位早退与身份核验共用。
export function headerNameHit(lines, name) {
  const needle = flatHeaderName(name);
  if (!needle) return false;
  return lines.some(
    (l) =>
      l.box.y < .13 &&
      l.box.x > .1 &&
      l.box.x < .7 &&
      flatHeaderName(l.text) === needle,
  );
}

export const AVATAR_BAND = { x: 0.16, y: 0.12, width: 0.13, height: 0.68 };
export const AVATAR_MATCH_DISTANCE = 8;
