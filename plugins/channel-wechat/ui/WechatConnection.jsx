import { MacPermissionHelp } from '../../../src/mac-permission-help';
import { ExperimentalChip, ExperimentalNote } from './ExperimentalNote.jsx';
import { AutomaticSettings } from '../../channel/ui/ConnectionForm.jsx';
import { useEffect, useState } from 'react';
import { api, refreshPlugins } from '../../../src/agent-runtime';
const when = value => value ? new Date(value).toLocaleString() : '尚未同步';
export function WechatConnection({ initial, onSaved }) {
  const [saved, setSaved] = useState(initial), [account, setAccount] = useState(initial.accountId || ''), [confirmed, setConfirmed] = useState(false), [status, setStatus] = useState(initial.status), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const accept = value => { setSaved(value); setStatus(value.status); onSaved(value); };
  async function run(fn) { setBusy(true); setError(''); try { await fn(); } catch(e) { setError(e.message); } finally { setBusy(false); } }
  const check = () => run(async () => { setStatus(await api('/api/chat-followups/connections/wechat/test', 'POST', {})); await refreshPlugins().catch(() => {}); });
  useEffect(() => { check(); }, []);
  return <section className="chat-setup"><h3>本机微信 <ExperimentalChip /></h3><ExperimentalNote /><p>在微信桌面版扫码登录后，工作台可以读取你授权的患者会话。</p>
    <p role="status">{status?.message || '正在检查微信…'}</p>
    <button disabled={busy} onClick={check}>检查微信与权限</button>
    {status && !status.ready && (saved.platform === 'darwin' || !saved.platform) && <MacPermissionHelp onRecheck={check} busy={busy} />}
    {status && !status.ready && saved.platform === 'win32' && <section aria-label="恢复 Windows 微信读取"><p>请打开并登录微信，允许本机读取窗口。</p><button disabled={busy} onClick={check}>重新检测</button></section>}
    {!saved.enabled && status?.ready && <form onSubmit={e => { e.preventDefault(); run(async () => accept(await api('/api/chat-followups/connections/wechat/connect', 'POST', { ...saved, accountId: account, revision: saved.revision, accountConfirmed: confirmed }))); }}>
      <p>微信不提供登录身份读取。请核对本次登录账号，避免将不同账号的患者会话混在一起。</p>
      <label>当前登录的微信号<input required value={account} maxLength={200} onChange={e => { setAccount(e.target.value); setConfirmed(false); }} /></label>
      <label><input required type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />已核对是我当前登录的账号</label>
      <button disabled={busy || !confirmed}>连接此账号</button>
    </form>}
    {saved.enabled && <><p>已连接账号：{saved.accountId}</p><a href="/?view=followups&followupTab=chat">选择患者会话 →</a><button disabled={busy} onClick={() => run(async () => { accept(await api('/api/chat-followups/connections/wechat', 'POST', { ...saved, enabled: false, autoUntil: '', autoSummarize: false })); setConfirmed(false); })}>断开账号</button><AutomaticSettings key={saved.revision} initial={saved} onSaved={value => { accept(value); setNotice(value.autoUntil ? '自动同步设置已保存' : '自动同步已停止'); }} /></>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}<p className="muted">最近同步：{when(saved.lastSyncAt)}</p>
  </section>;
}
