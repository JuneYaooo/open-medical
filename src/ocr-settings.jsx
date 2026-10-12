import { useEffect, useState } from 'react';
import { api } from './agent-runtime';
import { MODEL_PRESETS, presetById, presetFor } from '../shared/model-presets.mjs';

const NONE = '__none__';
const CUSTOM_MODEL = '__custom__';

// 文字识别（OCR）设置：识别策略 + 可选专用识别模型。挂在模型设置对话框里
// （见 model-settings.jsx），与 Jev 设置同一布局模式。专用模型可以是云端视觉
// 模型，也可以是本机 Ollama/LM Studio 安装的视觉模型（detect-local 一键发现）。
export function OcrSettingsSection() {
  const [data, setData] = useState(null);
  const [strategy, setStrategy] = useState('auto');
  const [preset, setPreset] = useState(NONE);
  const [form, setForm] = useState({ model: '', baseUrl: '', apiKey: '' });
  const [modelDirty, setModelDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [detected, setDetected] = useState(null);
  useEffect(() => {
    let alive = true;
    api('/api/ocr-settings').then(d => {
      if (!alive) return;
      setData(d);
      setStrategy(d.strategy || 'auto');
      if (d.model) {
        setPreset(presetFor(d.model.provider, d.model.baseUrl).id);
        setForm({ model: d.model.model, baseUrl: d.model.baseUrl, apiKey: '' });
      }
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  function update(changes) { setForm(f => ({ ...f, ...changes })); setError(''); setStatus(''); }
  function choosePreset(id) {
    const target = presetById(id);
    setPreset(id);
    setModelDirty(true);
    setError(''); setStatus(''); setDetected(null);
    setForm(f => ({ ...f, model: target.models[0] || '', baseUrl: target.baseUrl, apiKey: '' }));
  }
  function modelPayload() {
    const spec = presetById(preset);
    return {
      provider: spec.provider,
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    };
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true); setError(''); setStatus('');
    try {
      const payload = { strategy };
      if (modelDirty) {
        if (preset === NONE) payload.clearModel = true;
        else payload.model = modelPayload();
      }
      const saved = await api('/api/ocr-settings', 'PUT', payload);
      setData(saved);
      setStrategy(saved.strategy || 'auto');
      setModelDirty(false);
      if (saved.model) {
        setPreset(presetFor(saved.model.provider, saved.model.baseUrl).id);
        setForm({ model: saved.model.model, baseUrl: saved.model.baseUrl, apiKey: '' });
      }
      setStatus(saved.model
        ? '已保存。新上传的图片资料立即按此配置识别，无需重启。'
        : '已保存。未配置专用识别模型，图片转录将使用主模型（需勾选支持图片）。');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function test(scope) {
    setBusy(true); setError(''); setStatus('');
    try {
      const body = scope === 'local'
        ? { scope }
        : modelDirty && preset !== NONE ? { model: modelPayload() } : {};
      const result = await api('/api/ocr-settings/test', 'POST', body);
      setStatus(`${result.message}${result.matched?.length ? ` 命中：${result.matched.join('、')}。` : ''}`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function detect() {
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await api('/api/ocr-settings/detect-local', 'POST', {});
      setDetected(result);
      setStatus(result.message);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function fillFromDetected(value) {
    const source = detected?.sources?.find(s => s.models.includes(value));
    if (!source) return;
    setPreset(source.source === 'ollama' ? 'ollama' : 'custom');
    setForm(f => ({ ...f, model: value, baseUrl: source.baseUrl, apiKey: '' }));
    setModelDirty(true);
    setStatus(`已填入本机模型 ${value}，保存后生效。`);
  }
  const spec = preset === NONE ? null : presetById(preset);
  const customModel = spec && spec.models.length > 0 && !spec.models.includes(form.model);
  const detectedModels = detected?.sources?.flatMap(s => s.models.map(m => ({ model: m, inForm: Boolean(spec && s.baseUrl === form.baseUrl) }))) || [];
  return <details className="model-jev-section">
    <summary>文字识别（OCR）</summary>
    <p>扫描件、拍照资料读文字的引擎与顺序。本机识别不联网；识别模型可以是云端视觉模型，也可以是本机安装的专用模型（数据不出电脑）。微信聊天窗口的读取始终用本机识别，不受这里影响。</p>
    {!data && !error && <p role="status">正在读取 OCR 配置…</p>}
    {data && <form onSubmit={save}>
      <fieldset disabled={busy}>
        <p className="muted">本机识别组件：{data.localAvailable ? '可用' : '不可用（Windows 需在系统语言设置安装中文文本识别）'} · 图片识别能力：{data.imageCapable ? '已具备' : '暂无（配置专用识别模型或勾选主模型支持图片）'}</p>
        <div role="radiogroup" aria-label="识别策略">
          {Object.entries(data.strategies).map(([key, label]) => (
            <label className="model-check" key={key}>
              <input type="radio" name="ocr-strategy" checked={strategy === key} onChange={() => { setStrategy(key); setError(''); setStatus(''); }} />
              {label}
            </label>
          ))}
        </div>
        <fieldset>
          <legend>专用识别模型（可选）</legend>
          <p>配置后，图片资料的模型转录与「重新识别」都改用这个模型，主模型不必支持图片。推荐本机安装：安装 Ollama 后执行 <code>ollama pull qwen2.5vl:7b</code>，再点「检测本机模型」。</p>
          <label>服务商<select value={preset} onChange={e => choosePreset(e.target.value)}>
            <option value={NONE}>不使用（主模型需支持图片）</option>
            {MODEL_PRESETS.map(p => <option value={p.id} key={p.id}>{p.label}</option>)}
          </select></label>
          {spec && <>
            {spec.models.length > 0 && <label>模型<select value={customModel ? CUSTOM_MODEL : form.model} onChange={e => { setModelDirty(true); update({ model: e.target.value === CUSTOM_MODEL ? '' : e.target.value }); }}>
              {spec.models.map(m => <option value={m} key={m}>{m}</option>)}
              <option value={CUSTOM_MODEL}>自定义…</option>
            </select></label>}
            {customModel && <label>模型 ID<input required value={form.model} onChange={e => { setModelDirty(true); update({ model: e.target.value }); }} placeholder="服务商提供的模型 ID" /></label>}
            {spec.models.length === 0 && <label>模型 ID<input required value={form.model} onChange={e => { setModelDirty(true); update({ model: e.target.value }); }} placeholder="服务商提供的模型 ID" /></label>}
            <label>API Key <span>{data.model?.hasKey && !modelDirty ? '已保存 · 留空保留现有密钥' : spec.provider === 'local' ? '本地服务可不填写' : '必填'}</span>
              <input type="password" autoComplete="new-password" value={form.apiKey} onChange={e => { setModelDirty(true); update({ apiKey: e.target.value }); }} placeholder={data.model?.hasKey && !modelDirty ? '••••••••（已保存）' : '粘贴 API Key'} required={!data.model?.hasKey || modelDirty ? spec.provider !== 'local' && !form.apiKey : false} />
            </label>
            <label>接口地址<input type="url" required value={form.baseUrl} onChange={e => { setModelDirty(true); update({ baseUrl: e.target.value }); }} placeholder={spec.baseUrl || 'https://your-provider.example/v1'} /></label>
            <button type="button" onClick={detect}>检测本机模型（Ollama / LM Studio）</button>
            {detectedModels.length > 0 && <label>本机检测到的模型<select value="" onChange={e => fillFromDetected(e.target.value)}>
              <option value="">选择以填入…</option>
              {detectedModels.map(item => <option value={item.model} key={item.model}>{item.model}{item.inForm ? '（当前）' : ''}</option>)}
            </select></label>}
          </>}
        </fieldset>
        <p className="model-privacy">「测试识别」会用一张内置的中文检验单样张实测引擎，配置了识别模型时会产生一次极小的图片请求；「测试本机识别」不联网。密钥加密保存在本机。</p>
        <footer>
          <button type="button" onClick={() => test('local')}>测试本机识别</button>
          <button type="button" onClick={() => test('model')}>测试识别模型</button>
          <button className="model-save" type="submit">保存 OCR 设置</button>
        </footer>
      </fieldset>
    </form>}
    {busy && <p role="status">正在处理，请稍候…</p>}
    {error && <p role="alert" className="model-settings-error">{error}</p>}
    {status && <p role="status" className="model-settings-success">{status}</p>}
  </details>;
}
