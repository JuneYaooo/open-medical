import { check } from "../errors.mjs";
import { contextBudget, assertContextBudget, calibrateInput, estimateTokens } from "./context-budget.mjs";
import { normalizeDelivery } from "./delivery.mjs";
import { RunProgress, OBSERVATIONS_MESSAGE, TASK_INPUT_MESSAGE } from "./run-progress.mjs";
import { checkToolAvailability } from "./tool-registry.mjs";

// Provider + authorized tools + context in, events and complete context out.
// No medical policy, persistence implementation or transport is imported here.
export class AgentRuntime {
  constructor({
    provider,
    maxRounds = Infinity,
    maxContextChars = 100000,
    maxToolCalls = 8,
  }) {
    this.provider = provider;
    this.maxRounds = maxRounds;
    this.maxContextChars = maxContextChars;
    this.maxToolCalls = maxToolCalls;
  }
  async run({
    messages: input,
    registry,
    permissions,
    signal = new AbortController().signal,
    model = this.provider.model,
    thinking,
    emit = () => {},
    context = {},
    onUsage = () => {},
    onToolResult = () => {},
    domain,
    onCheckpoint = () => {},
    runtimeState,
    compact,
    takeInput = () => [],
    onTrace = () => {},
    onRound = () => {},
    offload,
    // 可选交付验证钩子（W5 seam）：由域/服务层提供，在无 tool_calls 且
    // beforeComplete 放行的返回点调用；返回 {delivered, evidence, gaps}
    // 形态（经 normalizeDelivery 归一）。未提供或显式返回 null 时不检查；
    // 抛错/无效返回须保留未验证缺口，不能静默丢掉本次检查结果。
    onDelivery,
  }) {
    permissions.require("model.external", "当前授权不允许调用模型服务");
    let messages = structuredClone(input).filter((item) => item.name !== OBSERVATIONS_MESSAGE);
    const latestInput = messages.findLast((item) => item.role === "user" && item.name !== "runtime_control");
    if (latestInput) latestInput.name = TASK_INPUT_MESSAGE;
    const appendInputs = (updates) => messages.push(...updates.map((item) => item.role === "user" && item.name !== "runtime_control"
      ? { ...item, name: TASK_INPUT_MESSAGE } : item));
    const progress = new RunProgress(runtimeState);
    const checkpoint = (value, state = {}) => onCheckpoint(value, { ...state, runtimeState: progress.snapshot() });
    let observationLimit = 0;
    let pausedTools = Object.freeze([]);
    const refreshObservations = () => {
      messages = messages.filter((item) => item.name !== OBSERVATIONS_MESSAGE && item.name !== "runtime_progress" && item.name !== "runtime_replan_policy");
      const observation = progress.message(observationLimit);
      if (observation) {
        const first = messages.findIndex((item) => !["system", "developer"].includes(item.role));
        messages.splice(first < 0 ? messages.length : first, 0, observation);
      }
      if (pausedTools.length) messages.unshift({ role: "system", name: "runtime_replan_policy", content:
        `运行时重新规划阶段：${pausedTools.join(", ")} 仅在本轮暂缓执行，下一轮自动恢复。请利用已经实际读取的证据和可读取原文的归档推进剩余工作，或规划下一步。这不是任务完成证明；仍需遵守原有审批和交付要求。` });
    };
    let text = "";
    // 单轮输出被长度截断时的自动续写次数：超过后交付部分内容并提示。
    let truncatedRounds = 0;
    let calibration = 1;
    for (let round = 0; round < this.maxRounds; round++) {
      signal.throwIfAborted();
      pausedTools = progress.beginRound();
      const updates = await takeInput();
      if (updates.length) {
        progress.steer();
        pausedTools = Object.freeze([]);
        appendInputs(updates);
        await checkpoint(structuredClone(messages));
      }
      const tools = registry.definitions(permissions).filter((item) => !pausedTools.includes(item.function.name));
      const roundContext = { ...context, pausedTools };
      const measure = (value) => contextBudget({ provider: this.provider, model, messages: value, tools,
        maxChars: this.maxContextChars, thinking, calibration });
      const capacity = measure(messages);
      const effectiveChars = Math.min(this.maxContextChars, Math.floor((capacity.inputLimit - capacity.schemaTokens -
        (capacity.mediaTokens || 0)) / (3 * capacity.calibration)));
      const required = messages.filter((item) => ["system", "developer"].includes(item.role) ||
        item.role === "user" && item.name === TASK_INPUT_MESSAGE);
      observationLimit = Math.max(0, Math.floor(Math.min(effectiveChars * 0.26,
        effectiveChars * 0.45 - JSON.stringify(required).length)));
      // Replace derived memory rather than accumulating it. Original tool
      // outputs remain archived and full model/tool traces are unchanged.
      const guidance = messages.findLast((item) => item.name === "runtime_progress");
      refreshObservations();
      if (guidance) messages.push(guidance);
      let budget = measure(messages);
      if (budget.shouldCompact) {
        const pruned = progress.prune(messages, { protectLatestBatch: true });
        if (pruned.count) {
          messages = pruned.messages;
          budget = measure(messages);
          emit("context.pruned", { results: pruned.count, budget });
          await checkpoint(structuredClone(messages));
        }
      }
      if (compact && budget.shouldCompact) {
        emit("context.compacting", { round: round + 1, budget });
        const result = await compact(messages, { budget, tools, model, thinking });
        messages = result.messages;
        refreshObservations();
        budget = measure(messages);
        await checkpoint(structuredClone(messages));
        const { messages: _messages, ...metadata } = result;
        emit("context.compacted", metadata);
      }
      // Preparation can be slow. Steering received during archive/compaction
      // must reach this model request, not one tool batch after it.
      const preparedInput = await takeInput();
      if (preparedInput.length) {
        progress.steer();
        appendInputs(preparedInput);
        if (pausedTools.length) {
          await checkpoint(structuredClone(messages));
          continue; // Restore the full tool surface before acting on new steering.
        }
        budget = measure(messages);
        emit("run.steered", { count: preparedInput.length });
      }
      signal.throwIfAborted();
      assertContextBudget(budget);
      // Persist inputs before contacting the provider, including the first round.
      await checkpoint(structuredClone(messages));
      if (pausedTools.length) emit("run.replanning", { pausedTools, rounds: 1 });
      await onRound(round + 1);
      emit("status.update", { status: "model_running", round: round + 1 });
      let streamed = "";
      const delta = (chunk) => {
        signal.throwIfAborted();
        streamed += chunk;
        text += chunk;
        emit("message.delta", { text: chunk });
      };
      await onTrace({
        type: "model.request",
        round: round + 1,
        messages: structuredClone(messages),
        tools,
        budget,
      });
      const modelStarted = Date.now();
      let result;
      try { result = await this.provider.complete(
        messages,
        tools,
        {
          model,
          thinking,
          budget,
          signal,
          onDelta: delta,
          onStatus: (status) => emit("status.update", status),
        },
      ); } catch (error) {
        await onTrace({ type: "model.error", round: round + 1, durationMs: Date.now() - modelStarted,
          code: error.code || "PROVIDER_ERROR", error: error.code ? error.message : "模型请求失败或中断" });
        throw error;
      }
      signal.throwIfAborted();
      check(
        result?.message?.role === "assistant",
        "PROVIDER_RESPONSE",
        "模型没有返回有效消息",
        502,
      );
      if (result.usage) {
        calibration = calibrateInput(result.usage, budget);
        onUsage(result.usage);
      }
      const message = result.message;
      if (!streamed && typeof message.content === "string")
        delta(message.content);
      messages.push(message);
      await onTrace({
        type: "model.response",
        round: round + 1,
        message,
        usage: result.usage,
        durationMs: Date.now() - modelStarted,
      });
      const calls = message.tool_calls || [];
      // 长报告类输出撞上单轮上限时软着陆：自动接续一轮而不是整轮失败；
      // 连续截断超过两次仍截断，就在已生成内容后附上说明收尾。
      if (result.stopReason === "max_tokens" && !calls.length) {
        if (truncatedRounds < 2) {
          truncatedRounds += 1;
          messages.push({
            role: "user",
            name: "runtime_control",
            content:
              "系统提示：上一条回复达到单轮输出长度上限被截断。请从中断处直接继续输出剩余内容，不要重复已输出部分；如内容已实质完成，用一两句话收尾即可。",
          });
          await checkpoint(structuredClone(messages));
          emit("message.delta", {
            text: "\n\n（单轮输出达到上限，自动继续生成……）\n\n",
          });
          continue;
        }
        text +=
          "\n\n（输出达到长度上限，以上为已生成的部分内容；回复「继续」可接着生成。）";
      }
      check(
        Array.isArray(calls) && calls.length <= 128,
        "TOOL_BUDGET",
        "单轮工具调用过多或格式无效",
        422,
      );
      if (!calls.length) {
        if (pausedTools.length) {
          // A planning response is never a successful finish by itself. The
          // next normal turn restores reads, including genuinely new sources.
          messages.push({ role: "user", name: "runtime_control", content:
            "运行时控制消息：重新规划阶段已结束，读取工具恢复。请继续原来的用户任务；前一轮计划不代表任务已经完成。" });
          await checkpoint(structuredClone(messages));
          continue;
        }
        const lateInput = await takeInput();
        if (lateInput.length) {
          progress.steer();
          appendInputs(lateInput);
          await checkpoint(structuredClone(messages));
          emit("run.steered", { count: lateInput.length });
          continue;
        }
        try {
          await domain?.beforeComplete?.({
            messages: structuredClone(messages),
            text,
            signal,
            context,
          });
        } catch (error) {
          if (!["TOOLS_RUNNING", "AGENTS_RUNNING"].includes(error.code))
            throw error;
          messages.push({
            role: "user",
            name: "runtime_control",
            content: "运行时状态：" + error.message,
          });
          await checkpoint(structuredClone(messages));
          emit("run.continuing", { reason: error.code });
          continue;
        }
        const finalInput = await takeInput();
        if (finalInput.length) {
          progress.steer();
          appendInputs(finalInput);
          await checkpoint(structuredClone(messages));
          continue;
        }
        signal.throwIfAborted();
        await checkpoint(structuredClone(messages));
        // 交付证据 seam：完成前由运行时事实核对交付（不是模型自评）。
        // 钩子异常不阻断完成——按“未能验证”记录事件，不伪造 delivered。
        let delivery = null;
        const verify =
          typeof onDelivery === "function"
            ? onDelivery
            : domain?.verifyDelivery;
        if (typeof verify === "function") {
          try {
            const verification = await verify({
                messages: structuredClone(messages),
                text,
                signal,
                context,
              });
            signal.throwIfAborted();
            // null is the explicit opt-out for ordinary answers. Undefined,
            // scalars and arrays from a configured checker are invalid results.
            delivery = verification === null ? null : normalizeDelivery(
              verification && typeof verification === "object" && !Array.isArray(verification)
                ? verification
                : { delivered: false, gaps: [{ reason: "invalid_delivery_result",
                  detail: "交付检查未返回有效结果，未能确认交付。" }] },
            );
          } catch (error) {
            signal.throwIfAborted();
            emit("delivery.unverified", {
              reason: error.code || "DELIVERY_CHECK_FAILED",
              error: error.code ? error.message : "交付检查未能执行",
            });
            delivery = normalizeDelivery({ delivered: false, evidence: [],
              gaps: [{ reason: "delivery_check_failed",
                detail: "交付检查执行失败，尚未核实成果。" }] });
          }
          if (delivery)
            emit(delivery.delivered ? "delivery.verified" : "delivery.gaps", {
              delivered: delivery.delivered,
              evidence: delivery.evidence.length,
              gaps: delivery.gaps.length,
            });
        }
        return {
          messages,
          text,
          rounds: round + 1,
          ...(delivery ? { delivery } : {}),
        };
      }
      check(
        permissions.can("tools.execute"),
        "MODE_TOOL_DENIED",
        "当前运行模式不允许执行模型工具调用",
        403,
      );
      const ids = new Set();
      for (const call of calls) {
        check(
          typeof call.id === "string" &&
            !ids.has(call.id) &&
            typeof call.function?.name === "string",
          "TOOL_CALL",
          "工具调用标识无效或重复",
          422,
        );
        ids.add(call.id);
      }
      if (calls.length > this.maxToolCalls) {
        // Reject the entire bounded batch without side effects, then let the
        // model split its work. Preserve one result per call for all providers.
        for (const call of calls) {
          const output = { code: "TOOL_BATCH_LIMIT",
            error: `本轮 ${calls.length} 个工具调用均未执行。每轮最多 ${this.maxToolCalls} 个，请拆分为较小批次后重试。` };
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
          await onTrace({ type: "tool.result", call, output, durationMs: 0 });
          await progress.record(call, output, registry.get?.(call.function.name));
          emit("tool.failed", { tool: call.function.name, call_id: call.id, error: output.error });
        }
        const status = progress.endRound();
        await checkpoint(structuredClone(messages));
        check(!status.stopped, "AGENT_NO_PROGRESS", "工具调用连续失败且没有新进展；已保留检查点", 409);
        continue;
      }
      for (const call of calls) {
        signal.throwIfAborted();
        // An unauthorized tool call is returned to the model as a tool result
        // so it can adapt (different tool, or ask the user) instead of the
        // whole run dying on one permission mismatch.
        try {
          registry.authorize(call.function.name, permissions);
        } catch (error) {
          const output = {
            code: error.code || "PERMISSION_DENIED",
            error: `${error.message}（该工具在当前授权下不可用；请改用其他工具完成任务，或向用户说明需要在设置中开启的能力）`,
          };
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
          await onTrace({ type: "tool.result", call, output, durationMs: 0 });
          await progress.record(call, output, registry.get?.(call.function.name));
          emit("tool.failed", { tool: call.function.name, call_id: call.id, error: output.error });
          continue;
        }
        // Write intent before any hook or tool side effect. Recovery never replays
        // an intent whose result was not durably recorded.
        await checkpoint(structuredClone(messages), { pendingToolCall: call.id });
        emit("tool.start", { tool: call.function.name, call_id: call.id });
        const toolStarted = Date.now();
        let output, toolEvent;
        try {
          const args = JSON.parse(call.function.arguments);
          checkToolAvailability(call.function.name, roundContext);
          await domain?.beforeTool?.({
            name: call.function.name,
            args: structuredClone(args),
            signal,
            context: roundContext,
          });
          output = await registry.execute(
            call.function.name,
            args,
            { ...roundContext, signal },
            permissions,
          );
          signal.throwIfAborted();
          await onToolResult(output, call);
          toolEvent = ["tool.complete", {
            tool: call.function.name,
            call_id: call.id,
            artifact: output?.id && output?.status === "draft" ? output : null,
          }];
        } catch (error) {
          signal.throwIfAborted();
          output = {
            error: error.code ? error.message : "工具执行失败",
            code: error.code || "TOOL_ERROR",
          };
          toolEvent = ["tool.failed", {
            tool: call.function.name,
            call_id: call.id,
            error: output.error,
          }];
        }
        let serialized = JSON.stringify(output ?? null);
        await onTrace({ type: "tool.result", call, output, durationMs: Date.now() - toolStarted });
        const observed = await progress.record(call, output, registry.get?.(call.function.name), offload);
        if (offload && (serialized.length > this.maxContextChars * 0.35 || estimateTokens(output) * calibration > (budget.inputLimit - budget.schemaTokens) * 0.35)) {
          const reference = observed.archiveId ? { id: observed.archiveId } : await offload(output);
          serialized = JSON.stringify(progress.archivedResult(call, output) || {
            archived: true,
            archiveId: reference.id,
            chars: serialized.length,
            preview: serialized.slice(0, 1000),
            instruction:
              "内容过大，原文已归档；需要完整内容时使用 read_context_archive 分段读取。预览不代表完整结果。",
          });
        }
        check(
          serialized.length <= this.maxContextChars,
          "TOOL_OUTPUT_LIMIT",
          "工具输出超过上下文预算",
          413,
        );
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: serialized,
        });
        await checkpoint(structuredClone(messages));
        emit(...toolEvent);
      }
      // Individual results are durable; incomplete batches are sealed on recovery.
      const status = progress.endRound();
      messages = messages.filter((item) => item.name !== "runtime_progress");
      if (status.warning) {
        messages.push({ role: "system", name: "runtime_progress", content:
          "运行时检测到连续重复读取/失败且没有新进展。已读取来源及版本在 runtime_observations 中，原文可按 archiveId 读取。请根据已有证据推进剩余步骤；不要以相同参数重复整个读取批次。" });
        emit("run.no_progress", status);
      }
      await checkpoint(structuredClone(messages));
      check(!status.stopped, "AGENT_NO_PROGRESS", "连续重复读取或失败且没有新进展；已保留证据和检查点，本次任务未完成", 409);
    }
    // 轮数默认不设上限：上下文靠逐轮压缩与大结果归档兜底，用户可随时
    // 停止。仅当显式配置了有限轮数（MEDICAL_MAX_ROUNDS）时才在此截断。
    if (Number.isFinite(this.maxRounds))
      check(false, "TOOL_BUDGET", "已达到工具轮数预算，本次执行不完整", 422);
  }
}
