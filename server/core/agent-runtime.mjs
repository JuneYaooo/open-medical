import { check } from "../errors.mjs";
import { normalizeDelivery } from "./delivery.mjs";

// Provider + authorized tools + context in, events and complete context out.
// No medical policy, persistence implementation or transport is imported here.
export class AgentRuntime {
  constructor({
    provider,
    maxRounds = Infinity,
    maxContextChars = 100000,
    maxToolCalls = 8,
    // 整次运行的工具调用总预算(N6):执行过的调用计数,超出的调用不再执行,
    // 以结构化错误返回给模型。默认不设限;评测控制器按协议传入真实上限。
    maxTotalToolCalls = Infinity,
  }) {
    this.provider = provider;
    this.maxRounds = maxRounds;
    this.maxContextChars = maxContextChars;
    this.maxToolCalls = maxToolCalls;
    this.maxTotalToolCalls = maxTotalToolCalls;
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
    compact,
    takeInput = () => [],
    onTrace = () => {},
    onRound = () => {},
    offload,
    // 可选交付验证钩子（W5 seam）：由域/服务层提供，在无 tool_calls 且
    // beforeComplete 放行的返回点调用；返回 {delivered, evidence, gaps}
    // 形态（经 normalizeDelivery 归一）。未提供或抛错时保持现状——循环
    // 照常完成，不附加 delivery 字段（向后兼容）。
    onDelivery,
  }) {
    permissions.require("model.external", "当前授权不允许调用模型服务");
    let messages = structuredClone(input);
    let text = "";
    // 单轮输出被长度截断时的自动续写次数：超过后交付部分内容并提示。
    let truncatedRounds = 0;
    // N3:交付验证发现可操作缺口时,反馈执行循环继续修正的已用次数
    // (有硬上限,防止验证-重试循环吃掉无界预算)。
    let deliveryRetries = 0;
    // N6:本运行已真实执行的工具调用数(总预算约束)。
    let executedToolCalls = 0;
    for (let round = 0; round < this.maxRounds; round++) {
      signal.throwIfAborted();
      const updates = await takeInput();
      if (updates.length) {
        messages.push(...updates);
        await onCheckpoint(structuredClone(messages));
      }
      if (
        compact &&
        JSON.stringify(messages).length > this.maxContextChars * 0.8
      ) {
        emit("context.compacting", { round: round + 1 });
        const result = await compact(messages);
        messages = result.messages;
        await onCheckpoint(structuredClone(messages));
        const { messages: _messages, ...metadata } = result;
        emit("context.compacted", metadata);
      }
      check(
        JSON.stringify(messages).length <= this.maxContextChars,
        "CONTEXT_LIMIT",
        "上下文超过预算，请缩小范围或创建新会话",
        413,
      );
      // Persist inputs before contacting the provider, including the first round.
      await onCheckpoint(structuredClone(messages));
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
        tools: registry.definitions(permissions),
      });
      const modelStarted = Date.now();
      let result;
      try { result = await this.provider.complete(
        messages,
        registry.definitions(permissions),
        {
          model,
          thinking,
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
      if (result.usage) onUsage(result.usage);
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
            content:
              "系统提示：上一条回复达到单轮输出长度上限被截断。请从中断处直接继续输出剩余内容，不要重复已输出部分；如内容已实质完成，用一两句话收尾即可。",
          });
          await onCheckpoint(structuredClone(messages));
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
        const lateInput = await takeInput();
        if (lateInput.length) {
          messages.push(...lateInput);
          await onCheckpoint(structuredClone(messages));
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
            content: "运行时状态：" + error.message,
          });
          await onCheckpoint(structuredClone(messages));
          emit("run.continuing", { reason: error.code });
          continue;
        }
        const finalInput = await takeInput();
        if (finalInput.length) {
          messages.push(...finalInput);
          await onCheckpoint(structuredClone(messages));
          continue;
        }
        signal.throwIfAborted();
        await onCheckpoint(structuredClone(messages));
        // 交付证据 seam:完成前由运行时事实核对交付(不是模型自评)。
        // 钩子异常不阻断完成,但也不丢事实——按“未能验证”持久化明确
        // 状态(N3),绝不静默当成功。
        let delivery = null;
        const verify =
          typeof onDelivery === "function"
            ? onDelivery
            : domain?.verifyDelivery;
        if (typeof verify === "function") {
          try {
            delivery = normalizeDelivery(
              await verify({
                messages: structuredClone(messages),
                text,
                signal,
                context,
              }),
            );
          } catch (error) {
            signal.throwIfAborted();
            emit("delivery.unverified", {
              reason: error.code || "DELIVERY_CHECK_FAILED",
              error: error.code ? error.message : "交付检查未能执行",
            });
            delivery = normalizeDelivery({
              delivered: false,
              unverified: true,
              evidence: [],
              gaps: [
                {
                  reason: error.code || "delivery_check_failed",
                  detail: error.code
                    ? error.message
                    : "交付检查未能执行(验证器异常),结果未验证",
                },
              ],
            });
          }
          if (delivery)
            emit(delivery.delivered ? "delivery.verified" : "delivery.gaps", {
              delivered: delivery.delivered,
              evidence: delivery.evidence.length,
              gaps: delivery.gaps.length,
            });
        }
        // N3-07:验证期间被取消时,晚到的验证结论一律不采信——取消后不能
        // 再写成成功。抛出中止,由执行服务的取消路径收敛状态。
        signal.throwIfAborted();
        // N3:验证不完整时,若存在可操作缺口且预算允许,把缺口反馈回执行
        // 循环继续修正;硬上限 2 次,防止验证-重试循环无界消耗。
        if (
          delivery &&
          delivery.delivered === false &&
          delivery.unverified !== true &&
          typeof delivery.retryMessage === "string" &&
          (delivery.gaps || []).some((g) => g && g.actionable === true) &&
          deliveryRetries < 2
        ) {
          deliveryRetries += 1;
          messages.push({ role: "user", content: delivery.retryMessage });
          await onCheckpoint(structuredClone(messages));
          emit("delivery.retry", {
            attempt: deliveryRetries,
            gaps: delivery.gaps.length,
          });
          continue;
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
          emit("tool.failed", { tool: call.function.name, call_id: call.id, error: output.error });
        }
        await onCheckpoint(structuredClone(messages));
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
          emit("tool.failed", { tool: call.function.name, call_id: call.id, error: output.error });
          continue;
        }
        // Write intent before any hook or tool side effect. Recovery never replays
        // an intent whose result was not durably recorded.
        await onCheckpoint(structuredClone(messages), { pendingToolCall: call.id });
        emit("tool.start", { tool: call.function.name, call_id: call.id });
        // N6:总预算真实执行——超出后调用不执行,以结构化错误回给模型。
        if (executedToolCalls >= this.maxTotalToolCalls) {
          const output = {
            code: "TOOL_BUDGET_EXHAUSTED",
            error: `工具调用总预算(${this.maxTotalToolCalls})已用尽,本次调用未执行。请基于已有信息收尾,如实说明未完成部分,不要声称已完成未执行的操作。`,
          };
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
          await onTrace({ type: "tool.result", call, output, durationMs: 0 });
          emit("tool.failed", { tool: call.function.name, call_id: call.id, error: output.error });
          continue;
        }
        const toolStarted = Date.now();
        let output;
        try {
          const args = JSON.parse(call.function.arguments);
          await domain?.beforeTool?.({
            name: call.function.name,
            args: structuredClone(args),
            signal,
            context,
          });
          executedToolCalls += 1;
          output = await registry.execute(
            call.function.name,
            args,
            { ...context, signal },
            permissions,
          );
          signal.throwIfAborted();
          await onToolResult(output, call);
          emit("tool.complete", {
            tool: call.function.name,
            call_id: call.id,
            artifact: output?.id && output?.status === "draft" ? output : null,
          });
        } catch (error) {
          signal.throwIfAborted();
          output = {
            error: error.code ? error.message : "工具执行失败",
            code: error.code || "TOOL_ERROR",
          };
          emit("tool.failed", {
            tool: call.function.name,
            call_id: call.id,
            error: output.error,
          });
        }
        let serialized = JSON.stringify(output ?? null);
        await onTrace({ type: "tool.result", call, output, durationMs: Date.now() - toolStarted });
        if (offload && serialized.length > this.maxContextChars * 0.35) {
          const reference = await offload(output);
          serialized = JSON.stringify({
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
        await onCheckpoint(structuredClone(messages));
      }
      // Individual results are durable; incomplete batches are sealed on recovery.
      await onCheckpoint(structuredClone(messages));
    }
    // 轮数默认不设上限：上下文靠逐轮压缩与大结果归档兜底，用户可随时
    // 停止。仅当显式配置了有限轮数（MEDICAL_MAX_ROUNDS）时才在此截断。
    if (Number.isFinite(this.maxRounds))
      check(false, "TOOL_BUDGET", "已达到工具轮数预算，本次执行不完整", 422);
  }
}
