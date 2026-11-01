import { createHmac, randomBytes, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { AppError, check } from "../../../server/errors.mjs";
import { sqliteTransaction } from "../../../server/sqlite-transaction.mjs";

const CHANNELS = ["wechat", "feishu"];
const ILINK = "https://ilinkai.weixin.qq.com";
const KEY = (channel) => `doctor-notifications:${channel}`;
const headers = () => ({ "iLink-App-Id": "bot", "iLink-App-ClientVersion": "131586" });
const text = (value, max = 4096) => typeof value === "string" && value.length <= max;
const local = (at, timezone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, clock: `${parts.hour}:${parts.minute}` };
};
function wechatOrigin(value) {
  let url; try { url = new URL(value); } catch { /* validated below */ }
  check(url?.protocol === "https:" && /^ilink[a-z0-9-]*\.weixin\.qq\.com$/.test(url.hostname) && !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash, "INVALID_CONNECTION", "微信返回的连接地址无效");
  return url.origin;
}
function feishuWebhook(value) {
  let url; try { url = new URL(value); } catch { /* validated below */ }
  check(url?.protocol === "https:" && url.hostname === "open.feishu.cn" && !url.username && !url.password && !url.port && /^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9_-]+$/.test(url.pathname) && !url.search && !url.hash, "INVALID_INPUT", "请填写飞书自定义机器人的完整 Webhook 地址");
  return url.href;
}

// Outbound doctor digests only. What leaves the machine is the doctor's own
// choice per channel (DETAIL): counts only (default, and what every existing
// connection keeps), surname-masked names with the agenda item title, or full
// names with the item detail. Chat messages and record text never enter the
// payload. Credentials share the app's vault.
export const DETAIL = Object.freeze(["count", "masked", "full"]);
const DETAIL_NOTE = {
  count: "提醒只包含待办数量，请在工作台查看患者详情。",
  masked: "提醒列出姓氏和待办事项，不含全名、联系方式和病历内容。",
  full: "提醒列出患者全名、待办事项和简要说明，会经过微信或飞书服务器。",
};
const LIST_LIMIT = 30, TEXT_LIMIT = 1800;
const maskName = (name) => {
  const chars = [...String(name || "")];
  return chars.length ? `${chars[0]}${"*".repeat(Math.max(1, Math.min(chars.length - 1, 2)))}` : "患者";
};
const clip = (value, max) => { const chars = [...String(value || "")]; return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join(""); };
export class DoctorNotifications {
  constructor(store, vault, { fetchImpl = fetch, now = () => Date.now(), pollMs = 60000, autoStart = true, createFeishuRegistration = null, patients = () => null, followups = () => null, careTasks = () => null, agenda = null } = {}) {
    Object.assign(this, { store, vault, fetchImpl, now, pollMs, autoStart, createFeishuRegistration, patients, followups, careTasks, agenda });
    this.db = store.db; this.active = new Map(); this.controllers = new Set(); this.qr = null; this.stopped = false;
    this.initializeBinding();
    for (const row of this.db.prepare("SELECT channel,connection_id,day,data FROM doctor_notification_deliveries").all()) {
      const data = JSON.parse(row.data);
      if (data.status === "sending") this.writeDelivery({ ...data, status: "unknown", message: "上次发送被中断，请核对收件箱后再重试" });
    }
  }
  get binding() {
    if (!this._binding) {
      check(typeof this.createFeishuRegistration === "function", "CHANNEL_SERVICE", "飞书扫码绑定需要可用的 channel 插件服务", 503);
      const registration = this.createFeishuRegistration(this.bindingOptions);
      check(registration && typeof registration.start === "function", "CHANNEL_SERVICE", "飞书扫码绑定需要可用的 channel 插件服务", 503);
      this._binding = registration;
    }
    return this._binding;
  }
  bindingOrNull() {
    try { return this.binding; } catch { return null; }
  }
  initializeBinding() {
    this.bindingOptions = { vault: this.vault, key: 'notification-feishu-registration', fetchImpl: this.fetchImpl, now: this.now,
      canStart: () => check(!this.active.has('feishu') && !this.publicConfig('feishu').hasConnection, 'ALREADY_CONNECTED', '请先断开已有连接，再重新扫码。', 409),
      accept: (flow, complete) => {
        check(!this.active.has('feishu') && !this.publicConfig('feishu').hasConnection, 'ALREADY_CONNECTED', '连接已变化', 409);
        const { appId, appSecret, openId } = flow.credentials;
        check(/^ou_[a-zA-Z0-9]+$/.test(openId), 'INVALID_OWNER', '飞书未返回绑定账号，请重新扫码。');
        const config = this.config('feishu');
        flow.channelId = appId;
        sqliteTransaction(this.db, () => {
          this.vault.set(KEY('feishu'), { appId, appSecret, userId: openId });
          this.write({ ...config, enabled: false, connectionId: appId, revision: config.revision + 1 });
          complete();
        });
        return appId;
      }
    };
  }
  config(channel) {
    check(CHANNELS.includes(channel), "INVALID_INPUT", "提醒渠道无效");
    const row = this.db.prepare("SELECT data FROM doctor_notification_settings WHERE channel=?").get(channel);
    const config = row ? JSON.parse(row.data) : { channel, enabled: false, time: "09:00", timezone: "Asia/Shanghai", revision: 0, connectionId: "" };
    return { ...config, detail: DETAIL.includes(config.detail) ? config.detail : "count" };
  }
  write(config) { this.db.prepare("INSERT OR REPLACE INTO doctor_notification_settings VALUES (?,?)").run(config.channel, JSON.stringify(config)); }
  receipt(config, day = local(this.now(), config.timezone).day) {
    const row = this.db.prepare("SELECT data FROM doctor_notification_deliveries WHERE channel=? AND connection_id=? AND day=?").get(config.channel, config.connectionId, day);
    return row ? JSON.parse(row.data) : null;
  }
  publicConfig(channel) {
    const config = this.config(channel), secret = this.vault.get(KEY(channel));
    return { ...config, feishuBinding: channel === "feishu" ? this.bindingOrNull()?.publicStatus() ?? { status: "unavailable" } : undefined, appId: secret.appId, hasConnection: channel === "wechat" ? Boolean(secret.botToken && secret.userId) : Boolean(secret.webhook || (secret.appId && secret.appSecret && secret.userId)), hasSigningSecret: Boolean(secret.signingSecret), busy: this.active.has(channel), delivery: this.receipt(config), preview: this.preview(config.timezone, config.detail) };
  }
  settings() { return { channels: CHANNELS.map(channel => this.publicConfig(channel)) }; }
  // The digest mirrors the doctor's 今日待办 (patient lane) when the host
  // supplies it, so the push and the workbench never disagree. Without an
  // agenda (bare unit construction) the legacy follow-up/tracking count stays.
  preview(timezone, detail = "count") {
    const today = local(this.now(), timezone).day;
    if (typeof this.agenda === "function") {
      let result = null;
      // Read the agenda as of the end of the doctor's local day, so a 09:00
      // digest already lists follow-ups and tasks that fall due later today.
      const { clock } = local(this.now(), timezone), [h, m] = clock.split(":").map(Number);
      const endOfDay = this.now() + ((24 * 60 - (h * 60 + m)) * 60000) - 1;
      try { result = this.agenda({ kind: "all", limit: 100, now: endOfDay }); }
      catch (error) {
        // Never report "nothing to do" when the agenda could not be read.
        return { day: today, patients: 0, items: 0, detail, error: error instanceof AppError ? error.message : "读取今日待办失败", text: "" };
      }
      if (result) return this.agendaDigest(result, today, detail);
    }
    const due = at => Number.isFinite(at) && local(at, timezone).day <= today;
    let people = new Set();
    try {
      const rows = this.patients()?.all?.() || [];
      people = new Set(rows.filter(row => !row.archived).map(row => row.id));
    } catch { /* Patient service unavailable leaves the digest empty. */ }
    // Follow-ups and care tasks belong to other plugins. Their services are
    // optional: a disabled or missing plugin contributes no rows, never an
    // error page. The fixed reminders table stays readable here.
    const followup = new Set(), tracking = new Set();
    for (const row of this.db.prepare("SELECT patient_id,due_at FROM reminders WHERE status='pending'").all()) if (people.has(row.patient_id) && due(row.due_at)) followup.add(row.patient_id);
    try {
      const jobs = this.followups()?.overview?.({ limit: 500 }) || [];
      for (const job of jobs) if (people.has(job.patientId) && due(job.nextDue)) followup.add(job.patientId);
    } catch { /* followup plugin inactive */ }
    try {
      const service = this.careTasks();
      for (const patientId of people) {
        try {
          const items = service?.list?.(patientId, { status: "active", limit: 100 })?.items || [];
          for (const task of items) if (task.patientId === patientId && (task.status !== "waiting_result" || due(task.dueAt))) tracking.add(patientId);
        } catch { /* one patient's rows must not hide the rest */ }
      }
    } catch { /* care-tasks plugin inactive */ }
    const count = new Set([...followup, ...tracking]).size;
    return { day: today, patients: count, items: count, followup: followup.size, tracking: tracking.size, detail: "count", text: `Open Medical · 医生随访提醒\n${today}：${count} 位患者有今日或逾期的随访、待跟进事项。\n待随访 ${followup.size} 位，待跟进 ${tracking.size} 位。\n请打开 Open Medical 的「随访」与「今日待办」查看并处理。` };
  }
  agendaDigest(result, today, detail) {
    const items = Array.isArray(result.items) ? result.items : [];
    const total = Number.isSafeInteger(result.total) ? result.total : items.length;
    const order = (result.kinds || []).filter((k) => k.kind !== "all");
    const labels = Object.fromEntries(order.map((k) => [k.kind, k.label]));
    const patients = new Set(items.filter((item) => item.patientId).map((item) => item.patientId));
    const byKind = order.map((k) => ({ ...k, rows: items.filter((item) => item.kind === k.kind) })).filter((k) => k.rows.length);
    for (const item of items) if (!labels[item.kind] && !byKind.some((k) => k.kind === item.kind)) byKind.push({ kind: item.kind, label: item.kind, rows: items.filter((row) => row.kind === item.kind) });
    // Per-kind totals come from the agenda counts, not the first page of rows.
    const kindTotal = Object.fromEntries((result.kinds || []).filter((k) => Number.isSafeInteger(k.count)).map((k) => [k.kind, k.count]));
    const count = (kind) => kindTotal[kind] ?? items.filter((item) => item.kind === kind).length;
    const lines = [`Open Medical · 今日待办提醒（${today}）`];
    if (!total) lines.push("今天没有需要处理的患者待办。");
    else {
      lines.push(`共 ${total} 项待办，涉及 ${patients.size} 位患者。`, byKind.map((k) => `${k.label} ${kindTotal[k.kind] ?? k.rows.length}`).join(" · "));
      if (detail !== "count") {
        let listed = 0;
        for (const group of byKind) {
          if (listed >= LIST_LIMIT) break;
          lines.push("", `【${group.label}】`);
          for (const item of group.rows) {
            if (listed >= LIST_LIMIT) break;
            const name = item.patientId ? (detail === "full" ? item.patientName : maskName(item.patientName)) : item.patientName;
            lines.push(`${++listed}. ${clip(name, 20)} · ${clip(item.title, 40)}${detail === "full" && item.detail ? `（${clip(item.detail, 60)}）` : ""}`);
          }
        }
        if (total > listed) lines.push("", `另有 ${total - listed} 项未列出。`);
      }
    }
    lines.push("", "请打开 Open Medical「今日待办」处理；本消息只是提醒，不会联系患者。");
    let text = lines.join("\n");
    if ([...text].length > TEXT_LIMIT) text = `${clip(text, TEXT_LIMIT - 40)}\n（内容过长已截断，请在工作台查看全部）`;
    return { day: today, patients: patients.size, items: total, followup: count("followup"), tracking: count("tracking"), detail, text };
  }
  save(channel, input) {
    const previous = this.config(channel);
    check(!this.active.has(channel), "BUSY", "正在处理该渠道，请稍后再修改", 409);
    check(input?.expectedRevision === previous.revision, "REVISION_CONFLICT", "配置已变化，请刷新后重试", 409);
    check(typeof input.enabled === "boolean" && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.time || ""), "INVALID_INPUT", "请选择启用状态与每日提醒时间");
    check(text(input.timezone, 100), "INVALID_INPUT", "时区无效");
    try { local(this.now(), input.timezone); } catch { throw new AppError("INVALID_INPUT", "时区无效"); }
    const secret = this.vault.get(KEY(channel)); let changed = false;
    if (channel === "feishu") {
      check(input.webhook === undefined || text(input.webhook), "INVALID_INPUT", "Webhook 地址无效");
      check(input.signingSecret === undefined || text(input.signingSecret, 512), "INVALID_INPUT", "签名密钥无效");
      if (input.webhook?.trim()) { const webhook = feishuWebhook(input.webhook.trim()); changed = secret.webhook !== webhook; secret.webhook = webhook; if (changed) secret.signingSecret = ""; }
      if (input.clearSigningSecret) secret.signingSecret = "";
      else if (input.signingSecret?.trim()) secret.signingSecret = input.signingSecret.trim();
    }
    check(!input.enabled || (channel === "wechat" ? secret.botToken && secret.userId : secret.webhook || (secret.appId && secret.appSecret && secret.userId)), "NOT_CONFIGURED", channel === "wechat" ? "请先扫码连接医生的微信" : "请先扫码连接飞书");
    check(input.detail === undefined || DETAIL.includes(input.detail), "INVALID_INPUT", "提醒内容选项无效");
    const next = { ...previous, enabled: input.enabled, time: input.time, timezone: input.timezone, detail: input.detail ?? previous.detail, revision: previous.revision + 1, connectionId: changed || !previous.connectionId ? randomUUID() : previous.connectionId };
    sqliteTransaction(this.db, () => { this.vault.set(KEY(channel), secret); this.write(next); });
    return this.publicConfig(channel);
  }
  disconnect(channel, revision) {
    const config = this.config(channel);
    check(!this.active.has(channel), "BUSY", "正在处理该渠道，请稍后再断开", 409);
    check(config.revision === revision, "REVISION_CONFLICT", "配置已变化，请刷新后重试", 409);
    if (channel === "wechat") this.qr = null;
    else this.bindingOrNull()?.clearForChannel(config.connectionId);
    sqliteTransaction(this.db, () => { this.vault.delete(KEY(channel)); this.write({ ...config, enabled: false, connectionId: "", revision: config.revision + 1 }); });
    return this.publicConfig(channel);
  }
  async request(url, init, timeout = 15000) {
    check(!this.stopped, "STOPPING", "应用正在退出", 503);
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
    try {
      const response = await this.fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
      if (!response.ok) throw new AppError("DELIVERY_FAILED", `提醒服务返回 HTTP ${response.status}，请检查连接`);
      const data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Malformed response");
      return data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("DELIVERY_UNKNOWN", "网络异常，无法确认是否送达；请先核对收件箱");
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  async exclusive(channel, action) {
    check(!this.active.has(channel), "BUSY", "该渠道正在处理，请稍后再试", 409);
    const promise = Promise.resolve().then(action); this.active.set(channel, promise);
    try { return await promise; } finally { this.active.delete(channel); }
  }
  async startQr() {
    return this.exclusive("wechat", async () => {
      const data = await this.request(`${ILINK}/ilink/bot/get_bot_qrcode?bot_type=3`, { headers: headers() });
      check(text(data.qrcode) && data.qrcode && text(data.qrcode_img_content) && data.qrcode_img_content, "CONNECT_FAILED", "微信未返回有效二维码，请重试");
      const qr = { id: randomUUID(), code: data.qrcode, expiresAt: this.now() + 5 * 60000, revision: this.config("wechat").revision };
      this.qr = qr;
      return { id: qr.id, expiresAt: qr.expiresAt, image: await QRCode.toDataURL(data.qrcode_img_content, { width: 240, margin: 2 }) };
    });
  }
  async pollQr(id) {
    return this.exclusive("wechat", async () => {
      const qr = this.qr;
      check(qr?.id === id && qr.expiresAt > this.now(), "QR_EXPIRED", "二维码已过期，请重新生成");
      const data = await this.request(`${ILINK}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.code)}`, { headers: headers() }, 40000);
      if (data.status !== "confirmed") return { status: ["wait", "scaned", "scanned", "expired"].includes(data.status) ? data.status : "wait" };
      const config = this.config("wechat");
      check(this.qr === qr && config.revision === qr.revision, "REVISION_CONFLICT", "连接配置已变化，请重新扫码", 409);
      const botToken = data.bot_token || data.token, userId = data.ilink_user_id || data.user_id, botId = data.ilink_bot_id || data.bot_id || "";
      check(text(botToken) && botToken && text(userId, 256) && userId && text(botId, 256), "CONNECT_FAILED", "微信未返回完整连接信息，请重新扫码");
      const baseUrl = wechatOrigin(data.baseurl || ILINK);
      sqliteTransaction(this.db, () => { this.vault.set(KEY("wechat"), { botToken, userId, botId, baseUrl }); this.write({ ...config, enabled: false, connectionId: randomUUID(), revision: config.revision + 1 }); });
      this.qr = null;
      return { status: "confirmed", config: this.publicConfig("wechat") };
    });
  }
  async deliver(channel, message, clientId) {
    const secret = this.vault.get(KEY(channel)); let result;
    if (channel === "feishu" && secret.appId) {
      check(secret.appSecret && secret.userId, 'NOT_CONFIGURED', '请先扫码连接飞书');
      const auth = await this.request('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: secret.appId, app_secret: secret.appSecret }) });
      check(auth.code === 0 && typeof auth.tenant_access_token === 'string' && auth.tenant_access_token, 'DELIVERY_FAILED', '飞书连接已失效，请重新扫码。');
      result = await this.request('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${auth.tenant_access_token}` }, body: JSON.stringify({ receive_id: secret.userId, msg_type: 'text', content: JSON.stringify({ text: message }), uuid: clientId }) });
      check(result.code === 0, 'DELIVERY_FAILED', '飞书未接受提醒，请打开机器人会话后重试。');
    } else if (channel === "feishu") {
      check(secret.webhook, "NOT_CONFIGURED", "请先保存飞书机器人连接");
      const payload = { msg_type: "text", content: { text: message } };
      if (secret.signingSecret) { payload.timestamp = String(Math.floor(this.now() / 1000)); payload.sign = createHmac("sha256", `${payload.timestamp}\n${secret.signingSecret}`).update("").digest("base64"); }
      result = await this.request(feishuWebhook(secret.webhook), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      check(result.code === 0 || (result.code === undefined && result.StatusCode === 0), "DELIVERY_FAILED", `飞书未接受提醒（代码 ${Number(result.code ?? result.StatusCode) || "未知"}），请检查机器人权限、关键词或签名`);
    } else {
      check(secret.botToken && secret.userId, "NOT_CONFIGURED", "请先扫码连接医生的微信");
      const body = JSON.stringify({ base_info: { channel_version: "2.2.0" }, msg: { from_user_id: secret.botId, to_user_id: secret.userId, client_id: clientId, message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text: message } }] } });
      result = await this.request(`${wechatOrigin(secret.baseUrl)}/ilink/bot/sendmessage`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json", AuthorizationType: "ilink_bot_token", Authorization: `Bearer ${secret.botToken}`, "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64") }, body });
      check((result.ret === 0 || result.errcode === 0) && (result.ret === undefined || result.ret === 0) && (result.errcode === undefined || result.errcode === 0), "DELIVERY_FAILED", `微信未接受提醒（代码 ${Number(result.errcode || result.ret) || "未知"}），请向机器人发送一条消息后重新连接`);
    }
  }
  async test(channel) {
    this.config(channel);
    return this.exclusive(channel, async () => { await this.deliver(channel, `Open Medical · 今日待办提醒\n这是一条连接测试消息。${DETAIL_NOTE[this.config(channel).detail]}`, `omw-test-${randomUUID()}`); return { message: "平台已接受测试消息，请在微信或飞书中确认收到。" }; });
  }
  writeDelivery(value) { this.db.prepare("INSERT OR REPLACE INTO doctor_notification_deliveries VALUES (?,?,?,?)").run(value.channel, value.connectionId, value.day, JSON.stringify(value)); }
  async send(channel, { retryId } = {}) {
    return this.exclusive(channel, async () => {
      const config = this.config(channel); check(config.enabled, "DISABLED", "请先启用并保存每日提醒");
      const summary = this.preview(config.timezone, config.detail), previous = this.receipt(config, summary.day);
      if (previous && !retryId) return { delivery: previous, message: previous.status === "sent" ? "今日提醒已发送，不重复发送。" : "今日发送未完成，请核对收件箱后重试。" };
      if (retryId) check(previous?.id === retryId && ["failed", "unknown"].includes(previous.status), "CONFLICT", "发送状态已变化，请刷新后重试", 409);
      if (summary.error) {
        const failed = { id: randomUUID(), channel, connectionId: config.connectionId, day: summary.day, at: this.now(), status: "failed", patients: 0, items: 0, detail: summary.detail, attempt: (previous?.attempt || 0) + 1, message: `未能生成今日提醒：${summary.error}` };
        this.writeDelivery(failed);
        return { delivery: failed, message: failed.message };
      }
      if (!summary.items) return { message: "今天没有需要处理的患者待办，无需发送。" };
      const delivery = { id: randomUUID(), channel, connectionId: config.connectionId, day: summary.day, at: this.now(), status: "sending", patients: summary.patients, items: summary.items, detail: summary.detail, attempt: (previous?.attempt || 0) + 1 };
      this.writeDelivery(delivery);
      try { await this.deliver(channel, summary.text, `omw-${delivery.id}`); delivery.status = "sent"; delivery.message = "平台已接受今日提醒"; }
      catch (error) { delivery.status = error.code === "DELIVERY_UNKNOWN" ? "unknown" : "failed"; delivery.message = error instanceof AppError ? error.message : "发送失败，请检查连接"; }
      this.writeDelivery(delivery);
      return { delivery, message: delivery.message };
    });
  }
  async tick() {
    for (const channel of CHANNELS) {
      if (this.stopped) return;
      const config = this.config(channel), { day, clock } = local(this.now(), config.timezone);
      if (config.enabled && !this.active.has(channel) && clock >= config.time && !this.receipt(config, day)) await this.send(channel).catch(() => {});
    }
  }
  start() { if (!this.autoStart || this.timer) return; this.bindingOrNull()?.start(); this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.pollMs); this.timer.unref?.(); void this.tick().catch(() => {}); }
  async stop() { if (this._binding) await this._binding.stop(); this.stopped = true; clearInterval(this.timer); for (const c of this.controllers) c.abort(); await Promise.allSettled([...this.active.values()]); }
}
