import { check } from "../errors.mjs";
export function normalizePlugin(files) {
  if (files.has("plugin.json")) return { format: "native", warnings: [] };
  const manifestPath = [
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
  ].find((path) => files.has(path));
  check(
    manifestPath,
    "PLUGIN_MANIFEST",
    "需要 plugin.json、.codex-plugin/plugin.json 或 .claude-plugin/plugin.json",
  );
  let original;
  try {
    original = JSON.parse(files.get(manifestPath));
  } catch {
    check(false, "PLUGIN_MANIFEST", "第三方插件清单 JSON 无效");
  }
  const id = original.name || original.id;
  check(
    typeof id === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(id),
    "PLUGIN_MANIFEST",
    "第三方插件 name/id 必须是有效的插件标识",
  );
  const warnings = [],
    manifest = {
      manifestVersion: 1,
      id,
      name: original.displayName || id,
      version: original.version || "0.0.0",
      description: String(original.description || "").slice(0, 1000),
      skills: [],
      commands: [],
      mcpServers: [],
      hooks: [],
    };
  for (const path of files.keys()) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
    const command = /^commands\/([^/]+)\.md$/.exec(path);
    if (match) manifest.skills.push({ id: match[1], path });
    if (command) {
      manifest.skills.push({ id: "cmd-" + command[1], path });
      warnings.push(
        `命令 ${command[1]} 作为指令技能导入，不作为宿主 Shell 执行`,
      );
    }
  }
  let mcp = original.mcpServers;
  if (files.has(".mcp.json")) {
    const parsed = JSON.parse(files.get(".mcp.json"));
    mcp = parsed.mcpServers || parsed;
  }
  if (typeof mcp === "string") {
    check(
      files.has(mcp.replace(/^\.\//, "")),
      "PLUGIN_MCP",
      "MCP 配置文件不存在",
    );
    mcp = JSON.parse(files.get(mcp.replace(/^\.\//, "")));
    mcp = mcp.mcpServers || mcp;
  }
  for (const [serverId, server] of Object.entries(mcp || {})) {
    if (server.url) {
      warnings.push(`HTTP MCP ${serverId} 请在 MCP 配置导入向导中连接并授权`);
      continue;
    }
    check(
      typeof server.command === "string" && Array.isArray(server.args || []),
      "PLUGIN_MCP",
      "MCP 命令格式无效",
    );
    check(
      !server.env || Object.keys(server.env).length === 0,
      "PLUGIN_MCP",
      "含环境变量的第三方 MCP 需先移除凭据，再通过连接授权配置，不能明文打包",
    );
    manifest.mcpServers.push({
      id: serverId,
      transport: "stdio",
      command: [server.command, ...(server.args || [])],
    });
  }
  for (const field of ["hooks", "agents", "apps", "lspServers"])
    if (
      original[field] ||
      [...files.keys()].some((path) => path.startsWith(field + "/"))
    )
      warnings.push(`${field} 尚未映射为可执行入口；安装时不会启用`);
  check(
    manifest.skills.length || manifest.mcpServers.length,
    "PLUGIN_COMPATIBILITY",
    "该插件没有可导入的技能或 stdio MCP 入口",
  );
  files.set("plugin.json", Buffer.from(JSON.stringify(manifest, null, 2)));
  return {
    format: manifestPath.startsWith(".codex") ? "codex" : "claude",
    warnings,
  };
}

export function importMcpConfig(input) {
  check(
    input && typeof input === "object" && !Array.isArray(input),
    "MCP_CONFIG",
    "需要 MCP JSON 对象",
  );
  const entries = input.mcpServers || input.servers || input;
  check(Object.keys(entries).length <= 20, "MCP_CONFIG", "最多导入 20 个连接");
  return Object.entries(entries).map(([id, value]) => {
    check(
      /^[a-z][a-z0-9_-]{0,39}$/.test(id),
      "MCP_CONFIG",
      "连接名称需为小写字母、数字、连字符或下划线",
    );
    if (value.command)
      return {
        id,
        unsupported: "stdio 需先作为插件安装到隔离环境，不能直接启动宿主命令",
      };
    const url = new URL(value.url);
    check(
      !url.username && !url.password && !url.search && !url.hash,
      "MCP_CONFIG",
      "请移除 URL 中的凭据和查询参数",
    );
    check(
      url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
      "MCP_CONFIG",
      "MCP 地址需要 HTTPS",
    );
    check(
      !value.headers || Object.keys(value.headers).length === 0,
      "MCP_CONFIG",
      "请先移除明文 headers 凭据，导入后使用 OAuth 授权",
    );
    return {
      id,
      transport:
        value.type === "sse" || value.transport === "sse" ? "sse" : "http",
      url: url.href,
      allowedTools: [],
      allowResources: false,
    };
  });
}
