import { useEffect, useState } from 'react';
import { api } from '../../../src/agent-runtime';
import { SavedConnection } from '../../channel/ui/ConnectionForm.jsx';
import { ExperimentalNote, WECOM_BOT_NOTE } from '../../channel-wechat/ui/ExperimentalNote.jsx';
const when = value => value ? new Date(value).toLocaleString() : '尚未同步';
export function AibotConnectionForm(props) {
  const [saved, setSaved] = useState(props.initial);
  const accept = value => { setSaved(value); props.onSaved?.(value); };
  return <>
    <ExperimentalNote text={WECOM_BOT_NOTE} />
    <SavedConnection {...props} onSaved={accept} key={`conn:${saved.revision}`} />
    {saved.enabled && <AibotReplySettings key={`reply:${saved.revision}`} initial={saved} onSaved={accept} />}
    {saved.enabled && <AibotGroups key={`groups:${saved.revision}`} authorized={Boolean(saved.groupAutoReply)} />}
  </>;
}
function AibotReplySettings({ initial, onSaved }) {
  const [autoReply, setAutoReply] = useState(Boolean(initial.autoReply)), [groupAutoReply, setGroupAutoReply] = useState(Boolean(initial.groupAutoReply)), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const update = (key, value) => { if (key === 'autoReply') setAutoReply(value); else setGroupAutoReply(value); setConsent(false); setError(''); };
  return <form className="chat-setup" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { onSaved(await api('/api/chat-followups/connections/wecom-aibot', 'POST', { ...initial, autoReply, autoReplyConsent: consent, groupAutoReply, groupAutoReplyConsent: consent })); } catch (err) { setError(err.message); } finally { setBusy(false); } }}>
    <h4>自动回复授权</h4>
    <label className="chat-check"><input type="checkbox" checked={autoReply} onChange={e => update('autoReply', e.target.checked)} />自动起草回复（患者单聊）：新消息自动生成回复草稿，只进待审核队列，不会自动发送</label>
    <label className="chat-check"><input type="checkbox" checked={groupAutoReply} onChange={e => update('groupAutoReply', e.target.checked)} />群聊自动回复：在下方为具体群开启后，群里 @ 机器人的消息可自动回复（红旗症状自动回固定安全话术；普通回复先过安全筛查，未过筛或超过每群限频的转人工审核）</label>
    {(autoReply || groupAutoReply) && <label className="chat-check"><input required type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />我知道自动起草/回复会把会话内容发送给当前配置的模型服务</label>}
    {error && <p role="alert">{error}</p>}
    <button disabled={busy} type="submit">{busy ? '保存中…' : '保存授权'}</button>
  </form>;
}
// 群聊自动回复管理:逐群配置开关、是否自动发送、知识库范围、技能与限频;
// 最近活动里对待审核条目可修改后发送或不回复。
function AibotGroups({ authorized }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [editing, setEditing] = useState(null);
  const load = () => { api('/api/chat-aibot/groups').then(v => { setData(v); setError(''); }).catch(e => setError(e.message)); };
  useEffect(() => { load(); }, []);
  const act = async fn => { try { await fn(); load(); } catch (e) { setError(e.message); load(); } };
  return <section className="chat-setup" aria-label="群聊自动回复管理">
    <h4>群聊自动回复</h4>
    {!authorized && <p className="muted">先在上方的「群聊自动回复」授权中勾选同意,再在这里逐群开启。</p>}
    {authorized && <>
      <p className="muted">群里 @ 机器人后,该群开启自动回复即生效:红旗症状立即自动回安全话术;其余按本群选择的知识库与技能起草回复。关闭「自动发送」时回复只进下方待审核列表;发送时自动附 AI 助手说明。</p>
      {error && <p role="alert">{error}</p>}
      {!data && <p role="status">正在读取群配置…</p>}
      {data && <>
        {!!data.groups.length && <div className="chat-bindings">{data.groups.map(g => <GroupCard key={g.conversationId} group={g} live={data.live} act={act} onEdit={() => setEditing(g)} />)}</div>}
        <details open={!data.groups.length}><summary>添加群（机器人收到过消息的群会出现在这里）</summary>
          {!data.available.length && <p className="muted">还没有可见的群。在群里 @ 一次机器人后回来刷新即可。</p>}
          <div className="chat-name-suggestions">{data.available.map(c => <button key={c.conversationId} type="button" onClick={() => setEditing({ conversationId: c.conversationId, title: c.title || '' })}>{c.title || c.conversationId}</button>)}</div>
          <AddByRoomId onAdd={setEditing} />
        </details>
        {editing && <GroupForm draft={editing} skills={data.skills} collections={data.collections} onClose={() => setEditing(null)} act={act} />}
        <h4>最近活动与待审核</h4>
        {!data.recent.length && <p className="muted">暂无记录。群里的提问与机器人回复都会留痕在这里。</p>}
        {data.recent.map(r => <GroupReplyRow key={`${r.id}:${r.revision}`} row={r} act={act} />)}
      </>}
    </>}
  </section>;
}
function AddByRoomId({ onAdd }) {
  const [value, setValue] = useState('');
  return <form className="toolbar-actions" onSubmit={e => { e.preventDefault(); if (value.trim().startsWith('room:')) { onAdd({ conversationId: value.trim(), title: '' }); setValue(''); } }}>群 ID 不在列表时手动填入：<input value={value} onChange={e => setValue(e.target.value)} placeholder="room:开头的群会话 ID" maxLength={300} /><button disabled={!value.trim().startsWith('room:')}>填入配置</button></form>;
}
function GroupForm({ draft, skills, collections, onClose, act }) {
  const [form, setForm] = useState({ title: draft.title || '', enabled: draft.enabled === true, autoSend: draft.autoSend === true, kbCollection: draft.kbCollection || '', skillIds: Array.isArray(draft.skillIds) ? draft.skillIds : [], maxPerHour: draft.maxPerHour || 6, confirmed: false });
  const toggleSkill = id => setForm(v => ({ ...v, skillIds: v.skillIds.includes(id) ? v.skillIds.filter(s => s !== id) : v.skillIds.length >= 3 ? v.skillIds : [...v.skillIds, id], confirmed: false }));
  const update = (key, value) => setForm(v => ({ ...v, [key]: value, confirmed: false }));
  return <form className="chat-binding-form" onSubmit={e => { e.preventDefault(); act(async () => { await api('/api/chat-aibot/groups', 'POST', { ...form, conversationId: draft.conversationId, maxPerHour: Number(form.maxPerHour), confirmed: true }); onClose(); }); }}>
    <h3>配置群：{draft.conversationId}</h3>
    <div className="chat-form-grid">
      <label>群名称<input value={form.title} maxLength={150} onChange={e => update('title', e.target.value)} placeholder="方便辨认的名字,如「3 床家属群」" /></label>
      <label>每群每小时最多回复<input type="number" min="1" max="60" value={form.maxPerHour} onChange={e => update('maxPerHour', e.target.value)} /></label>
      <label>知识库范围<select aria-label="知识库范围" value={form.kbCollection} onChange={e => update('kbCollection', e.target.value)}><option value="">全部知识库（默认）</option>{(collections || []).map(name => <option key={name} value={name}>{name}</option>)}</select></label>
    </div>
    <label className="chat-check"><input type="checkbox" checked={form.enabled} onChange={e => update('enabled', e.target.checked)} />开启此群的自动回复</label>
    <label className="chat-check"><input type="checkbox" checked={form.autoSend} onChange={e => update('autoSend', e.target.checked)} />自动发送（不勾选则只生成回复草稿,由你逐条审核发送）</label>
    {form.autoSend && <p className="muted">自动发送仍有两道保险:红旗症状固定回安全话术;普通回复须通过出站安全筛查(剂量/用药调整/诊断结论/处方/超长),未通过自动转人工审核。</p>}
    {!!skills.length && <fieldset><legend>回答参考技能（最多 3 个,只作为回答思路,不改变安全规则）</legend><div className="chat-name-suggestions">{skills.map(s => <button key={s.id} type="button" aria-pressed={form.skillIds.includes(s.id)} onClick={() => toggleSkill(s.id)}>{s.title || s.name}</button>)}</div></fieldset>}
    <label className="chat-check"><input required type="checkbox" checked={form.confirmed} onChange={e => setForm(v => ({ ...v, confirmed: e.target.checked }))} />我已核对该群配置,同意按上述设置自动回复</label>
    <div className="toolbar-actions">
      <button type="submit" disabled={!form.confirmed}>保存群配置</button>
      {draft.enabled !== undefined && <button type="button" onClick={() => { if (window.confirm(`删除「${form.title || draft.conversationId}」的自动回复配置?留痕记录保留。`)) act(async () => { await api(`/api/chat-aibot/groups/${encodeURIComponent(draft.conversationId)}`, 'DELETE'); onClose(); }); }}>删除配置</button>}
      <button type="button" onClick={onClose}>取消</button>
    </div>
  </form>;
}
function GroupCard({ group, live, act, onEdit }) {
  return <article><div><strong>{group.title}</strong><p>{group.enabled ? `自动回复已开启${group.autoSend ? ' · 自动发送' : ' · 仅草稿待审核'}` : '已关闭'} · 每小时≤{group.maxPerHour}条{group.kbCollection ? ` · 知识库:${group.kbCollection}` : ''}{group.skillIds?.length ? ` · 技能 ${group.skillIds.length} 个` : ''}{live ? '' : ' · 长连接离线,发送会转待审核'}</p></div><div className="toolbar-actions"><button onClick={onEdit}>修改</button><button onClick={() => { if (window.confirm(`删除「${group.title}」的自动回复配置?`)) act(() => api(`/api/chat-aibot/groups/${encodeURIComponent(group.conversationId)}`, 'DELETE')); }}>删除</button></div></article>;
}
function GroupReplyRow({ row, act }) {
  const [text, setText] = useState(row.text), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = row.status === 'draft';
  const label = { auto_sent: '已自动发送', sent: '已发送', dismissed: '不回复', draft: row.sendError ? `发送失败,待人工重发(${row.sendError})` : '待审核' }[row.status] || row.status;
  if (!pending) return <p className="muted">[{row.title || row.conversation}] {label} · {when(row.sentAt || row.createdAt)} · {row.mode === 'safety' ? '⚠ 红旗安全话术' : `问:${row.question}`} · 答:{row.text}</p>;
  return <div className="chat-draft" style={{ borderLeft: row.urgent ? '3px solid #b91c1c' : undefined }}>
    <p><strong>[{row.title || row.conversation}]</strong> {row.urgent ? '⚠ 红旗症状' : `问:${row.question}`}{row.screen?.reasons?.length ? ` · 送审提示:${row.screen.reasons.join('、')}` : ''}</p>
    <label>回复内容<textarea rows={3} maxLength={2000} aria-label="回复内容" value={text} onChange={e => { setText(e.target.value); setConsent(false); }} /></label>
    <p className="muted">发送到群里,自动附 AI 助手说明;优先原路回复,失败自动回退主动推送。</p>
    {error && <p role="alert">{error}</p>}
    <div className="toolbar-actions">
      <label className="chat-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />我已核对本条回复内容</label>
      <button disabled={busy || !consent || !text.trim()} onClick={() => { setBusy(true); setError(''); act(async () => { await api(`/api/chat-aibot/group-replies/${row.id}/send`, 'POST', { text, consent: true }); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>{busy ? '正在发送…' : '通过并发送'}</button>
      <button disabled={busy} onClick={() => { if (window.confirm('确认不回复这条消息?')) { setBusy(true); act(() => api(`/api/chat-aibot/group-replies/${row.id}/dismiss`, 'POST', { confirmed: true })).catch(e => setError(e.message)).finally(() => setBusy(false)); } }}>不回复</button>
    </div>
  </div>;
}
