import test from "node:test";
import assert from "node:assert/strict";
import { PermissionEngine } from "../server/core/permissions.mjs";
import { ToolRegistry } from "../server/core/tool-registry.mjs";

test("generic permission engine denies by profile and supports explicit grants", () => {
  const minimal = new PermissionEngine({ profile: "minimal" });
  assert.equal(minimal.can("tools.execute"), false);
  assert.throws(() => minimal.require("tools.execute"), /不允许/);
  const granted = new PermissionEngine({
    profile: "standard",
    grants: { network: true },
  });
  assert.equal(granted.can("network"), true);
  assert.deepEqual(granted.snapshot().profile, "standard");
});

test("tool registry filters definitions and enforces permission at execution", async () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: { type: "function", function: { name: "safe" } },
    execute: () => "ok",
  });
  registry.register({
    definition: { type: "function", function: { name: "network_call" } },
    permission: "network",
    execute: () => "bad",
  });
  assert.equal(
    registry.definitions(new PermissionEngine({ profile: "minimal" })).length,
    0,
  );
  assert.equal(
    await registry.execute(
      "safe",
      {},
      {},
      new PermissionEngine({ profile: "standard" }),
    ),
    "ok",
  );
  await assert.rejects(
    () =>
      registry.execute(
        "network_call",
        {},
        {},
        new PermissionEngine({ profile: "standard" }),
      ),
    /不允许/,
  );
});

test("generic code profile supports model and delegation while medical code policy stays local", async () => {
  const { MedicalDomain } = await import("../server/domains/medical.mjs");
  const generic = new PermissionEngine({ profile: "code" });
  assert.equal(generic.can("model.external"), true);
  assert.equal(generic.can("agents.delegate"), true);
  const medical = new PermissionEngine({
    profile: "code",
    grants: MedicalDomain.permissionGrants("code"),
  });
  assert.equal(medical.can("model.external"), false);
  assert.equal(medical.can("agents.delegate"), false);
  assert.equal(medical.can("sandbox.execute"), true);
});
