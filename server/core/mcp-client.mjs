import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import Ajv2019 from "ajv/dist/2019.js";
import addFormats from "ajv-formats";
import { rm } from "node:fs/promises";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { check, AppError } from "../errors.mjs";

const validatorsByDraft = {
  default: new Ajv({ strict: false, allErrors: false }),
  2020: new Ajv2020({ strict: false, allErrors: false }),
  2019: new Ajv2019({ strict: false, allErrors: false }),
};
for (const validator of Object.values(validatorsByDraft)) addFormats(validator);
export class MCPConnections {
  constructor(runner, oauth) {
    this.runner = runner;
    this.oauth = oauth;
    this.connections = new Map();
  }
  async connect(owner, config, pluginDirectory, sources) {
    const key = owner + ":" + config.id;
    await this.disconnect(owner, config.id);
    check(this.connections.size < 12, "MCP_LIMIT", "MCP 连接数量超过上限");
    const client = new Client(
      { name: "open-medical-workbench", version: "0.5.0" },
      { capabilities: sources ? { roots: {} } : {} },
    );
    if (sources)
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: [{ uri: "file:///sources", name: "用户授权的只读文件快照" }],
      }));
    let transport, container;
    if (config.transport === "stdio") {
      check(
        pluginDirectory && config.image,
        "MCP_CONFIG",
        "本地 MCP 必须来自已安装插件并指定隔离镜像",
      );
      const launch = this.runner.args({
        image: config.image,
        mounts: [
          { source: pluginDirectory, target: "/plugin", readonly: true },
          ...(sources
            ? [
                {
                  source: sources.directory,
                  target: "/sources",
                  readonly: true,
                },
              ]
            : []),
        ],
        command: config.command,
      });
      container = launch.name;
      // /work is supplied as tmpfs, with no host workspace or credentials mounted.
      transport = new StdioClientTransport({
        command: this.runner.docker,
        args: launch.args,
        env: this.runner.environment(),
        stderr: "pipe",
        maxBufferSize: 1024 * 1024,
      });
    } else {
      const url = new URL(config.url);
      check(
        ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.hash,
        "MCP_URL",
        "MCP 地址必须为 HTTP(S)，不能在 URL 中放入凭证",
      );
      check(
        url.protocol === "https:" ||
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
        "MCP_URL",
        "非本地 MCP 必须使用 HTTPS",
      );
      const headers = {};
      const authProvider = config.oauth
        ? this.oauth.provider(owner, config)
        : undefined;
      if (config.tokenEnv) {
        check(
          /^[A-Z][A-Z0-9_]{0,80}$/.test(config.tokenEnv) &&
            process.env[config.tokenEnv],
          "MCP_AUTH",
          "指定的令牌环境变量未配置",
        );
        headers.Authorization = "Bearer " + process.env[config.tokenEnv];
      }
      const guardedFetch = async (input, init = {}) => {
        if (config.oauth) return this.oauth.fetch(config)(input, init);
        check(
          new URL(input instanceof Request ? input.url : input).origin ===
            url.origin,
          "MCP_ORIGIN",
          "MCP 请求试图离开已授权来源",
          403,
        );
        const response = await fetch(input, {
          ...init,
          redirect: "error",
          signal: init.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)])
            : AbortSignal.timeout(30000),
        });
        if (!response.body) return response;
        let received = 0;
        const limited = response.body.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              received += chunk.byteLength;
              if (received > 2_000_000)
                throw new AppError(
                  "MCP_RESPONSE_LIMIT",
                  "MCP 响应流超过 2MB",
                  502,
                );
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(limited, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      };
      transport =
        config.transport === "sse"
          ? new SSEClientTransport(url, {
              authProvider,
              requestInit: { headers },
              fetch: guardedFetch,
              eventSourceInit: { fetch: guardedFetch },
            })
          : new StreamableHTTPClientTransport(url, {
              authProvider,
              requestInit: { headers },
              fetch: guardedFetch,
            });
    }
    const connection = {
      owner,
      id: config.id,
      client,
      transport,
      container,
      tools: [],
      validators: new Map(),
      config: structuredClone(config),
      sources,
    };
    this.connections.set(key, connection);
    let diagnostics = "";
    transport.stderr?.on("data", (data) => {
      diagnostics = (diagnostics + data.toString()).slice(-4000);
    });
    try {
      await client.connect(transport, { timeout: 15000 });
      transport.stderr?.resume();
      await this.refresh(connection);
      connection.ready = true;
      return this.describe(connection);
    } catch (e) {
      await this.disconnect(owner, config.id);
      if (diagnostics)
        throw new AppError("MCP_CONNECT", "MCP 启动失败：" + diagnostics, 502);
      throw e;
    }
  }
  describe(c) {
    return {
      id: c.id,
      connected: c.ready === true,
      tools: c.tools,
      capabilities: c.client.getServerCapabilities(),
      server: c.client.getServerVersion(),
      sources: c.sources
        ? { files: c.sources.manifest, createdAt: c.sources.createdAt }
        : undefined,
    };
  }
  async refresh(c) {
    const tools = [],
      seen = new Set();
    let cursor;
    do {
      const page = await c.client.listTools(cursor ? { cursor } : {}, {
        timeout: 15000,
      });
      tools.push(...page.tools);
      check(tools.length <= 200, "MCP_LIMIT", "服务器工具超过 200 项");
      cursor = page.nextCursor;
      check(
        !cursor || !seen.has(cursor),
        "MCP_PAGINATION",
        "服务器返回重复分页游标",
      );
      seen.add(cursor);
    } while (cursor);
    const validators = new Map();
    for (const tool of tools) {
      check(!validators.has(tool.name), "MCP_TOOLS", "服务器返回重复工具名");
      check(
        JSON.stringify(tool.inputSchema).length <= 32000,
        "MCP_SCHEMA",
        "工具参数结构过大",
      );
      const dialect = tool.inputSchema.$schema || "";
      const validator =
        validatorsByDraft[
          dialect.includes("2020-12")
            ? "2020"
            : dialect.includes("2019-09")
              ? "2019"
              : "default"
        ];
      validators.set(tool.name, validator.compile(tool.inputSchema));
    }
    c.tools = tools;
    c.validators = validators;
  }
  get(owner, id) {
    const c = this.connections.get(owner + ":" + id);
    check(c, "MCP_DISCONNECTED", "请先连接 MCP 服务器", 412);
    return c;
  }
  async call(owner, config, name, args, signal) {
    const c = this.get(owner, config.id);
    check(
      JSON.stringify(c.config) === JSON.stringify(config),
      "MCP_CHANGED",
      "MCP 配置已变化，请重新连接",
      409,
    );
    check(
      config.allowedTools?.includes(name),
      "MCP_TOOL_DENIED",
      "该 MCP 工具未获得用户授权",
      403,
    );
    const validate = c.validators.get(name);
    check(
      validate && validate(args),
      "MCP_ARGUMENTS",
      "MCP 参数不符合服务器声明的 JSON Schema",
      422,
    );
    const result = await c.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 30000, signal },
    );
    check(
      JSON.stringify(result).length <= 256000,
      "MCP_RESULT_LIMIT",
      "MCP 返回内容超过 256KB",
    );
    return result;
  }
  async resource(owner, config, action, args, signal) {
    check(
      config.allowResources === true,
      "MCP_RESOURCE_DENIED",
      "未授权 MCP 资源和提示词访问",
      403,
    );
    const c = this.get(owner, config.id);
    check(
      JSON.stringify(c.config) === JSON.stringify(config),
      "MCP_CHANGED",
      "请重新连接 MCP",
    );
    const operations = {
      resources: "listResources",
      templates: "listResourceTemplates",
      read: "readResource",
      prompts: "listPrompts",
      prompt: "getPrompt",
    };
    check(operations[action], "MCP_ACTION", "未知 MCP 操作");
    const result = await c.client[operations[action]](args, {
      timeout: 15000,
      signal,
    });
    check(
      JSON.stringify(result).length <= 256000,
      "MCP_RESULT_LIMIT",
      "MCP 资源超过 256KB",
    );
    return result;
  }
  async disconnect(owner, id) {
    const key = owner + ":" + id,
      c = this.connections.get(key);
    if (!c) return;
    this.connections.delete(key);
    await c.client.close().catch(() => {});
    if (c.sources)
      await rm(c.sources.directory, { recursive: true, force: true });
    if (c.container) {
      const { execFile } = await import("node:child_process");
      await new Promise((resolve) =>
        execFile(
          this.runner.docker,
          ["rm", "-f", c.container],
          { timeout: 4000 },
          () => resolve(),
        ),
      );
    }
  }
  async close(owner) {
    await Promise.allSettled(
      [...this.connections.values()]
        .filter((c) => !owner || c.owner === owner)
        .map((c) => this.disconnect(c.owner, c.id)),
    );
  }
}
