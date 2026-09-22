import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

test("large patient lists project identity without per-patient queries or clinical payload", async (t) => {
  const f = await fixture(t), registry = f.server.patients;
  const base = registry.create({ name: "合成容量患者", groups: ["慢病"], tags: ["复查"] });
  const insert = f.server.store.db.prepare("INSERT INTO patients VALUES (?,?)");
  const labs = Array.from({ length: 500 }, (_, i) => ({ item: "合成指标", value: i, date: "2026-09-20", unit: "合成单位", source: "合成来源" }));
  for (let i = 1; i <= 500; i++) insert.run(`capacity-${i}`, JSON.stringify({ ...base, id: `capacity-${i}`, name: `合成患者${i}`, patientNumber: `CAP-${i}`, labs, note: "详情备注", updatedAt: i }));
  const originalCounts = registry.counts;
  registry.counts = () => { throw new Error("N+1 counts regression"); };
  t.after(() => { registry.counts = originalCounts; });
  const list = (await f.json("/api/patients?summary=1")).data.patients;
  assert.equal(list.length, 501);
  assert.equal(list[1].id, "capacity-500");
  assert.ok(list.every((p) => !("labs" in p) && !("medications" in p) && !("note" in p)));
  assert.deepEqual(list[1].groups, ["慢病"]);
  assert.deepEqual(list[1].counts, { unprocessedMessages: 0, activeFollowups: 0, dueFollowups: 0, pendingReminders: 0 });
  assert.ok(JSON.stringify(list).length < 400000);
  assert.equal((await f.json("/api/patients?summary=1&q=CAP-500")).data.patients.length, 1);
  registry.counts = originalCounts;
  assert.equal((await f.json("/api/patients/capacity-500")).data.labs.length, 500);
});
