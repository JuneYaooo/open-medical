import test from "node:test";
import assert from "node:assert/strict";
import {
  EmbeddingService,
  resolveEmbeddingConfig,
  cosineSimilarity,
} from "../server/medical/embeddings.mjs";

const stubFetch = (expectUrl, expectModel, vector) => async (endpoint, init) => {
  assert.equal(endpoint.href, expectUrl);
  const body = JSON.parse(init.body);
  assert.equal(body.model, expectModel);
  const inputs = body.input;
  return {
    ok: true,
    json: async () => ({
      data: inputs.map((_, index) => ({
        index,
        embedding: vector ?? [1, 0, 1],
      })),
    }),
  };
};

test("embedding config: key selects cloud defaults, no key selects local ollama", () => {
  const cloud = resolveEmbeddingConfig({ apiKey: "sk-free" });
  assert.equal(cloud.mode, "cloud");
  assert.equal(cloud.provider, "siliconflow");
  assert.equal(cloud.url, "https://api.siliconflow.cn/v1");
  assert.equal(cloud.model, "BAAI/bge-m3");

  const local = resolveEmbeddingConfig({});
  assert.equal(local.mode, "local");
  assert.equal(local.provider, "ollama");
  assert.equal(local.url, "http://127.0.0.1:11434");
  assert.equal(local.model, "bge-m3");
});

test("embedding cloud mode: https + bearer auth + openai response parsing", async () => {
  let capturedHeaders;
  const service = new EmbeddingService({
    apiKey: "sk-free",
    fetchImpl: async (endpoint, init) => {
      capturedHeaders = init.headers;
      return stubFetch(
        "https://api.siliconflow.cn/v1/embeddings",
        "BAAI/bge-m3",
      )(endpoint, init);
    },
  });
  const vectors = await service.embed(["妊娠期高血压", "抗凝"]);
  assert.deepEqual(vectors.length, 2);
  assert.equal(vectors[0].length, 3);
  assert.equal(capturedHeaders.Authorization, "Bearer sk-free");
});

test("embedding cloud mode: plain http and missing key are rejected", async () => {
  const http = new EmbeddingService({
    apiKey: "sk-free",
    url: "http://api.siliconflow.cn/v1",
  });
  await assert.rejects(() => http.embed(["x"]), (err) => err.code === "EMBEDDING_CONFIG");

  const noKey = new EmbeddingService({
    apiKey: "",
    provider: "siliconflow",
    url: "https://api.siliconflow.cn/v1",
    model: "BAAI/bge-m3",
  });
  await assert.rejects(() => noKey.embed(["x"]), (err) => err.code === "EMBEDDING_CONFIG");
});

test("embedding local mode: loopback enforced", async () => {
  const remote = new EmbeddingService({
    provider: "ollama",
    url: "https://remote.example.com",
    model: "bge-m3",
  });
  await assert.rejects(() => remote.embed(["x"]), (err) => err.code === "EMBEDDING_CONFIG");
});

test("cosine similarity sanity", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
});
