import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceVectorStore } from "../server/medical/vector-store.mjs";

const row = (docId, ord = 0, text = "original", vector = [1, 0]) => ({
  doc_id: docId,
  ord,
  title: "Synthetic",
  org: "",
  year: 2026,
  start_line: ord + 1,
  end_line: ord + 1,
  text,
  vector,
});

test("vector indexing accepts missing publication years and retains later known years", async (t) => {
  const store = await fixture(t);
  const missing = row("material");
  delete missing.year;
  await store.upsertDoc("material", "materials", [missing]);
  await store.upsertDoc("undated", "guidelines", [
    { ...row("undated"), year: null },
  ]);
  await store.upsertDoc("dated", "guidelines", [row("dated")]);
  const hits = await store.search("guidelines", [1, 0]);
  assert.equal(hits.find((hit) => hit.docId === "undated").year, null);
  assert.equal(hits.find((hit) => hit.docId === "dated").year, 2026);
  await store.upsertDoc("undated", "guidelines", [
    { ...row("undated"), year: 2025 },
  ]);
  assert.equal(
    (await store.search("guidelines", [1, 0])).find(
      (hit) => hit.docId === "undated",
    ).year,
    2025,
  );
  assert.equal((await store.search("materials", [1, 0])).length, 1);
});
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "medical-vector-test-"));
  const store = LanceVectorStore.create(dir);
  t.after(async () => {
    store.db?.close();
    await rm(dir, { recursive: true, force: true });
  });
  await store.ensureDb();
  return store;
}

test("existing inferred vector schemas remain readable and writable after the update", async (t) => {
  const store = await fixture(t);
  await store.db.createTable(store.tableName("legacy"), [row("existing")]);
  await store.upsertDoc("existing", "legacy", [row("existing", 0, "updated")]);
  await store.upsertDoc("new", "legacy", [row("new")]);
  const hits = await store.search("legacy", [1, 0]);
  assert.equal(hits.length, 2);
  assert.equal(hits.find((hit) => hit.docId === "existing").text, "updated");
});

test("vector document replacement is atomic on conversion failure and removes only obsolete chunks", async (t) => {
  const store = await fixture(t);
  await store.upsertDoc("first", "synthetic", [row("first"), row("first", 1)]);
  await store.upsertDoc("other", "synthetic", [row("other")]);
  await assert.rejects(
    store.upsertDoc("first", "synthetic", [
      row("first", 0, "invalid", [1, 0, 0]),
    ]),
  );
  await assert.rejects(
    store.upsertDoc("first", "synthetic", [
      { ...row("first"), year: Symbol("invalid numeric value") },
    ]),
  );
  let hits = await store.search("synthetic", [1, 0]);
  assert.equal(hits.filter((h) => h.docId === "first").length, 2);
  assert.ok(hits.every((h) => h.text === "original"));
  await store.upsertDoc("first", "synthetic", [row("first", 0, "updated")]);
  hits = await store.search("synthetic", [1, 0]);
  assert.equal(hits.length, 2);
  assert.equal(hits.find((h) => h.docId === "first").text, "updated");
  assert.equal(hits.find((h) => h.docId === "other").text, "original");
});

test("concurrent vector writes create one table and preserve distinct documents", async (t) => {
  const store = await fixture(t);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      store.upsertDoc(`doc-${i}`, "synthetic", [row(`doc-${i}`)]),
    ),
  );
  assert.equal((await store.stats()).chunks, 8);
  await Promise.all([
    store.upsertDoc("doc-0", "synthetic", [row("doc-0", 0, "new")]),
    store.removeDocs(["doc-1"]),
    store.upsertDoc("doc-2", "synthetic", []),
  ]);
  const hits = await store.search("synthetic", [1, 0]);
  assert.equal(hits.length, 6);
  assert.equal(hits.find((h) => h.docId === "doc-0").text, "new");
  assert.ok(!hits.some((h) => ["doc-1", "doc-2"].includes(h.docId)));
});

test("quoted vector document IDs stay isolated and deleting absent documents is a no-op", async (t) => {
  const store = await fixture(t),
    id = "quoted' OR 1=1 --";
  await store.upsertDoc("absent", "synthetic", []);
  assert.equal((await store.stats()).models.length, 0);
  await store.upsertDoc("keep", "synthetic", [row("keep")]);
  await store.upsertDoc(id, "synthetic", [row(id)]);
  await store.upsertDoc(id, "synthetic", [row(id, 0, "updated")]);
  await store.removeDocs([id]);
  assert.deepEqual(
    (await store.search("synthetic", [1, 0])).map((h) => h.docId),
    ["keep"],
  );
});

test("invalid vectors and duplicate or mismatched chunk IDs cannot damage an existing document", async (t) => {
  const store = await fixture(t);
  await store.upsertDoc("first", "synthetic", [row("first")]);
  for (const rows of [
    [row("other")],
    [row("first"), row("first")],
    [row("first", 0, "bad", [NaN, 0])],
    [row("first", 0, "bad", [])],
    [null],
  ])
    await assert.rejects(store.upsertDoc("first", "synthetic", rows));
  assert.equal((await store.search("synthetic", [1, 0]))[0].text, "original");
});
