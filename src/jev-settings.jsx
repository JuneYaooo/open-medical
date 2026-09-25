import { useEffect, useState } from 'react';
import { api } from './agent-runtime';

export function JevSettings() {
  const [form, setForm] = useState(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [status, setStatus] = useState('');
  useEffect(() => {
    let alive = true;
    api('/api/jev-settings').then(data => { if (alive) setForm({ ...data, apiKey: '' }); })
      .catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  const update = changes => { setForm(f => ({ ...f, ...changes })); setError(''); setStatus(''); };
  async function submit(test = false) {
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await api('/api/jev-settings' + (test ? '/test' : ''), test ? 'POST' : 'PUT', form);
      if (test) setStatus(`${result.message} 实际模型：${result.model}，耗时 ${result.durationMs} 毫秒。`);
      else {
        setForm({ ...result, apiKey: '' });
        setStatus(result.enabled ? '已启用后台观察，从下一次任务判断起生效。' : '已关闭；后续任务不再调用 Jev。');
      }
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <details className="jev-settings">
    <summary>决策辅助 · Jev（默认关闭）</summary>
    <p>可选后台观察：每个新任务最多判断一次任务类型，记录结果。当前版本不调整主模型、工具、上下文或审批。</p>
    {!form && !error && <p role="status">正在读取配置…</p>}
    {form && <form onSubmit={e => { e.preventDefault(); submit(); }}>
      <fieldset disabled={busy}>
        <label>运行方式<select value={form.enabled ? 'shadow' : 'off'} onChange={e => update({ enabled: e.target.value === 'shadow' })}>
          <option value="off">关闭</option><option value="shadow">启用后台观察</option>
        </select></label>
        <label>Jev API Key<span>{form.hasKey ? '已保存 · 留空保留' : '启用或测试前填写'}</span>
          <input type="password" autoComplete="new-password" value={form.apiKey} onChange={e => update({ apiKey: e.target.value, clearKey: false })} />
        </label>
        <label>Jev 模型<input value={form.model} required onChange={e => update({ model: e.target.value })} /></label>
        <label>判断超时（毫秒）<input type="number" min="100" max="10000" value={form.timeoutMs} onChange={e => update({ timeoutMs: Number(e.target.value) })} /></label>
        <label>任务文本发送许可<select value={form.consent ? 'yes' : 'no'} onChange={e => update({ consent: e.target.value === 'yes' })}>
          <option value="no">不允许发送任务文本</option><option value="yes">同意向 TypeSafe 发送当前任务文本</option>
        </select></label>
        <p>启用后会将当前任务文本（可能包含你输入的患者信息）发送至 api.typesafe.ai，可能产生费用。不附带历史消息、附件或工作区文件；超过 4000 字符的任务跳过。失败时继续原流程。密钥加密保存在本机。</p>
        <p>测试连接仅发送固定示例文本，不保存配置、不启用服务。关闭不撤回已经发出的请求。</p>
        {form.latest && <p>最近判断：{form.latest.status} · {form.latest.choice || form.latest.reason} · {form.latest.model || '—'} · {form.latest.durationMs ?? '—'} 毫秒</p>}
        <footer>
          <button type="button" onClick={() => update({ apiKey: '', hasKey: false, clearKey: true, enabled: false })}>清除密钥（保存后生效）</button>
          <button type="button" onClick={() => submit(true)}>测试 Jev 连接</button>
          <button className="model-save" type="submit">保存 Jev 设置</button>
        </footer>
      </fieldset>
    </form>}
    {busy && <p role="status">正在处理…</p>}
    {error && <p role="alert" className="model-settings-error">{error}</p>}
    {status && <p role="status" className="model-settings-success">{status}</p>}
  </details>;
}
