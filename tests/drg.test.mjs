import test from "node:test";
import assert from "node:assert/strict";
import { DrgService } from "../server/medical/drg.mjs";
import { Store } from "../server/store.mjs";
import { fixture } from "./helpers.mjs";

const newDrg = (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return new DrgService(store);
};

test("drg scheme data files are present and structured", async (t) => {
  const drg = newDrg(t);
  await drg.load();
  assert.ok(drg.scheme.mdcMap.rules.length >= 20);
  assert.ok(drg.scheme.drgGroups.adrgs.length >= 15);
  assert.ok(drg.scheme.drgGroups.mccPrefixes.length >= 10);
  assert.match(drg.scheme.drgGroups.version, /简化|示例/);
});

test("drg group: routing, complication levels and estimated cost", async (t) => {
  const drg = newDrg(t);
  await drg.load();
  // Pneumonia with severe complication -> ER11 (MCC level).
  const severe = await drg.group({
    principalDx: "J18.9 社区获得性肺炎",
    secondaryDx: ["I50.9 心力衰竭", "J96.0"],
    procedures: [],
  });
  assert.equal(severe.mdc, "04 呼吸系统疾病");
  assert.match(severe.adrg, /ER1/);
  assert.equal(severe.complication.level, "mcc");
  assert.equal(severe.drgCode, "ER11");
  assert.ok(severe.rw > 1);
  assert.ok(severe.estimatedCost > 10000);
  // Same ADRG without complications -> cheaper DRG.
  const plain = await drg.group({ principalDx: "J18.9", secondaryDx: [] });
  assert.equal(plain.drgCode, "ER15");
  assert.ok(plain.rw < severe.rw);

  // Surgical routing: CABG (ICD-9-CM-3 36.1) picks FM1 over medical FR2.
  const pci = await drg.group({
    principalDx: "I20.0 不稳定型心绞痛",
    secondaryDx: ["E11.9"],
    procedures: ["36.07"],
  });
  assert.equal(pci.adrgType, "surgical");
  assert.match(pci.adrg, /FM1/);
  assert.equal(pci.complication.level, "cc");

  // Ungrouped principal diagnosis reports a reason instead of crashing.
  const unknown = await drg.group({ principalDx: "R07.4 胸痛" });
  assert.equal(unknown.drgCode, null);
  assert.match(unknown.ungroupedReason, /无法路由|MDC/);
});

test("drg settings and imported weights override builtin values", async (t) => {
  const drg = newDrg(t);
  await drg.load();
  const updated = drg.updateSettings({ rate: 8500, hospital: "测试统筹区" });
  assert.equal(updated.rate, 8500);
  const before = await drg.group({ principalDx: "J18.9", secondaryDx: [] });
  assert.equal(before.rwSource, "builtin");
  const imported = drg.importWeights({ ER15: 0.72 });
  assert.equal(imported.imported, 1);
  const after = await drg.group({ principalDx: "J18.9", secondaryDx: [] });
  assert.equal(after.rw, 0.72);
  assert.equal(after.rwSource, "imported");
  assert.equal(after.estimatedCost, Math.round(0.72 * 8500));
  assert.throws(() => drg.importWeights({ BAD: -1 }), /权重无效/);
  assert.throws(() => drg.updateSettings({ rate: -5 }), /费率/);
});

test("drg batch analysis: distribution and CMI", async (t) => {
  const drg = newDrg(t);
  await drg.load();
  const csv = [
    "principal_dx,secondary_dx,procedures,total_cost",
    "J18.9;;,;I50.9,,", // noisy-but-tolerated row shape check below
  ].join("\n");
  void csv;
  const csvText = [
    "principal_dx,secondary_dx,procedures,total_cost",
    "J18.9;I50.9;;;",
    "",
  ].join("\n");
  void csvText;
  const batch = await drg.batchAnalyze({
    csvText: [
      "principal_dx,secondary_dx,procedures,total_cost",
      "J18.9;I50.9;;",
      "I20.0;E11.9;36.07;58000",
      "K80.2;;51.23;26000",
      "R07.4;;",
    ].join("\n"),
  });
  assert.equal(batch.rows, 4);
  assert.equal(batch.grouped, 3);
  assert.equal(batch.ungrouped, 1);
  assert.ok(batch.cmi > 0);
  assert.ok(Object.keys(batch.distribution).length >= 3);
  assert.ok(batch.totalEstimated > 0);
  assert.ok(batch.results.at(-1).ungroupedReason);
});

test("drg agent tools registered; REST endpoints work end-to-end", async (t) => {
  const f = await fixture(t);
  const boot = (await f.json("/api/bootstrap")).data;
  assert.ok(boot.tools.includes("drg_group"));
  assert.ok(boot.tools.includes("drg_batch_analyze"));
  assert.equal(boot.drg.rate, 10000);

  const grouped = await f.json("/api/drg/group", "POST", {
    principalDx: "J18.9 社区获得性肺炎",
    secondaryDx: ["I50.9"],
  });
  assert.equal(grouped.status, 200);
  assert.equal(grouped.data.drgCode, "ER11");
  assert.ok(grouped.data.note.includes("草稿"));

  const settings = await f.json("/api/drg/settings", "POST", { rate: 9000 });
  assert.equal(settings.data.rate, 9000);
  const importResult = await f.json("/api/drg/import", "POST", {
    weights: { ER13: 0.91 },
  });
  assert.equal(importResult.data.imported, 1);
  const recost = await f.json("/api/drg/group", "POST", {
    principalDx: "J18.9",
    secondaryDx: ["E11.9"],
  });
  assert.equal(recost.data.drgCode, "ER13");
  assert.equal(recost.data.rw, 0.91);
  assert.equal(recost.data.estimatedCost, Math.round(0.91 * 9000));

  const batch = await f.json("/api/drg/batch", "POST", {
    csvText: [
      "principal_dx,secondary_dx,procedures,total_cost",
      "J18.9;;",
      "I61.0;J96.0;;66000",
    ].join("\n"),
  });
  assert.equal(batch.status, 200);
  assert.equal(batch.data.rows, 2);
  assert.ok(batch.data.cmi > 0);
});
