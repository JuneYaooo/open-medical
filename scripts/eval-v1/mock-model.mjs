// 脚本化 mock 模型(OpenAI Chat Completions SSE 兼容):
// 仅用于"模拟协议冒烟",证明评估控制器/夹具/标记/哈希/验收器全链路可用。
// 绝不冒充真实模型:所有产物都会打上 model_mode=mock 标记。
// 脚本按模型调用序号返回 tool_calls 或最终回答;可从消息中提取运行标记/动态 URL。
import { createServer } from "node:http";

function sse(res, frames) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\r\n\r\n`);
  res.write("data: [DONE]\r\n\r\n");
  res.end();
}

function toolCallFrames(calls) {
  const frames = calls.map((call, index) => ({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index,
              id: call.id || `call-${index + 1}`,
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        },
      },
    ],
  }));
  frames.push({
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  });
  return frames;
}

function contentFrames(text) {
  return [
    { choices: [{ delta: { content: text } }] },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 60 },
    },
  ];
}

/**
 * scripts: Map<caseId, (ctx) => step>,ctx = { call, messages, userText }
 * 每次调用返回 { toolCalls } 或 { content }。call 从 1 递增。
 * 运行器在每轮任务前调用 setCase() 指定当前脚本(确定性,不靠猜)。
 */
export async function startMockModel(scripts, { defaultCase = "C02" } = {}) {
  const counters = new Map();
  const history = [];
  let activeCase = defaultCase;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const body = JSON.parse(raw);
        history.push(body);
        const userText = [...(body.messages || [])]
          .filter((m) => m.role === "user")
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n");
        const caseId = activeCase;
        const call = (counters.get(caseId) || 0) + 1;
        counters.set(caseId, call);
        const step = scripts.get(caseId)?.({ call, messages: body.messages || [], userText });
        if (!step) {
          sse(res, contentFrames("mock: 脚本已结束"));
          return;
        }
        if (step.toolCalls) sse(res, toolCallFrames(step.toolCalls));
        else sse(res, contentFrames(step.content || ""));
      } catch (error) {
        res.writeHead(500);
        res.end(String(error.message));
      }
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    /** 运行器切换当前任务脚本(每次试验激活时重置调用计数)。 */
    activate: (id) => {
      activeCase = id;
      counters.set(id, 0);
    },
    requestCount: () => history.length,
    history: () => history,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(ok);
      }),
  };
}

/** 从消息中提取工具结果里的文件哈希(propose 修改已有文件需要 expectedHash)。 */
export function lastToolHash(messages) {
  const toolMsgs = (messages || []).filter((m) => m.role === "tool");
  for (let i = toolMsgs.length - 1; i >= 0; i--) {
    const m = /"hash"\s*:\s*"([a-f0-9]{16,64})"/.exec(
      typeof toolMsgs[i].content === "string"
        ? toolMsgs[i].content
        : JSON.stringify(toolMsgs[i].content),
    );
    if (m) return m[1];
  }
  return null;
}

/** 从用户消息中提取运行标记(EVAL-xxxx)。 */
export function markerFrom(userText) {
  return /EVAL-[0-9A-Z-]+/.exec(userText)?.[0] || null;
}
