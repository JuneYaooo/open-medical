import { useEffect, useState } from 'react';
import { api } from './agent-runtime';
import './wecom-panel.css';

const labels = { draft: '草稿 · 未外发', submitting: '正在提交', unknown: '结果待核实 · 勿重复提交', awaiting_member: '待成员发送', sent: '已发送 · 不代表已读', rejected: '企业微信未接受', delivery_failed: '发送未完成' };
export function WeComPanel({ patientId }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [member, setMember] = useState(''), [contact, setContact] = useState(''), [relationship, setRelationship] = useState('self');
  const [verified, setVerified] = useState(false), [bindingId, setBindingId] = useState(''), [text, setText] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  async function load() {
    const [status, contacts, bindings, tasks] = await Promise.all([api('/api/wecom/status'), api('/api/wecom/contacts'), api(`/api/wecom/bindings?patientId=${patientId}`), api(`/api/wecom/tasks?patientId=${patientId}`)]);
    setState({ ...status, ...contacts, ...bindings, ...tasks });
  }
  useEffect(() => { let active = true;
    Promise.all([api('/api/wecom/status'), api('/api/wecom/contacts'), api(`/api/wecom/bindings?patientId=${patientId}`), api(`/api/wecom/tasks?patientId=${patientId}`)])
      .then(([status, contacts, bindings, tasks]) => { if (active) setState({ ...status, ...contacts, ...bindings, ...tasks }); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [patientId]);
  async function act(fn) { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const selected = state?.contacts.find(c => JSON.stringify([c.member, c.external]) === contact);
  return <section className="wecom-panel" aria-label="企业微信患者联系">
    <div className="wecom-heading"><h3>企业微信患者联系</h3><span className="pill">{state ? state.configured ? '已配置 · 待联调' : '尚未配置' : '读取配置中'}</span></div>
    <p className="muted">将客户关联到患者本人或家属，核对内容后创建随访发送任务。</p>
    {error && <p role="alert" className="error">{error}</p>}
    {state && !state.configured && <p>还没有企业微信也可以继续使用患者档案。开通并配置客户联系接口后，即可同步客户、关联患者和提交随访任务。</p>}
    <details><summary>接入配置与能力范围</summary>
      <p>客户联系接口不提供完整聊天记录。这里创建的任务，需要成员在企业微信确认发送；“已发送”以查询到的企业微信结果为准。</p>
      <p>配置企业 ID、具有客户联系权限的自建应用 Secret（加入“可调用应用”）、可信 IP；需要接收客户变更时，再配置公网 HTTPS 回调地址、Token 和 EncodingAESKey。</p>
      <p>企业 ID、客户联系 Secret、微信客服和提醒应用统一在「患者消息 → 设置 → 企业微信连接」中填写，保存即生效，并可一键测试连接。</p>
      <p>回调路径：<code>/api/wecom/callback</code> · {state?.callbackConfigured ? '回调密钥已配置' : '回调尚未配置'}{state?.lastEventAt ? ` · 最近接收 ${new Date(state.lastEventAt).toLocaleString()}` : ''}</p>
      <p>桌面应用退出后不接收回调。需要全天运行时，应另行部署常驻服务；当前未接入会话内容存档。</p>
    </details>
    {state?.configured && <>
      <fieldset disabled={busy}><legend>同步与关联客户</legend>
        <div className="wecom-fields"><label>负责成员 UserID<input value={member} onChange={e => setMember(e.target.value)} placeholder="企业通讯录中的成员 ID" /></label>
          <button disabled={!member.trim()} onClick={() => act(() => api('/api/wecom/sync', 'POST', { member: member.trim() }))}>同步该成员客户</button></div>
        <label>选择客户<select value={contact} onChange={e => { setContact(e.target.value); setVerified(false); }}><option value="">请选择已同步客户</option>{state.contacts.filter(c => c.active).map(c => <option key={JSON.stringify([c.member, c.external])} value={JSON.stringify([c.member, c.external])}>{c.name} · {c.member} · {c.external}</option>)}</select></label>
        <label>与患者关系<select value={relationship} onChange={e => { setRelationship(e.target.value); setVerified(false); }}><option value="self">患者本人</option><option value="family">患者家属</option></select></label>
        <label className="wecom-check"><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />我已核实此客户与当前患者的关系</label>
        <button disabled={!selected || !verified} onClick={() => act(async () => { await api('/api/wecom/bindings', 'POST', { patientId, member: selected.member, external: selected.external, relationship, confirmed: true }); setVerified(false); })}>确认关联</button>
      </fieldset>
      {state.bindings.map(b => <div className="wecom-binding" key={b.id}><span>{b.name} · {b.relationship === 'self' ? '本人' : '家属'} · {b.member}{!b.active ? ' · 联系关系失效，请同步核实' : ''}</span><button disabled={busy} onClick={() => act(() => api(`/api/wecom/bindings/${b.id}`, 'DELETE'))}>解除关联</button></div>)}
      <fieldset disabled={busy}><legend>随访草稿</legend>
        <label>接收客户<select value={bindingId} onChange={e => { setBindingId(e.target.value); setRequestId(crypto.randomUUID()); }}><option value="">选择已关联客户</option>{state.bindings.filter(b => b.active).map(b => <option key={b.id} value={b.id}>{b.name} · {b.relationship === 'self' ? '本人' : '家属'} · {b.member} · {b.external}</option>)}</select></label>
        <label>随访内容<textarea rows={3} value={text} maxLength={2000} onChange={e => { setText(e.target.value); setRequestId(crypto.randomUUID()); }} placeholder="填写需要核对或提醒的内容" /></label>
        <button disabled={!bindingId || !text.trim()} onClick={() => act(async () => { await api('/api/wecom/tasks', 'POST', { requestId, patientId, bindingId, text }); setText(''); setRequestId(crypto.randomUUID()); })}>保存草稿</button>
      </fieldset>
      <div className="wecom-tasks">{state.tasks.map(task => <article key={task.id} aria-label="企业微信随访任务"><div className="wecom-heading"><b>{task.recipient} · {task.relationship === 'self' ? '本人' : '家属'}</b><span>{labels[task.status] || task.status}</span></div><small>{task.member} · {task.external}</small><p className="wecom-message">{task.text}</p>{task.detail && <p className="muted">{task.detail}</p>}
        {task.status === 'draft' && <button disabled={busy} onClick={() => { if (window.confirm(`确认将以下内容提交到企业微信？\n客户：${task.recipient}（${task.external}）\n负责成员：${task.member}\n\n${task.text}\n\n提交后仍需成员确认发送。`)) act(() => api(`/api/wecom/tasks/${task.id}/submit`, 'POST', { confirmed: true })); }}>核对并提交企业微信任务</button>}
        {task.msgid && <button disabled={busy} onClick={() => act(() => api(`/api/wecom/tasks/${task.id}/refresh`, 'POST', {}))}>查询发送结果</button>}
      </article>)}</div>
    </>}
  </section>;
}
