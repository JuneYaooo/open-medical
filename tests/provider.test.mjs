import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DeepSeekProvider } from "../server/provider.mjs";
import { fixture } from "./helpers.mjs";
const frame = (delta, finish = null) =>
  "data: " +
  JSON.stringify({ choices: [{ delta, finish_reason: finish }] }) +
  "\r\n\r\n";
async function mockProvider(t, handler) {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    await handler(JSON.parse(raw), res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return new DeepSeekProvider({
    apiKey: "test-only",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    timeoutMs: 1500,
  });
}

test("DeepSeek byte-fragmented UTF8, CRLF and keepalives produce proper text", async (t) => {
  const provider = await mockProvider(t, (_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const bytes = Buffer.from(
      ": keepalive\r\n\r\n" +
        frame({ content: "你好医学" }, "stop") +
        "data: [DONE]\r\n\r\n",
    );
    for (const byte of bytes) res.write(Buffer.from([byte]));
    res.end();
  });
  let delta = "";
  const result = await provider.complete(
    [{ role: "user", content: "hi" }],
    [],
    { onDelta: (t) => (delta += t) },
  );
  assert.equal(delta, "你好医学");
  assert.equal(result.message.content, delta);
});
test("incomplete and malformed streams are failures, never successful empty replies", async (t) => {
  for (const [name, response] of [
    ["truncated", frame({ content: "partial" })],
    ["malformed", "data: broken\n\n"],
    ["length", frame({ content: "partial" }, "length") + "data: [DONE]\n\n"],
  ]) {
    await t.test(name, async (t) => {
      const p = await mockProvider(t, (_, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(response);
      });
      await assert.rejects(() => p.complete([], []));
    });
  }
});
test("reasoning and fragmented tool calls survive tool rounds and later conversation turns", async (t) => {
  const received = [];
  let counter = 0;
  const provider = await mockProvider(t, (body, res) => {
    received.push(body);
    counter++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (counter === 1)
      res.end(
        frame({
          reasoning_content: "provider private context",
          tool_calls: [
            {
              index: 0,
              id: "tool-1",
              function: {
                name: "build_workflow",
                arguments: '{"title":"流程",',
              },
            },
          ],
        }) +
          frame(
            {
              tool_calls: [
                { index: 0, function: { arguments: '"steps":["核对原文"]}' } },
              ],
            },
            "tool_calls",
          ) +
          "data: [DONE]\n\n",
      );
    else res.end(frame({ content: "处理完成" }, "stop") + "data: [DONE]\n\n");
  });
  const f = await fixture(t, { provider });
  const s = await f.session();
  const first = await f.chat(s.id, "请整理工作流程", {
    mode: "model",
    externalConsent: true,
  });
  assert.equal(first.events.at(-1).type, "message.complete");
  assert.equal(
    received[1].messages.at(-2).reasoning_content,
    "provider private context",
  );
  assert.equal(received[1].messages.at(-1).role, "tool");
  await f.chat(s.id, "继续整理", { mode: "model", externalConsent: true });
  assert.ok(
    received[2].messages.some(
      (m) => m.reasoning_content === "provider private context",
    ),
  );
  const ui = await f.json(`/api/sessions/${s.id}`);
  assert.ok(!JSON.stringify(ui.data).includes("provider private context"));
});
test("model consent is enforced before any request and consented requests send original text", async (t) => {
  let bodySeen;
  const provider = await mockProvider(t, (body, res) => {
    bodySeen = body;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(frame({ content: "已整理" }, "stop") + "data: [DONE]\n\n");
  });
  const f = await fixture(t, { provider });
  const s = await f.session();
  assert.equal((await f.chat(s.id, "hi", { mode: "model" })).status, 412);
  assert.equal(bodySeen, undefined);
  const file = (
    await f.json(`/api/sessions/${s.id}/files`, "POST", {
      name: "r.txt",
      text: "姓名：测试甲\n联系电话 13812345678",
    })
  ).data;
  assert.equal(file.text, "姓名：测试甲\n联系电话 13812345678");
  await f.chat(s.id, "手机号 13912345678", {
    mode: "model",
    externalConsent: true,
    fileIds: [file.id],
  });
  const body = JSON.stringify(bodySeen);
  assert.ok(body.includes("13812345678"));
  assert.ok(body.includes("13912345678"));
  assert.ok(body.includes("测试甲"));
});
test("cancellation saves partial content, blocks duplicate runs and releases lock", async (t) => {
  let begin;
  const started = new Promise((resolve) => (begin = resolve));
  const provider = {
    apiKey: "x",
    model: "mock",
    complete: async (messages, tools, { signal, onDelta }) => {
      onDelta("已处理部分");
      begin();
      await new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  };
  const f = await fixture(t, { provider });
  const s = await f.session();
  const run = f.chat(s.id, "test", { mode: "model", externalConsent: true });
  await started;
  assert.equal((await f.chat(s.id, "test 2")).status, 409);
  assert.equal((await f.json(`/api/sessions/${s.id}`, "DELETE")).status, 409);
  await f.json(`/api/chat/${s.id}/cancel`, "POST", {});
  const result = await run;
  assert.equal(result.events.at(-1).type, "run.cancelled");
  assert.ok(!result.events.some((e) => e.type === "message.complete"));
  const stored = (await f.json(`/api/sessions/${s.id}`)).data;
  assert.equal(stored.runs[0].status, "cancelled");
  assert.equal(stored.runs[0].partial, "已处理部分");
  assert.equal(f.server.runtime.active.size, 0);
});

test("model deltas stream to client events exactly as provided", async (t) => {
  const provider = {
    apiKey: "x",
    model: "mock",
    complete: async (messages, tools, { onDelta }) => {
      onDelta("电话 13812");
      onDelta("345678。");
      return { message: { role: "assistant", content: "电话 13812345678。" } };
    },
  };
  const f = await fixture(t, { provider });
  const s = await f.session();
  const result = await f.chat(s.id, "整理测试文本", {
    mode: "model",
    externalConsent: true,
  });
  assert.ok(result.text.includes("13812345678。"));
});
test("finite tool budgets stop repeated calls without fake completion and preserve failure", async (t) => {
  let round = 0;
  const provider = {
    apiKey: "x",
    model: "mock",
    complete: async () => ({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c" + ++round,
            function: {
              name: "build_workflow",
              arguments: JSON.stringify({ title: "流程", steps: ["核对"] }),
            },
          },
        ],
      },
    }),
  };
  const f = await fixture(t, { provider, runtimeOptions: { maxRounds: 2 } });
  const s = await f.session();
  const result = await f.chat(s.id, "整理工作流程", {
    mode: "model",
    externalConsent: true,
  });
  assert.equal(round, 2);
  assert.equal(result.events.at(-1).type, "error");
  assert.equal(result.events.at(-1).payload.code, "TOOL_BUDGET");
  assert.equal(f.server.runtime.active.size, 0);
});
test("context budget does not silently truncate patient history", async (t) => {
  let called = false;
  const provider = {
    apiKey: "x",
    model: "mock",
    complete: async () => {
      called = true;
    },
  };
  const f = await fixture(t, {
    provider,
    runtimeOptions: { maxContextChars: 100 },
  });
  const s = await f.session();
  const result = await f.chat(s.id, "整理病历", {
    mode: "model",
    externalConsent: true,
  });
  assert.equal(called, false);
  assert.equal(result.events.at(-1).payload.code, "CONTEXT_LIMIT");
});

test("transient rate limits retry before streaming, with bounded attempts and usage", async (t) => {
  let attempts = 0;
  const p = await mockProvider(t, (body, res) => {
    assert.equal(body.thinking.type, "disabled");
    if (++attempts < 3) {
      res.writeHead(429, { "retry-after": "0" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame({ content: "成功。" }, "stop") +
        "data: " +
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  const statuses = [];
  const result = await p.complete([], [], {
    onStatus: (s) => statuses.push(s),
  });
  assert.equal(attempts, 3);
  assert.equal(statuses.length, 2);
  assert.equal(result.usage.total_tokens, 13);
});
test("provider timeout aborts hanging response; invalid tool completion is rejected", async (t) => {
  const p = await mockProvider(t, (_, res) =>
    res.writeHead(200, { "content-type": "text/event-stream" }),
  );
  p.timeoutMs = 60;
  await assert.rejects(
    () => p.complete([], []),
    (e) => e.name === "TimeoutError",
  );
  const invalid = await mockProvider(t, (_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame(
        {
          tool_calls: [
            {
              index: 0,
              id: "a",
              function: { name: "build_workflow", arguments: "{}" },
            },
          ],
        },
        "stop",
      ) + "data: [DONE]\n\n",
    );
  });
  await assert.rejects(() => invalid.complete([], []), /结束状态/);
});
test("browser disconnect aborts provider work and durable run is cancelled", async (t) => {
  let began, finished;
  const started = new Promise((r) => (began = r)),
    stopped = new Promise((r) => (finished = r));
  const provider = {
    apiKey: "mock",
    model: "mock",
    complete: async (_m, _t, { signal, onDelta }) => {
      onDelta("可追溯的部分结果。");
      began();
      await new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            finished();
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    },
  };
  const f = await fixture(t, { provider });
  const s = await f.session();
  const abort = new AbortController();
  const responsePromise = fetch(f.origin + `/api/chat/${s.id}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-medical-token": f.server.token,
    },
    body: JSON.stringify({
      message: "合成资料整理",
      mode: "model",
      externalConsent: true,
    }),
    signal: abort.signal,
  });
  await started;
  const response = await responsePromise;
  const reader = response.body.getReader();
  await reader.read();
  abort.abort();
  await stopped;
  for (let i = 0; i < 50 && f.server.runtime.active.size; i++)
    await new Promise((r) => setTimeout(r, 5));
  const state = (await f.json(`/api/sessions/${s.id}`)).data;
  assert.equal(state.runs[0].status, "cancelled");
  assert.equal(state.messages.filter((m) => m.role === "assistant").length, 0);
  assert.match(state.runs[0].partial, /部分结果/);
});
test("usage accumulates across tool rounds and unselected sources stay outside provider request", async (t) => {
  const seen = [];
  let n = 0;
  const provider = {
    apiKey: "mock",
    model: "mock",
    complete: async (messages, _tools, { onDelta }) => {
      seen.push(JSON.stringify(messages));
      n++;
      if (n === 1)
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c",
                function: {
                  name: "extract_clinical_timeline",
                  arguments: "{}",
                },
              },
            ],
          },
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        };
      onDelta("已整理。");
      return {
        message: { role: "assistant", content: "已整理。" },
        usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
      };
    },
  };
  const f = await fixture(t, { provider });
  const s = await f.session();
  const selected = (
    await f.json(`/api/sessions/${s.id}/files`, "POST", {
      name: "selected.txt",
      text: "2026-01-01 选中资料",
    })
  ).data;
  await f.json(`/api/sessions/${s.id}/files`, "POST", {
    name: "excluded.txt",
    text: "不得发送的独立标记 EXCLUDED-CASE-B",
  });
  const result = await f.chat(s.id, "整理时间线", {
    mode: "model",
    externalConsent: true,
    fileIds: [selected.id],
  });
  assert.equal(result.events.at(-1).payload.usage.total_tokens, 35);
  assert.equal(result.events.at(-1).payload.usage.rounds, 2);
  assert.ok(seen.every((s) => !s.includes("EXCLUDED-CASE-B")));
});

test("OpenAI-compatible factory omits DeepSeek-only thinking fields and preserves tools", async (t) => {
  const { createProvider } = await import("../server/provider.mjs");
  let body;
  const provider = await mockProvider(t, (payload, res) => {
    body = payload;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(frame({ content: "OpenAI。" }, "stop") + "data: [DONE]\n\n");
  });
  const open = createProvider({
    provider: "openai",
    apiKey: "x",
    baseUrl: provider.baseUrl,
    model: "gpt-test",
    fetchImpl: provider.fetch,
  });
  await open.complete(
    [{ role: "user", content: "hi" }],
    [
      {
        type: "function",
        function: {
          name: "x",
          description: "x",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
    ],
  );
  assert.equal(body.model, "gpt-test");
  assert.equal(body.thinking, undefined);
  assert.ok(body.tools.length);
});
test("Anthropic native Messages SSE supports text and fragmented tool_use", async (t) => {
  let round = 0;
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      round++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (round === 1)
        res.end(
          "event: message_start\ndata: " +
            JSON.stringify({
              type: "message_start",
              message: { usage: { input_tokens: 4 } },
            }) +
            "\n\n" +
            "event: content_block_start\ndata: " +
            JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "u1",
                name: "build_workflow",
              },
            }) +
            "\n\n" +
            "event: content_block_delta\ndata: " +
            JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: '{"title":"流程",',
              },
            }) +
            "\n\n" +
            "event: content_block_delta\ndata: " +
            JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: '"steps":["核对"]}',
              },
            }) +
            "\n\n" +
            "event: message_delta\ndata: " +
            JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 3 },
            }) +
            "\n\n" +
            "event: message_stop\ndata: " +
            JSON.stringify({ type: "message_stop" }) +
            "\n\n",
        );
      else
        res.end(
          "event: message_start\ndata: " +
            JSON.stringify({
              type: "message_start",
              message: { usage: { input_tokens: 8 } },
            }) +
            "\n\n" +
            "event: content_block_start\ndata: " +
            JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text" },
            }) +
            "\n\n" +
            "event: content_block_delta\ndata: " +
            JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "完成。" },
            }) +
            "\n\n" +
            "event: message_delta\ndata: " +
            JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 2 },
            }) +
            "\n\n" +
            "event: message_stop\ndata: " +
            JSON.stringify({ type: "message_stop" }) +
            "\n\n",
        );
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const { AnthropicProvider } = await import("../server/provider.mjs");
  const p = new AnthropicProvider({
    apiKey: "x",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    model: "claude-test",
  });
  const first = await p.complete(
    [
      { role: "system", content: "rules" },
      { role: "user", content: "hi" },
    ],
    [
      {
        type: "function",
        function: {
          name: "build_workflow",
          description: "",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
    ],
  );
  assert.equal(first.message.tool_calls[0].function.name, "build_workflow");
  assert.equal(first.usage.output_tokens, 3);
  const second = await p.complete(
    [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: first.message.tool_calls[0]
          ? [first.message.tool_calls[0]]
          : [],
      },
      { role: "tool", tool_call_id: "u1", content: "ok" },
    ],
    [],
  );
  assert.equal(second.message.content, "完成。");
  assert.equal(round, 2);
});
