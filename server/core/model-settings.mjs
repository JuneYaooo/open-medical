import { CredentialVault } from './oauth.mjs';
import { createProvider } from './providers.mjs';
import { check, AppError } from '../errors.mjs';
import { contextBudget, assertContextBudget } from './context-budget.mjs';

function validateBudget(config) {
  const provider = createProvider(config);
  // Validate the saved budget before the connection probe replaces maxTokens.
  assertContextBudget(contextBudget({ provider, thinking: provider.provider === 'anthropic' ? 'enabled' : undefined }));
}

const kinds = ['deepseek', 'openai', 'openai-compatible', 'openai-responses', 'anthropic', 'local'];
const key = 'platform:model-settings:v1';
export class ModelSettings {
  constructor(db, directory, initial) {
    this.vault = new CredentialVault(db, directory);
    this.initial = initial;
    this.saved = this.vault.get(key);
  }
  provider() { return this.saved.provider ? createProvider(this.saved) : this.initial; }
  public() {
    const p = this.provider();
    return { provider: this.saved.provider || (p.local ? 'local' : p.provider), baseUrl: p.baseUrl || '', model: p.model || '', hasKey: Boolean(p.apiKey), source: this.saved.provider ? 'saved' : 'environment', timeoutMs: p.timeoutMs || 90000, contextWindow: p.contextWindow ?? null, maxTokens: p.maxTokens || 8192 };
  }
  candidate(body) {
    check(kinds.includes(body.provider), 'MODEL_SETTINGS', '请选择支持的模型协议');
    for (const field of ['baseUrl', 'model']) check(typeof body[field] === 'string' && body[field].trim().length > 0 && body[field].length <= 500, 'MODEL_SETTINGS', '请填写有效的接口地址和模型名称');
    let url;
    try { url = new URL(body.baseUrl.trim()); } catch { throw new AppError('MODEL_SETTINGS', '接口地址格式无效', 400); }
    check(!url.username && !url.password && !url.search && !url.hash, 'MODEL_SETTINGS', '接口地址不能包含账号、密码、查询参数或片段');
    check(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), 'MODEL_SETTINGS', '请使用 HTTPS；本地模型允许回环 HTTP 地址');
    const baseUrl = url.href.replace(/\/$/, '');
    const existing = this.provider(), previous = this.public();
    check(body.apiKey === undefined || (typeof body.apiKey === 'string' && body.apiKey.length <= 8192), 'MODEL_SETTINGS', '密钥格式无效');
    const apiKey = body.apiKey?.trim() || (body.provider === previous.provider && baseUrl === previous.baseUrl.replace(/\/$/, '') ? existing.apiKey : '');
    check(body.provider === 'local' || Boolean(apiKey), 'MODEL_SETTINGS', '请填写 API Key；更换协议或接口地址时须重新输入密钥');
    const config = { provider: body.provider, baseUrl, model: body.model.trim(), apiKey: apiKey || '', timeoutMs: Number(body.timeoutMs ?? 90000), maxTokens: Number(body.maxTokens ?? 8192) };
    if (body.contextWindow != null) config.contextWindow = Number(body.contextWindow);
    else if (body.contextWindow === undefined && body.provider === previous.provider && baseUrl === previous.baseUrl.replace(/\/$/, '') && body.model.trim() === previous.model && existing.contextWindow) config.contextWindow = existing.contextWindow;
    validateBudget(config);
    return config;
  }
  save(config) { this.vault.set(key, config); this.saved = config; return this.provider(); }
  async test(config) {
    validateBudget(config);
    const start = Date.now();
    try {
      const p = createProvider({ ...config, timeoutMs: Math.min(config.timeoutMs, 30000), maxTokens: 256 });
      const result = await p.complete([{ role: 'user', content: 'Reply with OK.' }], [], { signal: AbortSignal.timeout(30000) });
      check(Boolean(result?.message?.content), 'MODEL_TEST', '模型未返回文本');
      return { ok: true, durationMs: Date.now() - start, message: '已收到模型回复。此测试验证连接和文本生成，不代表工具调用已验收。' };
    } catch { throw new AppError('MODEL_TEST', '连接测试失败。请检查接口地址、模型名称、密钥权限和网络；测试最长等待 30 秒。', 400); }
  }
}
