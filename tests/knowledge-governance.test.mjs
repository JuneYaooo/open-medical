import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { Store } from "../server/store.mjs";
import { GuidelineLibrary, knowledgeTools } from "../server/medical/guidelines.mjs";

const sample = (topic = "复诊") => `${topic}资料。此文档为测试合成内容，记录来源核对与知识库生命周期，不可用作医疗建议。\n`.repeat(8);

test("knowledge review cannot persist when its audit record fails", async (t) => {
  const f = await fixture(t);
  const doc = (await f.json("/api/knowledge", "POST", { title: "合成审计资料", text: sample() })).data;
  const audit = f.server.store.audit;
  f.server.store.audit = () => { throw new Error("synthetic audit failure"); };
  const result = await f.json(`/api/knowledge/${doc.id}`, "PATCH", { expectedRevision: 0, reviewStatus: "reviewed", reviewNote: "合成核对依据" });
  f.server.store.audit = audit;
  assert.equal(result.status, 500);
  const current = (await f.json(`/api/knowledge/${doc.id}`)).data;
  assert.equal(current.reviewStatus, "unreviewed");
  assert.equal(current.revision || 0, 0);
});

test("knowledge source lifecycle: import unreviewed, review with reason, stop using without breaking citations", async (t) => {
  const f = await fixture(t);
  const created = await f.json("/api/knowledge", "POST", { title: "合成资料", text: sample(), sourceUrl: "https://example.org/source", edition: "2026 测试版", reviewStatus: "reviewed" });
  assert.equal(created.status, 201);
  const doc = created.data;
  assert.equal(doc.reviewStatus, "unreviewed", "import cannot silently certify a source");
  assert.equal((await f.json(`/api/knowledge/${doc.id}`, "PATCH", { expectedRevision: 0, reviewStatus: "reviewed" })).status, 400);
  const reviewed = await f.json(`/api/knowledge/${doc.id}`, "PATCH", { expectedRevision: 0, reviewStatus: "reviewed", reviewNote: "合成测试：已核对发布页版本", reviewDueDate: "2020-01-01" });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.data.reviewDue, true);
  assert.ok(reviewed.data.reviewedAt);
  assert.equal((await f.json(`/api/knowledge/${doc.id}`, "PATCH", { expectedRevision: 0, title: "过期修改" })).status, 409);
  const hit = (await f.json("/api/knowledge/search?q=复诊")).data.hits[0];
  assert.equal(hit.sha256, doc.sha256);
  assert.equal(hit.edition, "2026 测试版");
  assert.equal(hit.reviewStatus, "reviewed");
  const retired = await f.json(`/api/knowledge/${doc.id}`, "PATCH", { expectedRevision: 1, reviewStatus: "retired", reviewNote: "已被新版本替代" });
  assert.equal(retired.status, 200);
  assert.equal((await f.json("/api/knowledge/search?q=复诊")).data.count, 0);
  assert.equal((await f.json("/api/knowledge/search?q=复诊&reviewStatus=all")).data.count, 1);
  const cited = f.server.guidelines.readLines(doc.id, 1, 2);
  assert.equal(cited.reviewStatus, "retired");
  assert.equal(cited.sha256, doc.sha256);
  assert.match(cited.lines[0], /复诊/);
  assert.equal((await f.json(`/api/knowledge/${doc.id}`)).data.metadataHistory.length, 2);
});

test("knowledge metadata changes invalidate review and reject unsafe source URLs or invalid dates", async (t) => {
  const f = await fixture(t);
  for (const sourceUrl of ["javascript:alert(1)", "file:///etc/passwd", "https://secret:token@example.org/a"]) {
    assert.equal((await f.json("/api/knowledge", "POST", { title: "无效链接", text: sample(), sourceUrl })).status, 400);
  }
  const doc = (await f.json("/api/knowledge", "POST", { title: "合成记录", text: sample() })).data;
  assert.equal((await f.json(`/api/knowledge/${doc.id}`, "PATCH", { expectedRevision: 0, reviewDueDate: "2026-02-30" })).status, 400);
  await f.json(`/api/knowledge/${doc.id}`, "PATCH", { expectedRevision: 0, reviewStatus: "reviewed", reviewNote: "核对合成文件原件" });
  const changed = await f.json(`/api/knowledge/${doc.id}`, "PATCH", { expectedRevision: 1, edition: "另一版本" });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.reviewStatus, "unreviewed");
  assert.equal(changed.data.text, sample().trim(), "metadata edits never rewrite cited source text");
});

test("knowledge list honors filters and vector-only matches remain source-governed", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  let vectorHits = [];
  const embedder = { model: "test-local", available: () => true, status: () => ({ mode: "local" }), embed: async (texts) => texts.map(() => [1, 0]) };
  const vectors = { upsertDoc: async () => {}, stats: async () => ({ backend: "test", chunks: 2, models: [{ model: "test-local" }] }), search: async () => vectorHits };
  const library = new GuidelineLibrary(store, embedder, vectors);
  const a = await library.addDocument({ title: "知识甲", text: sample("复诊"), kind: "资料", collection: "门诊" });
  const b = await library.addDocument({ title: "知识乙", text: sample("术后"), kind: "指南", collection: "外科", org: "机构乙" });
  const listTool = knowledgeTools(library).find((tool) => tool.definition.function.name === "knowledge_list");
  assert.deepEqual(listTool.execute({ collection: "门诊" }).documents.map((doc) => doc.id), [a.id]);
  vectorHits = [{ docId: a.id, ord: 1, score: 0.97 }, { docId: b.id, ord: 1, score: 0.3 }];
  const semantic = await library.search({ query: "unmatched-language" });
  assert.equal(semantic.hits.length, 1);
  assert.equal(semantic.hits[0].matchedVia, "vector");
  assert.equal(semantic.hits[0].reviewStatus, "unreviewed");
  assert.equal((await library.search({ query: "复诊", org: "机构乙" })).count, 0, "unknown org cannot satisfy a specific organization filter");
  library.updateMetadata(a.id, { expectedRevision: 0, reviewStatus: "retired", reviewNote: "合成停用" });
  assert.equal((await library.search({ query: "unmatched-language" })).count, 0, "stale vectors cannot resurrect a retired source");
});
