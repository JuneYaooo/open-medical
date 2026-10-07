import { useEffect, useState } from 'react';
import { api } from './agent-runtime';

const STATUS = { none: '待生成话术', draft: '待发送', sent: '已发送，等待回复', replied: '已回复，待整理', recorded: '已归档' };
const when = (v) => (v ? new Date(v).toLocaleString() : '');

// 微信(桌面版)自动随访队列:到期任务 → AI 起草话术 → 医生确认发送 → 监听模式回收回复
// → 按条目整理为随访记录 → 医生确认归档。两个人工检查点:发送前、归档前。
export function WechatOutreachPanel() {
  const [data, setData] = useState(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(''), [offset, setOffset] = useState(0);
  const load = () => api(`/api/chat-autofollow/queue?limit=20&offset=${offset}`).then((v) => { setData(v); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [offset]);
  const act = (key, fn, done) => async () => {
    setBusy(key); setError(''); setNotice('');
    try { const r = await fn(); if (done) done(r); await load(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const bulk = async () => {
    let n = 0;
    for (const it of (data?.items || [])) if (!it.outreach && it.bindingId) { await api(`/api/chat-autofollow/${it.jobId}/generate`, 'POST', {}); n++; }
    return n;
  };
  return <section aria-label="微信自动随访">
    <div className="toolbar-actions">
      <button disabled={busy !== '' || !data} onClick={act('bulk', bulk, (n) => setNotice(`已为 ${n} 个到期随访生成话术草稿`))}>为未生成的到期随访批量生成话术</button>
      {notice && <span className="muted">{notice}</span>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!data && !error && <p role="status">正在读取微信随访队列…</p>}
    {data && !data.items.length && <p className="care-empty"><p>当前没有到期的微信随访任务。</p><p className="care-hint">在患者档案里应用随访模板后，到期任务会出现在这里；患者的微信会话需先在「聊天随访」中关联并校准。</p></p>}
    <ul className="care-list">{(data?.items || []).map((it) => <OutreachItem key={`${it.jobId}:${it.outreach?.revision || 0}`} it={it} busy={busy} act={act} />)}</ul>
    <nav className="toolbar-actions" aria-label="微信随访分页"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span>第 {Math.floor(offset / 20) + 1} 页</span><button disabled={(data?.items?.length || 0) < 20} onClick={() => setOffset(offset + 20)}>下一页</button></nav>
  </section>;
}

function OutreachItem({ it, busy, act }) {
  const o = it.outreach;
  const [text, setText] = useState(o?.text || '');
  const [consent, setConsent] = useState(false);
  const [note, setNote] = useState(o?.record?.summary || '');
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { setText(o?.text || ''); setNote(o?.record?.summary || ''); setConsent(false); setConfirmed(false); }, [it.outreach?.revision]);
  const wechatOk = Boolean(it.bindingId);
  return <li className="care-card">
    <header><strong>{it.patientName}</strong><span className="care-tag">{it.name}</span><span className="care-tag">{STATUS[o?.status || 'none']}</span>
      {o?.urgent && <span className="care-tag" role="alert">⚠ 需医生关注：{(o.redFlags || []).join('、') || '模型提示'}</span>}
      {!wechatOk && <span className="care-tag">未关联微信</span>}
      <time className="muted">到期 {when(it.nextDue)}</time>
    </header>
    {!!it.checklist.length && <ol className="muted">{it.checklist.map((c) => <li key={c}>{c}</li>)}</ol>}
    {(!o || !o.text) && <button disabled={busy !== '' || !wechatOk} onClick={act(`g-${it.jobId}`, () => api(`/api/chat-autofollow/${it.jobId}/generate`, 'POST', {}))}>{busy === `g-${it.jobId}` ? '正在生成…' : '生成随访话术'}</button>}
    {o?.text && o.status === 'draft' && <>
      {o.screen && !o.screen.ok && <p className="form-error" role="note">话术筛查提示：{o.screen.reasons.join('；')}。请人工核对后自行决定是否发送。</p>}
      <label>随访消息<textarea rows={3} maxLength={2000} value={text} onChange={(e) => { setText(e.target.value); setConsent(false); }} /></label>
      <label className="chat-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />我已核对话术与该患者的对应关系，确认发送</label>
      <button disabled={busy !== '' || !wechatOk || !consent || !text.trim()} onClick={act(`s-${it.jobId}`, () => api(`/api/chat-autofollow/${it.jobId}/send`, 'POST', { text, consent: true }), () => setNotice('已发送并在微信窗口内核验'))}>{busy === `s-${it.jobId}` ? '正在核验发送…' : '发送到微信'}</button>
    </>}
    {o?.status === 'sent' && <p className="muted">已发送{when(o.sentAt)}；监听模式读到患者回复后，这里会提示整理。</p>}
    {(o?.status === 'replied' || o?.record) && <>
      {o.replyText && <p>患者回复：{o.replyText.length > 300 ? `${o.replyText.slice(0, 300)}…` : o.replyText} <button disabled={busy !== ''} onClick={act(`r-${it.jobId}`, () => api(`/api/chat-autofollow/${it.jobId}/record`, 'POST', {}))}>{busy === `r-${it.jobId}` ? '正在整理…' : '按条目整理为随访记录'}</button></p>}
      {o.record && <>
        <p>{o.record.needsDoctor ? '⚠ 模型提示需要医生关注：' : ''}{o.record.summary}</p>
        <label>随访记录<textarea rows={3} maxLength={4500} value={note} onChange={(e) => { setNote(e.target.value); setConfirmed(false); }} /></label>
        <label className="chat-check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />已核对记录内容，确认归档到随访记录（一次性任务将同步完成）</label>
        <button disabled={busy !== '' || !confirmed || !note.trim()} onClick={act(`a-${it.jobId}`, () => api(`/api/chat-autofollow/${it.jobId}/archive`, 'POST', { note, contactedAt: o.repliedAt, confirmed: true }), () => setNotice('已归档到随访记录'))}>归档到随访记录</button>
      </>}
    </>}
    {o?.status === 'recorded' && <p className="muted">已归档 ✓ {when(o.recordedAt)}</p>}
  </li>;
}
