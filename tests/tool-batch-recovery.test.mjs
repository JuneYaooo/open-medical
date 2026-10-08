import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../server/core/agent-runtime.mjs";
import { ToolRegistry } from "../server/core/tool-registry.mjs";
import { PermissionEngine } from "../server/core/permissions.mjs";
import { check } from "../server/errors.mjs";
import { validateArguments } from "../server/core/schema.mjs";

const calls = (count, name = "read") => Array.from({ length: count }, (_, i) =>
  ({ id: `call-${i}`, function: { name, arguments: "{}" } }));
function fixture(provider) {
  let effects = 0;
  const registry = new ToolRegistry([{ definition: { type: "function", function: {
    name: "read", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  permission: "filesystem.read", execute: () => { effects++; return { ok: true }; } }]);
  return { runtime: new AgentRuntime({ provider, maxRounds: 3 }), registry,
    permissions: new PermissionEngine({ profile: "standard" }), effects: () => effects };
}
test("tool budget survives a checkpoint and rejected attempts do not become pending effects", async () => {
  let state, pending, effects = 0;
  const registry = new ToolRegistry([{ definition: { type: "function", function: {
    name: "read", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  permission: "filesystem.read", execute: () => { effects++; return { ok: true }; } }]);
  const permissions = new PermissionEngine({ profile: "standard" });
  const provider = { model: "fixture", async complete(messages) {
    if (!messages.some(m => m.role === "tool")) return { message: { role: "assistant", tool_calls: calls(1) } };
    return { message: { role: "assistant", content: "done" } };
  } };
  const runtime = new AgentRuntime({ provider, maxRounds: 2, maxTotalToolCalls: 1 });
  const onCheckpoint = (_messages, value) => { state = value.runtimeState; pending = value.pendingToolCall; };
  await runtime.run({ messages: [], registry, permissions, onCheckpoint });
  assert.equal(effects, 1);
  assert.equal(state.executedToolCalls, 1);
  const result = await runtime.run({ messages: [], registry, permissions, runtimeState: state, onCheckpoint });
  assert.equal(effects, 1);
  assert.equal(pending, undefined);
  assert.ok(result.messages.some(m => m.role === "tool" && JSON.parse(m.content).code === "TOOL_BUDGET_EXHAUSTED"));
});
test("oversized tool batch executes nothing, preserves complete protocol and allows bounded retry", async () => {
  let rounds = 0;
  const f = fixture({ model: "fixture", async complete(messages) {
    rounds++;
    if (rounds === 1) return { message: { role: "assistant", tool_calls: calls(16) } };
    if (rounds === 2) {
      const outputs = messages.filter((m) => m.role === "tool");
      assert.equal(outputs.length, 16); assert.equal(f.effects(), 0);
      assert.ok(outputs.every((m) => JSON.parse(m.content).code === "TOOL_BATCH_LIMIT"));
      return { message: { role: "assistant", tool_calls: calls(1) } };
    }
    return { message: { role: "assistant", content: "done" } };
  } });
  const result = await f.runtime.run({ messages: [{ role: "user", content: "read" }], ...f });
  assert.equal(result.text, "done"); assert.equal(f.effects(), 1); assert.equal(rounds, 3);
});
test("batch recovery does not bypass unknown tools, authority or the hard payload ceiling", async () => {
  for (const [count, name] of [[16, "unknown"], [129, "read"]]) {
    const f = fixture({ model: "fixture", async complete() { return { message: { role: "assistant", tool_calls: calls(count, name) } }; } });
    // Denials (unknown tool / oversized batch) are returned to the model; a
    // model that never adapts is bounded by the round budget.
    await assert.rejects(f.runtime.run({ messages: [], ...f }),
      (e) => e.code === "TOOL_BUDGET");
    assert.equal(f.effects(), 0);
  }
  // Tool-specific authority denials never execute; the denial is fed back
  // so an adaptive model can finish the turn without side effects. (A minimal
  // profile still fails the whole run before any per-call authorization.)
  let rounds = 0;
  let deniedEffects = 0;
  const deniedRuntime = new AgentRuntime({
    provider: { model: "fixture", async complete(messages) {
      rounds++;
      if (rounds === 1) return { message: { role: "assistant", tool_calls: calls(4) } };
      const denial = JSON.parse(messages.filter((m) => m.role === "tool").at(-1).content);
      assert.equal(denial.code, "PERMISSION_DENIED");
      return { message: { role: "assistant", content: "cannot commit" } };
    } },
    maxRounds: 3,
  });
  const deniedRegistry = new ToolRegistry([{ definition: { type: "function", function: {
    name: "read", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  permission: "git.write", execute: () => { deniedEffects++; return { ok: true }; } }]);
  const result = await deniedRuntime.run({ messages: [], registry: deniedRegistry,
    permissions: new PermissionEngine({ profile: "standard" }) });
  assert.equal(result.text, "cannot commit");
  assert.equal(deniedEffects, 0);
});
test("COMPLETE_RETRY bounces a premature finish back into the loop instead of failing", async () => {
  let rounds = 0, saved = false;
  const registry = new ToolRegistry([{ definition: { type: "function", function: {
    name: "save", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  permission: "filesystem.write", execute: () => { saved = true; return { saved: true }; } }]);
  const provider = { model: "fixture", async complete(messages) {
    rounds++;
    if (rounds === 1) return { message: { role: "assistant", content: "我直接总结一下。" } };
    if (rounds === 2) {
      const nudge = messages.findLast((m) => m.name === "runtime_control");
      assert.ok(nudge, "重试提示未送达模型");
      assert.match(nudge.content, /save/);
      return { message: { role: "assistant", tool_calls: calls(1, "save") } };
    }
    return { message: { role: "assistant", content: "done" } };
  } };
  const runtime = new AgentRuntime({ provider, maxRounds: 4, maxTotalToolCalls: 2 });
  const result = await runtime.run({ messages: [{ role: "user", content: "整理" }], registry,
    permissions: new PermissionEngine({ profile: "standard", grants: { "filesystem.write": true } }),
    domain: { beforeComplete: () =>
      check(saved, "COMPLETE_RETRY", "尚未成功调用 save。请修正后重新调用；保存成功后再结束。") } });
  assert.ok(result.text.endsWith("done"));
  assert.equal(saved, true);
  assert.equal(rounds, 3);
});
test("tool argument errors name the exact violated constraint", () => {
  const schema = { type: "object",
    properties: {
      nodes: { type: "array", maxItems: 2, items: { type: "object",
        properties: { label: { type: "string" }, type: { type: "string", enum: ["疾病", "检查"] } },
        required: ["label", "type"], additionalProperties: false } },
    },
    required: ["nodes"], additionalProperties: false };
  assert.throws(() => validateArguments({ nodes: [{ label: "甲", type: "药物", note: "x" }] }, schema),
    (e) => e.code === "INVALID_TOOL_ARGS" && /type.*取值必须是/.test(e.message));
  assert.throws(() => validateArguments({ nodes: [{ type: "疾病" }] }, schema),
    (e) => /缺少必填字段 "label"/.test(e.message));
  assert.throws(() => validateArguments({ nodes: [{ label: "甲", type: "疾病", note: "x" }] }, schema),
    (e) => /未定义的字段 "note"/.test(e.message));
  assert.throws(() => validateArguments({ nodes: "三个" }, schema),
    (e) => /nodes（应为数组）/.test(e.message));
});
