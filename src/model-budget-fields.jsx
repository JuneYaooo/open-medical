import { resolveModelContext } from '../shared/model-context.mjs';

export function ModelBudgetFields({ form, onChange }) {
  const resolved = resolveModelContext(form);
  const format = (value) => value.toLocaleString('en-US');
  const reserve = Number(form.maxTokens ?? 8192) + (form.provider === 'anthropic' ? 4096 : 0);
  return <div className="model-budget-fields">
    <label>上下文窗口 Token（留空自动选择）
      <input type="number" min="512" max="10000000" step="1"
        placeholder={String(resolved.defaultContextWindow)} value={form.contextWindow ?? ''}
        onChange={(e) => onChange({ contextWindow: e.target.value === '' ? null : Number(e.target.value) })} />
    </label>
    <p>当前生效：{format(resolved.contextWindow)} Token · {resolved.windowSource === 'configured' ? '手动设置' : resolved.windowSource === 'model_default' ? '模型默认值' : '备用预算，模型规格待确认'}。
      {resolved.sourceUrl && <> <a href={resolved.sourceUrl} target="_blank" rel="noreferrer">官方规格</a>（核对于 {resolved.verifiedAt}）</>}
      {resolved.defaultSource === 'legacy_default_unverified' && ' 未识别的模型、本地服务或第三方接口，请按实际部署上限填写。'}
    </p>
    {form.contextWindow != null && <button type="button" onClick={() => onChange({ contextWindow: null })}>恢复自动选择</button>}
    <label>最大输出 Token<input type="number" min="256" max="131072" step="1"
      value={form.maxTokens ?? 8192} onChange={(e) => onChange({ maxTokens: Number(e.target.value) })} /></label>
    <p>输入与工具可用预算约 {format(Math.max(0, resolved.contextWindow - reserve - 128))} Token。上下文需同时容纳输入、工具和输出；Anthropic 深入思考另预留 4096。填写更大的数值不会扩展服务商的实际容量。</p>
    {reserve + 128 >= resolved.contextWindow && <p role="alert">输出预留已占满窗口，请降低最大输出或核对上下文设置。</p>}
  </div>;
}
