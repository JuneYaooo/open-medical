import { useEffect, useState } from 'react';
import { api } from './agent-runtime';
import './doctor-notifications.css';

export function FeishuKnowledgeBotSettings() {
  const [config, setConfig] = useState(null), [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const accept = value => { setConfig(value); setForm({ ...value, appSecret: '' }); };
  useEffect(() => { let alive = true; api('/api/knowledge-bot').then(v => { if (alive) accept(v); }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (!config?.enabled) return;
    let alive = true;
    const timer = setInterval(() => { api('/api/knowledge-bot').then(v => { if (alive) setConfig(v); }).catch(() => {}); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [config?.enabled]);
  async function action(fn) { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  function toggle(key, value) { setForm(f => ({ ...f, [key]: f[key].includes(value) ? f[key].filter(v => v !== value) : [...f[key], value] })); }
  const states = { disabled: '未启用', connecting: '正在连接', connected: '长连接已就绪', reconnecting: '正在重连', failed: '连接失败' };
  return <section className="doctor-notifications" aria-label="飞书知识库机器人">
    <h2>飞书知识库机器人</h2>
    <p>在授权群里 @ 机器人，或在授权单聊里直接提问。从你开放的已复核资料中查找依据，支持连续追问，并附上资料出处。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!form ? <button disabled={busy} onClick={() => action(async () => accept(await api('/api/knowledge-bot')))}>重新加载</button> : <>
      <p role="status">{states[config.state] || config.state}{config.message ? ` · ${config.message}` : ''}</p>
      <details><summary>如何连接群聊和单聊</summary><ol>
        <li>在<a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">飞书开发者后台</a>创建企业自建应用，开启机器人能力。</li>
        <li>添加权限：获取群组中所有用户 @ 机器人的消息（im:message.group_at_msg:readonly）、以应用身份发消息（im:message:send_as_bot）。单聊还需获取用户发给机器人的单聊消息（im:message.p2p_msg:readonly）。如需显示群名称，再添加获取群信息（im:chat:readonly）；显示单聊姓名可添加 contact:user.base:readonly。</li>
        <li>在事件与回调中选择「使用长连接接收事件」，添加「接收消息 v2.0」（im.message.receive_v1），先保存下方连接以建立长连接，再按飞书后台要求保存订阅、发布应用并完成组织内审批。</li>
        <li>填写应用凭证，选择可分享的知识库，勾选启用并保存。在群里 @ 机器人，或给机器人发一条单聊消息，再回到这里授权相应会话。</li>
      </ol><p>桌面应用需保持运行并联网。这里使用飞书自建应用；医生提醒中的群 Webhook 只用于发送提醒。</p></details>
      <form onSubmit={e => { e.preventDefault(); action(async () => { accept(await api('/api/knowledge-bot', 'PUT', { ...form, expectedRevision: form.revision })); setNotice('配置已保存。启用后请查看连接状态，并在下方授权会话。'); }); }}>
        <fieldset disabled={busy} className="notification-fields">
          <label>App ID<input autoComplete="off" value={form.appId} onChange={e => setForm({ ...form, appId: e.target.value.trim(), groups: [], privateChats: [], appSecret: '' })} placeholder="cli_…" /></label>
          <label>App Secret<input type="password" autoComplete="new-password" value={form.appSecret} onChange={e => setForm({ ...form, appSecret: e.target.value })} placeholder={config.hasSecret && form.appId === config.appId ? '已保存；留空保留' : '飞书应用密钥'} /></label>
          <h3>允许分享的知识库</h3><p>选中库中已复核资料的摘录会发送到授权群或单聊，之后加入该库并复核的资料也会参与检索。请选用适合在所选会话分享的内容；患者档案和病例库不参与检索。</p>
          {!config.availableCollections.length && <p>请先到「知识库」建立资料库、导入资料并复核来源。</p>}
          {config.availableCollections.map(c => <label className="notification-checkbox" key={c.name}><input type="checkbox" checked={form.collections.includes(c.name)} onChange={() => toggle('collections', c.name)} />{c.name} · {c.reviewedCount} 篇已复核 / {c.documentCount} 篇</label>)}
          {form.collections.filter(c => !config.availableCollections.some(v => v.name === c)).map(c => <label key={c}><input type="checkbox" checked onChange={() => toggle('collections', c)} />{c}（已不存在，请取消）</label>)}
          <h3>允许使用的群</h3><p>先把机器人加入飞书群并 @ 它一次，群就会出现在下面；勾选并保存后才开始回答。尚未授权时不会向群内发送消息。</p>
          {form.appId === config.appId && config.discoveredGroups.filter(g => g.chatType !== 'p2p').map(g => <label className="notification-checkbox" key={g.id}><input type="checkbox" checked={form.groups.includes(g.id)} onChange={() => toggle('groups', g.id)} /><span>{g.name || '待授权的飞书群'}<small style={{ display: 'block', overflowWrap: 'anywhere' }}>{g.id}</small></span></label>)}
          {!config.discoveredGroups.some(g => g.chatType !== 'p2p') && <p className="muted">尚未发现群</p>}
          <h3>允许使用的单聊</h3><p>先给机器人发一条消息，刷新后勾选对应会话并保存。单聊无需 @；未授权时不会回复。</p>
          {form.appId === config.appId && config.discoveredGroups.filter(g => g.chatType === 'p2p').map(g => <label className="notification-checkbox" key={g.id}><input type="checkbox" checked={form.privateChats.includes(g.id)} onChange={() => toggle('privateChats', g.id)} /><span>{g.name ? `${g.name} · 单聊` : "飞书单聊"}<small style={{ display: 'block', overflowWrap: 'anywhere' }}>用户：{g.senderId} · 会话：{g.id}</small></span></label>)}
          {!config.discoveredGroups.some(g => g.chatType === 'p2p') && <p className="muted">尚未发现单聊</p>}
          <h3>回答方式</h3>
          <label className="notification-checkbox"><input type="radio" name="answerMode" checked={form.answerMode === 'excerpts'} onChange={() => setForm({ ...form, answerMode: 'excerpts' })} />返回资料原文与出处</label>
          <label className="notification-checkbox"><input type="radio" name="answerMode" checked={form.answerMode === 'assistant'} onChange={() => setForm({ ...form, answerMode: 'assistant' })} />使用当前模型整理回答与连续追问</label>
          <p>{config.model ? `当前模型：${config.model.provider} · ${config.model.name}${config.model.local ? '（本地模型）' : ''}` : '尚未配置模型；资料原文检索仍可使用。'}</p>
          {form.answerMode === 'assistant' && <p>启用并保存后，问题、当前会话最近 4 轮上下文和命中的知识库片段会发送给当前配置的模型。可在「模型与运行」选择本地模型。</p>}
          <p>群聊上下文按提问人及话题分开，单聊互不混用。上下文仅在本次运行中保留，30 分钟无新消息后过期；发送 /new 或「新话题」可重新开始。</p>
          <label className="notification-checkbox"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />启用飞书知识库机器人</label>
          <button type="submit">保存机器人配置</button>
        </fieldset>
      </form>
      <button disabled={busy} onClick={() => action(async () => { const result = await api("/api/knowledge-bot/reset-context", "POST", { expectedRevision: config.revision }); setNotice(result.message); })}>清空所有对话上下文</button>
      <button disabled={busy} onClick={() => action(async () => { setConfig(await api('/api/knowledge-bot')); setNotice('群列表与连接状态已刷新，未保存的选项仍保留。'); })}>刷新群与连接状态</button>
    </>}
  </section>;
}
