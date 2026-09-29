import { useCallback, useEffect, useState } from 'react';
import { api } from './agent-runtime';
import { ContactFacts, linkContact } from './care-contacts';
import './wecom-panel.css';

const labels = { draft: '草稿 · 未外发', submitting: '正在提交', unknown: '结果待核实 · 勿重复提交', awaiting_member: '待成员发送', sent: '已发送 · 不代表已读', rejected: '企业微信未接受', delivery_failed: '发送未完成' };
const RELATION = { self: '本人', family: '家属' };
const fmt = value => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

// The patient's WeCom side on one card: linked customers (本人/家属) with
// remark, tags and groups, customers that look like this patient, and
// member-confirmed follow-up tasks. Customers are synced automatically.
export function WeComPanel({ patientId }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('');
  const [query, setQuery] = useState(''), [results, setResults] = useState(null);
  const [bindingId, setBindingId] = useState(''), [text, setText] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const load = useCallback(async () => {
    const [info, tasks] = await Promise.all([api(`/api/wecom/patients/${patientId}`), api(`/api/wecom/tasks?patientId=${patientId}`).catch(() => ({ tasks: [] }))]);
    setState({ ...info, tasks: tasks.tasks });
  }, [patientId]);
  useEffect(() => { load().catch(e => setError(e.message)); }, [load]);
  useEffect(() => {
    if (!query.trim()) { setResults(null); return undefined; }
    const t = setTimeout(() => api(`/api/wecom/contacts?status=suggested,unmatched&q=${encodeURIComponent(query.trim())}`).then(v => setResults(v.contacts.slice(0, 8))).catch(() => setResults([])), 250);
    return () => clearTimeout(t);
  }, [query]);
  async function act(key, fn) { setBusy(key); setError(''); setNotice(''); try { const message = await fn(); if (message) setNotice(message); await load(); } catch (e) { setError(e.message); } finally { setBusy(''); } }
  const link = (c, relationship) => act(c.external, async () => { const message = await linkContact(c, patientId, relationship); setQuery(''); return message; });
  const active = (state?.linked || []).filter(b => b.active);
  const recipient = bindingId || (active.length === 1 ? active[0].bindingId : '');

  return <section className="wecom-panel" aria-label="企业微信患者联系">
    <div className="wecom-heading"><h3>企业微信</h3>
      <span className="pill">{!state ? '读取中' : !state.configured ? '未接入' : state.linked.length ? `已关联 ${state.linked.length} 位` : '未关联'}</span></div>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="muted">{notice}</p>}
    {state && !state.configured && <p className="muted">接入企业微信客户联系后，助理微信里的客户会自动同步，并推荐哪位是这个患者。可在「患者消息 → 客户与群」中打开接入向导。</p>}
    {state?.configured && <>
      {state.linked.map(b => <article className="wecom-binding" key={b.bindingId} aria-label={`${b.remark || b.name}（${RELATION[b.relationship]}）`}>
        <div className="wecom-heading"><b>{b.remark || b.name} · {RELATION[b.relationship]}</b>
          <button disabled={Boolean(busy)} onClick={() => { if (window.confirm(`解除「${b.remark || b.name}」与该患者的关联？`)) act(b.bindingId, async () => { await api(`/api/wecom/bindings/${b.bindingId}`, 'DELETE'); return '已解除关联。'; }); }}>解除关联</button></div>
        {!b.active && <p className="error">该客户已不在负责成员的好友里，请在企业微信核实。</p>}
        <ContactFacts contact={b} />
      </article>)}
      {state.suggestions.length > 0 && <div className="wecom-suggestions">
        <p><b>可能是该患者的微信</b> <small className="muted">核实后点一下即可关联</small></p>
        {state.suggestions.map(c => <article key={c.member + c.external} className="wecom-binding">
          <div className="wecom-heading"><b>{c.displayName}</b><small className="muted">{c.reasons.join('；')}</small></div>
          <ContactFacts contact={c} />
          <div className="wecom-actions">{['self', 'family'].map(rel => <button key={rel} className={rel === c.relationship ? 'primary' : ''} disabled={Boolean(busy)} onClick={() => link(c, rel)}>是{RELATION[rel]}，关联</button>)}</div>
        </article>)}
      </div>}
      {!state.linked.length && !state.suggestions.length && <p className="muted">没有找到像该患者的微信客户。{state.status.lastSyncAt ? '' : '客户尚未同步，稍后会自动同步。'}可以在下面按昵称或备注搜索。</p>}
      <label className="wecom-search">查找其他客户<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="昵称、备注或电话" /></label>
      {results && (results.length ? results.map(c => <article key={c.member + c.external} className="wecom-binding">
        <div className="wecom-heading"><b>{c.displayName}</b>
          <span className="wecom-actions">{['self', 'family'].map(rel => <button key={rel} disabled={Boolean(busy)} onClick={() => link(c, rel)}>是{RELATION[rel]}</button>)}</span></div>
        <ContactFacts contact={c} />
      </article>) : <p className="muted">没有匹配的未关联客户。</p>)}
      <p className="muted">客户与群每 6 小时自动同步{state.status.lastSyncAt ? `，上次 ${fmt(state.status.lastSyncAt)}` : ''}。企业微信里的私聊内容不会被收集；需要自动记录的对话请让患者使用微信客服链接。</p>

      {active.length > 0 && <fieldset disabled={Boolean(busy)}><legend>通过企业微信发随访（助理确认后发出）</legend>
        {active.length > 1 && <label>接收客户<select value={bindingId} onChange={e => { setBindingId(e.target.value); setRequestId(crypto.randomUUID()); }}><option value="">选择已关联客户</option>{active.map(b => <option key={b.bindingId} value={b.bindingId}>{b.remark || b.name} · {RELATION[b.relationship]}</option>)}</select></label>}
        <label>随访内容<textarea rows={3} value={text} maxLength={2000} onChange={e => { setText(e.target.value); setRequestId(crypto.randomUUID()); }} placeholder="填写需要核对或提醒的内容" /></label>
        <button disabled={!recipient || !text.trim()} onClick={() => act('draft', async () => { await api('/api/wecom/tasks', 'POST', { requestId, patientId, bindingId: recipient, text }); setText(''); setRequestId(crypto.randomUUID()); })}>保存草稿</button>
      </fieldset>}
      {state.tasks.length > 0 && <div className="wecom-tasks">{state.tasks.map(task => <article key={task.id} aria-label="企业微信随访任务"><div className="wecom-heading"><b>{task.recipient} · {RELATION[task.relationship]}</b><span>{labels[task.status] || task.status}</span></div><small>负责成员 {task.member} · {fmt(task.createdAt)}</small><p className="wecom-message">{task.text}</p>{task.detail && <p className="muted">{task.detail}</p>}
        {task.status === 'draft' && <button disabled={Boolean(busy)} onClick={() => { if (window.confirm(`确认将以下内容提交到企业微信？\n客户：${task.recipient}\n负责成员：${task.member}\n\n${task.text}\n\n提交后仍需成员确认发送。`)) act(task.id, async () => { await api(`/api/wecom/tasks/${task.id}/submit`, 'POST', { confirmed: true }); }); }}>核对并提交企业微信任务</button>}
        {task.msgid && task.status !== 'sent' && <button disabled={Boolean(busy)} onClick={() => act(task.id, async () => { await api(`/api/wecom/tasks/${task.id}/refresh`, 'POST', {}); })}>查询发送结果</button>}
      </article>)}</div>}
    </>}
  </section>;
}
