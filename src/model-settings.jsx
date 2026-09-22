import { useEffect, useRef, useState } from 'react';
import { api } from './agent-runtime';
const presets = {
  deepseek: ['DeepSeek', 'https://api.deepseek.com/v1'],
  openai: ['OpenAI · Chat Completions', 'https://api.openai.com/v1'],
  'openai-responses': ['OpenAI · Responses', 'https://api.openai.com/v1'],
  anthropic: ['Anthropic · Messages', 'https://api.anthropic.com'],
  'openai-compatible': ['兼容 OpenAI 的服务', ''],
  local: ['本地模型 · Ollama 等', 'http://127.0.0.1:11434/v1'],
};
export function ModelSettings({ onClose, onSaved }) {
  const dialog = useRef(null);
  const [form, setForm] = useState(null), [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current.showModal(); let alive = true; api('/api/model-settings').then((data) => { if (alive) setForm({ ...data, apiKey: '' }); }).catch((e) => { if(alive) setError(e.message); }); return () => { alive = false; }; }, []);
  function update(changes) { setForm((f) => ({ ...f, ...changes })); setStatus(''); setError(''); }
  async function submit(test) {
    setBusy(true); setError(''); setStatus('');
    try {
      const data = await api('/api/model-settings' + (test ? '/test' : ''), test ? 'POST' : 'PUT', form);
      if(test) setStatus(`${data.message} 耗时 ${(data.durationMs / 1000).toFixed(1)} 秒。`);
      else { setForm({ ...data, apiKey: '' }); await onSaved(); setStatus('已保存并启用。新任务将使用此配置，无需重启服务。'); }
    } catch(e) { setError(e.message); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="model-settings-dialog" aria-labelledby="model-settings-title" onCancel={(e) => { if(busy) e.preventDefault(); }} onClose={onClose}>
    <header><div><h2 id="model-settings-title">设置</h2><p>本机模型连接 · 适用于所有通用工作区</p></div><button disabled={busy} onClick={onClose} aria-label="关闭模型设置">关闭</button></header>
    <div className="model-settings-body"><aside><strong>模型连接</strong><p>配置接口、验证连接，并选择任务使用的模型。</p></aside><section>
      <h3>连接你的模型服务</h3><p>支持云端 API 和本地模型。此处使用 API 凭据，不是 ChatGPT 或 Claude 订阅登录。</p>
      {!form && !error && <p role="status">正在读取配置…</p>}
      {form && <form onSubmit={(e) => { e.preventDefault(); submit(false); }}>
        <fieldset disabled={busy}>
          <label>服务商 / 接口协议<select value={form.provider} onChange={(e) => update({ provider:e.target.value, baseUrl:presets[e.target.value][1], model:'', contextWindow:null, apiKey:'', hasKey:false })}>{Object.entries(presets).map(([key,[label]]) => <option value={key} key={key}>{label}</option>)}</select></label>
          <label>接口地址<input type="url" required value={form.baseUrl} onChange={(e) => update({ baseUrl:e.target.value, contextWindow:null, apiKey:'', hasKey:false })} placeholder="https://your-provider.example/v1" /></label>
          <label>模型名称<input required value={form.model} onChange={(e) => update({ model:e.target.value, contextWindow:null })} placeholder="填写服务商提供的模型 ID" /></label>
          <label>API Key <span>{form.hasKey ? '已保存 · 留空保留现有密钥' : form.provider === 'local' ? '本地服务可不填写' : '必填'}</span><input type="password" autoComplete="new-password" value={form.apiKey} onChange={(e) => update({ apiKey:e.target.value })} placeholder={form.hasKey ? '••••••••（已保存）' : '粘贴 API Key'} required={!form.hasKey && form.provider !== 'local'} /></label>
          <details><summary>高级选项</summary><label>请求超时（毫秒）<input type="number" min="50" max="600000" value={form.timeoutMs} onChange={(e) => update({ timeoutMs:Number(e.target.value) })} /></label><label>上下文窗口 Token（留空使用默认预算）<input type="number" min="512" max="10000000" placeholder="131072（默认预算，非模型规格）" value={form.contextWindow ?? ''} onChange={(e) => update({ contextWindow:e.target.value === '' ? null : Number(e.target.value) })} /></label><label>最大输出 Token<input type="number" min="256" max="131072" value={form.maxTokens} onChange={(e) => update({ maxTokens:Number(e.target.value) })} /></label><p>上下文窗口需容纳输入、工具和输出。最大输出通常可设为 8192–16384；Anthropic 深入思考另预留 4096。请按服务商规格填写窗口，不能用增大数值绕过模型限制。</p></details>
          <p className="model-privacy">密钥加密保存在本机。测试会向所填接口发送一条固定文本，可能产生少量 API 费用，不包含工作区文件。</p>
          <footer><button type="button" onClick={() => submit(true)}>测试连接</button><button className="model-save" type="submit">保存并启用</button></footer>
        </fieldset>
      </form>}
      {busy && <p role="status">正在处理，请稍候…</p>}{error && <p role="alert" className="model-settings-error">{error}</p>}{status && <p role="status" className="model-settings-success">{status}</p>}
    </section></div>
  </dialog>;
}
