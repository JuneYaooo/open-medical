import { check } from "../errors.mjs";

const PLUGIN_ID = /^[a-z][a-z0-9-]{1,39}$/;
const TABLE_PREFIX = /^[a-z][a-z0-9_]{0,39}$/;
const HTTP_METHOD = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|\*)$/;
const API_SEGMENT = /^(?::[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9._~-]+|\*)$/;

const isObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Domain plugins describe server-side capabilities only: data migrations,
// Agent tools, prompts/skills, proposals, agenda sources and an HTTP handler.
// The host owns lifecycle; definePlugin only validates and freezes the spec so
// a broken plugin cannot mutate its own declaration after loading.
export function definePlugin(spec = {}) {
  check(isObject(spec), "PLUGIN_SPEC", "插件定义必须是对象");
  const {
    id,
    version,
    title,
    requires = {},
    enabledByDefault = true,
    keepEnabledOnUpgrade = false,
    migrations,
    tablePrefix,
    legacyTables = [],
    setup,
    tools,
    prompt,
    promptWhen,
    skills,
    proposals = {},
    legacyProposalTypes = {},
    agendaSources = [],
    workflows = {},
    contexts = {},
    api,
    events = {},
    hooks = {},
    patientSummary,
    patientBrief,
    demo,
    legacyApiPaths = [],
    lifecycle,
    provides,
    status,
    capabilities,
    activation,
  } = spec;

  check(
    typeof id === "string" && PLUGIN_ID.test(id),
    "PLUGIN_SPEC",
    "插件 id 必须匹配 /^[a-z][a-z0-9-]{1,39}$/",
  );
  check(
    typeof version === "string" && version.trim(),
    "PLUGIN_SPEC",
    `插件 ${id} 缺少 version`,
  );
  check(
    typeof title === "string" && title.trim(),
    "PLUGIN_SPEC",
    `插件 ${id} 缺少 title`,
  );
  check(
    typeof enabledByDefault === "boolean",
    "PLUGIN_SPEC",
    `插件 ${id} 的 enabledByDefault 必须是布尔值`,
  );
  check(
    typeof keepEnabledOnUpgrade === "boolean",
    "PLUGIN_SPEC",
    `插件 ${id} 的 keepEnabledOnUpgrade 必须是布尔值`,
  );
  check(isObject(requires), "PLUGIN_SPEC", `插件 ${id} 的 requires 必须是对象`);
  const rawRequiredPlugins = requires.plugins ?? {};
  // Both the canonical object form ({ id: range }) and the shorthand array
  // form ([id]) are accepted; the array form means "any version".
  const requiredPlugins = Array.isArray(rawRequiredPlugins)
    ? Object.fromEntries(rawRequiredPlugins.map((key) => [key, "*"]))
    : rawRequiredPlugins;
  check(
    isObject(requiredPlugins) &&
      Object.entries(requiredPlugins).every(
        ([key, value]) => PLUGIN_ID.test(key) && typeof value === "string" && value.trim(),
      ),
    "PLUGIN_SPEC",
    `插件 ${id} 的 requires.plugins 必须是 { 插件id: 版本范围 } 或插件 id 数组`,
  );
  const anyOf = requires.anyOf ?? [];
  check(
    Array.isArray(anyOf) &&
      anyOf.every(
        (group) =>
          Array.isArray(group) &&
          group.length > 0 &&
          group.every((key) => typeof key === "string" && PLUGIN_ID.test(key)),
      ),
    "PLUGIN_SPEC",
    `插件 ${id} 的 requires.anyOf 必须是插件 id 分组数组`,
  );

  check(
    migrations === undefined ||
      (typeof migrations === "string" && migrations.trim()),
    "PLUGIN_SPEC",
    `插件 ${id} 的 migrations 必须是相对路径`,
  );
  // A plugin may own several historical table families (for example the
  // followup plugin owns followup_*, chat_* and care_*). Accept a single
  // prefix for existing plugins, or a non-empty array of prefixes when the
  // migration creates more than one family.
  const prefixes = Array.isArray(tablePrefix) ? tablePrefix : [tablePrefix];
  const validPrefixes =
    prefixes.length > 0 &&
    prefixes.every(
      (prefix) => typeof prefix === "string" && TABLE_PREFIX.test(prefix),
    );
  if (migrations) {
    check(
      validPrefixes,
      "PLUGIN_SPEC",
      `插件 ${id} 有 migrations 时必须提供合法的 tablePrefix`,
    );
  } else {
    check(
      tablePrefix === undefined || validPrefixes,
      "PLUGIN_SPEC",
      `插件 ${id} 的 tablePrefix 无效`,
    );
  }
  check(
    Array.isArray(legacyTables) &&
      legacyTables.every((name) => typeof name === "string" && name.trim()),
    "PLUGIN_SPEC",
    `插件 ${id} 的 legacyTables 必须是表名数组`,
  );
  for (const [field, value] of [
    ["setup", setup],
    ["tools", tools],
    ["api", api],
    ["status", status],
    ["promptWhen", promptWhen],
    ["patientSummary", patientSummary],
    ["patientBrief", patientBrief],
  ]) {
    check(
      value === undefined || typeof value === "function",
      "PLUGIN_SPEC",
      `插件 ${id} 的 ${field} 必须是函数`,
    );
  }
  for (const [field, value] of [
    ["prompt", prompt],
    ["skills", skills],
  ]) {
    check(
      value === undefined || (typeof value === "string" && value.trim()),
      "PLUGIN_SPEC",
      `插件 ${id} 的 ${field} 必须是相对路径`,
    );
  }
  check(
    isObject(proposals),
    "PLUGIN_SPEC",
    `插件 ${id} 的 proposals 必须是对象`,
  );
  const normalizeProposal = (kind, handler) => {
    check(
      isObject(handler) && typeof handler.apply === "function",
      "PLUGIN_SPEC",
      `插件 ${id} 的提案类型 ${kind} 必须提供 apply`,
    );
    check(
      handler.validate === undefined || typeof handler.validate === "function",
      "PLUGIN_SPEC",
      `插件 ${id} 的提案类型 ${kind} 的 validate 必须是函数`,
    );
    check(
      handler.revisionScoped === undefined ||
        typeof handler.revisionScoped === "boolean",
      "PLUGIN_SPEC",
      `插件 ${id} 的提案类型 ${kind} 的 revisionScoped 必须是布尔值`,
    );
    return Object.freeze({
      validate: handler.validate,
      apply: handler.apply,
      revisionScoped: handler.revisionScoped === true,
    });
  };
  const normalizedProposals = {};
  for (const [kind, handler] of Object.entries(proposals)) {
    check(
      kind.startsWith(`${id}.`) && kind.length > id.length + 1,
      "PLUGIN_SPEC",
      `插件 ${id} 的提案类型 ${kind} 必须以 "${id}." 开头`,
    );
    normalizedProposals[kind] = normalizeProposal(kind, handler);
  }

  // Historical proposal types keep their database strings. A plugin may take
  // them over either by declaring { legacyType: handler } or by listing the
  // legacy names and providing the matching "<id>.<legacyType>" handler in
  // proposals. The host routes both shapes through the same validate/apply.
  check(
    Array.isArray(legacyProposalTypes) || isObject(legacyProposalTypes),
    "PLUGIN_SPEC",
    `插件 ${id} 的 legacyProposalTypes 必须是对象或历史类型数组`,
  );
  const legacyEntries = Array.isArray(legacyProposalTypes)
    ? legacyProposalTypes.map((kind) => [
        kind,
        normalizedProposals[`${id}.${kind}`] || normalizedProposals[kind],
      ])
    : Object.entries(legacyProposalTypes);
  const normalizedLegacyProposals = {};
  for (const [kind, handler] of legacyEntries) {
    check(
      typeof kind === "string" && kind.trim(),
      "PLUGIN_SPEC",
      `插件 ${id} 的 legacyProposalTypes 含非法类型`,
    );
    check(
      handler !== undefined,
      "PLUGIN_SPEC",
      `插件 ${id} 的 legacyProposalTypes.${kind} 缺少对应提案处理函数`,
    );
    normalizedLegacyProposals[kind] =
      normalizedProposals[kind] || normalizeProposal(kind, handler);
  }

  check(
    Array.isArray(agendaSources),
    "PLUGIN_SPEC",
    `插件 ${id} 的 agendaSources 必须是数组`,
  );
  const normalizedSources = agendaSources.map((source) => {
    check(
      isObject(source) &&
        typeof source.kind === "string" &&
        source.kind.trim() &&
        typeof source.read === "function",
      "PLUGIN_SPEC",
      `插件 ${id} 的 agendaSource 必须提供 kind 与 read`,
    );
    check(
      source.label === undefined || typeof source.label === "string",
      "PLUGIN_SPEC",
      `插件 ${id} 的 agendaSource label 必须是字符串`,
    );
    check(
      source.order === undefined || Number.isFinite(source.order),
      "PLUGIN_SPEC",
      `插件 ${id} 的 agendaSource order 必须是数字`,
    );
    check(
      source.available === undefined || typeof source.available === "function",
      "PLUGIN_SPEC",
      `插件 ${id} 的 agendaSource available 必须是函数`,
    );
    return Object.freeze({
      kind: source.kind,
      label: source.label ?? source.kind,
      order: source.order ?? 100,
      read: source.read,
      ...(source.available ? { available: source.available } : {}),
    });
  });

  check(isObject(workflows), "PLUGIN_SPEC", `插件 ${id} 的 workflows 必须是对象`);
  const normalizedWorkflows = {};
  for (const [workflowId, hooks] of Object.entries(workflows)) {
    check(
      PLUGIN_ID.test(workflowId),
      "PLUGIN_SPEC",
      `插件 ${id} 的工作流 id ${workflowId} 无效`,
    );
    check(
      isObject(hooks),
      "PLUGIN_SPEC",
      `插件 ${id} 的工作流 ${workflowId} 必须是对象`,
    );
    check(
      hooks.artifactType === undefined ||
        (typeof hooks.artifactType === "string" && hooks.artifactType.trim()),
      "PLUGIN_SPEC",
      `插件 ${id} 的工作流 ${workflowId} 的 artifactType 必须是非空字符串`,
    );
    for (const [name, hook] of Object.entries(hooks)) {
      if (name === "artifactType") continue;
      check(
        typeof hook === "function",
        "PLUGIN_SPEC",
        `插件 ${id} 的工作流 ${workflowId} 的 ${name} 必须是函数`,
      );
    }
    normalizedWorkflows[workflowId] = Object.freeze({ ...hooks });
  }

  // Task contexts: structured context a plugin page attaches to a question
  // (for example a follow-up record). The plugin owns the guidance text; the
  // client only picks the kind and supplies data. Kinds are namespaced by the
  // plugin id so they cannot shadow core kinds.
  check(isObject(contexts), "PLUGIN_SPEC", `插件 ${id} 的 contexts 必须是对象`);
  const normalizedContexts = {};
  for (const [kind, hooks] of Object.entries(contexts)) {
    check(
      /^[a-z][a-z0-9-]{1,47}$/.test(kind) && kind.startsWith(`${id}-`),
      "PLUGIN_SPEC",
      `插件 ${id} 的任务上下文 ${kind} 必须以 ${id}- 开头`,
    );
    check(isObject(hooks), "PLUGIN_SPEC", `插件 ${id} 的任务上下文 ${kind} 必须是对象`);
    check(typeof hooks.guidance === "function", "PLUGIN_SPEC", `插件 ${id} 的任务上下文 ${kind} 缺少 guidance`);
    check(hooks.validate === undefined || typeof hooks.validate === "function", "PLUGIN_SPEC", `插件 ${id} 的任务上下文 ${kind} 的 validate 必须是函数`);
    check(hooks.workflow === undefined || (typeof hooks.workflow === "string" && PLUGIN_ID.test(hooks.workflow)), "PLUGIN_SPEC", `插件 ${id} 的任务上下文 ${kind} 的 workflow 无效`);
    check(hooks.sticky === undefined || typeof hooks.sticky === "boolean", "PLUGIN_SPEC", `插件 ${id} 的任务上下文 ${kind} 的 sticky 必须是布尔值`);
    for (const name of Object.keys(hooks))
      check(["guidance", "validate", "workflow", "sticky"].includes(name), "PLUGIN_SPEC", `插件 ${id} 的任务上下文 ${kind} 含未知字段 ${name}`);
    normalizedContexts[kind] = Object.freeze({ ...hooks });
  }

  check(isObject(events), "PLUGIN_SPEC", `插件 ${id} 的 events 必须是对象`);
  for (const [name, listener] of Object.entries(events))
    check(
      typeof listener === "function",
      "PLUGIN_SPEC",
      `插件 ${id} 的事件 ${name} 必须是函数`,
    );

  // Transactional hooks are deliberately separate from events: an event
  // listener failure is logged and isolated, while a hook failure propagates
  // to the caller so the surrounding SQLite transaction can roll back.
  check(isObject(hooks), "PLUGIN_SPEC", `插件 ${id} 的 hooks 必须是对象`);
  for (const [name, hook] of Object.entries(hooks))
    check(
      typeof hook === "function",
      "PLUGIN_SPEC",
      `插件 ${id} 的 hook ${name} 必须是函数`,
    );

  let normalizedDemo;
  if (demo !== undefined) {
    check(isObject(demo), "PLUGIN_SPEC", `插件 ${id} 的 demo 必须是对象`);
    const allowed = new Set(["install", "clear", "exists"]);
    for (const [name, hook] of Object.entries(demo)) {
      check(allowed.has(name), "PLUGIN_SPEC", `插件 ${id} 的 demo 含未知钩子 ${name}`);
      check(
        hook === undefined || typeof hook === "function",
        "PLUGIN_SPEC",
        `插件 ${id} 的 demo.${name} 必须是函数`,
      );
    }
    normalizedDemo = Object.freeze({
      install: demo.install,
      clear: demo.clear,
      exists: demo.exists,
    });
  }

  const normalizeApiPath = (value, index) => {
    check(
      typeof value === "string" && value.startsWith("/api/") && !/[?#]/.test(value),
      "PLUGIN_SPEC",
      `插件 ${id} 的 legacyApiPaths[${index}].path 必须是以 /api/ 开头的路径`,
    );
    const segments = value.slice(5).split("/");
    check(
      segments.length > 0 &&
        segments.every((segment) => segment && API_SEGMENT.test(segment)),
      "PLUGIN_SPEC",
      `插件 ${id} 的 legacyApiPaths[${index}].path 含非法片段`,
    );
    const wildcard = segments.indexOf("*");
    check(
      wildcard === -1 || wildcard === segments.length - 1,
      "PLUGIN_SPEC",
      `插件 ${id} 的 legacyApiPaths[${index}].path 中 * 只能位于末尾`,
    );
    return value;
  };

  check(
    Array.isArray(legacyApiPaths),
    "PLUGIN_SPEC",
    `插件 ${id} 的 legacyApiPaths 必须是数组`,
  );
  const normalizedApiPaths = [];
  const seenApiPaths = new Set();
  legacyApiPaths.forEach((entry, index) => {
    check(
      isObject(entry),
      "PLUGIN_SPEC",
      `插件 ${id} 的 legacyApiPaths[${index}] 必须是对象`,
    );
    const method = String(entry.method || "GET").toUpperCase();
    check(
      HTTP_METHOD.test(method),
      "PLUGIN_SPEC",
      `插件 ${id} 的 legacyApiPaths[${index}].method 无效`,
    );
    const path = normalizeApiPath(entry.path, index);
    const key = `${method} ${path}`;
    if (seenApiPaths.has(key)) return;
    seenApiPaths.add(key);
    normalizedApiPaths.push(Object.freeze({ method, path }));
  });

  let normalizedLifecycle;
  if (lifecycle !== undefined) {
    check(
      isObject(lifecycle),
      "PLUGIN_SPEC",
      `插件 ${id} 的 lifecycle 必须是对象`,
    );
    // definePlugin is intentionally idempotent: the host re-validates the
    // object a plugin module already normalized. Undefined hooks are omitted
    // rather than rejected so that second pass is lossless.
    const hooks = {};
    for (const [name, hook] of Object.entries(lifecycle)) {
      check(
        ["start", "stop", "drain"].includes(name),
        "PLUGIN_SPEC",
        `插件 ${id} 的 lifecycle 含未知钩子 ${name}`,
      );
      check(
        hook === undefined || typeof hook === "function",
        "PLUGIN_SPEC",
        `插件 ${id} 的 lifecycle.${name} 必须是函数`,
      );
      if (typeof hook === "function") hooks[name] = hook;
    }
    normalizedLifecycle = Object.freeze(hooks);
  }

  let normalizedActivation;
  if (activation !== undefined) {
    check(
      isObject(activation),
      "PLUGIN_SPEC",
      `插件 ${id} 的 activation 必须是对象`,
    );
    check(
      activation.requiresConnection === undefined ||
        typeof activation.requiresConnection === "boolean",
      "PLUGIN_SPEC",
      `插件 ${id} 的 activation.requiresConnection 必须是布尔值`,
    );
    normalizedActivation = Object.freeze({
      requiresConnection: activation.requiresConnection === true,
    });
  }

  let normalizedProvides;
  if (provides !== undefined) {
    check(
      isObject(provides) &&
        typeof provides.service === "string" &&
        PLUGIN_ID.test(provides.service),
      "PLUGIN_SPEC",
      `插件 ${id} 的 provides.service 必须匹配 /^[a-z][a-z0-9-]{1,39}$/`,
    );
    const apiVersion = provides.apiVersion ?? 1;
    check(
      Number.isInteger(apiVersion) && apiVersion > 0,
      "PLUGIN_SPEC",
      `插件 ${id} 的 provides.apiVersion 必须是正整数`,
    );
    normalizedProvides = Object.freeze({
      ...provides,
      service: provides.service,
      apiVersion,
    });
  }

  const normalizeCapabilities = (value, field) => {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) {
      check(
        value.every((item) => typeof item === "string" && item.trim()),
        "PLUGIN_SPEC",
        `插件 ${id} 的 ${field} 必须是非空字符串数组`,
      );
      return Object.freeze([...value]);
    }
    check(
      isObject(value),
      "PLUGIN_SPEC",
      `插件 ${id} 的 ${field} 必须是数组或对象`,
    );
    return Object.freeze({ ...value });
  };
  const normalizedCapabilities = normalizeCapabilities(
    capabilities,
    "capabilities",
  );

  return Object.freeze({
    id,
    version,
    title,
    requires: Object.freeze({
      plugins: Object.freeze({ ...requiredPlugins }),
      anyOf: Object.freeze(anyOf.map((group) => Object.freeze([...group]))),
    }),
    enabledByDefault,
    keepEnabledOnUpgrade,
    migrations,
    tablePrefix,
    legacyTables: Object.freeze([...legacyTables]),
    setup,
    tools,
    prompt,
    promptWhen,
    skills,
    proposals: Object.freeze(normalizedProposals),
    legacyProposalTypes: Object.freeze(normalizedLegacyProposals),
    agendaSources: Object.freeze(normalizedSources),
    workflows: Object.freeze(normalizedWorkflows),
    contexts: Object.freeze(normalizedContexts),
    api,
    events: Object.freeze({ ...events }),
    hooks: Object.freeze({ ...hooks }),
    patientSummary,
    patientBrief,
    demo: normalizedDemo,
    legacyApiPaths: Object.freeze(normalizedApiPaths),
    lifecycle: normalizedLifecycle,
    provides: normalizedProvides,
    activation: normalizedActivation,
    status,
    capabilities: normalizedCapabilities,
  });
}
