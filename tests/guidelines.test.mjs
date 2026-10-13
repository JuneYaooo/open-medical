import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";
import { GuidelineLibrary, knowledgeTools } from "../server/medical/guidelines.mjs";

const SAMPLE = [
  "中国高血压防治指南（2024 年修订版）测试文本。",
  "",
  "## 推荐意见",
  "1. 对血压≥140/90 mmHg 的患者，推荐启动生活方式干预。",
  "2. 推荐在生活方式干预基础上启动降压药物治疗。",
  "3. 合并糖尿病的患者血压控制目标为 130/80 mmHg 以下。",
  "",
  "## 随访建议",
  "4. 启动药物治疗后每月随访一次，直至血压达标。",
  "5. 达标后每 3 个月随访一次，评估不良反应。",
].join("\n");

const newLibrary = (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return new GuidelineLibrary(store);
};

test("guideline document: add with chunking, sha dedupe, list and remove", async (t) => {
  const library = newLibrary(t);
  const doc = await library.addDocument({
    title: "中国高血压防治指南 2024",
    org: "中华医学会",
    year: 2024,
    text: SAMPLE,
    fileName: "hypertension-2024.md",
  });
  assert.ok(doc.id.startsWith("gl_"));
  assert.ok(doc.chunkCount >= 1);
  assert.equal(doc.sha256, doc.sha256.toLowerCase());

  await assert.rejects(
    () => library.addDocument({ title: "重复", text: SAMPLE }),
    (err) => err.code === "CONFLICT",
  );

  const list = library.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "中国高血压防治指南 2024");
  assert.equal(list[0].text, undefined);
  assert.ok(list[0].chunkCount >= 1);

  const full = library.get(doc.id);
  assert.ok(full.lineCount >= 10);
  assert.equal(library.removeDocument(doc.id).ok, true);
  assert.equal(library.list().length, 0);
});

test("guideline search: Chinese substring terms, org/year filters, provenance lines", async (t) => {
  const library = newLibrary(t);
  await library.addDocument({
    title: "中国高血压防治指南 2024",
    org: "中华医学会",
    year: 2024,
    text: SAMPLE,
  });
  await library.addDocument({
    title: "NICE hypertension guideline 2019",
    org: "NICE",
    year: 2019,
    text: [
      "NICE guideline: hypertension in adults diagnosis and management.",
      "1.1 For patients with sustained blood pressure over 140/90 mmHg, offer lifestyle advice.",
      "1.2 Offer antihypertensive treatment considering comorbidities.",
      "1.3 Review the patient at least annually, including blood pressure check.",
    ].join("\n"),
  });

  const hits = await library.search({ query: "随访 血压" });
  assert.equal(hits.count, 1);
  assert.equal(hits.hits[0].docTitle, "中国高血压防治指南 2024");
  assert.ok(hits.hits[0].startLine >= 1);
  assert.ok(hits.hits[0].matches.length >= 1);
  assert.ok(hits.hits[0].matches[0].lineNo >= 1);

  const english = await library.search({ query: "blood pressure treatment" });
  assert.equal(english.count, 1);
  assert.equal(english.hits[0].org, "NICE");

  const filtered = await library.search({ query: "随访", org: "NICE" });
  assert.equal(filtered.count, 0);
  const byYear = await library.search({ query: "随访", year: 2019 });
  assert.equal(byYear.count, 0);

  await assert.rejects(() => library.search({ query: "  " }), /必须是 1–200 字符/);
});

test("guideline readLines enforces ranges and returns original text", async (t) => {
  const library = newLibrary(t);
  const doc = await library.addDocument({ title: "指南", text: SAMPLE });
  const lines = SAMPLE.split("\n");
  const read = library.readLines(doc.id, 4, 5);
  assert.deepEqual(read.lines, lines.slice(3, 5));
  assert.equal(read.docTitle, "指南");
  assert.throws(
    () => library.readLines(doc.id, 0, 2),
    /起始行/,
  );
  assert.throws(
    () => library.readLines(doc.id, 2, 999),
    /结束行/,
  );
  assert.throws(
    () => library.readLines("gl_missing", 1, 2),
    (err) => err.code === "NOT_FOUND",
  );
});

test("guideline agent tools: search/list/read execute and skip validation upfront", async (t) => {
  const library = newLibrary(t);
  await library.addDocument({ title: "高血压指南", org: "中华医学会", year: 2024, text: SAMPLE });
  const tools = knowledgeTools(library);
  assert.deepEqual(
    tools.map((tool) => tool.definition.function.name),
    ["knowledge_collections", "knowledge_search", "knowledge_list", "knowledge_read", "knowledge_ingest"],
  );
  const hits = await tools.find(t=>t.definition.function.name==="knowledge_search").execute({ query: "糖尿病 血压" });
  assert.equal(hits.count, 1);
  const listed = await tools.find(t=>t.definition.function.name==="knowledge_list").execute({});
  assert.equal(listed.documents.length, 1);
  const read = await tools.find(t=>t.definition.function.name==="knowledge_read").execute({ docId: hits.hits[0].docId, startLine: 4, endLine: 4 });
  assert.match(read.lines[0], /生活方式干预/);
});

test("guideline API: import via REST, search endpoint, delete, bootstrap count", async (t) => {
  const { fixture } = await import("./helpers.mjs");
  const f = await fixture(t);
  const created = await f.json("/api/knowledge", "POST", {
    title: "中国高血压防治指南 2024",
    org: "中华医学会",
    year: 2024,
    text: SAMPLE,
  });
  assert.equal(created.status, 201);
  const doc = created.data;
  assert.ok(doc.chunkCount >= 1);

  const search = await f.json(`/api/guidelines/search?q=${encodeURIComponent("降压 药物")}`);
  assert.equal(search.status, 200);
  assert.equal(search.data.count, 1);
  assert.ok(search.data.hits[0].docTitle.includes("高血压"));

  const boot = (await f.json("/api/bootstrap")).data;
  assert.equal(boot.knowledge.count, 1);
  assert.ok(boot.tools.includes("knowledge_search"));
  assert.ok(boot.tools.includes("knowledge_ingest"));

  const full = await f.json(`/api/knowledge/${doc.id}`);
  assert.ok(full.data.lineCount >= 10);
  assert.equal((await f.json(`/api/knowledge/${doc.id}`, "DELETE")).data.ok, true);
  assert.equal((await f.json("/api/knowledge")).data.documents.length, 0);
});

test('documents with an implicit default collection remain countable and selectable without rewriting stored sources',async t=>{
 const library=newLibrary(t),doc=await library.addDocument({title:'合成短资料',text:'这是一份用于软件验证的简短科室流程。'});
 const raw=library.docRow(doc.id);delete raw.collection;const saved=JSON.stringify(raw);library.store.db.prepare('UPDATE guideline_docs SET data=? WHERE id=?').run(saved,doc.id);
 assert.equal(library.collections().find(c=>c.name==='默认知识库').documentCount,1);
 assert.equal(library.list({collection:'默认知识库'}).length,1);
 assert.equal(library.store.db.prepare('SELECT data FROM guideline_docs WHERE id=?').get(doc.id).data,saved);
});

test('guideline search ranks exact Chinese terms before frequent partial words and exposes actual matching lines', async t => {
  const library = newLibrary(t);
  const partial = await library.addDocument({title:'合成部分匹配资料',text:'肝功能变化。'.repeat(50)+'\n仅供检索测试。'});
  const exact = await library.addDocument({title:'合成目标资料',text:'肝功能储备评估。\n仅供检索测试，不含临床建议。'});
  const hits = (await library.search({query:'肝功能储备'})).hits;
  assert.equal(hits[0].docId, exact.id);
  assert.equal(hits[0].lexicalMatchType, 'exact');
  const fallback = hits.find(h => h.docId === partial.id);
  assert.equal(fallback.lexicalMatchType, 'partial');
  assert.ok(fallback.matches.length);
  for (const hit of hits) for (const line of hit.matches) assert.equal(library.get(hit.docId).text.split('\n')[line.lineNo-1].slice(0,300),line.text);
});

test("collection deletion checks current contents, removes chunks and vectors, preserves other libraries", async (t) => {
  const library = newLibrary(t);
  const deleted = [];
  library.vectorStore = { removeDocs: async ids => deleted.push(...ids) };
  library.saveCollection("待删除", { expectedRevision: 0, description: "测试资料", whenToUse: "测试" });
  const first = await library.addDocument({ title: "一", text: SAMPLE, collection: "待删除" });
  const stale = library.collections().find(c => c.name === "待删除");
  const second = await library.addDocument({ title: "二", text: SAMPLE + "\n新资料", collection: "待删除" });
  const keep = await library.addDocument({ title: "保留", text: SAMPLE, collection: "保留库" });
  await assert.rejects(library.removeCollection("待删除", stale), { code: "REVISION_CONFLICT" });
  assert.equal(library.list().length, 3);
  const current = library.collections().find(c => c.name === "待删除");
  assert.equal((await library.removeCollection("待删除", current)).deletedDocuments, 2);
  assert.deepEqual(deleted.sort(), [first.id, second.id].sort());
  assert.deepEqual(library.list().map(d => d.id), [keep.id]);
  assert.equal(library.store.db.prepare("SELECT count(*) AS n FROM guideline_chunks WHERE doc_id=?").get(first.id).n, 0);
  assert.equal(library.collections().some(c => c.name === "待删除"), false);
  await assert.rejects(library.removeCollection("待删除", current), { code: "NOT_FOUND" });
  const implicit = library.collections().find(c => c.name === "保留库");
  await library.removeCollection(implicit.name, implicit);
  assert.deepEqual(library.collections().map(c => c.name), ["患教素材"]);
});

test("empty collection deletion rolls back on audit failure and rejects concurrent indexing", async (t) => {
  const library = newLibrary(t);
  library.saveCollection("空库", { expectedRevision: 0, description: "测试", whenToUse: "测试" });
  const current = library.collections().find(c => c.name === "空库");
  library.activeIndexWrites = 1;
  await assert.rejects(library.removeCollection("空库", current), { code: "KNOWLEDGE_BUSY" });
  library.activeIndexWrites = 0;
  const audit = library.store.audit;
  library.store.audit = () => { throw new Error("audit failed"); };
  await assert.rejects(library.removeCollection("空库", current), /audit failed/);
  assert.ok(library.collections().some(c => c.name === "空库"));
  library.store.audit = audit;
  await library.removeCollection("空库", current);
  assert.deepEqual(library.collections().map(c => c.name), ["患教素材"]);
});
