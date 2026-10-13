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
    <p>把自己的资料积累带到协作群。群成员 @ 机器人提问时，从你开放的知识库中查找已复核资料，回复相关原文与出处。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!form ? <button disabled={busy} onClick={() => action(async () => accept(await api('/api/knowledge-bot')))}>重新加载</button> : <>
      <p role="status">{states[config.state] || config.state}{config.message ? ` · ${config.message}` : ''}</p>
      <details><summary>如何连接飞书群</summary><ol>
        <li>在<a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">飞书开发者后台</a>创建企业自建应用，开启机器人能力。</li>
        <li>添加权限：获取群组中所有用户 @ 机器人的消息（im:message.group_at_msg:readonly）、以应用身份发消息（im:message:send_as_bot）。如需显示群名称，再添加获取群信息（im:chat:readonly）。</li>
        <li>在事件与回调中选择「使用长连接接收事件」，添加「接收消息 v2.0」（im.message.receive_v1），发布应用并完成组织内审批。</li>
        <li>填写应用凭证，选择可分享的知识库，勾选启用并保存。在飞书群添加机器人、@ 它发送一条消息，再回到这里授权该群。</li>
      </ol><p>桌面应用需保持运行并联网。这里使用飞书自建应用；医生提醒中的群 Webhook 只用于发送提醒。</p></details>
      <form onSubmit={e => { e.preventDefault(); action(async () => { accept(await api('/api/knowledge-bot', 'PUT', { ...form, expectedRevision: form.revision })); setNotice('配置已保存。启用后请查看连接状态，并在下方授权群。'); }); }}>
        <fieldset disabled={busy} className="notification-fields">
          <label>App ID<input autoComplete="off" value={form.appId} onChange={e => setForm({ ...form, appId: e.target.value.trim(), groups: [], appSecret: '' })} placeholder="cli_…" /></label>
          <label>App Secret<input type="password" autoComplete="new-password" value={form.appSecret} onChange={e => setForm({ ...form, appSecret: e.target.value })} placeholder={config.hasSecret && form.appId === config.appId ? '已保存；留空保留' : '飞书应用密钥'} /></label>
          <h3>允许分享的知识库</h3><p>选中库中已复核资料的摘录会发送到授权群，之后加入该库并复核的资料也会参与检索。请选用适合群内分享的内容；患者档案和病例库不参与检索。</p>
          {!config.availableCollections.length && <p>请先到「知识库」建立资料库、导入资料并复核来源。</p>}
          {config.availableCollections.map(c => <label className="notification-checkbox" key={c.name}><input type="checkbox" checked={form.collections.includes(c.name)} onChange={() => toggle('collections', c.name)} />{c.name} · {c.reviewedCount} 篇已复核 / {c.documentCount} 篇</label>)}
          {form.collections.filter(c => !config.availableCollections.some(v => v.name === c)).map(c => <label key={c}><input type="checkbox" checked onChange={() => toggle('collections', c)} />{c}（已不存在，请取消）</label>)}
          <h3>允许使用的群</h3><p>先把机器人加入飞书群并 @ 它一次，群就会出现在下面；勾选并保存后才开始回答。尚未授权时不会向群内发送消息。</p>
          {form.appId === config.appId && config.discoveredGroups.map(g => <label className="notification-checkbox" key={g.id}><input type="checkbox" checked={form.groups.includes(g.id)} onChange={() => toggle('groups', g.id)} /><span>{g.name || '待授权的飞书群'}<small style={{ display: 'block', overflowWrap: 'anywhere' }}>{g.id}</small></span></label>)}
          {!config.discoveredGroups.length && <p className="muted">尚未发现群</p>}
          <label className="notification-checkbox"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />启用飞书知识库机器人</label>
          <button type="submit">保存机器人配置</button>
        </fieldset>
      </form>
      <button disabled={busy} onClick={() => action(async () => { setConfig(await api('/api/knowledge-bot')); setNotice('群列表与连接状态已刷新，未保存的选项仍保留。'); })}>刷新群与连接状态</button>
    </>}
  </section>;
}
