import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelContext } from '../shared/model-context.mjs';
import { contextBudget } from '../server/core/context-budget.mjs';
import { ModelSettings } from '../server/core/model-settings.mjs';
import { DeepSeekProvider } from '../server/core/providers.mjs';

const official = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' };
test('official exact model IDs resolve defaults shared by UI and runtime', () => {
  assert.equal(resolveModelContext(official).contextWindow, 1000000);
  assert.equal(contextBudget({ provider: official }).contextWindow, 1000000);
  assert.equal(resolveModelContext({ ...official, model: 'deepseek-v4-flash' }).windowSource, 'model_default');
  assert.equal(resolveModelContext({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' }).contextWindow, 1047576);
  assert.equal(resolveModelContext({ baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5' }).contextWindow, 200000);
});
test('unknown IDs, third party and local deployments never inherit official capacity by name', () => {
  for (const change of [{ model: 'deepseek-flash-custom' }, { baseUrl: 'https://proxy.example/v1' },
    { baseUrl: 'https://api.deepseek.com.evil.example' }, { baseUrl: 'https://api.deepseek.com:8443' }, { local: true }, { provider: 'local' }]) {
    const result = resolveModelContext({ ...official, ...change });
    assert.equal(result.contextWindow, 131072);
    assert.equal(result.windowSource, 'legacy_default_unverified');
    assert.equal(result.sourceUrl, null);
  }
});
test('per-model override beats provider override; alternate models do not inherit the current override', () => {
  const provider = { ...official, contextWindow: 32000, contextWindows: { 'deepseek-v4-pro': 64000 } };
  assert.equal(resolveModelContext(provider).contextWindow, 32000);
  assert.equal(resolveModelContext(provider, 'deepseek-v4-pro').contextWindow, 64000);
  assert.equal(resolveModelContext(provider, 'deepseek-v4-flash').contextWindow, 1000000);
  assert.equal(resolveModelContext({ ...official, contextWindow: null }).windowSource, 'model_default');
});
test('settings distinguish override from effective default and explicit clearing survives save', () => {
  const settings = Object.create(ModelSettings.prototype);
  settings.initial = new DeepSeekProvider({ ...official, apiKey: 'synthetic' });
  settings.saved = {};
  settings.vault = { set() {} };
  assert.equal(settings.public().contextWindow, null);
  assert.equal(settings.public().contextDefaults.contextWindow, 1000000);
  settings.save(settings.candidate({ ...official, contextWindow: 64000 }));
  assert.equal(settings.public().contextWindow, 64000);
  settings.save(settings.candidate(official));
  assert.equal(settings.public().contextWindow, 64000, 'omitted override preserved');
  settings.save(settings.candidate({ ...official, contextWindow: null }));
  assert.equal(settings.public().contextWindow, null);
  assert.equal(settings.public().contextDefaults.windowSource, 'model_default');
  settings.save(settings.candidate({ ...official, model: 'unknown-model' }));
  assert.equal(settings.public().contextDefaults.contextWindow, 131072);
});
