import { useEffect, useState } from "react";
import { api } from "./agent-runtime";
import "./doctor-notifications.css";
const names = { wechat: "微信", feishu: "飞书" };
function Channel({ initial, refresh }) {
  const [form, setForm] = useState({ ...initial, webhook: "", signingSecret: "", clearSigningSecret: false });
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState(""), [qr, setQr] = useState(null);
  const channel = initial.channel;
  const update = (key, value) => { setForm(v => ({ ...v, [key]: value })); setNotice(""); };
  const accept = value => { setForm({ ...value, webhook: "", signingSecret: "", clearSigningSecret: false }); refresh(value); };
  async function action(fn) { setBusy(true); setError(""); setNotice(""); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const reload = async () => accept((await api("/api/doctor-notifications")).channels.find(c => c.channel === channel));
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
  const disabled = busy || Boolean(qr);
  return <section className="notification-channel" aria-label={`${names[channel]}医生提醒`}>
    <h3>{names[channel]}提醒 <small>{initial.hasConnection ? "已配置连接" : "尚未接入"}</small></h3>
    {channel === "wechat" && <><p>用医生自己的微信扫码，提醒发送到该账号的机器人会话。</p><button disabled={disabled} onClick={() => action(async () => setQr(await api("/api/doctor-notifications/wechat/qrcode", "POST", {})))}>{initial.hasConnection ? "重新扫码连接" : "微信扫码连接"}</button>{qr && <div className="notification-qr"><img src={qr.image} alt="微信连接二维码" /><p role="status">请使用接收提醒的微信扫码并确认。二维码有效期约 5 分钟。</p></div>}</>}
    <form onSubmit={event => { event.preventDefault(); action(async () => { accept(await api(`/api/doctor-notifications/${channel}`, "PUT", { ...form, expectedRevision: form.revision })); setNotice("提醒设置已保存。"); }); }}><fieldset disabled={disabled}>
      {channel === "feishu" && <><label>飞书机器人 Webhook<input type="password" autoComplete="new-password" value={form.webhook} onChange={e => update("webhook", e.target.value)} placeholder={initial.hasConnection ? "已保存，留空保留" : "粘贴群自定义机器人的 Webhook"} /></label><label>签名密钥（可选）<input type="password" autoComplete="new-password" value={form.signingSecret} onChange={e => update("signingSecret", e.target.value)} placeholder={initial.hasSigningSecret ? "已保存，留空保留" : "机器人启用签名校验时填写"} /></label>{initial.hasSigningSecret && <label className="notification-check"><input type="checkbox" checked={form.clearSigningSecret} onChange={e => update("clearSigningSecret", e.target.checked)} />清除已保存的签名密钥</label>}<details><summary>如何获得 Webhook？</summary><p>在接收提醒的飞书群中添加「自定义机器人」，复制 Webhook。若开启关键词校验，请添加 Open Medical；若开启签名校验，请填写签名密钥。</p><a href="https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot" target="_blank" rel="noreferrer">飞书接入说明</a></details></>}
      <div className="notification-schedule"><label>每日提醒时间<input type="time" required value={form.time} onChange={e => update("time", e.target.value)} /></label><label>提醒时区<input required value={form.timezone} onChange={e => update("timezone", e.target.value)} placeholder="Asia/Shanghai" /></label></div>
      <label className="notification-check"><input type="checkbox" checked={form.enabled} onChange={e => update("enabled", e.target.checked)} />启用每日随访与待跟进提醒</label><button type="submit">保存提醒设置</button>
    </fieldset></form>
    <div className="toolbar-actions"><button disabled={disabled || !initial.hasConnection} onClick={() => action(async () => setNotice((await api(`/api/doctor-notifications/${channel}/test`, "POST", {})).message))}>发送测试提醒</button><button disabled={disabled || !initial.enabled} onClick={() => action(async () => { const result = await api(`/api/doctor-notifications/${channel}/send`, "POST", {}); await reload(); setNotice(result.message); })}>发送今日提醒</button>{initial.hasConnection && <button disabled={disabled} onClick={() => action(async () => { accept(await api(`/api/doctor-notifications/${channel}/disconnect`, "POST", { expectedRevision: form.revision })); setNotice("连接已断开，每日提醒已停用。"); })}>断开连接</button>}</div>
    <details><summary>查看提醒内容预览</summary><pre className="notification-preview">{initial.preview.text}</pre></details>
    {initial.delivery && <p className="notification-receipt" role="status">{initial.delivery.day}：{initial.delivery.message || "正在发送"}{["failed", "unknown"].includes(initial.delivery.status) && <button disabled={disabled} onClick={() => action(async () => { const result = await api(`/api/doctor-notifications/${channel}/send`, "POST", { retryId: initial.delivery.id }); await reload(); setNotice(result.message); })}>已核对收件箱，重试今日提醒</button>}</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
export function DoctorNotificationSettings() {
  const [data, setData] = useState(null), [error, setError] = useState("");
  const load = () => { setError(""); api("/api/doctor-notifications").then(setData).catch(e => setError(e.message)); };
  useEffect(load, []);
  return <section className="doctor-notifications"><h2>医生随访提醒</h2><p>每天汇总今日及逾期的随访、待跟进患者数量，提醒医生回到工作台处理。消息不包含患者姓名、联系方式或病历正文。</p><p>自动提醒需要桌面端保持运行并联网；每日最多发送一次汇总，处理患者详情请进入「今日待办」。退出后未发送的提醒会在下次运行时按当天待办重新汇总。</p>{error && <p role="alert">{error}<button onClick={load}>重新加载</button></p>}{!data && !error && <p role="status">正在读取提醒设置…</p>}{data?.channels.map(c => <Channel key={c.channel} initial={c} refresh={next => setData(value => ({ channels: value.channels.map(item => item.channel === next.channel ? next : item) }))} />)}</section>;
}
