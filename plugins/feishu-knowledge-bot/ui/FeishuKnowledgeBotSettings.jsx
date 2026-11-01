import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../src/agent-runtime';
import { FeishuBinding } from '../../../src/feishu-binding';
import { AvatarConversations } from './AvatarConversations.jsx';
import { takePluginIntent } from '../../../src/plugin-navigation';
import './avatar.css';

const DEFAULT_NAME = '医生的 AI 助手';
const disclosure = name => `—— ${(name || '').trim() || DEFAULT_NAME}（AI 自动回复，非医生本人）`;

// 医生分身: the doctor's AI avatar for public health education (Feishu only for now). Abilities = the doctor's
// habits + ticked knowledge bases; conversations are recorded automatically.
export function FeishuKnowledgeBotSettings() {
  const [config, setConfig] = useState(null), [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [tab, setTab] = useState(null), [stats, setStats] = useState(null);
  // An agenda row can ask to open one conversation directly.
  const [openChat] = useState(() => takePluginIntent('feishu-knowledge-bot', 'open-chat')?.chatId || null);
  const accept = value => { setConfig(value); setForm({ ...value, persona: { ...value.persona } }); setStats(value.conversationStats); };
  useEffect(() => { let alive = true; api('/api/knowledge-bot').then(v => { if (alive) { accept(v); setTab(t => t || (openChat || v.conversationStats?.attention > 0 ? 'records' : 'settings')); } }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (!config?.enabled && config?.feishuBinding?.status !== 'pending') return;
    let alive = true;
    const timer = setInterval(() => { api('/api/knowledge-bot').then(v => { if (alive) { if (!config.appId && v.appId) accept(v); else setConfig(v); } }).catch(() => {}); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [config?.enabled, config?.appId, config?.feishuBinding?.status]);
  const onStats = useCallback(value => setStats(value), []);
  async function action(fn) { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  function toggle(key, value) { setForm(f => ({ ...f, [key]: f[key].includes(value) ? f[key].filter(v => v !== value) : [...f[key], value] })); }
  const setPersona = patch => setForm(f => ({ ...f, persona: { ...f.persona, ...patch } }));
  const states = { disabled: '未启用', connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', failed: '连接失败' };
  const attention = stats?.attention || 0;

  return <section className="doctor-notifications" aria-label="医生分身">
    <h2>医生分身</h2>
    <p>根据你的知识库对外提供科普：按你的习惯和勾选的知识库，在授权的群（@ 它）或单聊里回答患者、家属和公众的常见问题。不做个体诊断，每条回复都会标明是 AI 助手，所有往来自动记录，可随时接手。<span className="om-chip">目前支持飞书渠道</span></p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!form ? <button className="secondary" disabled={busy} onClick={() => action(async () => accept(await api('/api/knowledge-bot')))}>重新加载</button> : <>
      {config.hasSecret && <div className="avatar-tabs" role="group" aria-label="医生分身页面">
        <button type="button" className="secondary" aria-pressed={tab !== 'records'} onClick={() => setTab('settings')}>分身设置</button>
        <button type="button" className="secondary" aria-pressed={tab === 'records'} onClick={() => setTab('records')}>分身会话记录{attention > 0 && <span className="om-chip is-danger">需关注 {attention}</span>}</button>
      </div>}
      {config.hasSecret && tab === 'records' ? <AvatarConversations connected={config.enabled && config.state === 'connected'} modelReady={Boolean(config.model)} onStats={onStats} initialChatId={openChat} /> : <>
      <div className="notification-channel">
      <h3>1. 连接 <span role="status" className={`om-chip ${config.state === 'connected' ? 'is-ok' : config.state === 'failed' ? 'is-danger' : config.state === 'disabled' ? '' : 'is-caution'}`}>{states[config.state] || config.state}</span></h3>
      {config.message && <p className="muted">{config.message}</p>}
      {!config.hasSecret ? <FeishuBinding endpoint="/api/knowledge-bot/feishu-binding" binding={config.feishuBinding} modelConsent={false} onUpdated={async () => accept(await api('/api/knowledge-bot'))} /> : <>
      <a className="chat-next-link" href={`https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(config.appId)}`} target="_blank" rel="noreferrer">在飞书中打开分身 ↗</a>
      </>}
      </div>
      {config.hasSecret && <>
      <form onSubmit={e => { e.preventDefault(); action(async () => { accept(await api('/api/knowledge-bot', 'PUT', { ...form, collectionScope: 'all-except-excluded', expectedRevision: form.revision })); setNotice('设置已保存，可以打开飞书提问。'); }); }}>
        <fieldset disabled={busy} className="notification-fields">
          <div className="avatar-section">
            <h3>2. 分身设定</h3>
            <label className="avatar-field">分身名称<input type="text" maxLength={30} value={form.persona.displayName} placeholder={DEFAULT_NAME} onChange={e => setPersona({ displayName: e.target.value })} /><small>例如「王医生的 AI 助手」。</small></label>
            <label className="avatar-field">说话方式与不回答的范围<textarea rows={4} maxLength={1000} value={form.persona.intro} placeholder="例如：说话简短亲切；不评价其他医院；涉及用药调整一律请对方来门诊。" onChange={e => setPersona({ intro: e.target.value })} /><small>{form.persona.intro.length}/1000 字。安全规则始终优先：分身不会做个体诊断、开药或承诺疗效。</small></label>
            <p className="avatar-disclosure-preview">每条回复末尾固定附上：{disclosure(form.persona.displayName)}</p>
          </div>
          <div className="avatar-section">
            <h3>3. 能力范围</h3>
            <label className="notification-checkbox"><input type="checkbox" checked={form.persona.useHabits} onChange={e => setPersona({ useHabits: e.target.checked })} />按我已确认的习惯与偏好来说话</label>
            <p className="avatar-hint">{config.habitsAvailable ? '使用「学习与记忆」中你已确认的偏好，只影响措辞和口径。' : '目前还没有已确认的习惯；在「学习与记忆」确认后会自动用上。'}</p>
            <h4>可以引用的知识库</h4>
            <p>勾选一个知识库，就表示分身可以引用其中的资料，之后新加入的资料也包括在内；你在资料的「来源与版本」里勾选「不让医生分身使用」的资料和已停用资料不会使用。患者档案和病例库始终不参与。</p>
            {config.collectionScope === 'external-only' && <p className="avatar-hint">当前仍只引用逐篇勾选了「允许对外引用」的资料；保存后改为按知识库授权。</p>}
            {!config.availableCollections.length && <p>请先到「知识库」建立资料库并导入资料。</p>}
            {config.availableCollections.map(c => <label className="notification-checkbox" key={c.name}><input type="checkbox" checked={form.collections.includes(c.name)} onChange={() => toggle('collections', c.name)} />{c.name} · 可引用 {c.allowedCount ?? c.sharedCount} 篇{c.excludedCount ? ` · ${c.excludedCount} 篇已设为不对外` : ''}</label>)}
            {form.collections.filter(c => !config.availableCollections.some(v => v.name === c)).map(c => <label key={c}><input type="checkbox" checked onChange={() => toggle('collections', c)} />{c}（已不存在，请取消）</label>)}
            <h4>回答方式</h4>
            <label className="notification-checkbox"><input type="radio" name="answerMode" checked={form.answerMode === 'assistant'} onChange={() => setForm({ ...form, answerMode: 'assistant' })} />用当前模型整理回答，支持连续追问</label>
            <label className="notification-checkbox"><input type="radio" name="answerMode" checked={form.answerMode === 'excerpts'} onChange={() => setForm({ ...form, answerMode: 'excerpts' })} />只返回资料原文与出处</label>
            <p className="avatar-hint">{config.model ? `当前模型：${config.model.provider} · ${config.model.name}${config.model.local ? '（本地模型）' : ''}。提问、最近几轮对话和命中的资料片段会交给该模型整理回答；可在「模型与运行」选择本地模型。` : '尚未配置模型；资料原文检索仍可使用。'}</p>
            <details><summary>连续追问、新话题与危险信号</summary><p>群聊上下文按提问人及话题分开，单聊互不混用；重启后仍保留，30 分钟无新消息后过期。发送 /new 或「新话题」可重新开始。提问中出现胸痛、呼吸困难等危险信号时，分身不调用模型，固定提醒对方立即就医或拨打 120，并把会话标为「需关注」放进今日待办。</p></details>
          </div>
          <div className="avatar-section">
            <h3>4. 允许聊天的群与单聊</h3>
            <p>先把分身加入飞书群并 @ 它一次，群就会出现在下面；勾选并保存后才开始回答。尚未授权时不会向群内发送消息，也不会记录。</p>
            {form.appId === config.appId && config.discoveredGroups.filter(g => g.chatType !== 'p2p').map((g, i) => <label className="notification-checkbox" key={g.id}><input type="checkbox" checked={form.groups.includes(g.id)} disabled={!g.name && !form.groups.includes(g.id)} onChange={() => toggle('groups', g.id)} /><span>{g.name || `待确认的群 ${i + 1}`}<small style={{ display: 'block' }}>发现于 {new Date(g.firstSeen).toLocaleString('zh-CN')}</small></span></label>)}
            {!config.discoveredGroups.some(g => g.chatType !== 'p2p') && <p className="muted">尚未发现群</p>}
            <p>扫码账号可直接私聊。其他人发来消息后，可以按姓名授权；无法确认身份的会话请勿勾选。</p>
            {form.appId === config.appId && config.discoveredGroups.filter(g => g.chatType === 'p2p').map((g, i) => <label className="notification-checkbox" key={g.id}><input type="checkbox" checked={form.privateChats.includes(g.id)} disabled={!g.name && g.senderId !== config.boundUserId && !form.privateChats.includes(g.id)} onChange={() => toggle('privateChats', g.id)} /><span>{g.senderId === config.boundUserId ? '我的飞书账号' : g.name ? `${g.name} · 单聊` : `待确认的单聊 ${i + 1}`}<small style={{ display: 'block' }}>发现于 {new Date(g.firstSeen).toLocaleString('zh-CN')}</small></span></label>)}
            {!config.discoveredGroups.some(g => g.chatType === 'p2p') && <p className="muted">尚未发现单聊</p>}
          </div>
          <div className="avatar-section">
            <h3>5. 启用</h3>
            <label className="avatar-field">会话记录保留<select value={form.retentionDays} onChange={e => setForm({ ...form, retentionDays: Number(e.target.value) })}>{[30, 90, 180, 365, 730].map(d => <option key={d} value={d}>{d} 天</option>)}{![30, 90, 180, 365, 730].includes(form.retentionDays) && <option value={form.retentionDays}>{form.retentionDays} 天</option>}</select><small>记录只保存在本机，超过期限自动清理。</small></label>
            <label className="notification-checkbox"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />启用医生分身</label>
            <button type="submit" className="primary">保存设置</button>
          </div>
        </fieldset>
      </form>
      <div className="settings-bot-actions"><button className="secondary" disabled={busy} onClick={() => action(async () => { accept(await api('/api/knowledge-bot')); setNotice('会话列表与设置已刷新。'); })}>刷新群与连接状态</button>
      <button className="secondary" disabled={busy} onClick={() => action(async () => { const result = await api('/api/knowledge-bot/reset-context', 'POST', { expectedRevision: config.revision }); setNotice(result.message); })}>清空所有对话上下文</button>
      <button className="text-button danger" disabled={busy} onClick={() => { if (window.confirm('断开医生分身？已导入资料会保留。')) action(async () => accept(await api('/api/knowledge-bot', 'DELETE', { expectedRevision: config.revision }))); }}>断开连接</button>
      </div>
      </>}
      </>}
    </>}
  </section>;
}

export default FeishuKnowledgeBotSettings;
