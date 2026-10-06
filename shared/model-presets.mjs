// 模型服务商预设：只决定表单默认值与推荐模型，后端仍按 provider 协议
// （deepseek/openai/openai-compatible/openai-responses/anthropic/local）保存，
// 因此旧配置无需迁移；presetFor 从已保存的协议与地址反推预设。
export const MODEL_PRESETS = Object.freeze([
  { id: 'deepseek', label: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'], keyUrl: 'https://platform.deepseek.com/api_keys', note: '国内直连，支持工具调用，性价比高。带 vision-exp 的模型可读图片（勾选“此模型支持图片”）。' },
  { id: 'qwen', label: '通义千问 · 阿里云百炼', provider: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen3-max', 'qwen-turbo'], keyUrl: 'https://bailian.console.aliyun.com/', note: '兼容 OpenAI 接口，支持工具调用。' },
  { id: 'kimi', label: 'Kimi · 月之暗面', provider: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'kimi-latest', 'moonshot-v1-32k'], keyUrl: 'https://platform.moonshot.cn/console/api-keys', note: '长上下文，支持工具调用。' },
  { id: 'glm', label: '智谱 GLM', provider: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4-plus'], keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', note: '兼容 OpenAI 接口，支持工具调用。' },
  { id: 'doubao', label: '豆包 · 火山方舟', provider: 'openai-compatible', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k-250115'], keyUrl: 'https://console.volcengine.com/ark', note: '也可填写方舟推理接入点 ID（ep-…）。' },
  { id: 'siliconflow', label: '硅基流动 SiliconFlow', provider: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct', 'zai-org/GLM-4.5'], keyUrl: 'https://cloud.siliconflow.cn/account/ak', note: '聚合多家开源模型。' },
  { id: 'openai', label: 'OpenAI · Chat Completions', provider: 'openai', baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5-mini', 'gpt-5.2-pro', 'gpt-4.1', 'gpt-4o'], keyUrl: 'https://platform.openai.com/api-keys', note: '需可访问境外网络。' },
  { id: 'openai-responses', label: 'OpenAI · Responses', provider: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5-mini', 'gpt-5.2-pro', 'gpt-4.1'], keyUrl: 'https://platform.openai.com/api-keys', note: '需可访问境外网络。' },
  { id: 'anthropic', label: 'Anthropic · Claude', provider: 'anthropic', baseUrl: 'https://api.anthropic.com',
    models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'], keyUrl: 'https://console.anthropic.com/settings/keys', note: '需可访问境外网络。' },
  { id: 'ollama', label: '本地模型 · Ollama 等', provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen3:8b', 'qwen2.5:7b', 'deepseek-r1:8b', 'llama3.1:8b'], keyUrl: '', note: '数据不出本机；小模型的工具调用能力有限。' },
  { id: 'custom', label: '其他兼容 OpenAI 的服务', provider: 'openai-compatible', baseUrl: '',
    models: [], keyUrl: '', note: '填写服务商提供的接口地址与模型 ID。' },
]);

const normalize = (url) => String(url || '').trim().replace(/\/+$/, '').toLowerCase();

export function presetById(id) {
  return MODEL_PRESETS.find((preset) => preset.id === id) || MODEL_PRESETS.at(-1);
}

export function presetFor(provider, baseUrl) {
  const url = normalize(baseUrl);
  return MODEL_PRESETS.find((p) => p.provider === provider && normalize(p.baseUrl) === url)
    || (provider === 'local' ? presetById('ollama') : null)
    || (provider !== 'openai-compatible' ? MODEL_PRESETS.find((p) => p.provider === provider) : null)
    || presetById('custom');
}
