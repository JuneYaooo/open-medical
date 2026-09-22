import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceDatabase, WorkspaceService } from "../server/core/index.mjs";

test("long-lived workspace archives old tasks, preserves deduplication and isolates model history", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omw-history-"));
  const db = new WorkspaceDatabase(join(root, "state.sqlite"));
  const service = new WorkspaceService(db.db, { apiKey: "synthetic", model: "test", async complete() {
    return { message: { role: "assistant", content: "result" } };
  } });
  t.after(async () => { await service.extensions.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const w = service.create({ root, directoryConsent: true });
  for (let n = 0; n < 55; n++) {
    const handle = service.prepare(w.id, { revision: service.get(w.id).revision,
      message: `task ${n}`, requestId: `request-${n}`, externalConsent: true });
    assert.equal((await service.execute(handle)).status, "completed");
  }
  const current = service.get(w.id);
  assert.equal(current.runs.length, 50);
  assert.equal(current.archivedRuns, 5);
  assert.equal(current.messages.length, 100);
  const page = service.store.history(w.id, { limit: 2 });
  assert.equal(page.entries[0].messages[0].content, "task 4");
  assert.equal(page.entries[0].run.contextMessages, undefined);
  assert.equal(service.store.history(w.id, { before: page.nextCursor, limit: 2 }).entries[0].messages[0].content, "task 2");
  assert.throws(() => service.prepare(w.id, { revision: current.revision,
    message: "duplicate", requestId: "request-0", externalConsent: true }), { code: "DUPLICATE_REQUEST" });
  let result = await service.tool(w.id, { tool: "search_run_history", arguments: { query: "task 0" } });
  assert.equal(result.entries.length, 1);
  service.provider.model = "another-model";
  result = await service.tool(w.id, { tool: "search_run_history", arguments: { query: "task 0" } });
  assert.equal(result.entries.length, 0);
  const other = service.create({ root, directoryConsent: true });
  assert.equal(service.store.history(other.id).entries.length, 0);
  assert.equal(db.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

test("compaction facts exclude completed earlier work while retaining current team receipts and every pending approval", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omw-durable-history-"));
  const db = new WorkspaceDatabase(join(root, "state.sqlite"));
  const service = new WorkspaceService(db.db, { local: true, model: "fixture", complete: async () => ({ message: { role: "assistant", content: "done" } }) });
  t.after(async () => { await service.extensions.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const w = service.create({ root, directoryConsent: true });
  const handle = service.prepare(w.id, { revision: service.get(w.id).revision, message: "current task", externalConsent: true });
  await service.execute(handle);
  service.store.update(w.id, (current) => {
    current.runs.at(-1).children = [{ id: "current-child" }];
    current.plan = { runId: "earlier", steps: [{ text: "An old plan must not become current requirements" }] };
    current.approvals = Array.from({ length: 1000 }, (_, n) => ({ id: `old-${n}`, runId: "earlier", path: `old-${n}.md`, status: "applied" }));
    current.approvals.push({ id: "still-pending", runId: "earlier", path: "pending.md", status: "pending" }, { id: "child-change", runId: "current-child", path: "child.md", status: "applied" });
    current.verifications = Array.from({ length: 1000 }, (_, n) => ({ id: `test-${n}`, runId: "manual", exitCode: 0, status: "completed" }));
    current.verifications.push({ id: "current-test", runId: "current-child", exitCode: 0, status: "completed" });
    current.artifacts = Array.from({ length: 1000 }, (_, n) => ({ id: `artifact-${n}`, runId: "earlier", name: `file-${n}.pdf`, hash: "h".repeat(64) }));
    current.artifacts.push({ id: "current-artifact", runId: handle.run.id, name: "current.pdf", hash: "c".repeat(64) });
  });
  const messages = service.durableContext(w.id, handle.run.id), content = messages[0].content;
  assert.ok(content.length < 2000, `durable facts grew to ${content.length} chars`);
  const facts = JSON.parse(content.slice(content.indexOf("{")));
  assert.deepEqual(facts.approvals.map((item) => item.id), ["still-pending", "child-change"]);
  assert.deepEqual(facts.verifications.map((item) => item.id), ["current-test"]);
  assert.deepEqual(facts.artifacts.map((item) => item.id), ["current-artifact"]);
  assert.equal(facts.plan, undefined); assert.equal(facts.earlierWork.verifications, 1000);
  assert.equal(service.store.get(w.id).verifications.length, 1001);
  assert.equal(service.store.get(w.id).artifacts.length, 1001);
});
