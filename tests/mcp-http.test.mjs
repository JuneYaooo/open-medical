import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { MCPConnections } from "../server/core/mcp-client.mjs";
import { ProcessRunner } from "../server/core/process-runner.mjs";

for (const type of ["http", "sse"])
  test(`real ${type} MCP discovers and invokes tools with schema and origin enforcement`, async (t) => {
    const sdk = new McpServer({ name: "http-fixture", version: "1.0.0" });
    sdk.registerTool(
      "echo",
      { inputSchema: { value: z.union([z.string(), z.number()]) } },
      async ({ value }) => ({
        content: [{ type: "text", text: String(value) }],
      }),
    );
    let transport;
    const http = createServer(async (req, res) => {
      try {
        if (type === "sse" && req.method === "GET") {
          transport = new SSEServerTransport("/messages", res);
          await sdk.connect(transport);
          return;
        }
        if (type === "sse") {
          await transport.handlePostMessage(req, res);
          return;
        }
        let body;
        if (req.method === "POST") {
          let text = "";
          for await (const chunk of req) text += chunk;
          body = JSON.parse(text);
        }
        await transport.handleRequest(req, res, body);
      } catch (e) {
        res.writeHead(500);
        res.end(e.message);
      }
    });
    if (type === "http") {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => "test-session",
      });
      await sdk.connect(transport);
    }
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    const client = new MCPConnections(new ProcessRunner());
    t.after(async () => {
      await client.close();
      await sdk.close();
      http.closeAllConnections();
      await new Promise((r) => http.close(r));
    });
    const config = {
      id: "fixture",
      transport: type,
      url: `http://127.0.0.1:${http.address().port}/mcp`,
      allowedTools: ["echo"],
    };
    const connected = await client.connect("owner", config);
    assert.equal(connected.tools[0].name, "echo");
    assert.equal(
      (await client.call("owner", config, "echo", { value: "hello" }))
        .content[0].text,
      "hello",
    );
    assert.equal(
      (await client.call("owner", config, "echo", { value: 42 })).content[0]
        .text,
      "42",
    );
    await assert.rejects(
      client.call("owner", config, "echo", { value: { bad: 1 } }),
      (e) => e.code === "MCP_ARGUMENTS",
    );
    await assert.rejects(
      client.call("other", config, "echo", { value: 1 }),
      (e) => e.code === "MCP_DISCONNECTED",
    );
    await assert.rejects(
      client.call("owner", { ...config, allowedTools: [] }, "echo", {
        value: 1,
      }),
      (e) => e.code === "MCP_CHANGED",
    );
  });

test("MCP HTTP redirects cannot forward authorization to another origin", async (t) => {
  let received = 0;
  const destination = createServer((_req, res) => {
    received++;
    res.end("forbidden");
  });
  await new Promise((r) => destination.listen(0, "127.0.0.1", r));
  const source = createServer((_req, res) => {
    res.writeHead(307, {
      Location: `http://127.0.0.1:${destination.address().port}/`,
    });
    res.end();
  });
  await new Promise((r) => source.listen(0, "127.0.0.1", r));
  const client = new MCPConnections(new ProcessRunner());
  t.after(async () => {
    await client.close();
    for (const server of [source, destination]) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
  await assert.rejects(
    client.connect("owner", {
      id: "redirect",
      transport: "http",
      url: `http://127.0.0.1:${source.address().port}/mcp`,
      allowedTools: [],
    }),
  );
  assert.equal(received, 0);
});
