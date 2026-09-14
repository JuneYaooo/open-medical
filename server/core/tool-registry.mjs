import { check } from "../errors.mjs";
import { PERMISSION_KEYS, permissionForTool } from "./permissions.mjs";

import { validateArguments, validateSchema } from "./schema.mjs";

export class ToolRegistry {
  constructor(tools = []) {
    this.tools = new Map();
    for (const tool of tools) this.register(tool);
  }
  register({ definition, execute, permission } = {}) {
    const name = definition?.function?.name;
    check(
      typeof name === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(name),
      "TOOL_CONFIG",
      "工具名称无效",
    );
    check(
      typeof execute === "function",
      "TOOL_CONFIG",
      `工具 ${name} 缺少执行器`,
    );
    check(!this.tools.has(name), "TOOL_CONFIG", `工具名称重复：${name}`);
    if (definition.function.parameters)
      validateSchema(definition.function.parameters);
    check(
      PERMISSION_KEYS.includes(permission || permissionForTool(definition)),
      "PERMISSION_KEY",
      "工具权限无效",
    );
    this.tools.set(name, {
      definition: structuredClone(definition),
      execute,
      permission: permission || permissionForTool(definition),
    });
    return this;
  }
  has(name) {
    return this.tools.has(name);
  }
  get(name) {
    return this.tools.get(name);
  }
  definitions(permissionEngine) {
    return [...this.tools.values()]
      .filter(
        (tool) =>
          !permissionEngine ||
          (permissionEngine.can("tools.execute") &&
            permissionEngine.can(tool.permission)),
      )
      .map((tool) => tool.definition);
  }
  authorize(name, permissions) {
    const tool = this.get(name);
    check(tool, "UNKNOWN_TOOL", "工具不存在", 422);
    check(
      permissions && typeof permissions.require === "function",
      "PERMISSION_REQUIRED",
      "执行工具必须提供授权上下文",
      403,
    );
    permissions.require("tools.execute");
    permissions.require(tool.permission, `当前权限不允许执行工具：${name}`);
    return tool;
  }
  async execute(name, args, context, permissions) {
    const tool = this.authorize(name, permissions);
    validateArguments(
      args,
      tool.definition.function.parameters || {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    );
    return tool.execute(args, context);
  }
}
