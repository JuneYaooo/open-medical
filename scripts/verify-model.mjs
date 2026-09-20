import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createProvider, OpenAIProvider } from "../server/provider.mjs";

// 模型配置自检与真实工具调用验证(W3 / P0-3)。
//   node scripts/verify-model.mjs             真实模型分阶段验证;无配置时 exit 2(blocked)
//   node scripts/verify-model.mjs --synthetic 本地合成端点自检 provider 协议栈(SSE、
//                                             工具调用、429 重试、长输出),无需任何凭据,
//                                             不代表真实模型可用性。
// 阶段检查结果逐项输出;不得只以“回复 OK”判定兼容。

const SYNTHETIC = process.argv.includes("--synthetic");

// 与 desktop/main.cjs 的发现顺序保持一致：Electron userData 优先（含遗留目录名），再回退仓库 .env
export function modelConfigCandidates(env = process.env) {
  const dir =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? env.APPDATA || join(homedir(), "AppData", "Roaming")
        : join(homedir(), ".config");
  const candidates = ["Open Medical Workbench", "Open Agent", "Open Medical"].map(
    (name) => ({
      source: `desktop:${process.platform}`,
      file: join(dir, name, "model.env"),
    }),
  );
  candidates.push({ source: "repo", file: ".env" });
  return candidates;
}

function discoverModelConfig(env = process.env) {
  const searched = [];
  if (
    env.AI_PROVIDER ||
    env.MODEL_PROVIDER ||
    env.OPENAI_API_KEY ||
    env.AI_API_KEY ||
    env.ANTHROPIC_API_KEY ||
    env.LOCAL_MODEL_BASE_URL
  )
    return { source: "environment", searched };
  for (const candidate of modelConfigCandidates(env)) {
    searched.push(candidate);
    if (existsSync(candidate.file)) {
      try {
        process.loadEnvFile(candidate.file);
      } catch (error) {
        return { source: candidate.source, error: error.message, searched };
      }
      return { source: candidate.source, file: candidate.file, searched };
    }
  }
  return { source: null, searched };
}

const statusTool = {
  type: "function",
  function: {
    name: "report_status",
    description: "按 schema 回报验证状态。只允许调用此工具。",
    parameters: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["ok", "degraded"] },
        attempts: { type: "number" },
        note: { type: "string" },
      },
      required: ["level", "attempts"],
      additionalProperties: false,
    },
  },
};

async function checkStreamAndToolSchema(provider, checks) {
  let deltas = 0;
  const messages = [
    {
      role: "system",
      content:
        "这是连接验证，无任何患者资料。必须调用 report_status：level 取 ok，attempts 填数字 1。",
    },
    { role: "user", content: "请执行合成连接验证。" },
  ];
  const result = await provider.complete(messages, [statusTool], {
    onDelta: () => deltas++,
  });
  const call = result.message.tool_calls?.[0];
  const args = call && JSON.parse(call.function.arguments);
  checks.push({
    name: "sse-stream-deltas",
    status: deltas >= 2 ? "passed" : "skipped",
    detail: `onDelta ${deltas} 次${deltas >= 2 ? "" : "（服务端单块聚合返回）"}`,
  });
  checks.push({
    name: "tool-schema",
    status:
      call?.function?.name === "report_status" &&
      ["ok", "degraded"].includes(args?.level) &&
      typeof args?.attempts === "number"
        ? "passed"
        : "failed",
    detail: call
      ? `name=${call.function.name} args.level=${args?.level} args.attempts=${args?.attempts}`
      : "模型未调用工具",
  });
  if (checks.at(-1).status === "failed")
    throw new Error("模型响应但没有按 schema 调用工具，未通过验证");
  messages.push(result.message, {
    role: "tool",
    tool_call_id: call.id,
    content: '{"ok":true,"synthetic":true}',
  });
  const final = await provider.complete(messages, []);
  checks.push({
    name: "tool-continuation",
    status:
      !final.message.tool_calls?.length && final.message.content
        ? "passed"
        : "failed",
    detail: final.message.tool_calls?.length
      ? "续轮仍在请求工具"
      : "工具结果后续轮正常收尾",
  });
}

async function checkLongOutput(provider, checks) {
  const result = await provider.complete(
    [
      {
        role: "user",
        content:
          "输出一个 JSON 对象：字段 paragraphs 为数组，含 20 个元素，每个元素是 120 字以上的连续中文说明文字（不要换行转义异常）。只输出该 JSON。",
      },
    ],
    [],
  );
  const length = result.message.content?.length ?? 0;
  checks.push({
    name: "long-output",
    status:
      length >= 2000 && !result.stopReason
        ? "passed"
        : result.stopReason
          ? "skipped"
          : "failed",
    detail: `内容 ${length} 字符${result.stopReason ? `，stopReason=${result.stopReason}（截断软着陆生效）` : ""}`,
  });
}

async function checkThinking(provider, checks) {
  if (!provider.includeThinking && !provider.reasoningEffort) {
    checks.push({
      name: "thinking-params",
      status: "skipped",
      detail: "当前 provider 未启用思考参数，不适用",
    });
    return;
  }
  const result = await provider.complete(
    [{ role: "user", content: "用一句话说明 7×8 等于多少。" }],
    [],
    { thinking: "enabled" },
  );
  checks.push({
    name: "thinking-params",
    status: result.message.content ? "passed" : "failed",
    detail: result.message.reasoning_content
      ? "思考内容已随响应返回"
      : "正常回复（该模型未返回 reasoning_content，协议未报错）",
  });
}

function sse(res, frames) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) res.write(frame);
  res.end();
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = "data: [DONE]\n\n";
const choice = (delta, finish) => ({
  choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
});

const LONG_PART = "长".repeat(600); // 5 块 × 600 = 3000 字符，验证长输出路径

export async function syntheticMode() {
  const checks = [];
  let stage = 0;
  let http429s = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const payload = JSON.parse(body);
      if (stage === 0) {
        // 前两次请求 429，验证指数退避重试；第三次起进入 SSE 阶段
        if (http429s < 2) {
          http429s++;
          res.writeHead(429, { "retry-after": "0" });
          res.end("rate limited");
          return;
        }
        if (payload.stream && payload.tools?.length) {
          stage = 1;
          sse(res, [
            frame(
              choice({
                tool_calls: [
                  {
                    index: 0,
                    id: "call_s1",
                    function: { name: "report_status", arguments: '{"level":"ok",' },
                  },
                ],
              }),
            ),
            frame(
              choice({
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"attempts":2,"note":"synthetic"}' },
                  },
                ],
              }),
            ),
            frame(choice({}, "tool_calls")),
            frame({ usage: { prompt_tokens: 10, completion_tokens: 20 } }),
            DONE,
          ]);
          return;
        }
      }
      if (stage === 1 && !payload.tools?.length) {
        stage = 2;
        sse(res, [
          ...[...Array(5)].map((_, i) =>
            frame(choice({ content: `${LONG_PART}${i}` })),
          ),
          frame(choice({}, "stop")),
          frame({ usage: { prompt_tokens: 30, completion_tokens: 3000 } }),
          DONE,
        ]);
        return;
      }
      res.writeHead(500);
      res.end("unexpected stage");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const retries = [];
  const provider = new OpenAIProvider({
    apiKey: "synthetic",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "synthetic-model",
    timeoutMs: 5000,
    maxTokens: 8192,
  });
  try {
    let deltas = 0;
    const first = await provider.complete(
      [{ role: "user", content: "开始合成自检" }],
      [statusTool],
      {
        onDelta: () => deltas++,
        onStatus: (s) => s.status === "retrying" && retries.push(s),
      },
    );
    const call = first.message.tool_calls?.[0];
    const args = call && JSON.parse(call.function.arguments);
    checks.push({
      name: "retry-429-backoff",
      status: retries.length >= 2 ? "passed" : "failed",
      detail: `onStatus retrying ×${retries.length}（期望 2 次 429 退避）`,
    });
    checks.push({
      name: "sse-tool-call",
      status:
        call?.function?.name === "report_status" && args?.level === "ok"
          ? "passed"
          : "failed",
      detail: "分块工具参数重组并按 schema 解析",
    });
    const final = await provider.complete(
      [
        { role: "user", content: "继续" },
        first.message,
        { role: "tool", tool_call_id: call.id, content: '{"ok":true}' },
      ],
      [],
      { onDelta: () => deltas++ },
    );
    const length = final.message.content?.length ?? 0;
    checks.push({
      name: "sse-stream-deltas",
      status: deltas >= 2 ? "passed" : "failed",
      detail: `onDelta ${deltas} 次`,
    });
    checks.push({
      name: "long-output",
      status: length >= 2000 && !final.stopReason ? "passed" : "failed",
      detail: `长输出 ${length} 字符，stopReason=${final.stopReason || "none"}`,
    });
    checks.push({
      name: "usage-accounting",
      status: final.usage?.completion_tokens ? "passed" : "failed",
      detail: `completion_tokens=${final.usage?.completion_tokens}`,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const failed = checks.filter((c) => c.status === "failed");
  return {
    result: failed.length ? "failed" : "passed",
    checks,
    syntheticOnly: true,
    realModel: false,
  };
}

async function realMode() {
  const discovery = discoverModelConfig();
  const provider = createProvider();
  if (discovery.error || (!provider.local && !provider.apiKey)) {
    console.error(
      JSON.stringify(
        {
          result: "blocked",
          reason: discovery.error || "未找到模型凭据配置",
          configDiscovery: {
            source: discovery.source,
            searched: discovery.searched.map((c) => c.file),
          },
          note: "没有进行真实模型验证；不得以合成结果冒充。可将 model.env 放到上述任一位置后重跑。",
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
    return;
  }
  const checks = [];
  try {
    await checkStreamAndToolSchema(provider, checks);
    await checkLongOutput(provider, checks);
    await checkThinking(provider, checks);
    checks.push({
      name: "retry-429-backoff",
      status: "skipped",
      detail: "真实端点无法稳定注入 429；重试路径由 --synthetic 模式覆盖",
    });
    const failed = checks.filter((c) => c.status === "failed");
    console.log(
      JSON.stringify(
        {
          result: failed.length ? "failed" : "passed",
          model: provider.model,
          configDiscovery: {
            source: discovery.source,
            file: discovery.file,
          },
          checks,
          syntheticOnly: false,
          clinicalValidated: false,
        },
        null,
        2,
      ),
    );
    if (failed.length) process.exitCode = 1;
  } catch (error) {
    console.error("真实模型验证未通过：" + error.message);
    process.exitCode = 1;
  }
}

async function main() {
  if (SYNTHETIC) {
    const report = await syntheticMode();
    console.log(JSON.stringify(report, null, 2));
    if (report.result === "failed") process.exitCode = 1;
  } else {
    await realMode(); // 自行输出 JSON 并设置退出码（blocked=2 / failed=1）
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
