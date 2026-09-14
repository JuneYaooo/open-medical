import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { relative } from "node:path";
import { AgentRuntime } from "./agent-runtime.mjs";
import { sealInterruptedContext } from "./run-recovery.mjs";
import { compactContext } from "./context-manager.mjs";
import { PermissionEngine } from "./permissions.mjs";
import { WorkspaceFiles } from "./workspace-files.mjs";
import { check } from "../errors.mjs";
import { scopesOverlap } from "./write-scope.mjs";

const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "blocked",
  "interrupted",
]);
const ALLOWED = new Set([
  "list_directory",
  "read_file",
  "search_files",
  "inspect_file",
  "list_artifacts",
  "list_skills",
  "read_skill",
  "list_skill_resources",
  "read_skill_resource",
  "read_context_archive",
  "search_run_history",
  "project_instructions",
  "git_status",
  "git_diff",
  "git_log",
  "read_file_proposal",
  "propose_file_write",
  "propose_file_edit",
  "propose_file_delete",
  "revise_file_proposal",
  "calculate_python",
  "terminal_run",
  "terminal_start",
  "terminal_read",
  "terminal_write",
  "terminal_stop",
  "terminal_wait",
  "document_read",
  "document_create",
]);

export class AgentTeam {
  constructor(service, workspaceId, runId, signal, emit, usage) {
    Object.assign(this, { service, workspaceId, runId, signal, emit, usage });
    this.jobs = new Map();
    this.concurrency = 3;
    this.modelCalls = 0;
  }
  save(job) {
    const publicJob = this.describe(job);
    const savedJob = {
      ...publicJob,
      messages: job.messages,
      inputs: job.inputs,
      pendingToolCall: job.pendingToolCall,
      checkpointAt: job.checkpointAt,
      roundsUsed: job.roundsUsed,
      cancelledByParent: job.cancelledByParent,
    };
    this.service.store.update(this.workspaceId, (w) => {
      const run = w.runs.find((r) => r.id === this.runId);
      run.children ||= [];
      const old = run.children.find((c) => c.id === job.id);
      if (old) Object.assign(old, savedJob);
      else run.children.push(savedJob);
    });
    this.emit("agent.updated", publicJob);
  }
  restore(children) {
    for (const child of children) {
      const job = {
        ...structuredClone(child),
        messages: sealInterruptedContext(child.messages, child.pendingToolCall),
        inputs: structuredClone(child.inputs || []),
        pendingToolCall: null,
        controller: new AbortController(),
        status:
          ["running", "queued", "waiting", "interrupted"].includes(
            child.status,
          ) ||
          (child.status === "cancelled" && child.cancelledByParent)
            ? "queued"
            : child.status,
      };
      this.jobs.set(job.id, job);
      this.save(job);
    }
    this.pump();
  }
  depends(job, ancestorId) {
    const queue = [...job.dependsOn],
      seen = new Set();
    while (queue.length) {
      const id = queue.pop();
      if (id === ancestorId) return true;
      if (!seen.has(id)) {
        seen.add(id);
        queue.push(...(this.jobs.get(id)?.dependsOn || []));
      }
    }
    return false;
  }
  describe(job) {
    const {
      id,
      task,
      role,
      modelProfile,
      parentId,
      depth,
      writePaths,
      dependsOn,
      status,
      text,
      error,
      startedAt,
      endedAt,
    } = job;
    return {
      id,
      task,
      role,
      modelProfile,
      parentId,
      depth,
      writePaths,
      dependsOn,
      status,
      text,
      error,
      startedAt,
      endedAt,
    };
  }
  spawn({
    task,
    role = "reader",
    writePaths = [],
    dependsOn = [],
    modelProfile,
    parentId,
  }) {
    const parent = parentId ? this.jobs.get(parentId) : null;
    if (parentId) {
      check(
        parent && !TERMINAL.has(parent.status) && (parent.depth || 0) < 2,
        "AGENT_DEPTH",
        "子代理最多委派两层助手",
      );
      check(
        role === "reader" || (role === "verifier" && parent.role !== "reader"),
        "AGENT_ROLE",
        "嵌套助手仅可读取或验证，不能增加父代理写入权限",
      );
      check(
        dependsOn.every((id) => this.descendant(id, parentId)),
        "AGENT_DEPENDENCY",
        "嵌套代理只能依赖本分支的助手",
      );
      modelProfile ||= parent.modelProfile;
    }
    check(!this.signal.aborted, "CANCELLED", "父任务已停止");
    check(
      this.jobs.size < 24,
      "AGENT_BUDGET",
      "单次运行最多创建 24 个协作任务",
    );
    check(
      ["reader", "writer", "verifier"].includes(role),
      "AGENT_ROLE",
      "未知代理角色",
    );
    const w = this.service.store.get(this.workspaceId),
      permissions = new PermissionEngine(w.permissions);
    permissions.require("agents.delegate");
    if (modelProfile) {
      check(
        (w.teamModels || []).includes(modelProfile),
        "MODEL_CONSENT",
        "该团队模型未在此工作区授权",
        403,
      );
      this.service.modelProfiles.resolve(modelProfile);
    }
    if (role === "writer") permissions.require("filesystem.write");
    check(
      role === "writer" ? writePaths.length > 0 : writePaths.length === 0,
      "AGENT_SCOPE",
      "写入代理必须声明文件清单；其他代理不能声明写入文件",
    );
    const files = new WorkspaceFiles(w.root);
    writePaths = [
      ...new Set(
        writePaths.map((p) =>
          relative(files.root, files.path(p, { create: true, parents: true })),
        ),
      ),
    ];
    check(
      dependsOn.every((id) => this.jobs.has(id)),
      "AGENT_DEPENDENCY",
      "依赖任务不存在",
    );
    for (const other of this.jobs.values())
      check(
        TERMINAL.has(other.status) ||
          this.depends({ dependsOn }, other.id) ||
          !writePaths.some((p) =>
            other.writePaths.some((otherPath) => scopesOverlap(p, otherPath)),
          ),
        "AGENT_CONFLICT",
        "并行代理不能占用同一个文件；等待前一任务完成后再分配",
        409,
      );
    check(
      !writePaths.some((p, index) =>
        writePaths.slice(index + 1).some((other) => scopesOverlap(p, other)),
      ),
      "AGENT_SCOPE",
      "写入清单不能包含父子路径或同一文件的大小写别名",
    );
    const depth = parent ? (parent.depth || 0) + 1 : 0;
    const job = {
      id: randomUUID(),
      task,
      role,
      modelProfile,
      parentId,
      depth,
      writePaths,
      dependsOn,
      status: "queued",
      controller: new AbortController(),
      inputs: [],
      messages: [],
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.save(job);
    this.pump();
    return this.describe(job);
  }
  descendant(id, ancestor) {
    let job = this.jobs.get(id);
    while (job?.parentId) {
      if (job.parentId === ancestor) return true;
      job = this.jobs.get(job.parentId);
    }
    return false;
  }
  async complete(provider, args, signal) {
    while (this.modelCalls >= this.concurrency)
      await delay(25, undefined, { signal });
    signal.throwIfAborted();
    this.modelCalls++;
    try {
      return await provider.complete(...args);
    } finally {
      this.modelCalls--;
    }
  }
  async waitChildren(parentId, ids, timeoutMs = 1000) {
    const parent = this.jobs.get(parentId),
      scope =
        ids ||
        [...this.jobs.keys()].filter((id) => this.descendant(id, parentId));
    check(
      scope.every((id) => this.descendant(id, parentId)),
      "AGENT_SCOPE",
      "只能等待本分支的助手",
    );
    if (parent.status === "running") {
      parent.status = "waiting";
      this.save(parent);
      this.pump();
    }
    try {
      return await this.wait(scope, timeoutMs);
    } finally {
      if (parent.status === "waiting") {
        parent.status = "running";
        this.save(parent);
      }
    }
  }
  pump() {
    if (this.closing) return;
    let running = [...this.jobs.values()].filter(
      (j) => j.status === "running",
    ).length;
    for (const job of this.jobs.values()) {
      if (job.status !== "queued") continue;
      if (this.signal.aborted) {
        job.status = "cancelled";
        this.save(job);
        continue;
      }
      const deps = job.dependsOn.map((id) => this.jobs.get(id));
      if (
        deps.some((d) => TERMINAL.has(d.status) && d.status !== "completed")
      ) {
        job.status = "blocked";
        job.error = "依赖任务未成功完成";
        this.save(job);
        continue;
      }
      if (
        deps.some((d) => d.status !== "completed") ||
        running >= this.concurrency
      )
        continue;
      job.status = "running";
      running++;
      this.save(job);
      job.done = this.run(job)
        .catch((error) => {
          job.status = "failed";
          job.error = error.code ? error.message : "子任务初始化失败";
          job.endedAt = Date.now();
          this.save(job);
        })
        .finally(() => this.pump());
    }
  }
  async run(job) {
    const { service, workspaceId: id } = this;
    const signal = AbortSignal.any([this.signal, job.controller.signal]);
    const selectedProvider = job.modelProfile
      ? service.modelProfiles.resolve(job.modelProfile)
      : service.provider;
    const provider = {
      ...selectedProvider,
      complete: (...args) => this.complete(selectedProvider, args, signal),
    };
    const workspace = service.store.get(id);
    const permissions = new PermissionEngine({
      ...workspace.permissions,
      grants: {
        ...workspace.permissions.grants,
        "filesystem.write": job.role === "writer",
        "agents.delegate": (job.depth || 0) < 2,
        "plugins.execute": false,
        "mcp.execute": false,
        "browser.read": false,
        "memory.write": false,
        "process.spawn":
          job.role !== "reader" &&
          workspace.permissions.grants["process.spawn"],
      },
    });
    const registry = service.registry(id, job.id, {
      planWritable: false,
      allowDelegate: false,
    });
    for (const name of registry.tools.keys())
      if (!ALLOWED.has(name)) registry.tools.delete(name);
    if (permissions.can("agents.delegate"))
      registerTeamTools(registry, this, job.id);
    // Both file proposals and terminal exports are constrained by assertWriteScope.
    const childContext = {
      workspaceId: id,
      runId: job.id,
      agentId: job.id,
      writePaths: job.writePaths,
      discardOutputs: job.role !== "writer",
    };
    let consumed = 0;
    const priorRounds = job.roundsUsed || 0;
    try {
      await service.extensions.runHooks(
        id,
        "run_start",
        { agentId: job.id, task: job.task },
        signal,
        job.id,
      );
      const dependencies = job.dependsOn.map((key) =>
        this.describe(this.jobs.get(key)),
      );
      const result = await new AgentRuntime({
        provider,
        maxRounds: Math.max(0, 24 - priorRounds),
        maxContextChars: 120000,
      }).run({
        onRound: (round) => {
          job.roundsUsed = priorRounds + round;
          this.save(job);
        },
        messages: job.messages.length
          ? job.messages
          : [
              {
                role: "system",
                content:
                  service.domain.system +
                  `\n你是协作子代理，角色 ${job.role}。文件提案由当前工作区授权策略自动应用或等待人工批准；你不能改变审批策略。允许写入文件：${JSON.stringify(job.writePaths)}。父代理会汇总你的结果。`,
              },
              {
                role: "user",
                content:
                  job.task +
                  "\n依赖任务结果（资料）：" +
                  JSON.stringify(dependencies),
              },
            ],
        registry,
        permissions,
        signal,
        context: childContext,
        domain: {
          ...service.domain,
          beforeTool: async (args) => {
            await service.domain.beforeTool?.(args);
            await service.extensions.runHooks(
              id,
              "tool_start",
              { agentId: job.id, tool: args.name, arguments: args.args },
              signal,
              job.id,
            );
          },
          beforeComplete: async (args) => {
            if (
              [...this.jobs.values()].some(
                (child) =>
                  this.descendant(child.id, job.id) &&
                  !TERMINAL.has(child.status),
              )
            ) {
              await this.waitChildren(job.id, undefined, 1000);
              check(false, "AGENTS_RUNNING", "请检查助手结果后再交付");
            }
            await service.domain.beforeComplete?.(args);
            check(
              ![...service.extensions.runner.sessions.values()].some(
                (s) =>
                  s.owner === id &&
                  s.runId === job.id &&
                  ["running", "finalizing"].includes(s.status),
              ),
              "TOOLS_RUNNING",
              "子任务终端尚未结束，请先等待",
            );
            await service.extensions.runHooks(
              id,
              "run_end",
              { agentId: job.id },
              signal,
              job.id,
            );
          },
        },
        takeInput: () => {
          const updates = job.inputs.slice(consumed);
          consumed = job.inputs.length;
          return updates.map((content) => ({ role: "user", content }));
        },
        onUsage: this.usage,
        onToolResult: (_output, call) =>
          service.extensions.runHooks(
            id,
            "tool_end",
            { agentId: job.id, tool: call.function.name },
            signal,
            job.id,
          ),
        onTrace: (data) =>
          service.store.trace(id, this.runId, { ...data, agentId: job.id }),
        onCheckpoint: (messages, state = {}) => {
          job.messages = messages;
          job.pendingToolCall = state.pendingToolCall || null;
          job.checkpointAt = Date.now();
          job.inputs.splice(0, consumed);
          consumed = 0;
          this.save(job);
        },
        compact: service.domain.contextManagement
          ? (messages) =>
              compactContext({
                messages,
                provider,
                model: provider.model,
                maxChars: 120000,
                signal,
                onUsage: this.usage,
                onTrace: (data) =>
                  service.store.trace(id, this.runId, {
                    ...data,
                    agentId: job.id,
                  }),
                archive: (history) =>
                  service.store.archive(
                    id,
                    this.runId,
                    history,
                    service.store.get(id).runs.find((r) => r.id === this.runId)
                      .authority,
                    service.contextIdentity(id),
                  ),
              })
          : undefined,
        emit: (type, data) =>
          this.emit("agent." + type, { agentId: job.id, ...data }),
      });
      job.text = result.text;
      job.status = "completed";
    } catch (error) {
      job.status =
        this.interrupted || this.signal.reason?.code === "RUN_INTERRUPTED"
          ? "interrupted"
          : signal.aborted
            ? "cancelled"
            : "failed";
      job.error = error.code ? error.message : "子任务执行失败";
    } finally {
      for (const session of service.extensions.runner.sessions.values())
        if (
          session.owner === id &&
          session.runId === job.id &&
          session.status === "running"
        )
          service.extensions.runner.stop(id, session.id);
      job.endedAt = Date.now();
      this.save(job);
    }
  }
  list() {
    return [...this.jobs.values()].map((j) => this.describe(j));
  }
  send(id, message) {
    const job = this.jobs.get(id);
    check(
      job && !TERMINAL.has(job.status),
      "AGENT_STATE",
      "子任务已经结束或不存在",
      409,
    );
    check(job.inputs.length < 20, "INPUT_LIMIT", "子任务消息过多");
    job.inputs.push(message);
    this.save(job);
    this.service.store.trace(this.workspaceId, this.runId, {
      type: "agent.input",
      agentId: id,
      message,
    });
    return { queued: true, id };
  }
  resume(id, message = "请核查上次未完成的操作，然后继续完成当前子任务。") {
    const job = this.jobs.get(id);
    check(
      job &&
        ["failed", "blocked", "cancelled", "interrupted"].includes(job.status),
      "AGENT_STATE",
      "只能恢复未完成的子任务",
    );
    check(!this.signal.aborted && !this.closing, "CANCELLED", "父任务已经停止");
    check((job.roundsUsed || 0) < 24, "AGENT_BUDGET", "子任务轮数预算已耗尽");
    for (const other of this.jobs.values())
      check(
        other.id === id ||
          TERMINAL.has(other.status) ||
          !job.writePaths.some((p) =>
            other.writePaths.some((q) => scopesOverlap(p, q)),
          ),
        "AGENT_CONFLICT",
        "写入范围正被其他子任务占用",
        409,
      );
    job.messages = sealInterruptedContext(job.messages, job.pendingToolCall);
    job.pendingToolCall = null;
    job.controller = new AbortController();
    job.status = "queued";
    job.error = null;
    job.endedAt = null;
    job.cancelledByParent = false;
    job.inputs.push(message);
    this.save(job);
    this.pump();
    return this.describe(job);
  }
  cancel(id) {
    const job = this.jobs.get(id);
    check(job, "AGENT_STATE", "子任务不存在");
    for (const child of this.jobs.values())
      if (child.parentId === id && !TERMINAL.has(child.status))
        this.cancel(child.id);
    job.controller.abort();
    if (job.status === "queued") {
      job.status = "cancelled";
      this.save(job);
      this.pump();
    }
    return this.describe(job);
  }
  async wait(ids = [...this.jobs.keys()], timeoutMs = 1000) {
    check(
      ids.every((id) => this.jobs.has(id)),
      "AGENT_STATE",
      "子任务不存在",
    );
    const deadline = Date.now() + timeoutMs;
    while (
      ids.some((id) => !TERMINAL.has(this.jobs.get(id).status)) &&
      Date.now() < deadline
    )
      await delay(
        Math.min(100, Math.max(1, deadline - Date.now())),
        undefined,
        { signal: this.signal },
      );
    return ids.map((id) => this.describe(this.jobs.get(id)));
  }
  hasPending() {
    return [...this.jobs.values()].some((j) => !TERMINAL.has(j.status));
  }
  async close({ interrupted = false } = {}) {
    this.closing = true;
    this.interrupted = interrupted;
    for (const job of this.jobs.values())
      if (!TERMINAL.has(job.status)) {
        job.cancelledByParent = true;
        this.cancel(job.id);
        if (interrupted && job.status === "cancelled") {
          job.status = "interrupted";
          this.save(job);
        }
      }
    await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
  }
}

export function registerTeamTools(registry, team, parentId) {
  const scoped = (id) => {
    check(
      !parentId || team.descendant(id, parentId),
      "AGENT_SCOPE",
      "只能操作本分支的助手",
    );
    return id;
  };
  const str = { type: "string", minLength: 1, maxLength: 10000 };
  const ids = { type: "array", items: str, maxItems: 24 };
  const add = (
    name,
    description,
    properties,
    execute,
    required = Object.keys(properties),
  ) =>
    registry.register({
      permission: "agents.delegate",
      definition: {
        type: "function",
        function: {
          name,
          description,
          parameters: {
            type: "object",
            properties,
            required,
            additionalProperties: false,
          },
        },
      },
      execute,
    });
  add(
    "spawn_agent",
    "创建异步协作代理。reader 只读；writer 可在明确文件清单内产生修改提案；verifier 可运行隔离测试但不导出修改。依赖成功后才开始。",
    {
      task: str,
      role: { type: "string", enum: ["reader", "writer", "verifier"] },
      writePaths: { type: "array", items: str, maxItems: 50 },
      dependsOn: ids,
      modelProfile: { type: "string", maxLength: 40 },
    },
    (a) => team.spawn({ ...a, ...(parentId ? { parentId } : {}) }),
    ["task"],
  );
  add(
    "list_agent_models",
    "列出当前工作区已授权的团队模型。spawn_agent 可使用 modelProfile。",
    {},
    () => ({
      models: (team.service.modelProfiles?.list() || []).filter((p) =>
        (team.service.store.get(team.workspaceId).teamModels || []).includes(
          p.id,
        ),
      ),
    }),
  );
  add("list_agents", "读取本次运行的所有协作任务状态。", {}, () =>
    team.list().filter((job) => !parentId || team.descendant(job.id, parentId)),
  );
  add(
    "send_agent_message",
    "向仍在运行或排队的子任务补充要求。",
    { id: str, message: str },
    (a) => team.send(scoped(a.id), a.message),
  );
  add(
    "resume_agent",
    "从持久检查点恢复失败或中断的子任务；不会重放已记录工具结果，保留剩余预算。",
    { id: str, message: str },
    (a) => team.resume(scoped(a.id), a.message),
    ["id"],
  );
  add("cancel_agent", "取消指定子任务，其依赖任务将阻塞。", { id: str }, (a) =>
    team.cancel(scoped(a.id)),
  );
  add(
    "wait_agents",
    "等待协作任务，返回完成或当前状态。结束父任务前必须收齐结果。",
    {
      ids,
      timeoutMs: { type: "integer", minimum: 1, maximum: 30000 },
    },
    (a) =>
      parentId
        ? team.waitChildren(parentId, a.ids, a.timeoutMs)
        : team.wait(a.ids, a.timeoutMs),
    [],
  );
}
