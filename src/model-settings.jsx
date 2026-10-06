import { ModelBudgetFields } from './model-budget-fields';
import { useEffect, useRef, useState } from 'react';
import { api } from './agent-runtime';
import { JevSettings } from './jev-settings';
import { MODEL_PRESETS, presetById, presetFor } from '../shared/model-presets.mjs';
const CUSTOM_MODEL = '__custom__';
export function ModelSettings({ onClose, onSaved }) {
  const dialog = useRef(null);
  const [form, setForm] = useState(null), [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false), [checks, setChecks] = useState(null);
  const load = (data) => setForm({ ...data, apiKey: '', preset: presetFor(data.provider, data.baseUrl).id });
  useEffect(() => { dialog.current.showModal(); let alive = true; api('/api/model-settings').then((data) => { if (alive) load(data); }).catch((e) => { if(alive) setError(e.message); }); return () => { alive = false; }; }, []);
  function update(changes) { setForm((f) => ({ ...f, ...changes })); setStatus(''); setError(''); setChecks(null); }
  function choosePreset(id) {
    const preset = presetById(id);
    update({ preset: id, provider: preset.provider, baseUrl: preset.baseUrl, model: preset.models[0] || '', contextWindow: null, apiKey: '', hasKey: false, vision: ['openai-responses', 'anthropic'].includes(preset.provider) });
  }
  async function submit(test) {
    setBusy(true); setError(''); setStatus(''); setChecks(null);
    const { preset: _preset, ...payload } = form;
    try {
      const data = await api('/api/model-settings' + (test ? '/test' : ''), test ? 'POST' : 'PUT', payload);
      if(test) { setChecks(data.checks || null); setStatus(`${data.message} 总耗时 ${(data.durationMs / 1000).toFixed(1)} 秒。`); }
      else { load(data); await onSaved(); setStatus('已保存并启用。新任务将使用此配置，无需重启服务。'); }
    } catch(e) { setError(e.message); } finally { setBusy(false); }
  }
  const preset = form ? presetById(form.preset) : null;
  const customModel = form && (!preset.models.length || !preset.models.includes(form.model));
  return <dialog ref={dialog} className="model-settings-dialog" aria-labelledby="model-settings-title" onCancel={(e) => { if(busy) e.preventDefault(); }} onClose={onClose}>
    <header><div><h2 id="model-settings-title">设置</h2><p>本机模型连接 · 适用于所有通用工作区</p></div><button disabled={busy} onClick={onClose} aria-label="关闭模型设置">关闭</button></header>
    <div className="model-settings-body"><aside><strong>模型连接</strong><p>配置接口、验证连接，并选择任务使用的模型。</p></aside><section>
      <h3>连接你的模型服务</h3><p>支持云端 API 和本地模型。此处使用 API 凭据，不是 ChatGPT 或 Claude 订阅登录。</p>
      {!form && !error && <p role="status">正在读取配置…</p>}
      {form && <form onSubmit={(e) => { e.preventDefault(); submit(false); }}>
        <fieldset disabled={busy}>
          <label>服务商<select value={form.preset} onChange={(e) => choosePreset(e.target.value)}>{MODEL_PRESETS.map((p) => <option value={p.id} key={p.id}>{p.label}</option>)}</select></label>
          {preset.note && <p className="model-preset-note">{preset.note}</p>}
          {preset.models.length > 0 && <label>模型<select value={customModel ? CUSTOM_MODEL : form.model} onChange={(e) => update({ model: e.target.value === CUSTOM_MODEL ? '' : e.target.value, contextWindow: null })}>{preset.models.map((m) => <option value={m} key={m}>{m}</option>)}<option value={CUSTOM_MODEL}>自定义…</option></select></label>}
          {customModel && <label>模型 ID<input required value={form.model} onChange={(e) => update({ model:e.target.value, contextWindow:null })} placeholder="填写服务商提供的模型 ID" /></label>}
          <label>API Key <span>{form.hasKey ? '已保存 · 留空保留现有密钥' : form.provider === 'local' ? '本地服务可不填写' : '必填'}{preset.keyUrl && <> · <a href={preset.keyUrl} target="_blank" rel="noreferrer">获取 Key</a></>}</span><input type="password" autoComplete="new-password" value={form.apiKey} onChange={(e) => update({ apiKey:e.target.value })} placeholder={form.hasKey ? '••••••••（已保存）' : '粘贴 API Key'} required={!form.hasKey && form.provider !== 'local'} /></label>
          <label className="model-check"><input type="checkbox" checked={form.vision === true} onChange={(e) => update({ vision: e.target.checked })}/>此模型支持图片（多模态/视觉）——勾选后，上传的图片资料会直接交给它读取，不再仅依赖本机 OCR</label>
          <details className="model-advanced" open={preset.id === 'custom' || undefined}><summary>高级选项</summary>
            <label>接口地址<input type="url" required value={form.baseUrl} onChange={(e) => update({ baseUrl:e.target.value, contextWindow:null, apiKey:'', hasKey:false })} placeholder="https://your-provider.example/v1" /></label>
            <ModelBudgetFields form={form} onChange={update} />
            <label>请求超时（毫秒）<input type="number" min="50" max="600000" value={form.timeoutMs} onChange={(e) => update({ timeoutMs:Number(e.target.value) })} /></label>
          </details>
          <p className="model-privacy">密钥加密保存在本机。测试会向所填接口发送三条固定文本（文本、工具调用、JSON），可能产生少量 API 费用，不包含工作区或患者数据。</p>
          <footer><button type="button" onClick={(event) => { if (event.currentTarget.form.reportValidity()) submit(true); }}>测试连接</button><button className="model-save" type="submit">保存并启用</button></footer>
        </fieldset>
      </form>}
      {checks && <ul className="model-checks" aria-label="能力检测结果">{checks.map((c) => <li key={c.id} className={c.ok ? 'ok' : 'failed'}><span aria-hidden="true">{c.ok ? '✓' : '✗'}</span><strong>{{ text: '文本回复', tools: '工具调用', json: 'JSON 输出' }[c.id] || c.id}</strong><em>{c.message} · {(c.durationMs / 1000).toFixed(1)} 秒</em></li>)}</ul>}
      {busy && <p role="status">正在处理，请稍候…</p>}{error && <p role="alert" className="model-settings-error">{error}{!form && <button type="button" onClick={() => { setError(''); api('/api/model-settings').then(load).catch(e => setError(e.message)); }}>重新读取配置</button>}</p>}{status && <p role="status" className="model-settings-success">{status}</p>}
      <details className="model-jev-section"><summary>其他连接 · Jev</summary><JevSettings /></details>
    </section></div>
  </dialog>;
}
