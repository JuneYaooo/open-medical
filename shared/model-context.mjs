// Exact IDs on official endpoints only. Recheck aliases when updating this catalog.
// Values labelled 1M by vendors use the conservative decimal capacity.
export const MODEL_CONTEXT_DEFAULTS = [
  { host: 'api.openai.com', models: ['gpt-5-mini'], contextWindow: 400000, source: 'https://developers.openai.com/api/docs/models/gpt-5-mini' },
  { host: 'api.openai.com', models: ['gpt-5.2-pro'], contextWindow: 400000, source: 'https://developers.openai.com/api/docs/models/gpt-5.2-pro' },
  { host: 'api.anthropic.com', models: ['claude-sonnet-4-6', 'claude-opus-4-6'], contextWindow: 1000000, source: 'https://platform.claude.com/docs/en/release-notes/overview' },
  { host: 'api.deepseek.com', models: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'], contextWindow: 1000000, source: 'https://api-docs.deepseek.com/quick_start/pricing/' },
  { host: 'api.openai.com', models: ['gpt-4.1', 'gpt-4.1-2025-04-14', 'gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14', 'gpt-4.1-nano', 'gpt-4.1-nano-2025-04-14'], contextWindow: 1047576, source: 'https://developers.openai.com/api/docs/models/gpt-4.1' },
  { host: 'api.openai.com', models: ['gpt-4o', 'gpt-4o-2024-08-06'], contextWindow: 128000, source: 'https://developers.openai.com/api/docs/guides/conversation-state' },
  { host: 'api.anthropic.com', models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5'], contextWindow: 1000000, source: 'https://platform.claude.com/docs/en/models/overview' },
  { host: 'api.anthropic.com', models: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'], contextWindow: 200000, source: 'https://platform.claude.com/docs/en/models/overview' },
];
export function resolveModelContext(provider = {}, model = provider.model) {
  let host;
  try { const url = new URL(provider.baseUrl); if (url.protocol === 'https:') host = url.host; } catch { /* Unknown endpoint: require an override to claim vendor capacity. */ }
  const entry = !provider.local && provider.provider !== 'local' && MODEL_CONTEXT_DEFAULTS.find(e => e.host === host && e.models.includes(model));
  const configured = provider.contextWindows?.[model] ?? (model === provider.model ? provider.contextWindow : undefined);
  return {
    contextWindow: configured ?? entry?.contextWindow ?? 131072,
    defaultContextWindow: entry?.contextWindow ?? 131072,
    windowSource: configured != null ? 'configured' : entry ? 'model_default' : 'legacy_default_unverified',
    defaultSource: entry ? 'model_default' : 'legacy_default_unverified',
    sourceUrl: entry?.source ?? null,
    verifiedAt: entry ? '2026-09-28' : null,
  };
}
