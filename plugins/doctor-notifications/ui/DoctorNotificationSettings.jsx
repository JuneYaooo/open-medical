import { useEffect, useRef, useState } from "react";
import { api } from "../../../src/agent-runtime";
import { FeishuBinding } from "../../../src/feishu-binding";
const names = { wechat: "微信", feishu: "飞书" };
const details = [
  ["count", "只发数量（不含患者信息）"],
  ["masked", "列出姓氏和待办事项（如：张* · 随访到期）"],
  ["full", "列出患者全名、事项和说明"],
];
function Channel({ initial, refresh }) {
  const [form, setForm] = useState({ ...initial });
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState(""), [qr, setQr] = useState(null);
  const channel = initial.channel;
  // Fields the doctor edits stay as typed while background polling refreshes
  // connection status; they are replaced only after a save.
  const edited = useRef(new Set());
  const update = (key, value) => { edited.current.add(key); setForm(v => ({ ...v, [key]: value })); setNotice(""); };
  const accept = value => { edited.current.clear(); setForm({ ...value }); refresh(value); };
  const acceptStatus = value => {
    setForm(v => ({ ...value, ...Object.fromEntries([...edited.current].map(key => [key, v[key]])) }));
    refresh(value);
  };
  async function action(fn) { setBusy(true); setError(""); setNotice(""); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const reload = async () => acceptStatus((await api("/api/doctor-notifications")).channels.find(c => c.channel === channel));
  useEffect(() => {
    if (!qr) return;
    let stopped = false, timer;
    const poll = async () => {
      try {
        const result = await api("/api/doctor-notifications/wechat/qrcode-status", "POST", { id: qr.id });
        if (stopped) return;
        if (result.status === "confirmed") { accept(result.config); setQr(null); setNotice("微信已扫码连接。可以先发送测试消息，再启用每日提醒。"); return; }
        if (result.status === "expired" || Date.now() > qr.expiresAt) { setQr(null); setError("二维码已过期，请重新生成。"); return; }
        timer = setTimeout(poll, 2000);
      } catch (e) { if (!stopped) { setQr(null); setError(e.message); } }
    };
    timer = setTimeout(poll, 1500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [qr]);
  useEffect(() => {
    if (initial.feishuBinding?.status !== 'pending') return;
    const timer = setInterval(() => { void reload().catch(() => {}); }, 2500);
    return () => clearInterval(timer);
  }, [initial.feishuBinding?.status]);
  const disabled = busy || Boolean(qr);
  return <section className="notification-channel" aria-label={`${names[channel]}医生提醒`}>
    <h3>{names[channel]}提醒 <span className={`om-chip ${initial.hasConnection ? (initial.enabled ? "is-ok" : "is-info") : "is-caution"}`}>{initial.hasConnection ? (initial.enabled ? "已配置连接 · 每日提醒已开启" : "已配置连接 · 每日提醒未开启") : "尚未接入"}</span></h3>
    {channel === "wechat" && <><p>用医生自己的微信扫码，提醒发送到该账号的机器人会话。</p><button className={initial.hasConnection ? "secondary" : "primary"} disabled={disabled} onClick={() => action(async () => setQr(await api("/api/doctor-notifications/wechat/qrcode", "POST", {})))}>{initial.hasConnection ? "重新扫码连接" : "微信扫码连接"}</button>{qr && <div className="notification-qr"><img src={qr.image} alt="微信连接二维码" /><p role="status">请使用接收提醒的微信扫码并确认。二维码有效期约 5 分钟。</p></div>}</>}
    {channel === 'feishu' && !initial.hasConnection && <FeishuBinding endpoint="/api/doctor-notifications/feishu-binding" binding={initial.feishuBinding} modelConsent={false} onUpdated={reload} />}
    {channel === 'feishu' && initial.appId && <a href={`https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(initial.appId)}`} target="_blank" rel="noreferrer">打开飞书提醒会话 ↗</a>}
    <form onSubmit={event => { event.preventDefault(); action(async () => { accept(await api(`/api/doctor-notifications/${channel}`, "PUT", { ...form, expectedRevision: form.revision })); setNotice("提醒设置已保存。"); }); }}><fieldset disabled={disabled}>
      <div className="notification-schedule"><label>每日提醒时间<input type="time" required value={form.time} onChange={e => update("time", e.target.value)} /></label><label>提醒时区<select value={form.timezone} onChange={e => update("timezone", e.target.value)}>{[...new Set([form.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Shanghai'])].map(zone => <option key={zone} value={zone}>{zone === 'Asia/Shanghai' ? '北京时间' : zone === Intl.DateTimeFormat().resolvedOptions().timeZone ? '本机时间' : '已保存的时区'}</option>)}</select></label></div>
      <label>提醒内容<select value={form.detail || "count"} onChange={e => update("detail", e.target.value)}>{details.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {form.detail === "full" && <p className="notification-warning" role="note">患者全名和待办说明会经过{names[channel]}的服务器，请确认符合所在机构的数据管理要求。</p>}
      <label className="notification-check"><input type="checkbox" checked={form.enabled} onChange={e => update("enabled", e.target.checked)} />启用每日待办提醒</label><button type="submit" className="primary">保存提醒设置</button>
    </fieldset></form>
    <div className="toolbar-actions"><button className="secondary" disabled={disabled || !initial.hasConnection} onClick={() => action(async () => setNotice((await api(`/api/doctor-notifications/${channel}/test`, "POST", {})).message))}>发送测试提醒</button><button className="secondary" disabled={disabled || !initial.enabled} onClick={() => action(async () => { const result = await api(`/api/doctor-notifications/${channel}/send`, "POST", {}); await reload(); setNotice(result.message); })}>发送今日提醒</button>{initial.hasConnection && <button className="text-button" disabled={disabled} onClick={() => action(async () => { accept(await api(`/api/doctor-notifications/${channel}/disconnect`, "POST", { expectedRevision: form.revision })); setNotice("连接已断开，每日提醒已停用。"); })}>断开连接</button>}</div>
    <details><summary>查看提醒内容预览</summary><pre className="notification-preview">{initial.preview.text}</pre></details>
    {initial.delivery && <p className="notification-receipt" role="status">{initial.delivery.day}：{initial.delivery.message || "正在发送"}{["failed", "unknown"].includes(initial.delivery.status) && <button disabled={disabled} onClick={() => action(async () => { const result = await api(`/api/doctor-notifications/${channel}/send`, "POST", { retryId: initial.delivery.id }); await reload(); setNotice(result.message); })}>已核对收件箱，重试今日提醒</button>}</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
export function DoctorNotificationSettings() {
  const [data, setData] = useState(null), [error, setError] = useState("");
  const load = () => { setError(""); api("/api/doctor-notifications").then(setData).catch(e => setError(e.message)); };
  useEffect(load, []);
  return <section className="doctor-notifications"><h2>医生待办提醒</h2><p>每天在设定时间，把「今日待办」里的复诊、方案复评、随访、检查检验等事项推送给医生本人。只提醒医生，不会联系患者。消息里是否出现患者姓名由下方「提醒内容」决定，默认只发数量；联系方式和病历正文不会发送。</p><p>自动提醒需保持应用运行并联网，每日最多一条；退出期间未发送的提醒在下次运行时汇总当天待办。</p>{error && <p role="alert">{error}<button onClick={load}>重新加载</button></p>}{!data && !error && <p role="status">正在读取提醒设置…</p>}{data?.channels.map(c => <Channel key={c.channel} initial={c} refresh={next => setData(value => ({ channels: value.channels.map(item => item.channel === next.channel ? next : item) }))} />)}</section>;
}

export default DoctorNotificationSettings;
