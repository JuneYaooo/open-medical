import { useState } from "react";
import { ModelBudgetFields } from "./model-budget-fields";
import { MODEL_PRESETS, presetById } from "../shared/model-presets.mjs";

const DEFAULT_PRESET = presetById("deepseek");

export function ModelConnectionForm({ busy, onTest, onSave, onChange, aiGranted = false }) {
  const [presetId, setPresetId] = useState(DEFAULT_PRESET.id);
  const [form, setForm] = useState({ provider: DEFAULT_PRESET.provider, baseUrl: DEFAULT_PRESET.baseUrl, model: DEFAULT_PRESET.models[0] || "", apiKey: "", vision: false, timeoutMs: 90000, maxTokens: 8192 });
  const [consent, setConsent] = useState(false);
  const update = changes => { setForm(value => ({ ...value, ...changes })); setConsent(false); onChange(); };
  const preset = presetById(presetId);
  // A required field must stay visible, or the browser cannot point to it.
  const baseUrlField = <label>接口地址<input required type="url" value={form.baseUrl} placeholder="https://服务商地址/v1" onChange={e => update({ baseUrl: e.target.value })}/></label>;
  const showBaseUrl = !preset.baseUrl;
  // Switching provider fills address/model only when they are empty or still
  // equal to the previous preset's defaults, so typed values are kept.
  const choosePreset = id => {
    const next = presetById(id), previous = preset;
    setPresetId(next.id);
    setForm(value => ({
      ...value,
      provider: next.provider,
      baseUrl: !value.baseUrl || value.baseUrl === previous.baseUrl ? next.baseUrl : value.baseUrl,
      model: !value.model || previous.models.includes(value.model) ? (next.models[0] || "") : value.model,
    }));
    setConsent(false); onChange();
  };
  return <details>
    <summary>添加模型连接</summary>
    <p>选择服务商，填写密钥后先测试。测试不会保存或启用连接。</p>
    <form onSubmit={event => { event.preventDefault(); onSave(form, () => setForm(value => ({ ...value, apiKey: "" })), form.provider !== 'local' && consent); }}>
      <fieldset disabled={busy}>
        <label>服务商<select value={presetId} onChange={e => choosePreset(e.target.value)}>
          {MODEL_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select></label>
        {(preset.note || preset.keyUrl) && <p><small>{preset.note}{preset.keyUrl && <> 去哪里获取密钥：<a href={preset.keyUrl} target="_blank" rel="noreferrer">{preset.keyUrl}</a></>}</small></p>}
        {showBaseUrl && baseUrlField}
        <label>模型名称<input required maxLength={500} list="model-preset-options" value={form.model} onChange={e => update({ model: e.target.value })}/></label>
        <datalist id="model-preset-options">{preset.models.map(m => <option key={m} value={m}/>)}</datalist>
        <label>API Key<input type="password" autoComplete="off" required={form.provider !== 'local'} value={form.apiKey} onChange={e => update({ apiKey: e.target.value })}/></label>
        <label className="model-check"><input type="checkbox" checked={form.vision} onChange={e => update({ vision: e.target.checked })}/>此模型支持图片（按服务商说明确认）</label>
        <details><summary>高级</summary>
          {!showBaseUrl && baseUrlField}
          <label>接口协议<select value={form.provider} onChange={e => update({ provider: e.target.value })}>
            <option value="openai-compatible">OpenAI 兼容接口</option><option value="openai">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic</option><option value="deepseek">DeepSeek</option><option value="local">本机模型</option>
          </select></label>
          <ModelBudgetFields form={form} onChange={update}/>
        </details>
        {form.provider !== 'local' && !aiGranted && <label className="model-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>允许 AI 功能使用患者资料（如病历整理、AI 总结、随访摘要），敏感信息按隐私设置脱敏后发送</label>}
        <div className="toolbar-actions"><button type="button" onClick={() => onTest(form)}>测试新连接</button><button type="submit" disabled={form.provider !== 'local' && !aiGranted && !consent}>保存并启用连接</button></div>
      </fieldset>
    </form>
  </details>;
}
