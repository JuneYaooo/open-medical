// 单轮输出撞上限的软着陆：provider 以 stopReason:"max_tokens" 交付部分
// 内容后，运行层自动接续一轮；连续截断到上限则附说明收尾，整轮不再失败。
import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../server/core/agent-runtime.mjs";
import { ToolRegistry } from "../server/core/tool-registry.mjs";
import { PermissionEngine } from "../server/core/permissions.mjs";

function fixture(provider) {
  const registry = new ToolRegistry([
    {
      definition: {
        type: "function",
        function: {
          name: "noop",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: () => ({ ok: true }),
    },
  ]);
  return {
    runtime: new AgentRuntime({ provider, maxRounds: 8 }),
    registry,
    permissions: new PermissionEngine({ profile: "standard" }),
  };
}

test("truncated output continues once and delivers the merged answer", async () => {
  const rounds = [];
  const f = fixture({
    model: "fixture",
    async complete(messages) {
      rounds.push(structuredClone(messages));
      if (rounds.length === 1)
        return {
          message: { role: "assistant", content: "报告第一段。" },
          stopReason: "max_tokens",
        };
      return { message: { role: "assistant", content: "报告第二段结尾。" } };
    },
  });
  const result = await f.runtime.run({
    messages: [{ role: "user", content: "写报告" }],
    ...f,
  });
  assert.equal(result.text, "报告第一段。报告第二段结尾。");
  // 续写轮把系统接续提示插进了上下文，模型能从截断处接着写。
  const last = rounds.at(-1);
  assert.equal(last.at(-1).role, "user");
  assert.match(last.at(-1).content, /中断处直接继续/);
});

test("persistent truncation ends the run with partial content and a notice, not an error", async () => {
  const f = fixture({
    model: "fixture",
    async complete() {
      return {
        message: { role: "assistant", content: "片段。" },
        stopReason: "max_tokens",
      };
    },
  });
  const result = await f.runtime.run({
    messages: [{ role: "user", content: "写报告" }],
    ...f,
  });
  assert.match(result.text, /片段。/);
  assert.match(result.text, /输出达到长度上限/);
});

test("truncation with intact tool calls keeps normal tool flow", async () => {
  let effects = 0;
  let rounds = 0;
  const registry = new ToolRegistry([
    {
      definition: {
        type: "function",
        function: {
          name: "noop",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: () => {
        effects++;
        return { ok: true };
      },
    },
  ]);
  const runtime = new AgentRuntime({ provider: {
    model: "fixture",
    async complete() {
      rounds++;
      if (rounds === 1)
        return {
          message: {
            role: "assistant",
            content: "先调用工具。",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "noop", arguments: "{}" },
              },
            ],
          },
          stopReason: "max_tokens",
        };
      return { message: { role: "assistant", content: "完成。" } };
    },
  }, maxRounds: 4 });
  const result = await runtime.run({
    messages: [{ role: "user", content: "干活" }],
    registry,
    permissions: new PermissionEngine({ profile: "standard" }),
  });
  assert.equal(effects, 1);
  assert.match(result.text, /完成。/);
});
