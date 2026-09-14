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
