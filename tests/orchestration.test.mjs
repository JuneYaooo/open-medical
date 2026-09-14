import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";

test("minimal mode rejects unsolicited model tool calls before execution", async (t) => {
  let requests = 0;
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    async complete(messages, tools) {
      requests++;
      assert.equal(tools.length, 0);
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "forbidden-child",
              function: {
                name: "delegate_medical_task",
                arguments: JSON.stringify({
                  profile: "timeline",
                  task: "整理合成记录",
                  sourceIds: [],
                }),
              },
            },
          ],
        },
      };
    },
  };
  const f = await fixture(t, { provider });
  const s = await f.session();
  const result = await f.chat(s.id, "整理合成记录", {
    mode: "minimal",
    externalConsent: true,
  });
  const run = f.server.store.get(s.id).runs[0];
  assert.equal(requests, 1);
  assert.equal(run.status, "failed");
  assert.match(run.error, /不允许执行模型工具调用/);
  assert.equal(run.children?.length || 0, 0);
  assert.equal(
    result.events.some((e) => e.type === "tool.start"),
    false,
  );
});

test("minimal mode rejects explicit delegations before creating a run", async (t) => {
  let requests = 0;
  const f = await fixture(t, {
    provider: {
      apiKey: "synthetic",
      model: "synthetic",
      async complete() {
        requests++;
        throw new Error("must not execute");
      },
    },
  });
  const s = await f.session();
  const result = await f.json(`/api/chat/${s.id}`, "POST", {
    message: "整理合成记录",
    mode: "minimal",
    externalConsent: true,
    delegations: ["timeline"],
  });
  assert.equal(result.status, 403);
  assert.equal(result.data.code, "MODE_TOOL_DENIED");
  assert.equal(requests, 0);
  assert.equal(f.server.store.get(s.id).runs.length, 0);
});

test("model-driven delegation returns child results and accumulates their usage", async (t) => {
  let rootRound = 0;
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    async complete(messages, tools, { onDelta = () => {} }) {
      if (
        !tools.some((tool) => tool.function.name === "delegate_medical_task")
      ) {
        return {
          message: { role: "assistant", content: "合成子代理结果" },
          usage: { total_tokens: 12 },
        };
      }
      if (!rootRound++)
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "child1",
                function: {
                  name: "delegate_medical_task",
                  arguments: JSON.stringify({
                    profile: "timeline",
                    task: "整理合成记录",
                    sourceIds: [],
                  }),
                },
              },
            ],
          },
          usage: { total_tokens: 3 },
        };
      const output = JSON.parse(messages.at(-1).content);
      assert.equal(output.status, "completed");
      assert.equal(output.text, "合成子代理结果");
      onDelta("已收集子任务结果。");
      return {
        message: { role: "assistant", content: "已收集子任务结果。" },
        usage: { total_tokens: 5 },
      };
    },
  };
  const f = await fixture(t, { provider });
  const s = await f.session();
  const result = await f.chat(s.id, "整理合成资料", {
    mode: "model",
    externalConsent: true,
  });
  assert.equal(result.events.at(-1).type, "message.complete");
  const run = f.server.store.get(s.id).runs[0];
  assert.equal(run.children.length, 1);
  assert.equal(run.usage.subagent_tokens, 12);
  assert.equal(run.usage.total_tokens, 20);
});

test("earlier model rounds containing deselected files are excluded from later context", async (t) => {
  const seen = [];
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    async complete(messages) {
      seen.push(JSON.stringify(messages));
      return {
        message: { role: "assistant", content: "PREVIOUS_MATERIAL_DERIVATION" },
      };
    },
  };
  const f = await fixture(t, { provider });
  const s = await f.session();
  const file = f.server.runtime.addFile(s.id, {
    name: "private.txt",
    text: "EXCLUDED_FILE_MARKER",
  });
  await f.chat(s.id, "整理合成记录", {
    mode: "model",
    externalConsent: true,
    fileIds: [file.id],
  });
  await f.chat(s.id, "整理其他合成记录", {
    mode: "model",
    externalConsent: true,
    fileIds: [],
  });
  assert.ok(!seen[1].includes("EXCLUDED_FILE_MARKER"));
  assert.ok(!seen[1].includes("PREVIOUS_MATERIAL_DERIVATION"));
});

test("medical child workers persist distinct lifecycles and source-linked drafts", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  const result = await f.chat(s.id, "合成测试 2026-01-02 首诊 Hb 98 g/L", {
    delegations: ["timeline", "observations", "medication"],
  });
  assert.equal(result.events.at(-1).type, "message.complete");
  const saved = f.server.store.get(s.id);
  assert.equal(saved.runs[0].children.length, 3);
  assert.ok(saved.runs[0].children.every((c) => c.status === "completed"));
  assert.equal(saved.artifacts.length, 3);
  assert.ok(saved.artifacts.every((a) => a.subagentId && a.status === "draft"));
  assert.ok(result.events.some((e) => e.type === "subagent.started"));
});
test("model child context is isolated and cannot recursively delegate", async (t) => {
  const seen = [];
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    async complete(messages, tools) {
      seen.push({ messages, tools });
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "bad",
              function: { name: "delegate_medical_task", arguments: "{}" },
            },
          ],
        },
      };
    },
  };
  const f = await fixture(t, { provider });
  const s = await f.session();
  f.server.runtime.addFile(s.id, {
    name: "excluded.txt",
    text: "UNSELECTED_SENTINEL",
  });
  const result = await f.chat(s.id, "合成测试，整理时间线", {
    mode: "model",
    externalConsent: true,
    delegations: ["timeline"],
    fileIds: [],
  });
  assert.equal(result.events.at(-1).type, "error");
  assert.ok(!JSON.stringify(seen).includes("UNSELECTED_SENTINEL"));
  assert.ok(
    !seen[0].tools.some((x) => x.function.name === "delegate_medical_task"),
  );
  assert.equal(f.server.store.get(s.id).runs[0].children[0].status, "failed");
});
test("parent cancellation reaches running and queued children", async (t) => {
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    complete(_m, _t, { signal }) {
      return new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  };
  const f = await fixture(t, { provider });
  const s = await f.session();
  const handle = f.server.runtime.prepare(s.id, {
    message: "整理合成资料",
    mode: "model",
    externalConsent: true,
    delegations: ["timeline", "observations", "medication"],
  });
  const pending = f.server.runtime.execute(handle);
  f.server.runtime.cancel(s.id);
  assert.equal((await pending).status, "cancelled");
  assert.ok(
    f.server.store
      .get(s.id)
      .runs[0].children.every((c) => c.status === "cancelled"),
  );
  assert.equal(f.server.runtime.subagents.active, 0);
});
test("registered plugins execute through actual model tool loop", async (t) => {
  let round = 0;
  const definition = {
    type: "function",
    function: {
      name: "medical_plugin_test",
      description: "test",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  };
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    async complete(messages) {
      if (!round++)
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "p1",
                function: { name: definition.function.name, arguments: "{}" },
              },
            ],
          },
        };
      assert.equal(
        JSON.parse(messages.at(-1).content).value,
        "plugin-executed",
      );
      return { message: { role: "assistant", content: "已处理" } };
    },
  };
  const f = await fixture(t, {
    provider,
    toolPlugins: [
      { definition, execute: () => ({ value: "plugin-executed" }) },
    ],
  });
  const s = await f.session();
  const result = await f.chat(s.id, "合成资料", {
    mode: "model",
    externalConsent: true,
  });
  assert.equal(result.events.at(-1).type, "message.complete");
});
test("manual sandbox uses authenticated runtime, preserves result and trajectory", async (t) => {
  const f = await fixture(t);
  if (!f.server.runtime.sandbox.status().available)
    return t.skip("OS sandbox unavailable");
  const s = await f.session();
  const result = await f.chat(s.id, "合成统计", {
    sandboxCode: "result=len(sources)",
    mode: "local",
  });
  assert.equal(result.events.at(-1).type, "message.complete");
  assert.match(f.server.store.get(s.id).messages.at(-1).content, /1/);
  assert.ok(
    f.server.store.eventLog(s.id).some((e) => e.type === "sandbox.completed"),
  );
});
