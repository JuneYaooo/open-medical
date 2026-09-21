import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

// 能力就绪判定（B1）：把「真实执行依赖」与「运行事实探测」从快照组装
// 和工具注册中提取出来，作为授权/就绪/可执行三态与稳定原因码的单一事实
// 来源。快照、模型工具列表（readinessFilter）与执行路径共用这里的概念。

// 探测短 TTL：daemon/镜像状态在无配置变化时的兜底刷新周期。足够短以
// 体现「依赖恢复后状态更新」，足够长以避免逐轮同步 docker CLI。
export const CAPABILITY_TTL_MS = 5000;

// 稳定原因码：测试、日志与 UI 依赖其取值跨版本不变，文案（reason/
// remedy）可以独立调整。不要复用语义或改名。
export const CAPABILITY_REASON = {
  OK: "OK",
  READINESS_UNKNOWN: "READINESS_UNKNOWN",
  CONFIGURATION_MISSING: "CONFIGURATION_MISSING",
  PERMISSION_MISSING: "PERMISSION_MISSING",
  BACKEND_UNAVAILABLE: "BACKEND_UNAVAILABLE",
  IMAGE_NOT_CONFIGURED: "IMAGE_NOT_CONFIGURED",
  IMAGE_MISSING: "IMAGE_MISSING",
};

// Audited built-in execution dependencies. Permissions describe authorization,
// never the execution backend. New/custom tools must declare capability metadata.
const BUILTIN_BACKENDS = new Map();
const declare = (backend, names) =>
  names
    .split(/\s+/)
    .filter(Boolean)
    .forEach((name) => BUILTIN_BACKENDS.set(name, backend));
declare(
  "container",
  `terminal_start terminal_run document_read document_create document_render archive_list archive_extract archive_create code_execute plugin_command`,
);
declare(
  "local",
  `terminal_read terminal_wait terminal_write terminal_stop list_directory read_file propose_file_write read_context_archive search_run_history list_skills read_skill list_skill_resources read_skill_resource search_files delegate_task delegate_tasks inspect_file list_artifacts project_instructions propose_file_edit propose_file_delete read_file_proposal revise_file_proposal apply_file_proposal update_plan plugin_list plugin_skill mcp_list memory_list memory_delete spawn_agent list_agent_models list_agents send_agent_message resume_agent cancel_agent wait_agents`,
);
declare("network", `web_fetch web_search`);
declare("git", `git_status git_diff git_log git_commit`);
declare(
  "browser",
  `browser_open browser_snapshot browser_screenshot browser_action`,
);
declare("python", "calculate_python");
declare("desktop", "desktop_control");
declare("media", "media_generate");
declare("vision", "inspect_image");
declare("mcp", "mcp_call mcp_resource");
declare("memory", "memory_search memory_add");
export const builtinCapability = (name) => {
  const backend = BUILTIN_BACKENDS.get(name);
  return backend
    ? {
        backend,
        ...(name === "plugin_command"
          ? { permissions: ["process.spawn"] }
          : {}),
        ...(name === "web_fetch" ? { permissions: ["network"] } : {}),
      }
    : null;
};
export const needsContainer = (tool) =>
  (tool.capability || builtinCapability(tool.definition.function.name))
    ?.backend === "container";
const unknown = () => ({
  ready: false,
  reasonCode: CAPABILITY_REASON.READINESS_UNKNOWN,
  reason: "工具未声明可验证的执行依赖",
  remedy: "为工具注册 capability 后端和就绪检查",
});
const executableFile = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// Read only local configuration/status; do not contact providers or read secrets.
export function serviceCapabilityChecks(service, id, probe) {
  return {
    python: () => service.sandbox?.status(),
    browser: () => service.extensions.browser.status(),
    desktop: () => {
      const nativePath = new URL(
        "../../desktop/bin/native-control",
        import.meta.url,
      );
      const native = service.desktop.invoke === service.desktop.native;
      if (
        native &&
        (process.platform !== "darwin" || !executableFile(nativePath))
      )
        return {
          available: false,
          reason: "macOS 桌面控制后端未安装",
          remedy: "在 macOS 构建原生控制组件",
        };
      try {
        service.desktop.session(id);
        return { available: true };
      } catch {
        return {
          available: false,
          reason: "没有有效的桌面应用授权",
          remedy: "在桌面面板选择并授权应用",
        };
      }
    },
    media: () => {
      const selected = service.store.get(id).teamModels || [];
      const profiles = service.modelProfiles?.list() || [];
      return {
        available: profiles.some(
          (p) =>
            selected.includes(p.id) &&
            [
              "openai",
              "openai-compatible",
              "openai-responses",
              "local",
            ].includes(p.provider),
        ),
        reason: "没有已授权且兼容媒体接口的模型连接",
        remedy: "配置并授权兼容 OpenAI 媒体接口的模型连接",
      };
    },
    vision: () => ({
      available: service.provider.vision === true,
      reason: "当前模型不支持图像输入",
    }),
    memory: () => {
      const config = service.extensions.current(id).config.memory;
      return {
        available:
          !config ||
          config.provider === "lsa" ||
          Boolean(config.url && config.model),
        reason: "语义记忆后端未配置",
      };
    },
    mcp: () => {
      const configs = service.extensions.current(id).config.mcpServers || [];
      return {
        available: configs.some((config) =>
          config.transport !== "stdio"
            ? Boolean(config.url)
            : probe.readiness(
                { capability: { backend: "container" } },
                probe.environment(`${id}:mcp:${config.id}`, config.image),
              ).ready,
        ),
        reason: "没有已配置且执行依赖就绪的 MCP 服务",
        remedy: "配置 MCP 服务；stdio 服务需要其容器镜像",
      };
    },
  };
}

const BACKEND_REMEDY = "启动 Docker（Linux 容器模式）并导入离线运行时镜像";
const IMAGE_REMEDY = "离线导入运行时镜像，或在扩展设置中重新选择";

// 按工作区缓存的运行事实探测。status/image 走 docker CLI（各 4s 超时），
// 不能每轮、每工具重复执行：
// - daemon 探测进程级复用（同一 runner 共享）；
// - 镜像存在性按工作区缓存，以 workspace revision + 短 TTL 双重失效：
//   配置变化（revision 前进）立即失效，daemon 状态变化由 TTL 兜底。
// 探测失败一律降级为「未就绪 + 原因」，绝不抛入模型循环。
export class CapabilityProbe {
  constructor({
    runner,
    ttlMs = CAPABILITY_TTL_MS,
    clock = () => Date.now(),
  } = {}) {
    this.runner = runner;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.backendCache = null;
    this.environments = new Map();
  }
  invalidate(_id) {
    this.backendCache = null;
    // A refreshed daemon fact invalidates every cached environment using it.
    this.environments.clear();
  }
  environment(id, imageReference) {
    // 缓存键是「配置身份」（工作区 + 镜像引用），不是全部运行状态的
    // revision：普通 run 会推进 revision，以 revision 失效会导致每轮
    // 重复镜像探测；镜像引用变化（扩展配置变化）自然换键，TTL 兜底
    // daemon 状态变化。invalidate(id) 供恢复/测试显式刷新。
    const reference = imageReference || null,
      cached = this.environments.get(id),
      now = this.clock();
    if (
      cached &&
      cached.reference === reference &&
      now - cached.at < this.ttlMs
    )
      return cached.env;
    const env = {
      backend: this.backendStatus(),
      image: {
        reference: imageReference || null,
        present: false,
        checked: false,
      },
    };
    // daemon 未运行时不探测镜像：镜像检查自身也依赖 daemon，其
    // SANDBOX_BACKEND 语义（先启 Docker）与后端不可用一致。
    if (env.backend.available && imageReference) {
      env.image.checked = true;
      try {
        this.runner.image(imageReference);
        env.image.present = true;
      } catch (error) {
        env.image.errorCode = error?.code || "SANDBOX_IMAGE";
        env.image.reason = error?.message || String(error);
      }
    }
    this.environments.set(id, { reference, at: now, env });
    return env;
  }
  backendStatus() {
    const now = this.clock();
    if (this.backendCache && now - this.backendCache.at < this.ttlMs)
      return this.backendCache.status;
    let status;
    try {
      status = this.runner.status();
    } catch (error) {
      status = {
        available: false,
        backend: "docker-linux",
        host: process.platform,
        reason: error?.message || String(error),
      };
    }
    this.backendCache = { at: now, status };
    return status;
  }
  // 环境维度的就绪三态（不含授权——授权由权限引擎单独判定）。
  readiness(tool, env) {
    const capability =
      tool.capability || builtinCapability(tool.definition?.function?.name);
    if (!capability) return unknown();
    if (capability.backend !== "container") {
      if (
        ["local", "network"].includes(capability.backend) &&
        !capability.check
      )
        return { ready: true, reasonCode: CAPABILITY_REASON.OK };
      const check = capability.check || env?.checks?.[capability.backend];
      let state;
      try {
        if (capability.backend === "git" && !check) {
          state = {
            available: (process.env.PATH || "")
              .split(delimiter)
              .some((dir) =>
                executableFile(
                  join(dir, process.platform === "win32" ? "git.exe" : "git"),
                ),
              ),
            reason: "未找到 Git 可执行文件",
            remedy: "安装 Git 并将其加入 PATH",
          };
        } else if (!check) return unknown();
        else state = check();
      } catch (error) {
        state = { available: false, reason: error.message };
      }
      if (!state || typeof state.available !== "boolean") return unknown();
      return state.available
        ? { ready: true, reasonCode: CAPABILITY_REASON.OK }
        : {
            ready: false,
            reasonCode:
              state.reasonCode || CAPABILITY_REASON.BACKEND_UNAVAILABLE,
            reason: state.reason || "工具执行后端不可用",
            remedy: state.remedy || "检查此工具的执行后端配置",
          };
    }
    if (!env.backend.available)
      return {
        ready: false,
        reasonCode: CAPABILITY_REASON.BACKEND_UNAVAILABLE,
        reason: env.backend.reason || "容器执行后端不可用",
        remedy: BACKEND_REMEDY,
      };
    if (!env.image.reference)
      return {
        ready: false,
        reasonCode: CAPABILITY_REASON.IMAGE_NOT_CONFIGURED,
        reason: "尚未配置容器镜像",
        remedy: IMAGE_REMEDY,
      };
    if (!env.image.present) {
      const backendDown = env.image.errorCode === "SANDBOX_BACKEND";
      return {
        ready: false,
        reasonCode: backendDown
          ? CAPABILITY_REASON.BACKEND_UNAVAILABLE
          : CAPABILITY_REASON.IMAGE_MISSING,
        reason:
          env.image.reason || "本地镜像不存在，请先离线导入；不会自动下载",
        remedy: backendDown ? BACKEND_REMEDY : IMAGE_REMEDY,
      };
    }
    return { ready: true, reasonCode: CAPABILITY_REASON.OK };
  }
}
