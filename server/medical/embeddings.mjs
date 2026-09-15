import { AppError, check } from "../errors.mjs";

// Embedding service for the guideline knowledge base. Three modes:
// - cloud  : free hosted API (default: SiliconFlow BAAI/bge-m3 — free tier,
//            OpenAI-compatible). HTTPS + API key required. Only PUBLIC
//            knowledge text (guideline chunks, search terms) is sent —
//            patient materials are never embedded remotely.
// - local  : Ollama on loopback, for fully-offline preference.
// - none   : no embedder — knowledge search degrades to full-text matching.
const CLOUD_DEFAULTS = {
  provider: "siliconflow",
  url: "https://api.siliconflow.cn/v1",
  model: "BAAI/bge-m3",
};
const LOCAL_DEFAULTS = {
  provider: "ollama",
  url: "http://127.0.0.1:11434",
  model: "bge-m3",
};

export function resolveEmbeddingConfig(options = {}) {
  const apiKey =
    options.apiKey ?? process.env.MEDICAL_EMBEDDING_KEY ?? "";
  const envUrl = options.url ?? process.env.MEDICAL_EMBEDDING_URL;
  const envModel = options.model ?? process.env.MEDICAL_EMBEDDING_MODEL;
  const provider =
    options.provider ?? process.env.MEDICAL_EMBEDDING_PROVIDER ?? undefined;
  // A key means cloud; no key means the local loopback path.
  const base = apiKey ? CLOUD_DEFAULTS : LOCAL_DEFAULTS;
  return {
    apiKey: typeof apiKey === "string" ? apiKey : "",
    provider: provider || base.provider,
    url: envUrl || base.url,
    model: envModel || base.model,
    mode: apiKey ? "cloud" : "local",
  };
}

export class EmbeddingService {
  constructor(options = {}) {
    this.config = resolveEmbeddingConfig(options);
    this.embedFn = options.embedFn || null; // test injection point
    this.fetchImpl = options.fetchImpl || null;
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
    return {
      enabled: this.available(),
      mode: this.config.mode,
      provider: this.config.provider,
      url: this.config.mode === "cloud" ? this.config.url : undefined,
      model: this.config.model,
      hasKey: Boolean(this.config.apiKey),
    };
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
    const remote = this.config.mode === "cloud";
    if (remote) {
      check(
        url.protocol === "https:",
        "EMBEDDING_CONFIG",
        "云端嵌入服务必须使用 HTTPS",
      );
      check(
        Boolean(this.config.apiKey),
        "EMBEDDING_CONFIG",
        "云端嵌入服务需要配置 API Key",
      );
    } else {
      check(
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
        "EMBEDDING_CONFIG",
        "本地嵌入服务必须位于回环地址",
      );
    }
    const isOllama = this.config.provider === "ollama";
    const endpoint = new URL(
      isOllama ? "api/embed" : "embeddings",
      url.href.endsWith("/") ? url : url.href + "/",
    );
    let response;
    try {
      response = await (this.fetchImpl || fetch)(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.apiKey
            ? { Authorization: `Bearer ${this.config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          input: inputs,
          ...(isOllama ? { truncate: false } : {}),
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw new AppError(
        "EMBEDDING_UNAVAILABLE",
        `嵌入服务不可达（${error.name === "TimeoutError" ? "超时" : "连接失败"}）；知识检索自动回退为全文匹配`,
        502,
      );
    }
    check(response.ok, "EMBEDDING_SERVICE", `嵌入服务返回 ${response.status}`, 502);
    const data = await response.json();
    const vectors = isOllama
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
