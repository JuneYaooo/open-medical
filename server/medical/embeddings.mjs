import { AppError, check } from "../errors.mjs";

// Local-only embedding client for the guideline knowledge base. Same
// security contract as semantic memory: the embedding service must be on
// the loopback interface — medical material never leaves the machine for
// indexing. Providers: ollama (/api/embed) or any OpenAI-compatible
// /embeddings server.
const DEFAULTS = {
  provider: process.env.MEDICAL_EMBEDDING_PROVIDER || "ollama",
  url:
    process.env.MEDICAL_EMBEDDING_URL ||
    "http://127.0.0.1:11434",
  model: process.env.MEDICAL_EMBEDDING_MODEL || "bge-m3",
};

export class EmbeddingService {
  constructor(options = {}) {
    this.config = {
      provider: options.provider || DEFAULTS.provider,
      url: options.url || DEFAULTS.url,
      model: options.model || DEFAULTS.model,
    };
    this.fetchImpl = options.fetchImpl || fetch;
  }
  available() {
    return Boolean(this.config.url && this.config.model);
  }
  // Vector provenance: chunks are tagged with the embedding model so
  // vectors from different models are never compared.
  get model() {
    return this.config.model;
  }
  status() {
    return { enabled: this.available(), ...this.config };
  }
  async embed(inputs, signal) {
    check(Array.isArray(inputs) && inputs.length >= 1, "INVALID_INPUT", "嵌入输入不能为空");
    check(
      inputs.every((t) => typeof t === "string" && t.length > 0 && t.length <= 8000),
      "INVALID_INPUT",
      "嵌入输入须为 1–8000 字符文本",
    );
    if (this.embedFn) return this.embedFn(inputs); // test injection point
    let url;
    try {
      url = new URL(this.config.url);
    } catch {
      throw new AppError("EMBEDDING_CONFIG", "嵌入服务地址无效", 400);
    }
    check(
      ["http:", "https:"].includes(url.protocol) &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
      "EMBEDDING_CONFIG",
      "嵌入服务必须位于本机（回环地址），不能配置云端 URL",
    );
    const endpoint = new URL(
      this.config.provider === "ollama" ? "api/embed" : "embeddings",
      url.href.endsWith("/") ? url : url.href + "/",
    );
    let response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          input: inputs,
          ...(this.config.provider === "ollama" ? { truncate: false } : {}),
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw new AppError(
        "EMBEDDING_UNAVAILABLE",
        `本地嵌入服务不可达（${error.name === "TimeoutError" ? "超时" : "连接失败"}）；知识检索自动回退为全文匹配`,
        502,
      );
    }
    check(response.ok, "EMBEDDING_SERVICE", `嵌入服务返回 ${response.status}`, 502);
    const data = await response.json();
    const vectors =
      this.config.provider === "ollama"
        ? data.embeddings
        : data.data
            ?.sort((a, b) => a.index - b.index)
            .map((d) => d.embedding);
    check(
      Array.isArray(vectors) &&
        vectors.length === inputs.length &&
        vectors.every(
          (v) =>
            Array.isArray(v) &&
            v.length >= 2 &&
            v.length <= 4096 &&
            v.every(Number.isFinite),
        ),
      "EMBEDDING_SERVICE",
      "嵌入服务返回的向量数量或维度无效",
      502,
    );
    return vectors;
  }
}

export const cosineSimilarity = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};
