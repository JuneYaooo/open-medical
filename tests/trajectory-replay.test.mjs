import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceDatabase } from "../server/core/database.mjs";
import { WorkspaceStore } from "../server/core/workspace-store.mjs";
import { replayTrajectory } from "../server/core/trajectory-replay.mjs";

test("read-only playback reconstructs actors and flags incomplete protocol batches", () => {
  const database = new WorkspaceDatabase(":memory:"), store = new WorkspaceStore(database.db);
  try {
    const w = store.create({ root: "/fixture", permissions: {} });
    store.update(w.id, (w) => w.runs.push({ id: "run", status: "interrupted" }));
    const call = { id: "call", function: { name: "terminal_run", arguments: '{"command":"do not execute recorded text"}' } };
    store.trace(w.id, "run", { type: "model.request", messages: [{ role: "user", content: "fixture" }], tools: [] });
    store.trace(w.id, "run", { type: "model.response", message: { role: "assistant", tool_calls: [call] } });
    const incomplete = replayTrajectory(store, w.id, "run");
    assert.equal(incomplete.summary.protocolComplete, false);
    assert.deepEqual(incomplete.summary.unfinished[0].toolCalls, ["call"]);
    store.trace(w.id, "run", { type: "tool.result", call, output: { status: "completed", exitCode: 0 }, durationMs: 20 });
    const complete = replayTrajectory(store, w.id, "run");
    assert.equal(complete.readOnly, true);
    assert.equal(complete.executesTools, false);
    assert.equal(complete.summary.protocolComplete, true);
    assert.notEqual(complete.traceHash, incomplete.traceHash);
    assert.equal(complete.steps[2].durationMs, 20);
    const other = store.create({ root: "/other", permissions: {} });
    assert.throws(() => replayTrajectory(store, other.id, "run"), { code: "NOT_FOUND" });
  } finally { database.close(); }
});
