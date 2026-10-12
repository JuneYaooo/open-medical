// PaddleOCR HTTP 服务连接器：兼容 medagent-gpu-worker 的 /v1/ocr 系列接口
// （FastAPI + Bearer 可选鉴权）。工作台把单页图片交给它，换取带真实置信度的
// 文字行——置信度直接进 shared/ocr-quality 的低置信度计罚，比系统组件的
// 伪造 0.95 有用得多。
//
// 接口契约（见 medagent-gpu-worker app/main.py）：
//   POST /v1/ocr/records  multipart file=图片 → { records: [{ text, box, score|null }] }
//   POST /v1/ocr          multipart file=图片/PDF → { text }（行文本，旧版 worker 也有）
//   GET  /health          免鉴权探活
//   401=鉴权失败，413=超服务端大小上限，429=引擎池容量耗尽，504=超时
import { AppError } from "../errors.mjs";

// 兼容用户把地址填成 http://host:18090 或 …/v1 两种写法。
export function serviceUrl(baseUrl, path) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${base}${path}`;
}

function serviceError(status, detail) {
  const error =
    status === 401
      ? new AppError("OCR_SERVICE_AUTH", "OCR 服务鉴权失败：请核对 API Key（worker 的 WORKER_API_KEY）", 502)
      : status === 413
        ? new AppError("OCR_SERVICE_LIMIT", `图片超过 OCR 服务的大小上限${detail ? `：${detail}` : ""}`, 413)
        : status === 429
          ? new AppError("OCR_BUSY", "OCR 服务繁忙（引擎池容量耗尽），请稍后重试", 502)
          : new AppError("OCR_SERVICE", `OCR 服务返回 ${status}${detail ? `：${detail}` : ""}`, 502);
  // 保留上游状态码：/v1/ocr/records 404（旧版 worker）时回退 /v1/ocr。
  error.upstreamStatus = status;
  return error;
}

async function postOcr(config, path, bytes, signal) {
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 60000;
  const bounded = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: "image/png" }), "page.png");
  let response;
  try {
    response = await fetch(serviceUrl(config.baseUrl, path), {
      method: "POST",
      redirect: "error",
      signal: bounded,
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      body: form,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.name === "TimeoutError" || bounded.aborted)
      throw new AppError("OCR_SERVICE_TIMEOUT", `OCR 服务 ${timeoutMs / 1000} 秒内未响应，请检查服务是否存活或调大超时`, 502);
    throw new AppError("OCR_SERVICE_UNREACHABLE", "无法连接 OCR 服务：请核对接口地址、端口与防火墙", 502);
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = String((await response.json())?.detail || "");
    } catch {
      await response.body?.cancel().catch(() => {});
    }
    throw serviceError(response.status, detail.slice(0, 200));
  }
  return response.json();
}

const linesFromRecords = (records) => {
  const lines = (Array.isArray(records) ? records : [])
    .map((record) => ({
      text: String(record?.text ?? "").trim(),
      confidence: typeof record?.score === "number" ? record.score : 1,
    }))
    .filter((line) => line.text);
  return lines;
};

// 主路径：/v1/ocr/records（带坐标与置信度）。旧版 worker 没有该端点
// （404/405）时回退 /v1/ocr 的纯文本；其余错误如实上抛。返回行数组
// [{ text, confidence }]，空页返回空数组由调用方决定兜底。
export async function recognizeViaService(config, bytes, signal) {
  try {
    const data = await postOcr(config, "/v1/ocr/records", bytes, signal);
    return linesFromRecords(data?.records);
  } catch (error) {
    signal?.throwIfAborted();
    if (![404, 405].includes(error?.upstreamStatus)) throw error;
  }
  const data = await postOcr(config, "/v1/ocr", bytes, signal);
  return String(data?.text || "")
    .split("\n")
    .map((text) => ({ text: text.trim(), confidence: 1 }))
    .filter((line) => line.text);
}

// 免鉴权探活：GET /health。返回 { ok, detail? }，探测失败不抛错。
export async function probeService(config, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(serviceUrl(config.baseUrl, "/health"), {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    let body = null;
    try {
      body = await response.json();
    } catch {}
    const engine = body?.paddle_version || body?.version;
    return { ok: true, ...(engine ? { engine } : {}) };
  } catch {
    return { ok: false, detail: "无法连接" };
  }
}
