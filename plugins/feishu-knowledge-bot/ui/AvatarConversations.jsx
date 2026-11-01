import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../src/agent-runtime';
import './avatar.css';

const BASE = '/api/knowledge-bot';
const FILTERS = [['all', '全部'], ['attention', '需关注'], ['review', '需复核'], ['unanswered', '未答问题'], ['paused', '我来回复中']];
const time = value => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const STATUS = { sending: '发送中', failed: '发送失败', cancelled: '未发送' };

function Badges({ c }) {
  return <span className="avatar-badges">
    {c.needsAttention && <span className={`om-chip ${c.attentionKind === 'red-flag' ? 'is-danger' : 'is-caution'}`}>{c.attentionKind === 'red-flag' ? '需关注' : '需复核'}</span>}
    {c.unanswered > 0 && <span className="om-chip is-info">未答 {c.unanswered}</span>}
    {c.paused && <span className="om-chip">我来回复中</span>}
    {c.followUpAt && <span className="om-chip">稍后联系 {new Date(c.followUpAt).toLocaleDateString('zh-CN')}</span>}
  </span>;
}

function Bubble({ turn, target }) {
  const ref = useRef(null);
  useEffect(() => { if (target) ref.current?.scrollIntoView?.({ block: 'center' }); }, [target]);
  const out = turn.direction === 'out', doctor = turn.flags.by === 'doctor';
  return <div ref={ref} className={`avatar-bubble${out ? ' is-out' : ''}${doctor ? ' is-doctor' : ''}${target ? ' is-target' : ''}`}>
    <div className="avatar-bubble-meta"><strong>{out ? (doctor ? '我（医生本人）' : '分身') : turn.senderName || '提问人'}</strong><span>{time(turn.at)}</span>
      {STATUS[turn.status] && <span className="om-chip is-danger">{STATUS[turn.status]}</span>}
      {turn.flags.paused && <span className="om-chip">分身已暂停，未自动回复</span>}
      {turn.flags.kind === 'safety' && <span className="om-chip is-danger">安全提示回复</span>}
      {turn.flags.noSource && <span className="om-chip is-info">未找到依据</span>}
    </div>
    {turn.text}
    {turn.flags.redFlags?.length > 0 && <div className="avatar-flag">危险信号：{turn.flags.redFlags.map(f => f.label).join('、')}</div>}
    {turn.flags.inbound?.length > 0 && <div className="avatar-flag">{turn.flags.inbound.join('、')}</div>}
    {turn.flags.review?.length > 0 && <div className="avatar-flag">需复核：{turn.flags.review.join('；')}{turn.flags.handled ? '（已处理）' : ''}</div>}
    {turn.flags.error && <div className="avatar-flag">{turn.flags.error}</div>}
    {turn.sources?.length > 0 && <details><summary>引用资料 {turn.sources.length} 条</summary><ol>{turn.sources.map((s, i) => <li key={i}>{s.docTitle} · {s.collection}{s.startLine ? ` · 第 ${s.startLine}–${s.endLine} 行` : ''}</li>)}</ol></details>}
  </div>;
}

function PatientPicker({ onPick, onCancel }) {
  const [q, setQ] = useState(''), [list, setList] = useState([]), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => api(`/api/patients?${new URLSearchParams({ q })}`).then(v => { if (alive) setList((v.patients || []).slice(0, 8)); }).catch(e => { if (alive) setError(e.message); }), 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [q]);
  return <div className="avatar-inline-form">
    <input type="search" aria-label="搜索患者" placeholder="输入姓名或编号" value={q} onChange={e => setQ(e.target.value)} autoFocus />
    {list.map(p => <button key={p.id} type="button" className="secondary" onClick={() => onPick(p)}>{p.name}{p.patientNumber ? ` · ${p.patientNumber}` : ''}</button>)}
    {!list.length && <span className="avatar-hint">{error || '没有匹配的患者'}</span>}
    <button type="button" className="text-button" onClick={onCancel}>取消</button>
  </div>;
}

function gapText(gap) {
  return `【建议补充】${gap.title}\n建议放入：${gap.collection || '（未指定）'}\n需要覆盖：${gap.cover}`;
}

export function InsightReport({ report, onOpenTurn }) {
  const [notice, setNotice] = useState('');
  async function supplement(gap) {
    // The knowledge module has no draft state: a created document would be
    // searchable by the avatar immediately, so hand over the suggestion text.
    let copied = false;
    try { await navigator.clipboard.writeText(gapText(gap)); copied = true; } catch { /* clipboard unavailable */ }
    setNotice(copied ? '建议内容已复制，正在打开知识库，可粘贴到新资料中。' : '无法写入剪贴板，请手动记下建议内容。正在打开知识库。');
    const params = new URLSearchParams({ view: 'knowledge', ...(gap.existingCollection ? { collection: gap.collection } : {}) });
    setTimeout(() => window.location.assign(`/?${params}`), 900);
  }
  return <article className="avatar-insight" aria-label="AI 总结">
    <h3>{report.headline || 'AI 总结'}</h3>
    <p className="avatar-hint">{new Date(report.createdAt).toLocaleString('zh-CN')} · {report.chatId ? '单个会话' : '全部会话'} · 近 {report.rangeDays} 天 · {report.turnCount} 条消息 · AI 整理，请结合原话核对</p>
    {notice && <p role="status">{notice}</p>}
    <h4>大家最关注的问题</h4>
    {report.topics?.length ? <ol>{report.topics.map((t, i) => <li key={i}><strong>{t.title}</strong>{t.count ? ` · 约 ${t.count} 次` : ''}
      {t.examples.map(e => <div key={e.turnId} className="avatar-quote">“<button type="button" onClick={() => onOpenTurn?.(e.chatId, e.turnId)}>{e.quote}</button>”</div>)}</li>)}</ol> : <p className="avatar-hint">没有归纳出明显的主题。</p>}
    <h4>反馈与情绪</h4>
    <p>{report.feedback?.summary || '暂无明显反馈。'}</p>
    {[['satisfied', '满意'], ['complaints', '不满或投诉'], ['confusion', '困惑']].map(([key, label]) => report.feedback?.[key]?.length > 0 && <p key={key}><strong>{label}：</strong>{report.feedback[key].join('；')}</p>)}
    <h4>知识库缺口建议</h4>
    {report.unanswered?.total > 0 && <p className="avatar-hint">期间分身有 {report.unanswered.total} 次没有找到依据（按记录统计，不依赖模型）。</p>}
    {report.gaps?.length ? <ul className="avatar-gaps">{report.gaps.map((g, i) => <li key={i} className="avatar-gap">
      <strong>{g.title}</strong>{g.collection && <span className="avatar-hint"> · 建议放入「{g.collection}」{g.existingCollection ? '' : '（新库）'}</span>}
      <div>{g.cover}</div>
      <div className="avatar-actions">
        {(g.refs || []).slice(0, 3).map((ref, n) => <button key={ref.turnId} type="button" className="text-button" onClick={() => onOpenTurn?.(ref.chatId, ref.turnId)}>相关原话 {n + 1}</button>)}
        <button type="button" className="secondary" onClick={() => supplement(g)}>去知识库补充</button>
      </div>
    </li>)}</ul> : <p className="avatar-hint">暂未发现需要补充的资料。</p>}
  </article>;
}

function Insights({ chatId, onOpenTurn, modelReady }) {
  const [list, setList] = useState([]), [open, setOpen] = useState(null), [unanswered, setUnanswered] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = useCallback(() => {
    api(`${BASE}/insights`).then(v => setList((v.insights || []).filter(r => !chatId || r.chatId === chatId))).catch(e => setError(e.message));
    if (!chatId) api(`${BASE}/unanswered?rangeDays=30`).then(setUnanswered).catch(() => {});
  }, [chatId]);
  useEffect(() => { load(); setOpen(null); }, [load]);
  async function run(rangeDays) {
    setBusy(true); setError('');
    try { const report = await api(`${BASE}/insights`, 'POST', { chatId: chatId || '', rangeDays }); setOpen(report); load(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="avatar-section" aria-label="AI 总结">
    <h3>{chatId ? 'AI 总结这段会话' : 'AI 会话洞察'}</h3>
    <div className="avatar-actions">
      {chatId ? <button type="button" className="secondary" disabled={busy || !modelReady} onClick={() => run(90)}>AI 总结</button> : <>
        <button type="button" className="secondary" disabled={busy || !modelReady} onClick={() => run(7)}>AI 总结 近7天</button>
        <button type="button" className="secondary" disabled={busy || !modelReady} onClick={() => run(30)}>AI 总结 近30天</button></>}
      {busy && <span role="status">正在总结…</span>}
      {!modelReady && <span className="avatar-hint">配置模型后可使用 AI 总结。</span>}
    </div>
    {error && <p role="alert">{error}</p>}
    {!chatId && unanswered?.total > 0 && <details><summary>近 30 天分身答不上的问题 {unanswered.total} 次</summary><ul>{unanswered.groups.slice(0, 15).map((g, i) => <li key={i}>{g.question || '（原问题已过期）'} · {g.count} 次 <button type="button" className="text-button" onClick={() => onOpenTurn?.(g.refs?.[0]?.chatId, g.refs?.[0]?.turnId)}>查看</button></li>)}</ul></details>}
    {list.length > 0 && <div className="avatar-actions" aria-label="已保存的总结">{list.slice(0, 8).map(r => <button key={r.id} type="button" className="text-button" aria-pressed={open?.id === r.id} onClick={() => api(`${BASE}/insights/${r.id}`).then(setOpen).catch(e => setError(e.message))}>{new Date(r.createdAt).toLocaleDateString('zh-CN')} {r.headline ? r.headline.slice(0, 16) : `近${r.rangeDays}天`}</button>)}</div>}
    {open && <InsightReport report={open} onOpenTurn={onOpenTurn} />}
  </section>;
}

export function AvatarConversations({ connected = true, modelReady = false, onStats }) {
  const [filter, setFilter] = useState('all'), [q, setQ] = useState(''), [query, setQuery] = useState('');
  const [page, setPage] = useState({ conversations: [], total: 0, stats: null }), [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(null), [thread, setThread] = useState(null), [targetTurn, setTargetTurn] = useState(null);
  const [mode, setMode] = useState(''), [draft, setDraft] = useState(''), [later, setLater] = useState({ days: 1, note: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const autoOpened = useRef(false);

  const loadList = useCallback(async (nextOffset = 0) => {
    const v = await api(`${BASE}/conversations?${new URLSearchParams({ filter, q: query, limit: '30', offset: String(nextOffset) })}`);
    setPage(old => ({ ...v, conversations: nextOffset ? [...old.conversations, ...v.conversations] : v.conversations }));
    setOffset(nextOffset);
    onStats?.(v.stats);
    return v;
  }, [filter, query, onStats]);
  const loadThread = useCallback(async (chatId) => { const v = await api(`${BASE}/conversations/${chatId}`); setThread(v); return v; }, []);

  useEffect(() => {
    let alive = true;
    loadList(0).then(v => {
      // Opened from the agenda: go straight to the first conversation needing attention.
      if (alive && !autoOpened.current && v.stats?.attention > 0) {
        autoOpened.current = true;
        const first = v.conversations.find(c => c.needsAttention);
        if (first) setSelected(first.chatId);
      }
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [loadList]);
  useEffect(() => { if (!selected) { setThread(null); return; } setMode(''); loadThread(selected).catch(e => setError(e.message)); }, [selected, loadThread]);
  useEffect(() => {
    const timer = setInterval(() => { if (document.hidden) return; loadList(0).catch(() => {}); if (selected) loadThread(selected).catch(() => {}); }, 15000);
    return () => clearInterval(timer);
  }, [loadList, loadThread, selected]);

  async function act(fn, message = '') {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); if (message) setNotice(message); await loadList(0); if (selected) await loadThread(selected).catch(() => setSelected(null)); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function openTurn(chatId, turnId) {
    if (!chatId) { setNotice('这条原话所在的会话已删除或过期。'); return; }
    setTargetTurn(turnId); setSelected(chatId);
  }
  async function followUpLater() {
    const c = thread.conversation;
    await api(`${BASE}/conversations/${c.chatId}/follow-up`, 'POST', { days: Number(later.days), note: later.note });
    if (!c.patientId) return '已设为稍后联系，到期后会出现在今日待办。';
    try {
      const due = new Date(Date.now() + Math.max(1, Number(later.days)) * 86400000);
      due.setHours(9, 0, 0, 0);
      await api(`/api/patients/${encodeURIComponent(c.patientId)}/followups`, 'POST', { name: `联系：飞书会话 ${c.name || ''}`.slice(0, 100), once: true, firstDueAt: due.toISOString(), requestId: crypto.randomUUID() });
      return `已设为稍后联系，并为 ${c.patientName || '关联患者'} 新建一次随访提醒。`;
    } catch (e) {
      return `已设为稍后联系（到期出现在今日待办）；随访提醒未创建：${e.message}`;
    }
  }

  const c = thread?.conversation;
  return <div aria-label="分身会话记录">
    <p className="avatar-hint">分身在已授权的群和单聊里收到的消息与回复都会自动记录在本机。需要你本人处理时，选择「我来回复」，分身会暂停该会话的自动回复。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="avatar-records">
      <div>
        <div className="avatar-filters" role="group" aria-label="筛选">{FILTERS.map(([id, label]) => <button key={id} type="button" className="secondary" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}{id === 'attention' && page.stats?.attention ? ` ${page.stats.attention}` : ''}</button>)}</div>
        <form className="avatar-search" onSubmit={e => { e.preventDefault(); setQuery(q.trim()); }}><input type="search" aria-label="搜索会话" placeholder="搜索姓名、群名或消息" value={q} onChange={e => setQ(e.target.value)} /><button type="submit" className="secondary">搜索</button></form>
        <ul className="avatar-list">
          {page.conversations.map(item => <li key={item.chatId}><button type="button" aria-current={selected === item.chatId} onClick={() => { setTargetTurn(null); setSelected(item.chatId); }}>
            <span className="avatar-row-head"><span>{item.name || (item.chatType === 'p2p' ? '单聊' : '群聊')}</span><small>{time(item.lastAt)}</small></span>
            <span className="avatar-row-meta">{item.chatType === 'p2p' ? '单聊' : '群聊'}{item.patientName ? ` · ${item.patientName}` : ''} · {item.lastText}</span>
            <Badges c={item} />
          </button></li>)}
        </ul>
        {!page.conversations.length && <p className="avatar-hint">{filter === 'all' && !query ? '还没有会话记录。授权群或单聊后，分身收到的消息会出现在这里。' : '没有符合条件的会话。'}</p>}
        {page.conversations.length < page.total && <button type="button" className="secondary" onClick={() => loadList(offset + 30).catch(e => setError(e.message))}>加载更多</button>}
      </div>
      <div>
        {!c ? <Insights onOpenTurn={openTurn} modelReady={modelReady} /> : <>
          <div className="avatar-thread-head">
            <h3>{c.name || (c.chatType === 'p2p' ? '单聊' : '群聊')} <small className="avatar-hint">{c.chatType === 'p2p' ? '单聊' : '群聊'}{c.patientName ? ` · 关联患者：${c.patientName}` : ''}</small></h3>
            <div className="avatar-actions">
              <button type="button" className="text-button" onClick={() => setSelected(null)}>返回总览</button>
              {c.needsAttention && <button type="button" className="primary" disabled={busy} onClick={() => act(() => api(`${BASE}/conversations/${c.chatId}/handled`, 'POST', {}), '已标记处理。')}>标记已处理</button>}
              {c.paused ? <button type="button" className="secondary" disabled={busy} onClick={() => act(() => api(`${BASE}/conversations/${c.chatId}/pause`, 'POST', { paused: false }), '分身已恢复自动回复。')}>恢复分身回复</button>
                : <button type="button" className="secondary" disabled={busy} onClick={() => act(async () => { await api(`${BASE}/conversations/${c.chatId}/pause`, 'POST', { paused: true }); setMode('reply'); }, '分身已暂停该会话，由你本人回复。')}>我来回复</button>}
              <button type="button" className="secondary" disabled={busy} onClick={() => setMode(mode === 'later' ? '' : 'later')}>稍后联系</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setMode(mode === 'patient' ? '' : 'patient')}>{c.patientId ? '更换关联患者' : '关联患者'}</button>
              <button type="button" className="text-button danger" disabled={busy} onClick={() => { if (window.confirm('删除这段会话记录？飞书中的消息不受影响。')) act(async () => { await api(`${BASE}/conversations/${c.chatId}`, 'DELETE', {}); setSelected(null); }, '会话记录已删除。'); }}>删除记录</button>
            </div>
          </div>
          {c.needsAttention && <div className={`avatar-attention${c.attentionKind === 'red-flag' ? '' : ' is-review'}`} role="note">{c.attentionKind === 'red-flag' ? '需关注' : '需复核'}：{c.attentionReason}</div>}
          {c.followUpAt && <p className="avatar-hint">稍后联系：{new Date(c.followUpAt).toLocaleString('zh-CN')}{c.followUpNote ? ` · ${c.followUpNote}` : ''} <button type="button" className="text-button" onClick={() => act(() => api(`${BASE}/conversations/${c.chatId}/follow-up`, 'POST', { days: null }), '已取消稍后联系。')}>取消</button></p>}
          {mode === 'patient' && <>
            <PatientPicker onCancel={() => setMode('')} onPick={p => act(async () => { await api(`${BASE}/conversations/${c.chatId}/patient`, 'PUT', { patientId: p.id, patientName: p.name }); setMode(''); }, `已关联患者 ${p.name}。`)} />
            {c.patientId && <button type="button" className="text-button" onClick={() => act(() => api(`${BASE}/conversations/${c.chatId}/patient`, 'PUT', { patientId: null }), '已取消关联。')}>取消关联</button>}
          </>}
          {mode === 'later' && <form className="avatar-inline-form" onSubmit={e => { e.preventDefault(); act(async () => { const message = await followUpLater(); setMode(''); setNotice(message); }); }}>
            <label>多久后<select value={later.days} onChange={e => setLater({ ...later, days: e.target.value })}><option value="0">今天</option><option value="1">明天</option><option value="3">3 天后</option><option value="7">1 周后</option></select></label>
            <input type="text" aria-label="备注" maxLength={300} placeholder="备注（可选）" value={later.note} onChange={e => setLater({ ...later, note: e.target.value })} />
            <button type="submit" className="primary" disabled={busy}>保存</button>
            <span className="avatar-hint">{c.patientId ? '同时会为关联患者新建一次随访提醒。' : '到期后出现在今日待办；关联患者后还会新建随访提醒。'}</span>
          </form>}
          <div className="avatar-bubbles">{thread.turns.map(turn => <Bubble key={turn.id} turn={turn} target={turn.id === targetTurn} />)}</div>
          {(c.paused || mode === 'reply') && <form className="avatar-composer" onSubmit={e => { e.preventDefault(); act(async () => { await api(`${BASE}/conversations/${c.chatId}/reply`, 'POST', { text: draft }); setDraft(''); }, '已通过飞书发送，并记入会话。'); }}>
            <label htmlFor="avatar-manual-reply">以你本人身份回复（经飞书发送，不带 AI 标识）</label>
            <textarea id="avatar-manual-reply" maxLength={2000} value={draft} onChange={e => setDraft(e.target.value)} placeholder={connected ? '输入回复内容' : '医生分身未连接，暂时只能在飞书中直接回复'} disabled={!connected} />
            <div className="avatar-actions"><button type="submit" className="primary" disabled={busy || !draft.trim() || !connected}>发送</button><span className="avatar-hint">你的回复会作为分身后续回答的口径参考。</span></div>
          </form>}
          <Insights chatId={c.chatId} onOpenTurn={openTurn} modelReady={modelReady} />
        </>}
      </div>
    </div>
  </div>;
}

export default AvatarConversations;
