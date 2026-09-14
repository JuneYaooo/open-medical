// Explicit synthetic provider for browser verification. Never used by npm start.
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/agent.mjs";
import { DeepSeekProvider } from "../server/provider.mjs";
const persistent = process.env.MEDICAL_VERIFICATION_DIRECTORY;
const directory =
  persistent || mkdtempSync(join(tmpdir(), "medical-browser-check-"));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const port = Number(process.env.MEDICAL_VERIFICATION_PORT || 8792);
const mock = http.createServer(async (req, res) => {
  let raw = "";
  for await (const part of req) raw += part;
  const data = JSON.parse(raw);
  const prompt =
    data.messages.findLast((m) => m.role === "user")?.content || "";
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const frame = (delta, finish = null) =>
    res.write(
      "data: " +
        JSON.stringify({ choices: [{ delta, finish_reason: finish }] }) +
        "\n\n",
    );
  if (prompt.includes("失败测试")) {
    frame({ content: "这是失败前的合成片段。" });
    res.end();
    return;
  }
  if (prompt.includes("慢速测试")) {
    let count = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      frame({ content: `合成处理步骤 ${++count}。` });
      if (count === 24) {
        clearInterval(timer);
        frame({}, "stop");
        res.end("data: [DONE]\n\n");
      }
    }, 450);
    res.on("close", () => clearInterval(timer));
    return;
  }
  if (data.messages.at(-1)?.role === "user" && prompt.includes("时间线")) {
    frame(
      {
        tool_calls: [
          {
            index: 0,
            id: "fixture-timeline",
            type: "function",
            function: { name: "extract_clinical_timeline", arguments: "{}" },
          },
        ],
      },
      "tool_calls",
    );
    res.end("data: [DONE]\n\n");
    return;
  }
  frame({ content: "合成模型已完成协议验证。此响应不包含临床建议。" }, "stop");
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const provider = new DeepSeekProvider({
  apiKey: "synthetic-only",
  baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
  model: "verification-only",
});
const app = createServer({
  database: join(directory, "test.sqlite"),
  provider,
});
app.listen(port, "127.0.0.1", () =>
  console.log(`Synthetic verification only: http://127.0.0.1:${port}`),
);
async function close() {
  await app.shutdown();
  mock.closeAllConnections();
  await new Promise((r) => mock.close(r));
  if (!persistent) rmSync(directory, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
