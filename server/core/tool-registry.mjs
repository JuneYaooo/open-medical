import { builtinCapability } from "./capability.mjs";
import { check } from "../errors.mjs";
import { PERMISSION_KEYS, permissionForTool } from "./permissions.mjs";

import { validateArguments, validateSchema } from "./schema.mjs";

export function checkToolAvailability(name, context) {
  check(!context?.pausedTools?.includes(name), "TOOL_RECOVERY_PAUSED",
    "该读取工具在本轮重新规划阶段暂缓执行；已有原文仍可从归档读取，下一轮恢复", 409);
}

export class ToolRegistry {
  constructor(tools = []) {
    this.tools = new Map();
    // Deferred tools stay registered and executable but are not listed to the
    // model until their group is revealed (see deferred-tools.mjs).
    this.hidden = new Set();
    this.groupOf = new Map();
    this.onReveal = null;
    for (const tool of tools) this.register(tool);
  }
  register({ definition, execute, permission, capability, observation, parallel = false } = {}) {
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
    const dependency = capability ?? builtinCapability(name);
    check(!observation || (typeof observation.revision === "string" &&
      typeof observation.content === "string" &&
      ((permission || permissionForTool(definition)) === "filesystem.read" ||
        (name === "read_context_archive" && observation.archiveReference === "id"))),
    "TOOL_CONFIG", "版本化观察必须来自明确注册的只读文件工具");
    check(
      !dependency ||
        (typeof dependency.backend === "string" &&
          (!dependency.check || typeof dependency.check === "function") &&
          (dependency.permissions || []).every((key) =>
            PERMISSION_KEYS.includes(key),
          )),
      "TOOL_CONFIG",
      "工具能力依赖无效",
    );
    this.tools.set(name, {
      // Opt-in semantics owned by the tool implementer, never by the model.
      observation: observation ? structuredClone(observation) : null,
      // 无副作用、可与同批其他 parallel 调用并发执行；权限键不能代替这个声明。
      parallel: parallel === true,
      capability: dependency ? { ...dependency } : null,
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
  // readinessFilter 由组装方注入（core/capability.mjs 的就绪判定）：
  // 环境未就绪的容器工具不进入模型可调用列表；未注入时行为不变。
  // 权限过滤与此独立，且 authorize/execute 的执行前校验保持原样。
  definitions(permissionEngine) {
    return [...this.tools.values()]
      .filter(
        (tool) =>
          !permissionEngine ||
          (permissionEngine.can("tools.execute") &&
            permissionEngine.can(tool.permission) &&
            (tool.capability?.permissions || []).every((key) =>
              permissionEngine.can(key),
            )),
      )
      .filter((tool) => !this.readinessFilter || this.readinessFilter(tool))
      .filter((tool) => !this.hidden.has(tool.definition.function.name))
      .map((tool) => tool.definition);
  }
  // Lists a deferred group from the next model round on.
  reveal(groupId) {
    const names = [...this.groupOf].filter(([, group]) => group === groupId).map(([name]) => name);
    const newly = names.filter((name) => this.hidden.delete(name));
    if (newly.length) this.onReveal?.(groupId, newly);
    return names;
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
    for (const key of tool.capability?.permissions || [])
      permissions.require(key);
    return tool;
  }
  async execute(name, args, context, permissions) {
    const tool = this.authorize(name, permissions);
    // A model may call a deferred tool it already knows; run it and list its
    // whole group from now on.
    if (this.hidden.has(name)) this.reveal(this.groupOf.get(name));
    checkToolAvailability(name, context);
    validateArguments(
      args,
      tool.definition.function.parameters || {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    );
    return untilAborted(tool.execute(args, context), context?.signal);
  }
}

// A tool that ignores its abort signal must not keep a cancelled or timed-out
// run alive (and its workspace locked). The tool's own promise is left to
// settle in the background; its result is discarded.
function untilAborted(work, signal) {
  if (!signal || typeof signal.addEventListener !== "function") return work;
  if (signal.aborted) {
    Promise.resolve(work).catch(() => {});
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(work).then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
