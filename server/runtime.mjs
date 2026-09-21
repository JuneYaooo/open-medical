import { providerConfigured } from "./core/provider-status.mjs";
import { randomUUID, createHash } from "node:crypto";
import { MedicalDomain } from "./domains/medical.mjs";
import { AppError, check, string, identifier } from "./errors.mjs";
import { MedicalSandbox } from "./sandbox.mjs";
import {
  MedicalSubagents,
  MEDICAL_AGENTS,
  ORCHESTRATION_TOOLS,
} from "./subagents.mjs";
import { PermissionEngine } from "./core/permissions.mjs";
import { AgentRuntime } from "./core/agent-runtime.mjs";
import { ToolRegistry } from "./core/tool-registry.mjs";
import { compactContext } from "./core/context-manager.mjs";
import {
  assertRunTransition,
  deriveRunStatus,
  waitingReasonFor,
} from "./core/run-status.mjs";
import { artifactEvidence, receiptEvidence } from "./core/delivery.mjs";

const {
  system: SYSTEM,
  policy: medicalPolicy,
  sourcesFor,
  runTool,
  localWork,
  toolDefinitions: TOOL_DEFINITIONS,
} = MedicalDomain;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const iso = () => new Date().toISOString();
// 咨询问答在本地规则模式下的降级回答：内置指标速查 + 模式引导，而不是工作流草稿。
export const consultationNotice = (result) => {
  const entries = (result?.entries || []).slice(0, 4);
  return [
    "这是一条咨询提问。当前为本地规则模式（不调用模型），只能给出内置检验指标速查，无法针对具体情况解答：",
    ...entries.map(
      (e) =>
        `· ${e.name}（参考范围 ${e.ref} ${e.unit}）升高：${e.high}；降低：${e.low}`,
    ),
    ...(entries.length ? [] : ["内置速查未覆盖这个问题。"]),
    "配置模型密钥并把运行方式切换为「智能模式」后重新发送，即可获得针对具体情况的解答。出现胸痛、呼吸困难、意识改变等急症表现时，请立即就医。",
    result?.note || "",
  ]
    .filter(Boolean)
    .join("\n");
};
// Compaction and oversized tool results are archived verbatim; the model
// pages the original text back through this tool. Execution is wired to the
// session scope in the registry (not runTool), like delegate/sandbox.
const ARCHIVE_TOOL = {
  type: "function",
  function: {
    name: "read_context_archive",
    description:
      "按字符范围读取被压缩或归档的会话历史/大型工具结果原文（压缩摘要与归档提示中会给出 archiveId）。只能读取当前会话的归档。",
    parameters: {
      type: "object",
      properties: {
        archiveId: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 16000 },
      },
      required: ["archiveId"],
      additionalProperties: false,
    },
  },
};
export function publicSession(session) {
  const { runs, ...rest } = session;
  return {
    ...rest,
    // run.status 保留引擎原始取值（兼容旧客户端）；derivedStatus 是 §12
    // 目标状态的唯一派生结果（run-status.mjs），等待/受阻时附 waitingReason。
    runs: runs.map(({ providerMessages: _providerMessages, ...run }) => {
      const waitingReason = waitingReasonFor(run);
      return {
        ...run,
        derivedStatus: deriveRunStatus(run),
        ...(waitingReason ? { waitingReason } : {}),
      };
    }),
  };
}
export class MedicalRuntime {
  constructor(
    store,
    provider,
    {
      maxRounds = Infinity,
      maxContextChars = 80000,
      maxToolCalls = 8,
      maxActive = 3,
      skills = null,
      toolPlugins = [],
      doctor = null,
      sandbox,
    } = {},
  ) {
    this.store = store;
    this.provider = provider;
    this.maxRounds = maxRounds;
    this.maxContextChars = maxContextChars;
    this.maxToolCalls = maxToolCalls;
    this.maxActive = maxActive;
    this.active = new Map();
    this.agent = new AgentRuntime({
      provider,
      maxRounds,
      maxContextChars,
      maxToolCalls,
    });
    this.skills = skills;
    this.sandbox = sandbox || new MedicalSandbox();
    this.subagents = new MedicalSubagents({ provider, skills, system: SYSTEM });
    this.doctor = doctor;
    this.toolPlugins = new Map();
    for (const plugin of toolPlugins) {
      check(
        plugin?.definition?.function?.name &&
          typeof plugin.execute === "function",
        "PLUGIN_CONFIG",
        "医疗工具插件定义无效",
      );
      const name = plugin.definition.function.name;
      check(
        !this.toolPlugins.has(name) &&
          ![...TOOL_DEFINITIONS, ...ORCHESTRATION_TOOLS].some(
            (d) => d.function.name === name,
          ),
        "PLUGIN_CONFIG",
        `医疗工具名称重复：${name}`,
      );
      this.toolPlugins.set(name, plugin);
    }
    this.toolDefinitions = [
      ...TOOL_DEFINITIONS,
      ...ORCHESTRATION_TOOLS.filter(
        (t) =>
          t.function.name !== "sandbox_python" ||
          this.sandbox.status().available,
      ),
      ARCHIVE_TOOL,
      ...[...this.toolPlugins.values()].map((p) => p.definition),
    ];
  }
  // Late registration for plugins that need services constructed after the
  // runtime (e.g. write-back proposals depending on patients/followups).
  registerPlugins(plugins) {
    for (const plugin of plugins) {
      check(
        plugin?.definition?.function?.name && typeof plugin.execute === "function",
        "PLUGIN_CONFIG",
        "医疗工具插件定义无效",
      );
      const name = plugin.definition.function.name;
      check(
        !this.toolPlugins.has(name),
        "PLUGIN_CONFIG",
        `医疗工具名称重复：${name}`,
      );
      this.toolPlugins.set(name, plugin);
      this.toolDefinitions.push(plugin.definition);
    }
  }
  prepare(sessionId, body) {
    identifier(sessionId);
    const session = this.store.get(sessionId);
    check(body && typeof body === "object", "INVALID_INPUT", "请求必须为对象");
    check(
      session.kind !== "general",
      "DOMAIN_MISMATCH",
      "通用工作区请使用通用运行接口",
      403,
    );
    const message = string(body.message, "消息", 20000);
    check(
      !this.active.has(sessionId),
      "RUN_ACTIVE",
      "当前会话正在执行，请先停止或等待完成",
      409,
    );
    check(
      this.active.size < this.maxActive,
      "CAPACITY",
      "并行任务达到上限，请稍后再试",
      429,
    );
    if (body.sessionRevision !== undefined)
      check(
        body.sessionRevision === session.revision,
        "REVISION_CONFLICT",
        "会话资料已更新，请刷新核对后再发送",
        409,
      );
    if (body.model !== undefined) string(body.model, "模型名称", 100);
    if (body.thinking !== undefined)
      check(
        ["enabled", "disabled"].includes(body.thinking),
        "INVALID_INPUT",
        "思考档无效",
      );
    const requestId = identifier(body.requestId || randomUUID());
    check(
      !session.runs.some((r) => r.requestId === requestId),
      "DUPLICATE_REQUEST",
      "这次请求已经提交，请刷新查看结果",
      409,
    );
    const fileIds = body.fileIds || [];
    check(
      Array.isArray(fileIds) &&
        fileIds.length <= 100 &&
        fileIds.every((id) => typeof id === "string") &&
        new Set(fileIds).size === fileIds.length,
      "INVALID_INPUT",
      "最多选择 100 个材料",
    );
    const files = fileIds.map((id) => {
      const f = session.files.find((f) => f.id === id);
      check(f, "SOURCE_NOT_FOUND", "材料不属于当前会话", 404);
      return f;
    });
    const requestedMode = body.mode || "local";
    check(
      ["local", "model", "standard", "minimal", "creator", "code"].includes(
        requestedMode,
      ),
      "INVALID_INPUT",
      "运行方式无效",
    );
    // Keep the old local/model protocol while exposing Harness-style single-user
    // modes. The medical runtime remains the authority over every capability.
    const mode = ["standard", "creator", "minimal"].includes(requestedMode)
      ? "model"
      : requestedMode === "code"
        ? "local"
        : requestedMode;
    const modeProfile = {
      requested: requestedMode,
      tools: !["minimal", "code"].includes(requestedMode),
      sandbox: requestedMode === "code",
    };
    const permissions = new PermissionEngine({
      grants: MedicalDomain.permissionGrants(requestedMode),
      profile:
        requestedMode === "minimal"
          ? "minimal"
          : requestedMode === "code"
            ? "code"
            : requestedMode === "creator"
              ? "creator"
              : "standard",
    });
    const delegations = body.delegations || [];
    check(
      Array.isArray(delegations) &&
        delegations.length <= 3 &&
        new Set(delegations).size === delegations.length &&
        delegations.every((p) => Object.hasOwn(MEDICAL_AGENTS, p)),
      "AGENT_PROFILE",
      "请选择最多 3 个不同医疗子代理",
    );
    // 用户以 @ 明确固定的技能；未指定时由模型在 SYSTEM 引导下自动路由。
    const pinnedSkills = body.skills || [];
    check(
      Array.isArray(pinnedSkills) &&
        pinnedSkills.length <= 3 &&
        new Set(pinnedSkills).size === pinnedSkills.length &&
        pinnedSkills.every((s) => typeof s === "string"),
      "INVALID_INPUT",
      "最多固定 3 个技能",
    );
    if (pinnedSkills.length) {
      check(
        this.skills,
        "SKILL_NOT_CONFIGURED",
        "技能注册表未配置",
        503,
      );
      const known = new Set(this.skills.list().map((s) => s.id));
      check(
        pinnedSkills.every((id) => known.has(id)),
        "SKILL_NOT_FOUND",
        "指定的技能不存在",
        400,
      );
    }
    if (body.sandboxCode !== undefined || requestedMode === "code") {
      check(
        body.sandboxCode !== undefined,
        "INVALID_INPUT",
        "代码模式需要提供受控沙箱代码",
      );
      string(body.sandboxCode, "Python 代码", 12000);
      check(
        mode === "local" && !delegations.length,
        "INVALID_INPUT",
        "手动沙箱任务使用本地方式，不同时委派子代理",
      );
      check(
        this.sandbox.status().available,
        "SANDBOX_UNAVAILABLE",
        this.sandbox.status().reason,
        503,
      );
    }
    check(
      modeProfile.tools || delegations.length === 0,
      "MODE_TOOL_DENIED",
      "当前运行模式不允许委派工具任务",
      403,
    );
    const policy = medicalPolicy(message);
    if (mode === "model") {
      check(
        providerConfigured(this.provider),
        "MODEL_NOT_CONFIGURED",
        "服务端尚未配置模型密钥；可以选择本地整理",
        503,
      );
      check(
        body.externalConsent === true,
        "CONSENT_REQUIRED",
        "请先确认本次输入和选中材料可以原文发送给所配置的模型服务",
        412,
      );
    }
    const user = {
      id: randomUUID(),
      role: "user",
      content: message,
      createdAt: iso(),
      fileIds,
    };
    const sources = sourcesFor({ ...session, files }, user);
    const run = {
      id: randomUUID(),
      requestId,
      status: "running",
      startedAt: iso(),
      endedAt: null,
      partial: "",
      events: [],
      artifacts: [],
      policy,
      mode,
      modeProfile,
      permissions: permissions.snapshot(),
      fileIds,
      ...(pinnedSkills.length ? { skills: pinnedSkills } : {}),
      sourceHashes: sources.map((s) => ({ id: s.id, hash: s.hash })),
      usage: null,
      error: null,
      children: [],
      ...(body.sandboxCode !== undefined
        ? { sandboxCode: body.sandboxCode }
        : {}),
    };
    const handle = {
      sessionId,
      run,
      user,
      sources,
      body: {
        model: body.model,
        delegations,
        skills: pinnedSkills,
        sandboxCode: body.sandboxCode,
        modeProfile,
        isolatedContext: body.isolatedContext === true,
      },
      delegatedCount: 0,
      controller: new AbortController(),
    };
    this.active.set(sessionId, handle);
    try {
      this.store.mutate(sessionId, (s) => {
        s.runs.push(run);
        s.messages.push({ ...user, runId: run.id });
        if (s.title === "新的医疗工作") s.title = message.slice(0, 32);
      });
      this.store.audit(sessionId, "run.started", {
        runId: run.id,
        mode,
        intent: policy.intent,
        skills: pinnedSkills,
        externalConsent: mode === "model" && body.externalConsent === true,
      });
      return handle;
    } catch (e) {
      this.active.delete(sessionId);
      throw e;
    }
  }
  cancel(sessionId) {
    const handle = this.active.get(sessionId);
    if (handle)
      handle.controller.abort(new AppError("CANCELLED", "执行已停止", 409));
    return Boolean(handle);
  }
  async execute(handle, notify = () => {}) {
    const { sessionId, run, user, sources, controller } = handle;
    const permissions = new PermissionEngine(run.permissions);
    let seq = 0;
    let text = "";
    let lastPersist = 0,
      persistedLength = 0;
    const artifacts = [];
    // W5 交付事实：仅记录运行时已发生的回执（沙箱/子代理），供交付钩子
    // 在完成点核对；不推断、不采信模型的自述。
    let sandboxReceipt = null;
    const delegatedReceipts = [];
    const emit = (type, payload = {}) => {
      const event = {
        seq: ++seq,
        type,
        session_id: sessionId,
        run_id: run.id,
        payload,
        time: iso(),
      };
      if (type === "message.delta") text += payload.text || "";
      this.store.appendEvent(event);
      const checkpoint =
        type !== "message.delta" ||
        Date.now() - lastPersist >= 200 ||
        text.length - persistedLength >= 2048;
      if (checkpoint)
        this.store.mutate(sessionId, (s) => {
          const saved = s.runs.find((r) => r.id === run.id);
          saved.partial = text;
          if (type !== "message.delta") {
            saved.events.push(event);
            saved.events = saved.events.slice(-200);
          }
        });
      if (checkpoint) {
        lastPersist = Date.now();
        persistedLength = text.length;
      }
      try {
        notify(event);
      } catch {
        /* disconnected transport does not lose durable state */
      }
    };
    const childEvent = (type, payload) => {
      this.store.mutate(sessionId, (s) => {
        const saved = s.runs.find((r) => r.id === run.id);
        saved.children ||= [];
        const index = saved.children.findIndex(
          (c) => c.id === payload.child.id,
        );
        if (index < 0) saved.children.push(payload.child);
        else saved.children[index] = payload.child;
      });
      emit(type, payload);
    };
    const delegate = async (profile, task, selected = sources) => {
      permissions.require("agents.delegate");
      check(
        handle.delegatedCount < 3,
        "AGENT_BUDGET",
        "父任务最多委派 3 个子代理",
        422,
      );
      handle.delegatedCount++;
      const child = await this.subagents.run({
        profile,
        task,
        sources: selected,
        mode: run.mode,
        model: handle.body.model || this.provider.model,
        signal: controller.signal,
        onEvent: childEvent,
      });
      // N4(复核 R4):回执记录真实状态;失败子任务回执仅作诊断,
      // 绝不在完成点被当作成功证据。
      delegatedReceipts.push({
        childId: child.id,
        status: child.status,
        ok: child.status === "completed",
        artifactCount: (child.artifacts || []).length,
        error: child.error || null,
      });
      if (child.status === "completed") artifacts.push(...child.artifacts);
      if (child.usage?.total_tokens) {
        run.usage ||= {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          rounds: 0,
        };
        run.usage.total_tokens += child.usage.total_tokens;
        run.usage.subagent_tokens =
          (run.usage.subagent_tokens || 0) + child.usage.total_tokens;
      }
      return child;
    };
    const sandboxRun = async (code) => {
      permissions.require("sandbox.execute");
      emit("sandbox.started", {
        backend: this.sandbox.status().backend,
        code,
        sourceIds: sources.map((s) => s.id),
      });
      try {
        const output = await this.sandbox.run({
          code,
          sources,
          signal: controller.signal,
        });
        sandboxReceipt = { backend: output.backend, completed: true };
        emit("sandbox.completed", { backend: output.backend });
        return output;
      } catch (error) {
        emit("sandbox.failed", {
          code: error.code || "INTERNAL",
          error: error instanceof AppError ? error.message : "沙箱执行失败",
        });
        throw error;
      }
    };
    try {
      emit("message.start", {
        provider: run.mode === "local" ? "local" : this.provider.model,
      });
      emit("policy.evaluated", run.policy);
      controller.signal.throwIfAborted();
      // 模型循环返回的交付核对结果（无钩子/纯问答时保持 null）。
      let delivery = null;
      if (handle.body.sandboxCode !== undefined) {
        const output = await sandboxRun(handle.body.sandboxCode);
        emit("message.delta", {
          text: `沙箱计算结果（待复核）：\n${JSON.stringify(output.result, null, 2)}`,
        });
      } else if (handle.body.delegations.length) {
        const children = await Promise.all(
          handle.body.delegations.map((profile) =>
            delegate(profile, user.content),
          ),
        );
        check(
          children.every((child) => child.status === "completed"),
          "SUBAGENT_FAILED",
          "部分子代理未完成，请查看子代理记录；本次联合结果未标记完成",
          422,
        );
        emit("message.delta", {
          text: children
            .map((child) => `${child.name}：${child.text}`)
            .join("\n\n"),
        });
      } else if (run.mode === "local") {
        const work = localWork(run.policy, sources);
        const known = this.toolDefinitions.some(
          (d) => d.function.name === work.tool,
        );
        const result = known
          ? await runTool(work.tool, work.args, {
              sources,
              skills: this.skills,
              definitions: this.toolDefinitions,
              plugins: this.toolPlugins,
            })
          : null;
        if (result) {
          emit("tool.start", { tool: work.tool, call_id: randomUUID() });
          if (result.id) {
            result.provenance = "local_rule";
            artifacts.push(result);
          }
          emit("tool.complete", { tool: work.tool, artifact: result });
        }
        const message =
          result?.type === "observations"
            ? `已摘录 ${result.observations.length} 个原文检验数值，保留单位和来源，未进行异常判断。`
            : result?.type === "clinical_timeline"
              ? `已从本次材料中识别 ${result.events.length} 条带日期的原文事件。请在右侧逐项核对来源后复核。没有完整日期的内容未被推断。`
              : result?.type === "medication_review"
                ? `已生成用药资料核对表，列出 ${result.missing.length} 类待补充信息。这是资料检查，尚未执行药理、剂量或相互作用核查。`
                : result?.type === "evidence_plan"
                  ? "已创建循证任务的 PICO 草稿和检索步骤。尚未联网检索；请在产物中补充人群、干预、对照和结局。"
                  : run.policy.intent === "consultation"
                    ? consultationNotice(result)
                    : "已生成可编辑的医疗工作流程草稿。请检查材料范围与人工复核要求。";
        emit("message.delta", { text: message });
      } else {
        let state = this.store.get(sessionId);
        const previous = state.runs
          .filter(
            (r) =>
              !handle.body.isolatedContext &&
              r.id !== run.id &&
              r.status === "completed" &&
              r.mode === "model" &&
              (r.fileIds || []).every((id) => run.fileIds.includes(id)),
          )
          .flatMap((r) => r.providerMessages || []);
        // Retrieval replaces wholesale stuffing: a large selection ships
        // name/size only; the model pulls fragments via search/read tools.
        const manifest = sources.map((s) => ({
          id: s.id,
          name: s.name,
          lines: s.text.split("\n").length,
          hash: s.hash,
          ...(sources.length <= 8 ? { preview: s.text.slice(0, 1000) } : {}),
        }));
        const messages = [
          {
            role: "system",
            content: [
              SYSTEM,
              this.doctor?.digest(),
              `可用技能：${JSON.stringify(this.skills?.list() || [])}`,
              ...(handle.body.skills?.length
                ? [
                    `用户通过 @ 明确固定了技能：${JSON.stringify(handle.body.skills)}。先 read_skill 阅读这些技能并按其执行，无需再自行选择模板。`,
                  ]
                : []),
              "可将时间线、检验摘录、用药资料检查委派给独立子代理。沙箱只用于资料计算，计算结果不能自动确认临床结论。",
              "选中材料已建立可检索索引：语义检索用 semantic_material_search，关键词检索用 search_materials，按行读原文用 read_source。检索工具未返回不代表材料中没有相关内容。",
              "当上下文被压缩时，摘要中会给出 archiveId，用 read_context_archive 分段取回原文。",
              `策略：${JSON.stringify(run.policy)}`,
              `本次材料索引（可用工具读取全文）：${JSON.stringify(manifest)}`,
            ]
              .filter(Boolean)
              .join("\n"),
          },
          ...previous,
          { role: "user", content: user.content },
        ];
        const start = messages.length - 1;
        const registry = new ToolRegistry(
          this.toolDefinitions.map((definition) => ({
            definition,
            permission:
              definition.function.name === "sandbox_python"
                ? "sandbox.execute"
                : definition.function.name === "delegate_medical_task"
                  ? "agents.delegate"
                  : "tools.execute",
            execute: async (args) => {
              const name = definition.function.name;
              let output;
              if (name === "delegate_medical_task") {
                check(
                  args &&
                    Object.keys(args).every((k) =>
                      ["profile", "task", "sourceIds"].includes(k),
                    ) &&
                    Array.isArray(args.sourceIds) &&
                    args.sourceIds.length <= sources.length &&
                    new Set(args.sourceIds).size === args.sourceIds.length,
                  "INVALID_TOOL_ARGS",
                  "子代理参数无效",
                );
                const selected = args.sourceIds.map((id) => {
                  const source = sources.find((s) => s.id === id);
                  check(
                    source,
                    "SOURCE_NOT_FOUND",
                    "子代理只能读取父任务中的资料",
                    403,
                  );
                  return source;
                });
                const child = await delegate(args.profile, args.task, selected);
                output = {
                  childId: child.id,
                  status: child.status,
                  text: child.text,
                  artifacts: child.artifacts,
                  error: child.error,
                };
              } else if (name === "sandbox_python") {
                check(
                  args &&
                    Object.keys(args).length === 1 &&
                    Object.hasOwn(args, "code"),
                  "INVALID_TOOL_ARGS",
                  "沙箱只接受 code 参数",
                );
                output = await sandboxRun(args.code);
              } else if (name === "read_context_archive") {
                output = this.store.readArchive(
                  sessionId,
                  args?.archiveId,
                  args?.offset === undefined ? 0 : args.offset,
                  args?.limit === undefined ? 8000 : args.limit,
                );
              } else
                output = await runTool(name, args, {
                  sources,
                  skills: this.skills,
                  definitions: this.toolDefinitions,
                  plugins: this.toolPlugins,
                });
              return output;
            },
          })),
        );
        const addUsage = (usage) => {
          run.usage ||= {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            rounds: 0,
          };
          for (const key of [
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
          ]) {
            if (Number.isFinite(usage[key]) && usage[key] >= 0)
              run.usage[key] += usage[key];
          }
          run.usage.rounds++;
        };
        const archiveFor = (data) => this.store.archive(sessionId, run.id, data);
        // N4 交付验证钩子(复核 R4 重写):与 N3 共用结果语义(delivery/
        // normalizeDelivery),只做领域事实收集。
        // - 纯咨询(consultation)是回答型任务:检索/沙箱回执只是过程,
        //   返回 null 保持 answered 语义,不因发生过副作用就宣称交付。
        // - 执行类意图:delivered 必须“有通过结构核对的本 run 产物”且无
        //   未解决缺口;沙箱成功只证明动作成功,不能抵消缺失产物;失败
        //   子任务回执进入缺口(诊断),不进证据。
        // - 草稿 awaiting review:delivered 表示产物已核实存在且待复核,
        //   不代表医生已确认。
        // 结构化草稿的最小“按要求核对”:有 id、状态 draft,且除元数据键
        // 外带至少一个非空内容载荷(observations/events/content 等)。有
        // artifactId/hash 只证明对象存在,不证明内容满足任务——内容级核对
        // 由对应验证器/复核承担。
        const DRAFT_META_KEYS = new Set([
          "id", "type", "title", "status", "version",
          "createdAt", "updatedAt", "provenance",
        ]);
        const hasPayload = (value) => {
          if (typeof value === "string") return value.trim().length > 0;
          if (Array.isArray(value)) return value.length > 0;
          if (value && typeof value === "object") return Object.keys(value).length > 0;
          return false;
        };
        const isWellFormedDraft = (a) =>
          Boolean(
            a &&
              typeof a.id === "string" &&
              a.status === "draft" &&
              Object.entries(a).some(
                ([key, value]) => !DRAFT_META_KEYS.has(key) && hasPayload(value),
              ),
          );
        const onDelivery = () => {
          if (run.policy.intent === "consultation") return null;
          const validArtifacts = artifacts.filter(isWellFormedDraft);
          const brokenArtifacts = artifacts.filter((a) => !isWellFormedDraft(a));
          const okDelegations = delegatedReceipts.filter((r) => r.ok);
          const failedDelegations = delegatedReceipts.filter((r) => !r.ok);
          const sandboxOk = sandboxReceipt?.completed === true;
          const evidence = [];
          const gaps = [];
          for (const artifact of validArtifacts)
            evidence.push(artifactEvidence(artifact));
          for (const receipt of okDelegations)
            evidence.push(receiptEvidence("subagent", receipt));
          for (const artifact of brokenArtifacts)
            gaps.push({
              reason: "artifact_incomplete",
              detail: `结构化产物 ${artifact?.id || "(无id)"} 缺少必要内容/状态,未按目标核对通过`,
              artifactId: artifact?.id || null,
            });
          for (const receipt of failedDelegations)
            gaps.push({
              reason: "subagent_failed",
              detail: `子任务 ${receipt.childId} 状态 ${receipt.status},其失败回执仅作诊断,不构成成功证据`,
              childId: receipt.childId,
            });
          if (sandboxOk) evidence.push(receiptEvidence("sandbox", sandboxReceipt));
          if (sandboxOk && validArtifacts.length === 0 && okDelegations.length === 0)
            gaps.push({
              reason: "sandbox_without_deliverable",
              detail:
                "沙箱执行成功但没有可核对的交付产物;与目标无关的动作成功不能当作任务完成",
            });
          if (evidence.length === 0 && gaps.length === 0)
            gaps.push({
              reason: "no_verifiable_output",
              detail: `执行类任务(意图 ${run.policy.intent})结束时没有任何产物类工具结果或执行回执;模型的文字完成说明不构成交付证据。`,
            });
          // 子任务完成/沙箱成功都只证明动作发生过;没有可核对产物时父目标
          // 不视为完成(N4:子任务 completed 不自动代表父目标全部完成)。
          if (validArtifacts.length === 0 && gaps.length === 0)
            gaps.push({
              reason: "no_artifact_deliverable",
              detail:
                "存在执行回执但没有可核对的结构化产物;动作成功不等于父目标完成",
            });
          return {
            delivered: validArtifacts.length > 0 && gaps.length === 0,
            evidence,
            gaps,
            method: "runtime-facts",
            note: "delivered 表示本次运行产物已核实存在且待复核;不代表医生已确认或患者侧操作已生效。",
          };
        };
        const result = await this.agent.run({
          domain: MedicalDomain,
          messages,
          registry,
          permissions,
          signal: controller.signal,
          model: handle.body.model || this.provider.model,
          thinking: handle.body.thinking,
          emit,
          onUsage: addUsage,
          onDelivery,
          // 会话超过预算时自动压缩：保留最近对话，更早历史摘要化，原文
          // 归档后可经 read_context_archive 分段读回（同一预算约束）。
          compact: (compacting) =>
            compactContext({
              messages: compacting,
              provider: this.provider,
              model: handle.body.model || this.provider.model,
              maxChars: this.maxContextChars,
              signal: controller.signal,
              onUsage: addUsage,
              archive: archiveFor,
            }),
          // 超预算 35% 的单个工具结果整体归档，模型按需读回。
          offload: archiveFor,
          onToolResult: (output) => {
            // Consultation retrieval supplies context for the answer; it is
            // not a document draft requiring a separate review card.
            if (run.policy.intent === "consultation" && output?.type === "source_search") return;
            // readOnly 输出（技能正文、目录等）不是可复核产物，不进产物列表
            if (output?.id && !output.readOnly) {
              output.provenance =
                output.provenance === "local_rule"
                  ? "local_rule"
                  : "model_draft";
              artifacts.push(output);
            }
          },
        });
        // Keep reasoning/tool messages privately for DeepSeek continuation, not in UI.
        this.store.mutate(sessionId, (s) => {
          s.runs.find((r) => r.id === run.id).providerMessages =
            result.messages.slice(start);
        });
        delivery = result.delivery || null;
      }
      controller.signal.throwIfAborted();
      // N3/N4:结果分类统一——delivered(核实交付)/unverified(验证异常)/
      // delivery_failed(执行类缺口未解决)。执行类任务不再把未完成降格为
      // answered;answered 保留给本来就是回答的任务(delivery 为 null,
      // 由 intent=consultation 或纯问答产生)。
      const outcome = delivery
        ? delivery.delivered
          ? "delivered"
          : delivery.unverified
            ? "unverified"
            : "delivery_failed"
        : null;
      const assistant = {
        id: randomUUID(),
        runId: run.id,
        role: "assistant",
        content: text,
        createdAt: iso(),
        risk: run.policy.risk,
        // 咨询直答不产出草稿，前端据 intent 区分署名，避免一律标「工作草稿」
        intent: run.policy.intent,
        status: "completed",
        ...(outcome ? { outcome } : {}),
      };
      this.store.mutate(sessionId, (s) => {
        s.messages.push(assistant);
        s.artifacts.push(...artifacts);
        const saved = s.runs.find((r) => r.id === run.id);
        // 状态写入经单一转移守卫：非法转移直接失败并保留原状态，
        // 而不是把重启中断等记录悄悄改写成 completed。
        assertRunTransition(saved.status, "completed");
        Object.assign(saved, {
          status: "completed",
          partial: text,
          artifacts: artifacts.map((a) => a.id),
          usage: run.usage,
          endedAt: iso(),
          ...(delivery ? { delivery, outcome } : {}),
        });
      });
      this.store.audit(sessionId, "run.completed", {
        runId: run.id,
        artifactIds: artifacts.map((a) => a.id),
        ...(outcome ? { outcome } : {}),
      });
      emit("message.complete", {
        text,
        risk: run.policy.risk,
        artifacts,
        usage: run.usage,
        status: "completed",
        ...(delivery ? { delivery } : {}),
      });
      return {
        runId: run.id,
        text,
        artifacts,
        status: "completed",
        ...(delivery ? { delivery, outcome } : {}),
      };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const status = cancelled ? "cancelled" : "failed";
      const message = cancelled
        ? "执行已停止，已保留部分内容。"
        : error instanceof AppError
          ? error.message
          : error.name === "TimeoutError"
            ? "模型响应超时，保留的部分内容未标为完成。"
            : "执行失败，请检查服务配置后重试。";
      this.store.mutate(sessionId, (s) => {
        const saved = s.runs.find((r) => r.id === run.id);
        // 终态写入同样经单一转移守卫；同状态幂等重写放行。
        assertRunTransition(saved.status, status);
        Object.assign(saved, {
          status,
          error: message,
          partial: text,
          usage: run.usage,
          endedAt: iso(),
        });
      });
      this.store.audit(sessionId, `run.${status}`, {
        runId: run.id,
        code: cancelled ? "CANCELLED" : error.code || "INTERNAL",
      });
      emit(cancelled ? "run.cancelled" : "error", {
        status,
        error: message,
        code: cancelled ? "CANCELLED" : error.code || "INTERNAL",
      });
      return { runId: run.id, status, error: message };
    } finally {
      if (this.active.get(sessionId) === handle) this.active.delete(sessionId);
    }
  }
  copyMaterials(sessionId, body) {
    const source = this.store.get(sessionId);
    check(
      source.revision === body.sessionRevision,
      "REVISION_CONFLICT",
      "原会话资料已更新，请刷新核对",
      409,
    );
    check(
      Array.isArray(body.fileIds) &&
        body.fileIds.length > 0 &&
        body.fileIds.length <= 100 &&
        new Set(body.fileIds).size === body.fileIds.length,
      "INVALID_INPUT",
      "请选择 1–100 份要复制的材料",
    );
    const files = body.fileIds.map((id) => {
      const file = source.files.find((f) => f.id === id);
      check(file, "SOURCE_NOT_FOUND", "材料不属于当前会话", 404);
      return {
        ...file,
        id: randomUUID(),
        createdAt: iso(),
        copiedFrom: { sessionId, fileId: id },
      };
    });
    const session = this.store.create({
      title: source.title.slice(0, 70) + " · 材料副本",
      files,
      copiedFrom: { sessionId, revision: source.revision },
    });
    this.store.audit(session.id, "materials.copied", {
      sourceSessionId: sessionId,
      count: files.length,
    });
    return publicSession(session);
  }
  addFile(sessionId, body) {
    check(
      !this.active.has(sessionId),
      "RUN_ACTIVE",
      "执行期间不能变更材料",
      409,
    );
    const name = string(body.name, "文件名", 180);
    check(
      /\.(txt|md|csv|json|pdf)$/i.test(name),
      "FILE_TYPE",
      "当前支持 TXT、Markdown、CSV、JSON 和 PDF 抽取文本",
    );
    const raw = string(body.text, "文件内容", 400000);
    check(Buffer.byteLength(raw) <= 2000000, "FILE_SIZE", "文件超过 2MB");
    let extraction;
    if (/\.pdf$/i.test(name)) {
      const e = body.extraction;
      check(
        e?.type === "pdf_text" &&
          Number.isInteger(e.pageCount) &&
          e.pageCount > 0 &&
          e.pageCount <= 300 &&
          Array.isArray(e.emptyPages) &&
          e.emptyPages.length < e.pageCount &&
          e.emptyPages.every(
            (p) => Number.isInteger(p) && p >= 1 && p <= e.pageCount,
          ),
        "PDF_EXTRACTION",
        "请通过工作台的 PDF 文字抽取流程导入",
      );
      extraction = {
        type: "pdf_text",
        pageCount: e.pageCount,
        emptyPages: e.emptyPages,
        originalRetained: false,
      };
    }
    const file = {
      id: randomUUID(),
      name,
      text: raw,
      hash: hash(raw),
      createdAt: iso(),
      size: Buffer.byteLength(raw),
      ...(extraction ? { extraction } : {}),
    };
    const session = this.store.get(sessionId);
    check(session.files.length < 100, "FILE_LIMIT", "每个会话最多 100 份材料");
    check(
      !session.files.some((f) => f.hash === file.hash),
      "DUPLICATE_FILE",
      "相同内容已在本会话中",
      409,
    );
    this.store.mutate(sessionId, (s) => s.files.push(file));
    this.store.audit(sessionId, "file.added", {
      fileId: file.id,
      hash: file.hash,
    });
    return file;
  }
  review(sessionId, artifactId, body) {
    // 代号选填（交互规范 v2.1）：未填时记为"本机使用者"，保留审计但降低复核门槛。
    const reviewer = body.reviewer
      ? string(body.reviewer, "复核者代号", 80)
      : "本机使用者";
    const note = string(body.note, "复核说明", 3000);
    check(
      ["approved", "rejected"].includes(body.decision),
      "INVALID_INPUT",
      "复核决定无效",
    );
    check(
      body.attested === true,
      "REVIEW_REQUIRED",
      "请确认已检查原文和适用范围",
      412,
    );
    this.store.mutate(sessionId, (s) => {
      const a = s.artifacts.find((a) => a.id === artifactId);
      check(a, "NOT_FOUND", "产物不存在", 404);
      check(
        a.version === body.version,
        "REVISION_CONFLICT",
        "产物已改变，请刷新后复核",
        409,
      );
      a.status = body.decision;
      a.review = {
        reviewer,
        note,
        at: iso(),
        attestation: "local_user",
        reviewedVersion: a.version,
        decision: body.decision,
      };
      a.reviews ||= [];
      a.reviews.push(a.review);
      a.version++;
    });
    this.store.audit(sessionId, "artifact.reviewed", {
      artifactId,
      decision: body.decision,
      reviewer,
    });
    if (body.decision === "rejected" && note && this.doctor) {
      const saved = this.store
        .get(sessionId)
        .artifacts.find((a) => a.id === artifactId);
      if (saved)
        this.doctor.recordSignal({
          content: `复核拒绝${saved.type === "observations" ? "检验摘录" : saved.type === "clinical_timeline" ? "时间线" : saved.type === "medication_review" ? "用药核对" : "草稿"}：${note}`,
          topic: "复核反馈",
          source: { type: "review_rejected", sessionId, artifactId },
        });
    }
    return this.store.get(sessionId).artifacts.find((a) => a.id === artifactId);
  }

  editArtifact(sessionId, artifactId, body) {
    const title = string(body.title, "产物标题", 150);
    let changedNotes = [];
    this.store.mutate(sessionId, (s) => {
      const a = s.artifacts.find((a) => a.id === artifactId);
      check(a, "NOT_FOUND", "产物不存在", 404);
      check(
        a.version === body.version,
        "REVISION_CONFLICT",
        "产物版本已改变",
        409,
      );
      let events, items, pico;
      if (body.events !== undefined) {
        check(
          a.events &&
            Array.isArray(body.events) &&
            body.events.length === a.events.length,
          "INVALID_INPUT",
          "事件数量不可改变；请修订现有事件",
        );
        events = body.events.map((e, i) => {
          check(
            e &&
              Object.keys(e).every((k) =>
                ["date", "event", "correctionNote"].includes(k),
              ),
            "INVALID_INPUT",
            "不能替换原文来源",
          );
          const date = string(e.date, "事件日期", 20),
            event = string(e.event, "事件内容", 3000);
          check(
            /^\d{4}-\d{2}-\d{2}$/.test(date) &&
              !Number.isNaN(Date.parse(date)) &&
              new Date(date).toISOString().slice(0, 10) === date,
            "INVALID_INPUT",
            "请填写真实的 YYYY-MM-DD 日期",
          );
          const changed =
            date !== a.events[i].date || event !== a.events[i].event;
          const correctionNote = changed
            ? string(e.correctionNote, "修改依据", 1500)
            : a.events[i].correctionNote;
          if (changed && correctionNote) changedNotes.push(correctionNote);
          return {
            ...a.events[i],
            date,
            event,
            dateValid: true,
            needs_review: true,
            ...(correctionNote ? { correctionNote } : {}),
          };
        });
      }
      if (body.items !== undefined) {
        check(
          a.items &&
            Array.isArray(body.items) &&
            body.items.length > 0 &&
            body.items.length <= 40,
          "INVALID_INPUT",
          "请保留 1–40 条流程条目",
        );
        items = body.items.map((item) => string(item, "条目", 2000));
      }
      if (a.pico) {
        pico = {};
        for (const key of [
          "population",
          "intervention",
          "comparison",
          "outcome",
        ])
          pico[key] = string(body.pico?.[key], key, 300);
      }
      a.history ||= [];
      a.history.push({
        version: a.version,
        title: a.title,
        status: a.status,
        events: a.events,
        items: a.items,
        pico: a.pico,
        review: a.review,
        at: iso(),
      });
      a.title = title;
      a.version++;
      a.status = "draft";
      delete a.review;
      if (events) a.events = events;
      if (items) a.items = items;
      if (pico) {
        a.pico = pico;
        a.query = [pico.population, pico.intervention]
          .map((v) => '"' + v.replace(/"/g, " ") + '"')
          .join(" AND ");
        a.searchUrl = `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(a.query)}`;
      }
    });
    this.store.audit(sessionId, "artifact.edited", { artifactId });
    if (this.doctor && changedNotes.length)
      for (const note of changedNotes)
        this.doctor.recordSignal({
          content: `修订草稿时补充依据：${note}`,
          topic: "修订依据",
          source: { type: "artifact_edited", sessionId, artifactId },
        });
    return this.store.get(sessionId).artifacts.find((a) => a.id === artifactId);
  }
}
