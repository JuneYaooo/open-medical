import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { check } from "../errors.mjs";
import { createProvider } from "./providers.mjs";
import { visionTranscriber } from "./image-text.mjs";
import { localOcrAvailable, recognizeImage } from "./image-ocr.mjs";
import { recognizeWindowsImage, windowsOcrAvailable } from "./windows-ocr.mjs";

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

export class OcrSettings {
  constructor(vault, profiles, fetchImpl = fetch) {
    this.vault = vault;
    this.profiles = profiles;
    this.fetch = fetchImpl;
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
    return localOcrAvailable() || windowsOcrAvailable();
  }
  save(body = {}) {
    check(
      body && typeof body === "object" && !Array.isArray(body),
      "OCR_SETTINGS",
      "需要配置对象",
    );
    if (body.strategy !== undefined) {
      check(
        typeof body.strategy === "string" && OCR_STRATEGIES[body.strategy],
        "OCR_SETTINGS",
        "识别策略无效",
      );
      this.vault.set(KEY, { strategy: body.strategy });
    }
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
    return {
      strategy: this.strategy(),
      strategies: OCR_STRATEGIES,
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
  // 用同一张样张实测本机识别组件（Windows 需已安装中文文本识别）。
  async testLocal() {
    check(
      this.localAvailable(),
      "OCR_UNAVAILABLE",
      "此平台没有本机识别组件。Windows 需在系统「时间和语言→语言」中安装中文文本识别；macOS 为内置组件",
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
      ok,
      matched,
      text: text.slice(0, 400),
      message: ok
        ? `本机识别可用：基准样张命中 ${matched.length}/${OCR_TEST_BASELINE.length} 项。本机 OCR 对小数点、单位与表格线容易出错，重要数值请保留核对原图的习惯。`
        : `本机识别已返回文字，但与基准样张匹配较少（命中 ${matched.length}/${OCR_TEST_BASELINE.length} 项），中文识别组件可能不完整，建议在系统设置中补装中文文本识别。`,
    };
  }
  // 探测本机模型服务（Ollama / LM Studio / vLLM），返回可直接填入识别模型
  // 表单的 OpenAI 兼容地址与模型列表——“本机安装 OCR 专用模型”的入口。
  async detectLocal(endpoints) {
    const list = (Array.isArray(endpoints) && endpoints.length
      ? endpoints
      : ["http://127.0.0.1:11434", "http://127.0.0.1:1234"]
    )
      .map((item) => String(item || "").trim().replace(/\/+$/, ""))
      .filter((item) =>
        /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(item),
      );
    const sources = [];
    for (const base of list) {
      const found = await this.probeLocalBase(base);
      if (found) sources.push(found);
    }
    return {
      ok: sources.length > 0,
      sources,
      message: sources.length
        ? `检测到本机模型服务：${sources.map((s) => `${s.source}（${s.models.length} 个模型）`).join("、")}。选择视觉类模型（名称含 vl/vision 的优先）填入即可。`
        : "未检测到本机模型服务。可安装 Ollama 后拉取视觉模型（如 qwen2.5vl），装好再点「检测本机模型」。",
    };
  }
  async probeLocalBase(base) {
    // Ollama：GET /api/tags → { models: [{ name }] }，对话接口在 base + /v1。
    try {
      const r = await this.fetch(base + "/api/tags", {
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) {
        const data = await r.json();
        const models = (data.models || [])
          .map((m) => m.name)
          .filter(Boolean)
          .slice(0, 30);
        if (models.length) return { source: "ollama", baseUrl: base + "/v1", models };
      }
    } catch {}
    // OpenAI 兼容（LM Studio / vLLM）：GET /v1/models → { data: [{ id }] }。
    for (const [modelsUrl, chatUrl] of [
      [base + "/v1/models", base + "/v1"],
      [base + "/models", base],
    ]) {
      try {
        const r = await this.fetch(modelsUrl, {
          signal: AbortSignal.timeout(1500),
        });
        if (!r.ok) continue;
        const data = await r.json();
        const models = (data.data || [])
          .map((m) => m.id)
          .filter(Boolean)
          .slice(0, 30);
        if (models.length)
          return { source: "openai-compatible", baseUrl: chatUrl, models };
      } catch {}
    }
    return null;
  }
}
