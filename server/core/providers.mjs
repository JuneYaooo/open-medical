import { contextBudget, assertContextBudget } from "./context-budget.mjs";
import { requestProvider } from "./provider-request.mjs";
import { providerConfigured } from "./provider-status.mjs";
import { sseFrames } from "../../shared/sse.mjs";
import { AppError, check } from "../errors.mjs";

export class DeepSeekProvider {
  constructor({
    apiKey,
    local = false,
    baseUrl = "https://api.deepseek.com/v1",
    model = "deepseek-v4-flash",
    timeoutMs = 90000,
    thinking = "disabled",
    maxTokens = 8192,
    contextWindow,
    contextWindows,
    fetchImpl = fetch,
  } = {}) {
    this.apiKey = apiKey;
    this.local = local;
    this.provider = "deepseek";
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    check(
      Number.isInteger(timeoutMs) && timeoutMs >= 50 && timeoutMs <= 600000,
      "PROVIDER_CONFIG",
      "模型超时须为 50–600000 毫秒",
    );
    check(
      ["enabled", "disabled"].includes(thinking),
      "PROVIDER_CONFIG",
      "DEEPSEEK_THINKING 需为 enabled 或 disabled",
    );
    check(
      Number.isInteger(maxTokens) && maxTokens >= 256 && maxTokens <= 131072,
      "PROVIDER_CONFIG",
      "模型输出预算须为 256–131072 token",
    );
    this.timeoutMs = timeoutMs;
    this.thinking = thinking;
    this.includeThinking = true;
    this.maxTokens = maxTokens;
    if (contextWindow !== undefined) check(Number.isInteger(contextWindow) && contextWindow >= 512 && contextWindow <= 10000000, "PROVIDER_CONFIG", "模型上下文窗口须为 512–10000000 token");
    this.contextWindow = contextWindow;
    this.contextWindows = contextWindows;
    this.fetch = fetchImpl;
    const url = new URL(this.baseUrl);
    if (local)
      check(
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
          !url.username &&
          !url.password,
        "LOCAL_PROVIDER_URL",
        "本地模型必须使用回环地址",
      );
    check(
      url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)),
      "PROVIDER_URL",
      "模型地址必须为 HTTPS（本地测试除外）",
    );
  }
  async complete(
    messages,
    tools,
    {
      signal,
      onDelta = () => {},
      onStatus = () => {},
      model = this.model,
      maxTokens = this.maxTokens,
      budget,
      thinking = this.thinking,
    } = {},
  ) {
    check(
      providerConfigured(this),
      "MODEL_NOT_CONFIGURED",
      "服务端尚未配置模型",
      503,
    );
    assertContextBudget(contextBudget({ provider: this, model, messages, tools,
      maxChars: budget?.maxChars ?? 100000, calibration: budget?.calibration,
      outputReserve: maxTokens + (this.provider === "anthropic" && thinking === "enabled" ? 4096 : 0) }));
    const combined = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(this.timeoutMs),
    ]);
    combined.throwIfAborted();
    const payload = {
      model,
      messages,
      ...(tools?.length ? { tools } : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...(this.includeThinking ? { thinking: { type: thinking } } : {}),
      max_tokens: maxTokens,
    };
    const response = await requestProvider(this.fetch, `${this.baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: combined,
      }, onStatus);
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        "PROVIDER_ERROR",
        `模型服务返回 ${response.status}，请检查服务配置或稍后重试`,
        502,
      );
    }
    check(
      response.headers.get("content-type")?.includes("text/event-stream") &&
        response.body,
      "PROVIDER_PROTOCOL",
      "模型没有返回有效 SSE 流",
      502,
    );
    let content = "",
      reasoning = "",
      finish = null,
      usage = null,
      done = false;
    const calls = new Map();
    for await (const frame of sseFrames(response.body)) {
      combined.throwIfAborted();
      if (frame.data === "[DONE]") {
        done = true;
        break;
      }
      let data;
      try {
        data = JSON.parse(frame.data);
      } catch {
        throw new AppError("PROVIDER_PROTOCOL", "模型流包含无效 JSON", 502);
      }
      if (data.error)
        throw new AppError(
          "PROVIDER_ERROR",
          "模型执行失败，未将本次内容标为完成",
          502,
        );
      usage = data.usage || usage;
      const choice = data.choices?.[0];
      if (!choice) continue;
      finish = choice.finish_reason || finish;
      const delta = choice.delta || {};
      if (typeof delta.content === "string") {
        content += delta.content;
        onDelta(delta.content);
      }
      if (typeof delta.reasoning_content === "string")
        reasoning += delta.reasoning_content;
      check(
        content.length + reasoning.length < 120000,
        "OUTPUT_LIMIT",
        "模型输出超过单轮上限",
        502,
      );
      for (const part of delta.tool_calls || []) {
        check(
          Number.isInteger(part.index) && part.index >= 0 && part.index < 12,
          "TOOL_LIMIT",
          "工具调用数量或索引无效",
          502,
        );
        const call = calls.get(part.index) || {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments)
          call.function.arguments += part.function.arguments;
        check(
          call.function.arguments.length < 30000,
          "TOOL_LIMIT",
          "工具参数过大",
          502,
        );
        calls.set(part.index, call);
      }
    }
    // 输出长度截断不再整轮失败：有部分内容时交付并带 stopReason 标记，
    // 由运行层决定续写或收尾；未正常结束仍按协议错误抛出。
    check(done, "INCOMPLETE_STREAM", "模型流中断或没有正常结束", 502);
    check(
      ["stop", "tool_calls", "length"].includes(finish),
      "INCOMPLETE_STREAM",
      "模型流异常结束",
      502,
    );
    const truncated = finish === "length";
    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
    check(
      new Set(toolCalls.map((c) => c.id)).size === toolCalls.length,
      "PROVIDER_PROTOCOL",
      "模型工具标识重复",
      502,
    );
    check(
      finish !== "tool_calls" || toolCalls.length,
      "PROVIDER_PROTOCOL",
      "模型未提供工具调用",
      502,
    );
    const usableCalls = truncated
      ? toolCalls.filter((call) => {
          // 截断流里的工具参数可能是半截 JSON：无法解析的调用直接丢弃，
          // 避免执行层炸掉；参数完整的调用照常执行。
          try {
            if (!call.function.arguments?.trim()) return false;
            JSON.parse(call.function.arguments);
            return true;
          } catch {
            return false;
          }
        })
      : toolCalls;
    check(
      finish !== "stop" || usableCalls.length === 0,
      "PROVIDER_PROTOCOL",
      "模型结束状态与工具调用不一致",
      502,
    );
    check(
      usableCalls.every((call) => call.id && call.function.name),
      "PROVIDER_PROTOCOL",
      "模型工具标识无效",
      502,
    );
    check(
      truncated || content.trim() || usableCalls.length,
      truncated ? "INCOMPLETE_STREAM" : "EMPTY_OUTPUT",
      truncated ? "模型达到输出上限，且没有可交付的内容" : "模型没有返回内容",
      502,
    );
    return {
      message: {
        role: "assistant",
        content: content || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(usableCalls.length ? { tool_calls: usableCalls } : {}),
      },
      usage,
      ...(truncated ? { stopReason: "max_tokens" } : {}),
    };
  }
}

// OpenAI-compatible providers share the Chat Completions wire protocol but do not
// receive DeepSeek-only `thinking` fields. This is also the adapter seam for
// OpenRouter, Azure-compatible gateways and local vLLM endpoints.
export class OpenAIProvider extends DeepSeekProvider {
  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl || "https://api.openai.com/v1",
      model: options.model || "gpt-4.1-mini",
      thinking: "disabled",
    });
    this.includeThinking = false;
    this.provider = options.local ? "local" : "openai";
  }
}

export class ResponsesProvider extends OpenAIProvider {
  constructor(options = {}) {
    super(options);
    this.provider = "openai-responses";
    this.vision = true;
    this.reasoningEffort = options.reasoningEffort;
    check(
      !this.reasoningEffort ||
        ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          this.reasoningEffort,
        ),
      "PROVIDER_CONFIG",
      "推理强度无效",
    );
  }
  async complete(
    messages,
    tools,
    {
      signal,
      model = this.model,
      maxTokens = this.maxTokens,
      budget,
      onDelta = () => {},
      onStatus = () => {},
      thinking,
    } = {},
  ) {
    check(
      providerConfigured(this),
      "MODEL_NOT_CONFIGURED",
      "尚未配置模型",
      503,
    );
    const input = [];
    for (const message of messages) {
      if (message.responseItems) {
        input.push(...message.responseItems);
        continue;
      }
      if (message.role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: message.tool_call_id,
          output: message.content,
        });
        continue;
      }
      if (message.content)
        input.push({ role: message.role, content: message.content });
      for (const call of message.tool_calls || [])
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
    }
    assertContextBudget(contextBudget({ provider: this, model, messages, tools,
      maxChars: budget?.maxChars ?? 100000, calibration: budget?.calibration,
      outputReserve: maxTokens + (this.provider === "anthropic" && thinking === "enabled" ? 4096 : 0) }));
    const combined = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(this.timeoutMs),
    ]);
    const payload = {
      model,
      input,
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: maxTokens,
      ...(this.reasoningEffort
        ? { reasoning: { effort: this.reasoningEffort } }
        : {}),
      ...(tools?.length
        ? {
            tools: tools.map(({ function: f }) => ({
              type: "function",
              name: f.name,
              description: f.description,
              parameters: f.parameters,
              strict: false,
            })),
          }
        : {}),
    };
    const response = await requestProvider(this.fetch, this.baseUrl + "/responses", {
        method: "POST",
        redirect: "error",
        signal: combined,
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
      }, onStatus);
    check(
      response.ok &&
        response.headers.get("content-type")?.includes("text/event-stream") &&
        response.body,
      "PROVIDER_RESPONSE",
      `Responses 服务返回无效响应（${response.status}）`,
      502,
    );
    let finished,
      chars = 0;
    for await (const frame of sseFrames(response.body)) {
      combined.throwIfAborted();
      chars += frame.data.length;
      check(chars <= 2_000_000, "OUTPUT_LIMIT", "Responses 输出超过 2MB", 502);
      if (frame.data === "[DONE]") continue;
      const event = JSON.parse(frame.data);
      if (event.type === "response.output_text.delta")
        onDelta(event.delta || "");
      check(
        !["error", "response.failed", "response.incomplete"].includes(
          event.type,
        ),
        "PROVIDER_INCOMPLETE",
        "模型响应失败或超过输出预算，执行未完成",
        502,
      );
      if (event.type === "response.completed") finished = event.response;
    }
    check(
      finished?.status === "completed" && Array.isArray(finished.output),
      "PROVIDER_INCOMPLETE",
      "Responses 流没有完整终态",
      502,
    );
    const calls = finished.output.filter((i) => i.type === "function_call");
    check(
      calls.length <= 8 &&
        calls.every(
          (i) =>
            typeof i.call_id === "string" &&
            typeof i.name === "string" &&
            typeof i.arguments === "string",
        ),
      "PROVIDER_RESPONSE",
      "工具调用无效或过多",
      502,
    );
    const content = finished.output
      .filter((i) => i.type === "message")
      .flatMap((i) => i.content || [])
      .map((part) =>
        part.type === "output_text"
          ? part.text
          : part.type === "refusal"
            ? part.refusal
            : "",
      )
      .join("");
    return {
      message: {
        role: "assistant",
        content,
        responseItems: finished.output,
        ...(calls.length
          ? {
              tool_calls: calls.map((i) => ({
                id: i.call_id,
                type: "function",
                function: { name: i.name, arguments: i.arguments },
              })),
            }
          : {}),
      },
      usage: finished.usage,
    };
  }
}

function anthropicMessages(messages) {
  const system = messages.filter((m) => ["system", "developer"].includes(m.role))
    .map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n\n");
  const out = [];
  for (const message of messages.filter((m) => !["system", "developer"].includes(m.role))) {
    if (message.role === "tool") {
      const previous = out.at(-1);
      const block = {
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: message.content,
      };
      if (previous?.role === "user" && Array.isArray(previous.content))
        previous.content.push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const content = [];
      if (message.content)
        content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls)
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          // The previous call may have failed JSON parsing. Preserve its raw
          // arguments for model repair without crashing history serialization.
          input: (() => {
            try { const value = JSON.parse(call.function.arguments); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch {}
            return { invalid_json_arguments: call.function.arguments };
          })(),
        });
      out.push({ role: "assistant", content });
      continue;
    }
    out.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content || "",
    });
  }
  return { system, messages: out };
}

export class AnthropicProvider {
  constructor({
    apiKey,
    baseUrl = "https://api.anthropic.com",
    model = "claude-sonnet-4-5",
    timeoutMs = 90000,
    maxTokens = 8192,
    contextWindow,
    contextWindows,
    fetchImpl = fetch,
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.vision = true; // Claude 3+ 全系支持图片输入;模型设置里可显式关闭。
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
    if (contextWindow !== undefined) check(Number.isInteger(contextWindow) && contextWindow >= 512 && contextWindow <= 10000000, "PROVIDER_CONFIG", "模型上下文窗口须为 512–10000000 token");
    this.contextWindow = contextWindow;
    this.contextWindows = contextWindows;
    this.fetch = fetchImpl;
    this.provider = "anthropic";
    const url = new URL(this.baseUrl);
    check(
      url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)),
      "PROVIDER_URL",
      "模型地址必须为 HTTPS（本地测试除外）",
    );
    check(
      Number.isInteger(timeoutMs) && timeoutMs >= 50 && timeoutMs <= 600000,
      "PROVIDER_CONFIG",
      "模型超时须为 50–600000 毫秒",
    );
    check(
      Number.isInteger(maxTokens) && maxTokens >= 256 && maxTokens <= 131072,
      "PROVIDER_CONFIG",
      "模型输出预算须为 256–131072 token",
    );
  }
  async complete(
    messages,
    tools,
    {
      signal,
      onDelta = () => {},
      onStatus = () => {},
      model = this.model,
      maxTokens = this.maxTokens,
      budget,
      thinking = this.thinking,
    } = {},
  ) {
    check(
      providerConfigured(this),
      "MODEL_NOT_CONFIGURED",
      "服务端尚未配置模型",
      503,
    );
    assertContextBudget(contextBudget({ provider: this, model, messages, tools,
      maxChars: budget?.maxChars ?? 100000, calibration: budget?.calibration,
      outputReserve: maxTokens + (this.provider === "anthropic" && thinking === "enabled" ? 4096 : 0) }));
    const combined = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(this.timeoutMs),
    ]);
    const converted = anthropicMessages(messages);
    // 深入思考：启用扩展思考并扩容输出预算（思考内容不计入回答）。
    const thinkBudget = 4096;
    const payload = {
      model,
      system: converted.system,
      messages: converted.messages,
      max_tokens: maxTokens + (thinking === "enabled" ? thinkBudget : 0),
      ...(thinking === "enabled"
        ? { thinking: { type: "enabled", budget_tokens: thinkBudget } }
        : {}),
      stream: true,
      ...(tools?.length
        ? {
            tools: tools.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              input_schema: t.function.parameters,
            })),
          }
        : {}),
    };
    const response = await requestProvider(this.fetch, `${this.baseUrl}/v1/messages`, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(payload),
        signal: combined,
      }, onStatus);
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        "PROVIDER_ERROR",
        `模型服务返回 ${response.status}，请检查服务配置或稍后重试`,
        502,
      );
    }
    check(
      response.headers.get("content-type")?.includes("text/event-stream") &&
        response.body,
      "PROVIDER_PROTOCOL",
      "Claude 没有返回有效 SSE 流",
      502,
    );
    let content = "",
      reasoning = "",
      finish = null,
      usage = null,
      done = false;
    const calls = new Map();
    for await (const frame of sseFrames(response.body)) {
      combined.throwIfAborted();
      let data;
      try {
        data = JSON.parse(frame.data);
      } catch {
        throw new AppError("PROVIDER_PROTOCOL", "Claude 流包含无效 JSON", 502);
      }
      if (data.type === "message_start") {
        usage = data.message?.usage || usage;
        continue;
      }
      if (data.type === "content_block_start") {
        const block = data.content_block;
        if (block?.type === "tool_use") {
          calls.set(data.index, { id: block.id, name: block.name, args: "" });
        }
        continue;
      }
      if (data.type === "content_block_delta") {
        const delta = data.delta || {};
        if (delta.type === "text_delta") {
          content += delta.text || "";
          onDelta(delta.text || "");
        }
        if (delta.type === "thinking_delta") reasoning += delta.thinking || "";
        if (delta.type === "input_json_delta") {
          const call = calls.get(data.index);
          check(call, "PROVIDER_PROTOCOL", "Claude 工具索引无效", 502);
          call.args += delta.partial_json || "";
          check(call.args.length < 30000, "TOOL_LIMIT", "工具参数过大", 502);
        }
        continue;
      }
      if (data.type === "message_delta") {
        finish = data.delta?.stop_reason || finish;
        usage = { ...(usage || {}), ...(data.usage || {}) };
        continue;
      }
      if (data.type === "message_stop") {
        done = true;
      }
    }
    const toolCalls = [...calls.values()].map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.args },
    }));
    const reason =
      finish === "tool_use"
        ? "tool_calls"
        : finish === "end_turn"
          ? "stop"
          : finish;
    // 输出长度截断不再整轮失败：有部分内容时交付并带 stopReason 标记，
    // 由运行层决定续写或收尾；未正常结束仍按协议错误抛出。
    check(done, "INCOMPLETE_STREAM", "模型流中断或没有正常结束", 502);
    check(
      ["stop", "tool_calls", "max_tokens"].includes(reason),
      "INCOMPLETE_STREAM",
      "模型流异常结束",
      502,
    );
    const truncated = reason === "max_tokens";
    const usableCalls = truncated
      ? toolCalls.filter((call) => {
          // 截断流里的工具参数可能是半截 JSON：无法解析的调用直接丢弃；
          // 参数完整的调用照常执行。
          try {
            if (!call.function.arguments?.trim()) return false;
            JSON.parse(call.function.arguments);
            return true;
          } catch {
            return false;
          }
        })
      : toolCalls;
    check(
      reason !== "stop" || !usableCalls.length,
      "PROVIDER_PROTOCOL",
      "Claude 结束状态与工具调用不一致",
      502,
    );
    check(
      reason !== "tool_calls" || usableCalls.length,
      "PROVIDER_PROTOCOL",
      "Claude 未提供工具调用",
      502,
    );
    check(
      truncated || content.trim() || usableCalls.length,
      truncated ? "INCOMPLETE_STREAM" : "EMPTY_OUTPUT",
      truncated
        ? "模型达到输出上限，且没有可交付的内容"
        : "模型没有返回内容",
      502,
    );
    if (usage && usage.total_tokens == null)
      usage.total_tokens =
        Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0);
    return {
      message: {
        role: "assistant",
        content: content || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(usableCalls.length ? { tool_calls: usableCalls } : {}),
      },
      usage,
      ...(truncated ? { stopReason: "max_tokens" } : {}),
    };
  }
}

function createProviderByKind(provider, options = {}) {
  const kind = provider;
  if (kind === "openai-responses" || kind === "responses")
    return new ResponsesProvider({
      apiKey:
        options.apiKey ||
        process.env.OPENAI_API_KEY ||
        process.env.AI_API_KEY ||
        "",
      baseUrl: options.baseUrl || process.env.OPENAI_BASE_URL,
      model: options.model || process.env.OPENAI_MODEL,
      reasoningEffort:
        options.reasoningEffort || process.env.AI_REASONING_EFFORT,
      timeoutMs: Number(
        options.timeoutMs ?? process.env.AI_TIMEOUT_MS ?? 90000,
      ),
      maxTokens: Number(options.maxTokens ?? process.env.AI_MAX_TOKENS ?? 8192),
      contextWindow: options.contextWindow,
      contextWindows: options.contextWindows,
      fetchImpl: options.fetchImpl,
    });
  if (kind === "local")
    return new OpenAIProvider({
      apiKey: options.apiKey || "",
      local: true,
      baseUrl:
        options.baseUrl ||
        process.env.LOCAL_MODEL_BASE_URL ||
        "http://127.0.0.1:11434/v1",
      model: options.model || process.env.LOCAL_MODEL_NAME || "local-model",
      timeoutMs: Number(
        options.timeoutMs ?? process.env.AI_TIMEOUT_MS ?? 90000,
      ),
      maxTokens: Number(options.maxTokens ?? process.env.AI_MAX_TOKENS ?? 8192),
      contextWindow: options.contextWindow,
      contextWindows: options.contextWindows,
      fetchImpl: options.fetchImpl,
    });
  if (kind === "anthropic" || kind === "claude")
    return new AnthropicProvider({
      apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "",
      baseUrl: options.baseUrl || process.env.ANTHROPIC_BASE_URL,
      model: options.model || process.env.ANTHROPIC_MODEL,
      timeoutMs: Number(
        options.timeoutMs ??
          process.env.AI_TIMEOUT_MS ??
          process.env.ANTHROPIC_TIMEOUT_MS ??
          90000,
      ),
      maxTokens: Number(
        options.maxTokens ??
          process.env.AI_MAX_TOKENS ??
          process.env.ANTHROPIC_MAX_TOKENS ??
          8192,
      ),
      contextWindow: options.contextWindow,
      contextWindows: options.contextWindows,
      fetchImpl: options.fetchImpl,
    });
  if (
    kind === "openai" ||
    kind === "openai-compatible" ||
    kind === "openrouter"
  )
    return new OpenAIProvider({
      apiKey:
        options.apiKey ||
        (kind === "openrouter" ? process.env.OPENROUTER_API_KEY : undefined) ||
        process.env.OPENAI_API_KEY ||
        process.env.AI_API_KEY ||
        "",
      baseUrl:
        options.baseUrl ||
        process.env.OPENAI_BASE_URL ||
        (kind === "openrouter" ? "https://openrouter.ai/api/v1" : undefined),
      model:
        options.model ||
        (kind === "openrouter" ? process.env.OPENROUTER_MODEL : undefined) ||
        process.env.OPENAI_MODEL,
      timeoutMs: Number(
        options.timeoutMs ?? process.env.AI_TIMEOUT_MS ?? 90000,
      ),
      maxTokens: Number(options.maxTokens ?? process.env.AI_MAX_TOKENS ?? 8192),
      contextWindow: options.contextWindow,
      contextWindows: options.contextWindows,
      fetchImpl: options.fetchImpl,
    });
  return new DeepSeekProvider({
    apiKey: options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "",
    baseUrl: options.baseUrl || process.env.DEEPSEEK_BASE_URL,
    model: options.model || process.env.DEEPSEEK_MODEL,
    thinking: options.thinking || process.env.DEEPSEEK_THINKING || "disabled",
    maxTokens: Number(
      options.maxTokens ??
        process.env.DEEPSEEK_MAX_TOKENS ??
        process.env.AI_MAX_TOKENS ??
        8192,
    ),
    timeoutMs: Number(
      options.timeoutMs ??
        process.env.DEEPSEEK_TIMEOUT_MS ??
        process.env.AI_TIMEOUT_MS ??
        90000,
    ),
    contextWindow: options.contextWindow,
    contextWindows: options.contextWindows,
    fetchImpl: options.fetchImpl,
  });
}

// 用户在模型设置里声明的图片能力优先于各协议类的默认值:
// 显式 vision:true 让 openai-compatible/anthropic 等接入的多模态模型
// 可以直接读取图片资料;显式 false 关闭该能力。
export function createProvider(options = {}) {
  const provider = createProviderByKind(
    String(
      options.provider ??
        process.env.AI_PROVIDER ??
        process.env.MODEL_PROVIDER ??
        "deepseek",
    ).toLowerCase(),
    options,
  );
  if (options && Object.hasOwn(options, "vision"))
    provider.vision = options.vision === true;
  return provider;
}
