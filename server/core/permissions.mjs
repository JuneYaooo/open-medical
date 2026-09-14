import { AppError, check } from "../errors.mjs";

export const PERMISSION_KEYS = Object.freeze([
  "filesystem.read",
  "filesystem.write",
  "network",
  "process.spawn",
  "sandbox.execute",
  "tools.execute",
  "model.external",
  "agents.delegate",
  "plugins.execute",
  "mcp.execute",
  "browser.read",
  "memory.read",
  "memory.write",
  "git.write",
]);

const PROFILES = Object.freeze({
  minimal: Object.freeze({
    "filesystem.read": false,
    "filesystem.write": false,
    network: false,
    "process.spawn": false,
    "sandbox.execute": false,
    "tools.execute": false,
    "model.external": true,
    "agents.delegate": false,
  }),
  standard: Object.freeze({
    "filesystem.read": true,
    "filesystem.write": false,
    network: false,
    "process.spawn": false,
    "sandbox.execute": true,
    "tools.execute": true,
    "model.external": true,
    "agents.delegate": true,
  }),
  code: Object.freeze({
    "filesystem.read": true,
    "filesystem.write": true,
    network: false,
    "process.spawn": false,
    "sandbox.execute": true,
    "tools.execute": true,
    "model.external": true,
    "agents.delegate": true,
  }),
  creator: Object.freeze({
    "filesystem.read": true,
    "filesystem.write": true,
    network: false,
    "process.spawn": false,
    "sandbox.execute": true,
    "tools.execute": true,
    "model.external": true,
    "agents.delegate": true,
  }),
});

export class PermissionEngine {
  constructor({ profile = "standard", grants = {} } = {}) {
    check(
      Object.hasOwn(PROFILES, profile),
      "PERMISSION_PROFILE",
      "未知权限模式",
    );
    check(
      grants && typeof grants === "object" && !Array.isArray(grants),
      "PERMISSION_GRANTS",
      "授权配置无效",
    );
    for (const value of Object.values(grants))
      check(
        typeof value === "boolean",
        "PERMISSION_GRANTS",
        "授权必须为布尔值",
      );
    this.profile = profile;
    this.grants = Object.freeze({
      ...Object.fromEntries(PERMISSION_KEYS.map((key) => [key, false])),
      ...PROFILES[profile],
      ...grants,
    });
    for (const key of Object.keys(this.grants))
      check(
        PERMISSION_KEYS.includes(key),
        "PERMISSION_KEY",
        `未知权限：${key}`,
      );
  }
  can(permission) {
    return this.grants[permission] === true;
  }
  require(permission, reason = "当前运行模式不允许此操作") {
    check(
      PERMISSION_KEYS.includes(permission),
      "PERMISSION_KEY",
      `未知权限：${permission}`,
    );
    if (!this.can(permission))
      throw new AppError("PERMISSION_DENIED", reason, 403);
  }
  snapshot() {
    return { profile: this.profile, grants: { ...this.grants } };
  }
}

export function permissionForTool(tool) {
  return tool?.permission || "tools.execute";
}
