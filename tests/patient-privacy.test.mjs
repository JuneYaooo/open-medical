import test from "node:test";
import assert from "node:assert/strict";
import { MaterialLibrary } from "../server/medical/materials.mjs";
import { EmbeddingService } from "../server/medical/embeddings.mjs";
import { fixture } from "./helpers.mjs";

const file = { id: "privacy-file", name: "合成患者记录.txt", text: "SYNTHETIC_PATIENT_RECORD 血压记录与复诊信息。" };

test("patient material import and search do not call a cloud embedding provider", async () => {
  const requests = [];
  const embedder = new EmbeddingService({ apiKey: "synthetic", fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) };
  } });
  const vectorStore = { upsertDoc: async () => {}, search: async () => [] };
  const library = new MaterialLibrary(embedder, vectorStore);
  const imported = await library.ingest(file);
  const result = await library.search({ sources: [file], query: "SYNTHETIC_PATIENT_RECORD" });
  assert.equal(requests.length, 0, "patient text and patient queries must stay local");
  assert.equal(imported.embedded, 0);
  assert.equal(result.mode, "keyword");
  assert.equal(result.matches.length, 1);
});

test("unknown material embedding adapters fail closed, explicit local adapters still work", async () => {
  let calls = 0;
  const adapter = { available: () => true, model: "synthetic-local", embed: async (inputs) => { calls++; return inputs.map(() => [1, 0]); } };
  const vectors = { upsertDoc: async () => {}, search: async () => [] };
  await new MaterialLibrary(adapter, vectors).ingest(file);
  assert.equal(calls, 0);
  adapter.status = () => ({ mode: "local" });
  const result = await new MaterialLibrary(adapter, vectors).ingest(file);
  assert.equal(result.embedded, 1);
  assert.equal(calls, 1);
});

test("medical server separates public knowledge embeddings from patient material embeddings", async (t) => {
  const calls = [];
  const publicEmbedder = { available: () => true, model: "synthetic-public", status: () => ({ mode: "cloud" }), embed: async (inputs) => { calls.push(...inputs); return inputs.map(() => [1, 0]); } };
  const f = await fixture(t, { embedder: publicEmbedder });
  const patient = (await f.json("/api/patients", "POST", { name: "合成隐私患者" })).data;
  const imported = await f.json(`/api/sessions/${patient.sessionId}/files`, "POST", { name: file.name, text: file.text });
  assert.equal(imported.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 0);
  assert.notEqual(f.server.materials.embedder, publicEmbedder);
  assert.equal(f.server.materials.embedder.status().mode, "local");
});
