import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionEngine } from "../server/core/permissions.mjs";
import { fixture } from "./helpers.mjs";

// Full UI+capability fusion: the project workspace IS the medical surface.
// A per-workspace 医疗能力 permission adds the medical toolset and
// provenance discipline; full project permissions stay untouched.
test("workspace medical capability: toggle persists and registry gains medical tools", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omw-fusion-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await fixture(t, { database: join(dir, "medical.sqlite") });
  const perms = new PermissionEngine({ profile: "standard", grants: {} });

  const created = await f.json("/api/workspaces", "POST", {
    title: "融合工作区",
    root: dir,
    directoryConsent: true,
  });
  assert.equal(created.status, 201);
  const wsId = created.data.id;

  const names = (runId) =>
    f.server.workspaces
      .registry(wsId, runId)
      .definitions(perms)
      .map((d) => d.function.name);

  // Default: no medical tools, full project permissions intact.
  const before = names("run-before");
  assert.ok(!before.includes("guideline_search"));
  assert.ok(before.includes("read_file"));
  assert.ok(before.includes("list_directory"));

  // Enable medical capability.
  const toggled = await f.json(`/api/workspaces/${wsId}/medical`, "POST", {
    enabled: true,
  });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.data.modeFlags.medical, true);

  const after = names("run-after");
  for (const tool of [
    "literature_search",
    "guideline_search",
    "guideline_read",
    "medical_scale_calculate",
    "lab_knowledge_search",
    "assess_adverse_reaction",
    "medication_safety_check",
    "similar_case_search",
    "drg_group",
    "doctor_memory_get",
  ])
    assert.ok(after.includes(tool), `缺少医疗工具 ${tool}`);
  // Project permissions are untouched by the medical layer.
  assert.ok(after.includes("read_file"));
  assert.ok(after.includes("list_directory"));

  // Record reflects the flag for the UI.
  const refreshed = (await f.json(`/api/workspaces/${wsId}`)).data;
  assert.equal(refreshed.modeFlags.medical, true);

  // System prompt gains the medical discipline only for medical workspaces.
  assert.ok(
    f.server.workspaces.systemFor({ modeFlags: { medical: true } }).includes("已开启医疗能力"),
  );
  assert.ok(
    !f.server.workspaces.systemFor({}).includes("已开启医疗能力"),
  );

  // Disable removes the medical tools again.
  await f.json(`/api/workspaces/${wsId}/medical`, "POST", { enabled: false });
  const disabled = names("run-disabled");
  assert.ok(!disabled.includes("guideline_search"));
  assert.ok(disabled.includes("read_file"));
});

test("medical mode toggle rejects during active runs and invalid payloads", async (t) => {
  const f = await fixture(t);
  const dir = mkdtempSync(join(tmpdir(), "omw-fusion2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const created = await f.json("/api/workspaces", "POST", {
    title: "守卫工作区",
    root: dir,
    directoryConsent: true,
  });
  const wsId = created.data.id;

  const bad = await f.json(`/api/workspaces/${wsId}/medical`, "POST", {
    enabled: "yes",
  });
  assert.equal(bad.status, 400);

  // Simulate an active run -> 409.
  f.server.workspaces.active.set(wsId, {});
  const blocked = await f.json(`/api/workspaces/${wsId}/medical`, "POST", {
    enabled: true,
  });
  assert.equal(blocked.status, 409);
  f.server.workspaces.active.delete(wsId);
  const ok = await f.json(`/api/workspaces/${wsId}/medical`, "POST", {
    enabled: true,
  });
  assert.equal(ok.status, 200);
});

test("bootstrap still reports generic kernel identity for the fused domain", async (t) => {
  const f = await fixture(t);
  const health = (await f.json("/api/agent/health")).data;
  assert.equal(health.genericWorkspaces, true);
});
