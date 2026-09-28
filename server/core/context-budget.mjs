import { resolveModelContext } from '../../shared/model-context.mjs';
import { check } from '../errors.mjs';

// Byte-count upper estimate, deliberately not a tokenizer. Unknown model windows
// use a conservative configured ceiling, never an inferred marketing specification.
export function estimateTokens(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') + 16;
}
export function contextBudget({ provider = {}, model = provider.model, messages = [], tools = [], maxChars = 100000, thinking, calibration = 1, outputReserve } = {}) {
  const { contextWindow, windowSource } = resolveModelContext(provider, model);
  const reserve = outputReserve ?? ((provider.maxTokens ?? 8192) + (provider.provider === 'anthropic' && thinking === 'enabled' ? 4096 : 0));
  check(Number.isInteger(contextWindow) && contextWindow >= 512 && Number.isInteger(reserve) && reserve > 0 && reserve < contextWindow,
    'CONTEXT_CONFIG', `模型预算配置无效：上下文窗口 ${contextWindow} token，输出预留 ${reserve} token（含已启用的思考预算）。请在模型设置中降低最大输出，并为输入保留空间；仅在服务商确认后填写更大的上下文窗口。`, 400);
  const factor = Math.max(1, Number.isFinite(calibration) ? calibration : 1);
  const schemaTokens = Math.ceil(estimateTokens(tools) * factor);
  const messageTokens = Math.ceil(estimateTokens(messages) * factor);
  const inputLimit = contextWindow - reserve - 128;
  const chars = JSON.stringify(messages).length;
  const media = messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((part) => part && ["image_url", "input_image", "input_audio", "audio", "video"].includes(part.type));
  // Media pricing varies by model/resolution; expose uncertainty and reserve a
  // configurable conservative allowance instead of pretending URLs are tokens.
  const unknownMultimodal = media.length > 0;
  const mediaTokens = media.length * (provider.mediaTokenReserve ?? 16384);
  return { model, contextWindow, outputReserve: reserve, schemaTokens, messageTokens, inputLimit, chars, maxChars,
    calibration: factor, estimation: 'conservative_estimate', windowSource,
    unknownMultimodal, mediaTokens, fits: messageTokens + schemaTokens + mediaTokens <= inputLimit && chars <= maxChars,
    shouldCompact: messageTokens + schemaTokens + mediaTokens > inputLimit * 0.8 || chars > maxChars * 0.8 };
}
export function assertContextBudget(budget) {
  check(budget.fits, 'CONTEXT_LIMIT', '上下文（含工具定义及输出预留）超过模型预算，请缩小范围或调整模型窗口', 413);
  return budget;
}
// Only response-local, explicitly named input counts are usable. Never consume
// total_tokens/output_tokens or a caller's accumulated run usage; only raise the estimate.
export function calibrateInput(usage, budget) {
  const input = usage?.prompt_tokens ?? usage?.input_tokens;
  if (!Number.isFinite(input) || input < 0 || usage?.cumulative === true) return budget.calibration;
  const cache = usage?.input_tokens !== undefined ? (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : 0;
  return Math.max(budget.calibration, (input + cache) / Math.max(1, (budget.messageTokens + budget.schemaTokens) / budget.calibration));
}
