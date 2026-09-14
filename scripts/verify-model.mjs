import { existsSync } from "node:fs";
import { createProvider } from "../server/provider.mjs";
if (existsSync(".env")) process.loadEnvFile(".env");
const provider = createProvider();
const providerName = provider.provider || process.env.AI_PROVIDER || "deepseek";
if (!provider.local && !provider.apiKey) {
  console.error(
    `未运行：请配置 ${providerName} 模型凭据。没有进行真实模型验证。`,
  );
  process.exitCode = 2;
} else {
  try {
    const tool = {
      type: "function",
      function: {
        name: "verify_connection",
        description: "唯一的连接验证工具。请调用它。",
        parameters: {
          type: "object",
          properties: { marker: { type: "string" } },
          required: ["marker"],
          additionalProperties: false,
        },
      },
    };
    const messages = [
      {
        role: "system",
        content:
          "这是连接验证，无任何患者资料。必须先调用 verify_connection，marker 为 SYNTHETIC。工具返回后回复连接成功。",
      },
      { role: "user", content: "请执行合成连接验证。" },
    ];
    const result = await provider.complete(messages, [tool]);
    const call = result.message.tool_calls?.[0];
    if (
      !call ||
      call.function.name !== "verify_connection" ||
      JSON.parse(call.function.arguments).marker !== "SYNTHETIC"
    )
      throw new Error("模型响应但没有按协议调用工具，未通过验证");
    messages.push(result.message, {
      role: "tool",
      tool_call_id: call.id,
      content: '{"ok":true,"synthetic":true}',
    });
    const final = await provider.complete(messages, []);
    if (final.message.tool_calls?.length || !final.message.content)
      throw new Error("工具续轮未正常完成");
    console.log(
      JSON.stringify({
        result: "passed",
        model: provider.model,
        checks: ["SSE stream", "tool call", "tool continuation"],
        syntheticOnly: true,
        clinicalValidated: false,
      }),
    );
  } catch (error) {
    console.error("真实模型验证未通过：" + error.message);
    process.exitCode = 1;
  }
}
