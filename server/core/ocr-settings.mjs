import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { check, AppError } from "../errors.mjs";
import { createProvider } from "./providers.mjs";
import { visionTranscriber } from "./image-text.mjs";
import { localOcrAvailable, recognizeImage } from "./image-ocr.mjs";
import { recognizeWindowsImage, windowsOcrAvailable } from "./windows-ocr.mjs";
import { recognizeViaService, serviceUrl } from "./paddle-ocr.mjs";

const KEY = "platform:ocr-settings:v1";

// 识别策略决定图片资料读文字时的引擎顺序（见 core/image-text.mjs）：
//   auto  本机 OCR 先读，质量差或读不出时自动改用识别模型重试（历史默认行为）
//   model 识别模型直接转录，失败时回退本机 OCR——扫描件字小/表格多时远端或本机
//         视觉模型明显好于 Windows.Media.Ocr
//   local 仅本机识别，图片字节不发给任何模型——隐私/离线场景的硬承诺
export const OCR_STRATEGIES = Object.freeze({
  auto: "智能（推荐）：先用本机识别，质量差或读不出时自动改用识别模型重试",
  model: "模型优先：直接用识别模型转录，失败时回退本机识别",
  local: "仅本机识别：图片不发送给任何模型，需要本机识别组件",
});

// 专用识别模型存为团队模型配置里的固定条目（复用地址/密钥/预算校验与加密存储）。
export const OCR_MODEL_PROFILE_ID = "ocr-vision";

// 基准样张（assets/ocr-test-image.png）里应被认出的文字片段；本机 OCR 对
// 小数点/字母常识别错（6·1、mmoI/L），命中 2 项即认为引擎可用。
export const OCR_TEST_BASELINE = Object.freeze([
  "检验报告单",
  "6.1",
  "mmol/L",
  "工作台文字识别基准",
]);

const testImagePath = resolve(import.meta.dirname, "assets/ocr-test-image.png");
const flat = (text) => String(text || "").replace(/\s+/g, "");
const hits = (text) =>
  OCR_TEST_BASELINE.filter((item) => flat(text).includes(flat(item)));

// 本机识别服务（PaddleOCR / medagent-gpu-worker）：仅允许 https 或回环/内网
// http 由部署方自担——这里沿用主模型连接的口径，http 仅回环；GPU Worker 常见
// 经 HTTP 代理映射出公网，应使用 https 或隧道。API Key 对应 worker 的
// WORKER_API_KEY，服务端未启用鉴权时可留空。
function serviceCandidate(previous, body) {
  const input = body && typeof body === "object" ? body : {};
  const rawBase = String(input.baseUrl ?? previous?.baseUrl ?? "").trim();
  check(rawBase.length > 0 && rawBase.length <= 500, "OCR_SETTINGS", "请填写 OCR 服务的接口地址");
  let url;
  try {
    url = new URL(rawBase);
  } catch {
    throw new AppError("OCR_SETTINGS", "OCR 服务地址格式无效", 400);
  }
  check(
    !url.username && !url.password && !url.search && !url.hash,
    "OCR_SETTINGS",
    "OCR 服务地址不能包含账号、密码、查询参数或片段",
  );
  check(
    url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
    "OCR_SETTINGS",
    "OCR 服务地址需使用 HTTPS；本机服务允许回环 HTTP 地址",
  );
  const config = { baseUrl: serviceUrl(rawBase, "") };
  const apiKey = input.apiKey !== undefined ? String(input.apiKey || "").trim() : previous?.apiKey || "";
  check(apiKey.length <= 8192, "OCR_SETTINGS", "API Key 格式无效");
  if (apiKey) config.apiKey = apiKey;
  const timeout = Number(input.timeoutMs ?? previous?.timeoutMs ?? 60000);
  check(Number.isInteger(timeout) && timeout >= 5000 && timeout <= 300000, "OCR_SETTINGS", "超时须为 5000–300000 毫秒");
  config.timeoutMs = timeout;
  return config;
}

export class OcrSettings {
  constructor(vault, profiles) {
    this.vault = vault;
    this.profiles = profiles;
  }
  strategy() {
    const saved = this.vault.get(KEY).strategy;
    return OCR_STRATEGIES[saved] ? saved : "auto";
  }
  modelConfig() {
    return this.profiles.all()[OCR_MODEL_PROFILE_ID] || null;
  }
  // 专用识别模型的 provider 实例；未配置时返回 null，调用方回退主模型视觉。
  model() {
    try {
      return this.profiles.resolve(OCR_MODEL_PROFILE_ID);
    } catch {
      return null;
    }
  }
  localAvailable() {
    return Boolean(this.service()) || localOcrAvailable() || windowsOcrAvailable();
  }
  // 本机识别服务配置（PaddleOCR / GPU Worker）；未配置返回 null，本机识别层
  // 退回 macOS 原生 / Windows 系统组件。
  service() {
    const saved = this.vault.get(KEY).service;
    return saved && saved.baseUrl ? saved : null;
  }
  // 校验并返回服务配置（不落盘）——「测试本机识别」支持先测未保存的表单值。
  candidateService(body) {
    return serviceCandidate(null, body);
  }
  save(body = {}) {
    check(
      body && typeof body === "object" && !Array.isArray(body),
      "OCR_SETTINGS",
      "需要配置对象",
    );
    // 同一 vault 键下合并写入，避免策略与服务配置互相覆盖。
    const next = { ...this.vault.get(KEY) };
    if (body.strategy !== undefined) {
      check(
        typeof body.strategy === "string" && OCR_STRATEGIES[body.strategy],
        "OCR_SETTINGS",
        "识别策略无效",
      );
      next.strategy = body.strategy;
    }
    if (body.clearService === true) next.service = null;
    else if (body.service !== undefined && body.service !== null)
      next.service = serviceCandidate(this.service(), body.service);
    this.vault.set(KEY, next);
    if (body.clearModel === true) this.profiles.remove(OCR_MODEL_PROFILE_ID);
    else if (body.model !== undefined && body.model !== null) {
      // 复用 ModelProfiles 的完整校验（地址、密钥、上下文预算）；识别模型
      // 必须支持图片，这里强制 vision=true，不由用户额外勾选。
      check(
        body.model && typeof body.model === "object",
        "OCR_SETTINGS",
        "识别模型配置无效",
      );
      this.profiles.save(OCR_MODEL_PROFILE_ID, { ...body.model, vision: true });
    }
    return this.public();
  }
  public(extra = {}) {
    const saved = this.modelConfig();
    const service = this.service();
    return {
      strategy: this.strategy(),
      strategies: OCR_STRATEGIES,
      service: service
        ? { baseUrl: service.baseUrl, hasKey: Boolean(service.apiKey), timeoutMs: service.timeoutMs }
        : null,
      model: saved
        ? {
            provider: saved.provider,
            baseUrl: saved.baseUrl,
            model: saved.model,
            hasKey: Boolean(saved.apiKey),
          }
        : null,
      ...extra,
    };
  }
  testImage() {
    return readFileSync(testImagePath);
  }
  // 用基准样张实测识别模型：连通 + 真能读中文文档，而不只是 API 可达。
  async testModel(config) {
    check(
      config && config.baseUrl && config.model,
      "OCR_SETTINGS",
      "请先填写识别模型的服务商与模型名称",
      400,
    );
    const transcriber = visionTranscriber(
      createProvider({ ...config, vision: true }),
    );
    check(transcriber, "OCR_SETTINGS", "识别模型必须支持图片", 400);
    const text = await transcriber(
      this.testImage(),
      AbortSignal.timeout(45000),
    );
    check(
      flat(text).length > 0,
      "VISION_EMPTY",
      "模型未返回任何文字，请确认该模型支持图片输入",
      422,
    );
    const matched = hits(text);
    const ok = matched.length >= 2;
    return {
      scope: "model",
      ok,
      matched,
      text: String(text).slice(0, 400),
      message: ok
        ? `识别模型可用：基准样张命中 ${matched.length}/${OCR_TEST_BASELINE.length} 项（${matched.join("、")}）。`
        : `模型已返回文字，但与基准样张匹配较少（命中 ${matched.length}/${OCR_TEST_BASELINE.length} 项），请确认所用模型适合中文文档转录。`,
    };
  }
  // 用同一张样张实测本机识别：优先实测指定/已配置的 PaddleOCR 服务（真实
  // 网络往返），否则实测操作系统识别组件（Windows 需已安装中文文本识别）。
  async testLocal(override = null) {
    const service = override || this.service();
    if (service) {
      const bytes = this.testImage();
      const lines = await recognizeViaService(service, bytes, AbortSignal.timeout(60000));
      const text = lines.map((line) => line.text).join("\n");
      check(
        flat(text).length > 0,
        "OCR_EMPTY",
        "OCR 服务已连通，但未能读出样张文字，请确认服务端模型加载正常",
        422,
      );
      const matched = hits(text);
      const ok = matched.length >= 2;
      return {
        scope: "local",
        engine: "paddle-service",
        ok,
        matched,
        text: text.slice(0, 400),
        message: ok
          ? `OCR 服务可用：基准样张命中 ${matched.length}/${OCR_TEST_BASELINE.length} 项（${lines.length} 行文字）。`
          : `OCR 服务已返回 ${lines.length} 行文字，但与基准样张匹配较少（命中 ${matched.length}/${OCR_TEST_BASELINE.length} 项），请确认服务端使用的是中文识别模型。`,
      };
    }
    check(
      this.localAvailable(),
      "OCR_UNAVAILABLE",
      "此平台没有本机识别组件，也未配置 OCR 服务。可在「本机识别服务」中填入 PaddleOCR 服务地址；Windows 也可在系统「时间和语言→语言」中安装中文文本识别",
      503,
    );
    const bytes = this.testImage();
    const result = localOcrAvailable()
      ? await recognizeImage(bytes, undefined)
      : await recognizeWindowsImage(bytes, undefined, {});
    const text = (result.lines || []).map((line) => line.text).join("\n");
    check(
      flat(text).length > 0,
      "OCR_EMPTY",
      "本机识别未能读出样张文字，请确认系统已安装中文文本识别组件",
      422,
    );
    const matched = hits(text);
    const ok = matched.length >= 2;
    return {
      scope: "local",
      engine: "system",
      ok,
      matched,
      text: text.slice(0, 400),
      message: ok
        ? `本机识别可用：基准样张命中 ${matched.length}/${OCR_TEST_BASELINE.length} 项。本机 OCR 对小数点、单位与表格线容易出错，重要数值请保留核对原图的习惯。`
        : `本机识别已返回文字，但与基准样张匹配较少（命中 ${matched.length}/${OCR_TEST_BASELINE.length} 项），中文识别组件可能不完整，建议配置「本机识别服务」（PaddleOCR）。`,
    };
  }
}
