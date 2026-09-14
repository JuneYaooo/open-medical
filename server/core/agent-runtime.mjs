import { check } from "../errors.mjs";

// Provider + authorized tools + context in, events and complete context out.
// No medical policy, persistence implementation or transport is imported here.
export class AgentRuntime {
  constructor({
    provider,
    maxRounds = 8,
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
  }) {
    permissions.require("model.external", "当前授权不允许调用模型服务");
    let messages = structuredClone(input);
    let text = "";
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
        return { messages, text, rounds: round + 1 };
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
    check(false, "TOOL_BUDGET", "已达到工具轮数预算，本次执行不完整", 422);
  }
}
