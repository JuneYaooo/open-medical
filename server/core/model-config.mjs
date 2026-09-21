// N5 统一模型配置发现(复核报告 R5):
// 一个无副作用的配置解析/发现模块,共用于 verify-model、eval-v1 运行器与
// 其他需要真实 provider 的入口。与 desktop/main.cjs 的保存/发现位置保持
// 一致(Electron userData 优先,含遗留目录名,再回退仓库 .env)。
//
// 关键约束(任务书 8.2):
// - 不修改 process.env、不 import 执行型脚本;
// - 优先级:显式运行参数 → 有效进程环境 → 项目桌面配置 → 仓库配置;
// - 不把不同提供方的 key/baseURL/model 拼在一起;仅有 AI_PROVIDER 而无
//   该提供方凭据时,允许回退到完整保存配置并如实记录;
// - 校验完整后才判定 configured;本地无密钥模型(local + baseUrl)合法;
// - 损坏的配置文件要报告错误,不静默切换到另一账户;
// - 报告/日志只含 provider/model/来源类别与脱敏 baseUrl,绝不含密钥。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const KEY_VALUE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** 解析 .env/model.env 文本(纯函数;支持 export 前缀、注释、引号)。 */
export function parseEnvFile(text) {
  const values = {};
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const line = raw.startsWith("export ") ? raw.slice(7).trim() : raw;
    const m = KEY_VALUE.exec(line);
    if (!m)
      return {
        ok: false,
        error: `配置文件格式无效:第 ${i + 1} 行不是 KEY=VALUE(${line.slice(0, 24)}…)`,
      };
    let value = m[2].trim();
    const quote = value.startsWith('"') || value.startsWith("'");
    if (quote && value.length >= 2 && value.endsWith(value[0]))
      value = value.slice(1, -1);
    values[m[1]] = value;
  }
  return { ok: true, values };
}

/** 与 desktop 一致的候选位置(userData 优先,遗留目录名,再仓库 .env)。 */
export function modelConfigCandidates(
  env = process.env,
  { platform = process.platform, home = homedir() } = {},
) {
  const dir =
    platform === "darwin"
      ? join(home, "Library", "Application Support")
      : platform === "win32"
        ? env.APPDATA || join(home, "AppData", "Roaming")
        : join(home, ".config");
  const candidates = ["Open Medical Workbench", "Open Agent", "Open Medical"].map(
    (name) => ({
      source: `desktop:${platform}:${name}`,
      sourceCategory: "desktop",
      file: join(dir, name, "model.env"),
    }),
  );
  candidates.push({ source: "repo", sourceCategory: "repo", file: ".env" });
  return candidates;
}

// 每个提供方独立的字段组——绝不跨提供方拼接 key/baseURL/model。
const PROVIDER_FIELDS = {
  deepseek: {
    apiKey: ["DEEPSEEK_API_KEY"],
    baseUrl: ["DEEPSEEK_BASE_URL"],
    model: ["DEEPSEEK_MODEL"],
  },
  openai: {
    apiKey: ["OPENAI_API_KEY", "AI_API_KEY"],
    baseUrl: ["OPENAI_BASE_URL"],
    model: ["OPENAI_MODEL"],
  },
  "openai-responses": {
    apiKey: ["OPENAI_API_KEY", "AI_API_KEY"],
    baseUrl: ["OPENAI_BASE_URL"],
    model: ["OPENAI_MODEL"],
  },
  openrouter: {
    apiKey: ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "AI_API_KEY"],
    baseUrl: ["OPENAI_BASE_URL"],
    model: ["OPENROUTER_MODEL", "OPENAI_MODEL"],
  },
  anthropic: {
    apiKey: ["ANTHROPIC_API_KEY"],
    baseUrl: ["ANTHROPIC_BASE_URL"],
    model: ["ANTHROPIC_MODEL"],
  },
  local: {
    apiKey: [],
    baseUrl: ["LOCAL_MODEL_BASE_URL"],
    model: ["LOCAL_MODEL_NAME"],
  },
};

const KIND_ALIASES = {
  claude: "anthropic",
  responses: "openai-responses",
  "openai-compatible": "openai",
};

function normalizeKind(name) {
  if (!name) return null;
  const kind = String(name).toLowerCase().trim();
  return KIND_ALIASES[kind] || (PROVIDER_FIELDS[kind] ? kind : null);
}

// 从一组键值里推断提供方(无显式 provider 字段时)。
function inferKind(keys) {
  const has = (k) => keys.includes(k);
  if (has("DEEPSEEK_API_KEY")) return "deepseek";
  if (has("ANTHROPIC_API_KEY")) return "anthropic";
  if (has("OPENROUTER_API_KEY")) return "openrouter";
  if (has("OPENAI_API_KEY") || has("AI_API_KEY")) return "openai";
  if (has("LOCAL_MODEL_BASE_URL")) return "local";
  return null;
}

function fieldsFor(kind, get) {
  const spec = PROVIDER_FIELDS[kind];
  const out = {};
  for (const [field, names] of Object.entries(spec)) {
    for (const name of names) {
      const value = get(name);
      if (value !== undefined && value !== "") {
        out[field] = value;
        break;
      }
    }
  }
  return out;
}

const usable = (config) =>
  Boolean(
    config?.kind &&
      (config.apiKey || config.kind === "local"),
  );

/**
 * 无副作用发现:返回
 * { ok, provider, apiKey, baseUrl, model, timeoutMs, maxTokens,
 *   source, sourceCategory, searched, notes, error }
 * 环境字段/文件值不回写 env;error 时绝不用其他来源的凭据发起请求。
 */
export function discoverModelConfig({
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  home = homedir(),
  explicit = null,
} = {}) {
  const searched = [];
  const notes = [];
  if (explicit && (explicit.apiKey || explicit.provider === "local")) {
    return {
      ok: true,
      provider: normalizeKind(explicit.provider) || "deepseek",
      apiKey: explicit.apiKey ?? "",
      baseUrl: explicit.baseUrl,
      model: explicit.model,
      source: "explicit",
      sourceCategory: "explicit",
      searched,
      notes,
    };
  }
  // 1) 进程环境(按提供方分组,不拼接跨组字段)。
  const envKeys = Object.keys(env);
  const envProvider = normalizeKind(env.AI_PROVIDER || env.MODEL_PROVIDER);
  const envConfig = envProvider
    ? { kind: envProvider, ...fieldsFor(envProvider, (n) => env[n]) }
    : null;
  const envInferredKind = inferKind(envKeys);
  const envInferred = envInferredKind
    ? {
        kind: envInferredKind,
        ...fieldsFor(envInferredKind, (n) => env[n]),
      }
    : null;
  // 2) 候选文件(全部存在的都解析;损坏即报错,不静默跳过)。
  const fileConfigs = [];
  for (const candidate of modelConfigCandidates(env, { platform, home })) {
    // 桌面候选是绝对路径;仓库 .env 相对 cwd(join 对绝对段不重置,需先判断)。
    const file =
      cwd && !isAbsolute(candidate.file) ? join(cwd, candidate.file) : candidate.file;
    const record = { ...candidate, file, exists: existsSync(file) };
    searched.push({ source: candidate.source, file: candidate.file });
    if (!record.exists) continue;
    let parsed;
    try {
      parsed = parseEnvFile(readFileSync(file, "utf8"));
    } catch (error) {
      return {
        ok: false,
        error: `读取配置失败(${candidate.file}):${error.message}`,
        searched,
        notes,
      };
    }
    if (!parsed.ok)
      return {
        ok: false,
        error: `${candidate.source} 配置损坏:${parsed.error}`,
        searched,
        notes,
      };
    const keys = Object.keys(parsed.values);
    const kind = normalizeKind(parsed.values.AI_PROVIDER || parsed.values.MODEL_PROVIDER) || inferKind(keys);
    fileConfigs.push({
      source: candidate.source,
      sourceCategory: candidate.sourceCategory,
      kind,
      ...(kind ? fieldsFor(kind, (n) => parsed.values[n]) : {}),
      values: parsed.values,
    });
  }
  const usableFile = fileConfigs.find((f) => usable(f));
  // 3) 优先级合成:有效环境 → 桌面/仓库文件;同名提供方字段级互补,
  //    不同提供方绝不拼接。
  if (envConfig && usable(envConfig)) {
    if (usableFile && usableFile.kind !== envConfig.kind)
      notes.push(
        `环境指定 ${envConfig.kind} 且凭据有效,保存的 ${usableFile.kind} 配置未使用`,
      );
    return finalize({
      kind: envConfig.kind,
      apiKey: envConfig.apiKey,
      baseUrl: envConfig.baseUrl,
      model: envConfig.model,
      timeoutMs: env.AI_TIMEOUT_MS,
      maxTokens: env.AI_MAX_TOKENS,
      source: "environment",
      sourceCategory: "environment",
      searched,
      notes,
    });
  }
  if (envInferred && usable(envInferred)) {
    notes.push(
      envProvider
        ? `环境 AI_PROVIDER=${envProvider} 缺少该提供方凭据;改用环境中 ${envInferred.kind} 的有效凭据`
        : `使用环境中 ${envInferred.kind} 的有效凭据`,
    );
    return finalize({
      kind: envInferred.kind,
      apiKey: envInferred.apiKey,
      baseUrl: envInferred.baseUrl,
      model: envInferred.model,
      timeoutMs: env.AI_TIMEOUT_MS,
      maxTokens: env.AI_MAX_TOKENS,
      source: "environment",
      sourceCategory: "environment",
      searched,
      notes,
    });
  }
  if (usableFile) {
    // 环境只给了 provider 名称(无凭据)时不忽略保存配置;环境有另一个
    // 提供方的散键但无效时同样回退保存配置。
    if (envProvider && envProvider !== usableFile.kind)
      notes.push(
        `环境仅指定 AI_PROVIDER=${envProvider} 而无该提供方凭据;使用保存的 ${usableFile.kind} 配置`,
      );
    return finalize({
      kind: usableFile.kind,
      apiKey: usableFile.apiKey,
      baseUrl: usableFile.baseUrl,
      model: usableFile.model,
      timeoutMs: usableFile.values.AI_TIMEOUT_MS,
      maxTokens: usableFile.values.AI_MAX_TOKENS,
      source: usableFile.source,
      sourceCategory: usableFile.sourceCategory,
      searched,
      notes,
    });
  }
  if (envProvider)
    return {
      ok: false,
      error: `环境指定 AI_PROVIDER=${envProvider} 但缺少该提供方凭据;保存位置也未找到有效配置`,
      searched,
      notes,
    };
  return {
    ok: false,
    error: "未找到模型凭据配置(环境与所有保存位置均无有效提供方)",
    searched,
    notes,
  };
}

function finalize(config) {
  // 校验完整后才判 configured:有 key,或显式 local 模型(无密钥合法,
  // baseUrl 缺省由 provider 工厂回退 127.0.0.1:11434)。
  const kind = config.kind;
  const valid = Boolean(config.apiKey) || kind === "local";
  return {
    ok: valid,
    provider: kind,
    apiKey: config.apiKey || "",
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs ? Number(config.timeoutMs) : undefined,
    maxTokens: config.maxTokens ? Number(config.maxTokens) : undefined,
    source: config.source,
    sourceCategory: config.sourceCategory,
    searched: config.searched,
    notes: config.notes,
  };
}

/** 报告/日志用的脱敏摘要:provider/model/来源类别 + 去凭据 baseUrl。 */
export function describeModelConfig(config) {
  if (!config?.ok) return { configured: false };
  let baseUrlHost;
  if (config.baseUrl) {
    try {
      const url = new URL(config.baseUrl);
      baseUrlHost = url.origin;
    } catch {
      baseUrlHost = "(invalid-url)";
    }
  }
  return {
    configured: true,
    provider: config.provider,
    model: config.model || null,
    baseUrlHost: baseUrlHost || null,
    sourceCategory: config.sourceCategory,
    source: config.source,
    notes: config.notes,
  };
}
