import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// A real local MCP transport with synthetic business data, not a mocked model.
export async function startAcceptanceMcp() {
  const sdk = new McpServer({ name: "acceptance-inventory", version: "1.0.0" });
  const batch = randomUUID(), rows = [{ sku: "ALPHA", quantity: 17 }, { sku: "BETA", quantity: 29 }];
  let calls = 0;
  sdk.registerTool("inventory", { inputSchema: { warehouse: z.literal("demo") } }, async () => {
    calls++;
    if (calls === 1) return { isError: true, content: [{ type: "text", text: "TEMPORARY_UNAVAILABLE: retry this read-only query once." }] };
    return { content: [{ type: "text", text: JSON.stringify({ batch, rows }) }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await sdk.connect(transport);
  const http = createServer(async (req, res) => {
    try {
      let body;
      if (req.method === "POST") {
        let raw = "";
        for await (const chunk of req) { raw += chunk; if (raw.length > 1000000) throw new Error("too large"); }
        body = JSON.parse(raw);
      }
      await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${http.address().port}/mcp`, batch, rows, calls: () => calls,
    close: async () => { await sdk.close(); http.closeAllConnections(); await new Promise((r) => http.close(r)); } };
}
