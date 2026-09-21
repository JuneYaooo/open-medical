import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDelivery, receiptEvidence } from "../server/core/delivery.mjs";
import { AgentRuntime } from "../server/core/agent-runtime.mjs";
import { ToolRegistry } from "../server/core/tool-registry.mjs";
import { PermissionEngine } from "../server/core/permissions.mjs";

const file = { kind: "file", path: "report.md", readable: true, hash: "a".repeat(64) };

test("delivery requires usable evidence and no unresolved gaps", () => {
  for (const evidence of [[], [{}], [null], [[]], [{ ...file, readable: false }],
    [{ ...file, hash: "fake" }], [file, { kind: "file", gap: "not_found" }]]) {
    const result = normalizeDelivery({ delivered: true, evidence });
    assert.equal(result.delivered, false);
    assert.ok(result.gaps.length > 0);
  }
  assert.equal(normalizeDelivery({ delivered: true, evidence: [file], gaps: ["测试仍失败"] }).delivered, false);
  assert.equal(normalizeDelivery({ delivered: true, evidence: [file] }).delivered, true);
  assert.equal(normalizeDelivery({ delivered: false, evidence: [file] }).delivered, false);
  assert.equal(normalizeDelivery([]), null);
  assert.equal(normalizeDelivery({ delivered: true, evidence: [file], gaps: [null] }).delivered, false);
  for (const receipt of [{ exitCode: 1 }, { exitCode: null }, { status: "running" }, { status: "rejected" }, { ok: false }])
    assert.equal(normalizeDelivery({ delivered: true, evidence: [receiptEvidence("sandbox", receipt)] }).delivered, false);
  assert.equal(normalizeDelivery({ delivered: true, evidence: [receiptEvidence("sandbox", { exitCode: 0 })] }).delivered, true);
});

test("receipt metadata cannot override the runtime-assigned evidence identity", () => {
  const receipt = receiptEvidence("sandbox", { kind: "invented", source: "untrusted", exitCode: 0 });
  assert.equal(receipt.kind, "receipt");
  assert.equal(receipt.source, "sandbox");
  assert.equal(receipt.exitCode, 0);
});

function setup() {
  const events = [];
  const runtime = new AgentRuntime({ provider: {
    model: "synthetic", complete: async () => ({ message: { role: "assistant", content: "完成" } }),
  } });
  const args = { messages: [{ role: "user", content: "创建报告" }],
    registry: new ToolRegistry(), permissions: new PermissionEngine({ profile: "standard" }),
    emit: (type) => events.push(type) };
  return { runtime, args, events };
}

test("configured checkers cannot verify empty, malformed, or contradictory results", async () => {
  for (const verification of [undefined, "done", [], { delivered: true, evidence: [] },
    { delivered: true, evidence: [file], gaps: ["内容要求未满足"] }]) {
    const { runtime, args, events } = setup();
    const result = await runtime.run({ ...args, onDelivery: () => verification });
    assert.equal(result.delivery.delivered, false);
    assert.ok(result.delivery.gaps.length);
    assert.ok(!events.includes("delivery.verified"));
    assert.ok(events.includes("delivery.gaps"));
  }
});

test("verification failure remains observable while explicit answer opt-out stays compatible", async () => {
  const { runtime, args, events } = setup();
  const failure = await runtime.run({ ...args, onDelivery: () => { throw new Error("private internal details"); } });
  assert.equal(failure.delivery.delivered, false);
  assert.equal(failure.delivery.gaps[0].reason, "delivery_check_failed");
  assert.doesNotMatch(JSON.stringify(failure.delivery), /private internal/);
  assert.ok(events.includes("delivery.unverified"));
  assert.equal((await runtime.run({ ...args, onDelivery: () => null })).delivery, undefined);
  assert.equal((await runtime.run(args)).delivery, undefined);
});

test("cancellation during a successful verifier never returns a completed result", async () => {
  const { runtime, args } = setup();
  const controller = new AbortController();
  await assert.rejects(runtime.run({ ...args, signal: controller.signal, onDelivery: () => {
    controller.abort();
    return { delivered: true, evidence: [file] };
  } }), (error) => error.name === "AbortError");
});
