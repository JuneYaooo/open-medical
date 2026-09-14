import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../server/core/agent-runtime.mjs";
import { ToolRegistry } from "../server/core/tool-registry.mjs";
import { PermissionEngine } from "../server/core/permissions.mjs";

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
  for (const [count, name, code] of [[16, "unknown", "UNKNOWN_TOOL"], [129, "read", "TOOL_BUDGET"]]) {
    const f = fixture({ model: "fixture", async complete() { return { message: { role: "assistant", tool_calls: calls(count, name) } }; } });
    await assert.rejects(f.runtime.run({ messages: [], ...f }), (e) => e.code === code);
    assert.equal(f.effects(), 0);
  }
  const f = fixture({ model: "fixture", async complete() { return { message: { role: "assistant", tool_calls: calls(16) } }; } });
  await assert.rejects(f.runtime.run({ messages: [], ...f, permissions: new PermissionEngine({ profile: "minimal" }) }),
    (e) => e.code === "MODE_TOOL_DENIED");
  assert.equal(f.effects(), 0);
});
