import { useEffect, useState } from 'react';
import { api } from './agent-runtime';
import { MODEL_PRESETS, presetById, presetFor } from '../shared/model-presets.mjs';

const NONE = '__none__';
const CUSTOM_MODEL = '__custom__';
// OCR 难例兜底模型走云端视觉服务即可；本机识别由 PaddleOCR 服务承担，
// 不在本面板提供 Ollama 预设（主模型设置里的本地模型不受影响）。
const OCR_MODEL_PRESETS = MODEL_PRESETS.filter(p => p.id !== 'ollama');
const presetIdFor = (provider, baseUrl) => {
  const id = presetFor(provider, baseUrl).id;
  return id === 'ollama' ? CUSTOM_MODEL : id;
};

// 文字识别（OCR）设置：识别策略 + 本机识别服务（PaddleOCR）+ 可选专用识别
// 模型。挂在模型设置对话框里（见 model-settings.jsx），与 Jev 设置同一布局
// 模式。三层引擎：PaddleOCR 服务（兼容 medagent-gpu-worker /v1/ocr 接口）→
// 操作系统识别组件 → 专用/主模型视觉转录；「模型优先」时模型先行。
export function OcrSettingsSection() {
  const [data, setData] = useState(null);
  const [strategy, setStrategy] = useState('auto');
  const [serviceForm, setServiceForm] = useState({ baseUrl: '', apiKey: '' });
  const [serviceDirty, setServiceDirty] = useState(false);
  const [preset, setPreset] = useState(NONE);
  const [form, setForm] = useState({ model: '', baseUrl: '', apiKey: '' });
  const [modelDirty, setModelDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  // 本机 PaddleOCR 引擎：状态轮询 + 安装/启停。安装只在医生点击确认后进行。
  const [engine, setEngine] = useState(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const pollEngine = () => api('/api/ocr-settings/local-engine').then(d => { setEngine(d); return d; }).catch(() => null);
  useEffect(() => { pollEngine(); }, []);
  useEffect(() => {
    let alive = true;
    api('/api/ocr-settings').then(d => {
      if (!alive) return;
      setData(d);
      setStrategy(d.strategy || 'auto');
      if (d.service) setServiceForm({ baseUrl: d.service.baseUrl, apiKey: '' });
      if (d.model) {
        setPreset(presetIdFor(d.model.provider, d.model.baseUrl));
        setForm({ model: d.model.model, baseUrl: d.model.baseUrl, apiKey: '' });
      }
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  async function adoptEngine(d) {
    // 装好/启动后把服务配置指向本机引擎，识别立即生效（不动策略与模型）。
    const saved = await api('/api/ocr-settings', 'PUT', { service: { baseUrl: d.baseUrl } });
    setData(saved);
    setServiceDirty(false);
    setServiceForm({ baseUrl: d.baseUrl, apiKey: '' });
  }
  async function installEngine() {
    setEngineBusy(true); setError(''); setStatus(''); setConfirmInstall(false);
    try {
      await api('/api/ocr-settings/local-engine/install', 'POST');
      let d = await pollEngine();
      while (d?.installing) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        d = await pollEngine();
      }
      if (d?.error) setError(d.error);
      else if (d?.baseUrl) {
        await adoptEngine(d);
        setStatus(`本机 PaddleOCR 已装好并运行（${d.baseUrl}），本机识别现在优先走它。新上传的图片资料立即生效。`);
      }
    } catch (e) { setError(e.message); } finally { setEngineBusy(false); pollEngine(); }
  }
  async function startEngine() {
    setEngineBusy(true); setError(''); setStatus('');
    try {
      const d = await api('/api/ocr-settings/local-engine/start', 'POST');
      await adoptEngine(d);
      setStatus(`本机引擎已启动（${d.baseUrl}），本机识别现在优先走它。`);
    } catch (e) { setError(e.message); } finally { setEngineBusy(false); pollEngine(); }
  }
  async function stopEngine() {
    setEngineBusy(true); setError(''); setStatus('');
    try {
      const d = await api('/api/ocr-settings/local-engine/stop', 'POST');
      const saved = await api('/api/ocr-settings');
      setData(saved);
      setStatus('本机引擎已停止；本机识别落回系统组件。需要时点「启动本机引擎」或重新安装。');
      void d;
    } catch (e) { setError(e.message); } finally { setEngineBusy(false); pollEngine(); }
  }
  function update(changes) { setForm(f => ({ ...f, ...changes })); setError(''); setStatus(''); }
  function updateService(changes) { setServiceForm(f => ({ ...f, ...changes })); setServiceDirty(true); setError(''); setStatus(''); }
  function servicePayload() {
    const baseUrl = serviceForm.baseUrl.trim();
    if (!baseUrl) return null;
    return { baseUrl, ...(serviceForm.apiKey.trim() ? { apiKey: serviceForm.apiKey.trim() } : {}) };
  }
  function choosePreset(id) {
    const target = presetById(id);
    setPreset(id);
    setModelDirty(true);
    setError(''); setStatus('');
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
      if (serviceDirty) {
        const service = servicePayload();
        if (service) payload.service = service;
        else payload.clearService = true;
      }
      if (modelDirty) {
        if (preset === NONE) payload.clearModel = true;
        else payload.model = modelPayload();
      }
      const saved = await api('/api/ocr-settings', 'PUT', payload);
      setData(saved);
      setStrategy(saved.strategy || 'auto');
      setServiceDirty(false);
      setServiceForm(saved.service ? { baseUrl: saved.service.baseUrl, apiKey: '' } : { baseUrl: '', apiKey: '' });
      setModelDirty(false);
      if (saved.model) {
        setPreset(presetIdFor(saved.model.provider, saved.model.baseUrl));
        setForm({ model: saved.model.model, baseUrl: saved.model.baseUrl, apiKey: '' });
      }
      setStatus(`已保存（本机服务：${saved.service ? '已配置' : '未配置'}；识别模型：${saved.model ? saved.model.model : '未配置'}）。新上传的图片资料立即按此配置识别，无需重启。`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function test(scope) {
    setBusy(true); setError(''); setStatus('');
    try {
      const body = scope === 'local'
        ? { scope, ...(serviceDirty && servicePayload() ? { service: servicePayload() } : {}) }
        : modelDirty && preset !== NONE ? { model: modelPayload() } : {};
      const result = await api('/api/ocr-settings/test', 'POST', body);
      setStatus(`${result.message}${result.matched?.length ? ` 命中：${result.matched.join('、')}。` : ''}`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const spec = preset === NONE ? null : presetById(preset);
  const customModel = spec && spec.models.length > 0 && !spec.models.includes(form.model);
  // 外层的 details 折叠由 model-settings.jsx 提供；这里只渲染内容，
  // 否则医生点开「文字识别（OCR）」看到的又是同一个标题的空折叠。
  return <div className="model-jev-section-body">
    <p>扫描件、拍照资料读文字的引擎与顺序：本机识别（PaddleOCR 服务或系统组件）优先，质量差时自动改用识别模型重试；「仅本机」策略下图片不会发给任何大模型。微信聊天窗口的读取始终用系统本机识别，不受这里影响。</p>
    {!data && !error && <p role="status">正在读取 OCR 配置…</p>}
    {data && <form onSubmit={save}>
      <fieldset disabled={busy}>
        <p className="muted">本机识别服务：{data.service ? '已配置' : '未配置'} · 专用识别模型：{data.model ? '已配置' : '未配置'} · 图片识别能力：{data.imageCapable ? '已具备' : '暂无'}</p>
        <div role="radiogroup" aria-label="识别策略">
          {Object.entries(data.strategies).map(([key, label]) => (
            <label className="model-check" key={key}>
              <input type="radio" name="ocr-strategy" checked={strategy === key} onChange={() => { setStrategy(key); setError(''); setStatus(''); }} />
              {label}
            </label>
          ))}
        </div>
        <fieldset>
          <legend>本机识别服务（PaddleOCR，推荐）</legend>
          <p>兼容 medagent-gpu-worker 的 <code>/v1/ocr</code> 接口（部署在 GPU/服务器上的 PaddleOCR 服务，见该仓库的 AutoDL 脚本）。中文文档识别质量远好于系统组件，且只转录原文、不会像大模型一样改写。配置后本机识别优先走它，服务不可达时自动落回系统组件；「仅本机识别」策略下图片也只会发到你自己的这个服务。接口地址如 <code>http://127.0.0.1:18090</code>；worker 设置了 WORKER_API_KEY 时填写 API Key。</p>
          <label>接口地址<input type="url" value={serviceForm.baseUrl} onChange={e => updateService({ baseUrl: e.target.value })} placeholder="http://127.0.0.1:18090" /></label>
          <label>API Key <span>{data.service?.hasKey && !serviceDirty ? '已保存 · 留空保留现有密钥' : '服务未启用鉴权时可留空'}</span>
            <input type="password" autoComplete="new-password" value={serviceForm.apiKey} onChange={e => updateService({ apiKey: e.target.value })} placeholder={data.service?.hasKey && !serviceDirty ? '••••••••（已保存）' : '粘贴 WORKER_API_KEY'} />
          </label>
          <div className="ocr-local-engine">
            <p className="muted">没有现成的 PaddleOCR 服务？可以让工作台在本机装一个（独立的虚拟环境，不影响系统 Python；只在下面点确认后才下载，约 300MB，装不上会提示原因，不会后台强装）。</p>
            {engine?.installing && <p role="status">正在安装本机引擎：{engine.step}{engine.detail ? ` · ${engine.detail}` : ''}…（可关闭此窗口，安装继续）</p>}
            {!engine?.installing && !engine?.installed && !confirmInstall && <button type="button" disabled={engineBusy} onClick={() => setConfirmInstall(true)}>在本机安装 PaddleOCR 识别引擎…</button>}
            {!engine?.installing && confirmInstall && <div role="group" aria-label="确认安装">
              <p className="muted">即将在本机安装 PaddleOCR：创建独立虚拟环境 → 下载并安装约 300MB 依赖（自动尝试清华/阿里镜像）→ 下载识别模型（约 20MB）→ 在本机 <code>{engine?.port ? `127.0.0.1:${engine.port}` : '127.0.0.1'}</code> 启动识别服务并设为本机识别。需要 Python 3.9–3.12（未检测到会直接提示，不会替你装 Python）。整个过程几分钟到半小时，取决于网络；任何一步失败都会说明原因，已下载内容保留、重试续用。</p>
              <button className="model-save" type="button" disabled={engineBusy} onClick={installEngine}>确认安装</button>
              <button type="button" disabled={engineBusy} onClick={() => setConfirmInstall(false)}>取消</button>
            </div>}
            {engine?.installed && !engine?.running && !engine?.installing && <button type="button" disabled={engineBusy} onClick={startEngine}>启动本机引擎（{engine.baseUrl}）</button>}
            {engine?.running && <p className="muted">本机引擎运行中：<code>{engine.baseUrl}</code> <button className="text-button" type="button" disabled={engineBusy} onClick={stopEngine}>停止</button>（停止后本机识别落回系统组件）</p>}
            {!!engine?.python && !engine?.installing && <p className="muted">检测到 Python {engine.python.version}；安装位置 <code>{engine.root}</code></p>}
          </div>
        </fieldset>
        <fieldset>
          <legend>专用识别模型（可选，难例兜底）</legend>
          <p>盖章、手写、复杂表格等本机识别读不好的页面，质量差时会自动升级到这个视觉模型重转录；「模型优先」策略则直接用它。填云端视觉模型服务商即可；不配置时沿用主模型（需勾选支持图片）。</p>
          <label>服务商<select value={preset} onChange={e => choosePreset(e.target.value)}>
            <option value={NONE}>不使用（主模型需支持图片）</option>
            {OCR_MODEL_PRESETS.map(p => <option value={p.id} key={p.id}>{p.label}</option>)}
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
          </>}
        </fieldset>
        <p className="model-privacy">「测试本机识别」会用一张内置的中文检验单样张实测引擎——配置了服务时向服务发一次真实请求（可用未保存的表单值先测），未配置时离线测系统组件。「测试识别模型」向所填服务发一次极小的图片请求。密钥加密保存在本机。</p>
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
  </div>;
}
