import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createViteServer } from "vite";

test("bulkPatientPatch builds per-patient group and archive patches", async () => {
  const vite = await createViteServer({ appType: "custom", optimizeDeps: { noDiscovery: true, include: [] }, logLevel: "silent", server: { middlewareMode: true } });
  try {
    const { bulkPatientPatch } = await vite.ssrLoadModule("/src/patients.jsx");
    const p = { groups: ["高血压"], archived: false };
    assert.deepEqual(bulkPatientPatch(p, "add-group", " 糖尿病 "), { groups: ["高血压", "糖尿病"] });
    assert.equal(bulkPatientPatch(p, "add-group", "高血压"), null);
    assert.equal(bulkPatientPatch(p, "add-group", "  "), null);
    assert.deepEqual(bulkPatientPatch({}, "add-group", "糖尿病"), { groups: ["糖尿病"] });
    assert.deepEqual(bulkPatientPatch(p, "remove-group", "高血压"), { groups: [] });
    assert.equal(bulkPatientPatch(p, "remove-group", "糖尿病"), null);
    assert.deepEqual(bulkPatientPatch(p, "archive"), { archived: true });
    assert.equal(bulkPatientPatch({ archived: true }, "archive"), null);
    assert.deepEqual(bulkPatientPatch({ archived: true }, "restore"), { archived: false });
    assert.equal(bulkPatientPatch(p, "restore"), null);
  } finally {
    await vite.close();
  }
});
