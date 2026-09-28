import { AppError, check } from "../errors.mjs";
import { WecomApi } from "./wecom-api.mjs";

const VAULT_KEY = "care:channels:v1";
export const CHANNEL_IDS = Object.freeze(["wecom-kf", "wecom-contact", "manual"]);
// 微信客服 may only answer within 48 hours of the customer's last message,
// and at most 5 messages until the customer writes again.
export const KF_WINDOW_MS = 48 * 3600000;
export const KF_WINDOW_MESSAGES = 5;
const LABELS = { "wecom-kf": "微信客服", "wecom-contact": "企业微信客户联系", manual: "人工发送" };

// Outbound channels. Only official WeCom APIs are used; a channel that
// cannot deliver unattended reports autoSend=false and the engine keeps
// its replies as drafts or member-confirmed tasks.
export class CareChannels {
  constructor({ vault, wecom, env = process.env, fetch: fetchImpl = fetch, now = Date.now }) {
    this.vault = vault;
    this.now = now;
    this.wecom = wecom;
    this.env = env;
    this.fetch = fetchImpl;
    this.clients = new Map();
  }
  config() {
    const saved = this.vault?.get(VAULT_KEY) || {};
    return {
      corpId: this.wecom?.corpId || this.env.MEDICAL_WECOM_CORP_ID || "",
      kfSecret: saved.kfSecret || this.env.MEDICAL_WECOM_KF_SECRET || "",
      openKfId: saved.openKfId || this.env.MEDICAL_WECOM_KF_ID || "",
      appSecret: saved.appSecret || this.env.MEDICAL_WECOM_AGENT_SECRET || "",
      agentId: saved.agentId || this.env.MEDICAL_WECOM_AGENT_ID || "",
    };
  }
  // Secrets are write-only: empty string keeps the stored value, null clears it.
  save(input = {}) {
    const saved = { ...(this.vault.get(VAULT_KEY) || {}) };
    for (const key of ["kfSecret", "appSecret", "openKfId", "agentId"]) {
      if (input[key] === null) delete saved[key];
      else if (typeof input[key] === "string" && input[key].trim()) {
        check(input[key].length <= 200 && /^[A-Za-z0-9_\-.]+$/.test(input[key].trim()), "INVALID_INPUT", `${key} 格式无效`);
        saved[key] = input[key].trim();
      }
    }
    this.vault.set(VAULT_KEY, saved);
    this.clients.clear();
    return this.public();
  }
  kfReady() { const c = this.config(); return Boolean(c.corpId && c.kfSecret && c.openKfId); }
  appReady() { const c = this.config(); return Boolean(c.corpId && c.appSecret && /^\d+$/.test(c.agentId)); }
  public() {
    const c = this.config();
    return {
      channels: [
        { id: "wecom-kf", label: LABELS["wecom-kf"], configured: this.kfReady(), autoSend: true, detail: "患者来消息后 48 小时内可自动回复（每次最多 5 条）" },
        { id: "wecom-contact", label: LABELS["wecom-contact"], configured: Boolean(this.wecom?.client), autoSend: false, detail: "生成群发任务，需成员在企业微信确认发送" },
        { id: "manual", label: LABELS.manual, configured: true, autoSend: false, detail: "复制内容后由医生或助理自行发送" },
      ],
      notifier: { id: "wecom-app", label: "企业微信应用消息", configured: this.appReady() },
      kf: { openKfId: c.openKfId, hasSecret: Boolean(c.kfSecret) },
      app: { agentId: c.agentId, hasSecret: Boolean(c.appSecret) },
    };
  }
  client(kind) {
    const c = this.config();
    const secret = kind === "kf" ? c.kfSecret : c.appSecret;
    const key = `${kind}:${c.corpId}:${secret}`;
    if (!this.clients.has(key)) this.clients.set(key, new WecomApi({ corpId: c.corpId, secret, fetch: this.fetch }));
    return this.clients.get(key);
  }
  canAutoSend(id) { return id === "wecom-kf" && this.kfReady(); }
  // Why 微信客服 cannot reach this patient right now, or "" when it can.
  kfBlocked(targets) {
    if (!this.kfReady()) return "微信客服未配置";
    if (!targets.kfExternalUserId) return "该患者尚未通过微信客服联系";
    const last = Date.parse(targets.kfLastInboundAt || "");
    if (!Number.isFinite(last) || this.now() - last > KF_WINDOW_MS) return "患者超过 48 小时未在微信客服发消息，微信客服暂不能主动发送";
    if ((targets.kfSentSinceInbound || 0) >= KF_WINDOW_MESSAGES) return "患者上次发消息后已回复 5 条，需等患者再次发消息";
    return "";
  }
  // Picks the preferred channel when it can reach this patient, else the
  // best available one; manual always works as the last resort.
  choose(preferred, targets) {
    const reachable = {
      "wecom-kf": !this.kfBlocked(targets),
      "wecom-contact": Boolean(this.wecom?.client) && Boolean(targets.bindingId),
      manual: true,
    };
    if (preferred && reachable[preferred]) return preferred;
    return CHANNEL_IDS.find((id) => reachable[id]);
  }
  async send(channel, { patientId, text, requestId, targets }) {
    if (channel === "manual") return { status: "sent", detail: "已标记为人工发送；请确认已在企业微信中发出。" };
    if (channel === "wecom-kf") {
      const blocked = this.kfBlocked(targets);
      check(!blocked, "CARE_CHANNEL", blocked, 409);
      const result = await this.client("kf").sendKf({ externalUserId: targets.kfExternalUserId, openKfId: this.config().openKfId, text });
      return { status: "sent", externalId: result.msgid || "", detail: "微信客服已发送（不代表已读）。" };
    }
    if (channel === "wecom-contact") {
      check(this.wecom?.client && targets.bindingId, "CARE_CHANNEL", "该患者没有已核实的企业微信客户关联", 409);
      const draft = this.wecom.draft({ patientId, bindingId: targets.bindingId, text, requestId });
      const task = await this.wecom.submit(draft.id, { confirmed: true });
      const status = task.status === "awaiting_member" ? "awaiting_member" : task.status === "sent" ? "sent" : task.status === "rejected" ? "failed" : "unknown";
      return { status, externalId: task.id, detail: task.detail || "" };
    }
    throw new AppError("CARE_CHANNEL", "未知发送渠道", 400);
  }
  // Checks each configured credential against WeCom without sending anything;
  // `only` limits the check to some of "contact", "kf", "app".
  async test({ only } = {}) {
    const c = this.config(), results = [];
    const run = async (id, label, configured, probe) => {
      if (only && !only.includes(id)) return;
      if (!configured) return results.push({ id, label, ok: null, detail: "未配置" });
      try { results.push({ id, label, ok: true, detail: await probe() }); }
      catch (error) { results.push({ id, label, ok: false, detail: error.message, ...(error.errcode ? { errcode: error.errcode } : {}), ...(error.ip ? { ip: error.ip } : {}) }); }
    };
    await run("contact", "客户联系", Boolean(c.corpId && this.wecom?.corpSecret), async () => {
      const api = new WecomApi({ corpId: c.corpId, secret: this.wecom.corpSecret, fetch: this.fetch });
      const body = await api.get("/externalcontact/get_follow_user_list");
      const members = body.follow_user || [];
      return members.length ? `可用；已开通客户联系的成员：${members.slice(0, 10).join("、")}${members.length > 10 ? " 等" : ""}` : "凭据可用，但还没有成员开通客户联系";
    });
    await run("kf", "微信客服", Boolean(c.corpId && c.kfSecret && c.openKfId), async () => {
      const body = await this.client("kf").listKfAccounts();
      const account = (body.account_list || []).find((a) => a.open_kfid === c.openKfId);
      check(account, "WECOM_API", `凭据可用，但账号 ${c.openKfId} 不在该 Secret 可管理的客服账号中`, 502);
      return `可用；客服账号「${account.name || c.openKfId}」`;
    });
    await run("app", "提醒应用", this.appReady(), async () => { await this.client("app").token(); return "凭据可用（未发送测试消息）"; });
    return { results, testedAt: new Date(this.now()).toISOString() };
  }
  // Accounts the saved 微信客服 Secret may manage; open_kfid is not shown in
  // the admin console, so setup picks it from this list.
  async kfAccounts() {
    const c = this.config();
    check(c.corpId && c.kfSecret, "CARE_CHANNEL", "请先填写企业 ID 和微信客服 Secret", 409);
    const body = await this.client("kf").listKfAccounts();
    return { accounts: (body.account_list || []).map((a) => ({ openKfId: a.open_kfid, name: a.name || a.open_kfid })), selected: c.openKfId };
  }
  // The customer-service link is created once per account and reused, since
  // every call to add_contact_way mints a new link.
  async kfLink() {
    check(this.kfReady(), "CARE_CHANNEL", "微信客服未配置", 409);
    const c = this.config(), saved = this.vault.get(VAULT_KEY) || {};
    if (saved.kfLink?.openKfId === c.openKfId && saved.kfLink.url) return { url: saved.kfLink.url, createdAt: saved.kfLink.createdAt };
    const { url } = await this.client("kf").addKfContactWay({ openKfId: c.openKfId, scene: "omw" });
    check(typeof url === "string" && url.startsWith("https://"), "WECOM_RESPONSE", "企业微信未返回客服链接", 502);
    const kfLink = { openKfId: c.openKfId, url, createdAt: new Date(this.now()).toISOString() };
    this.vault.set(VAULT_KEY, { ...(this.vault.get(VAULT_KEY) || {}), kfLink });
    return { url, createdAt: kfLink.createdAt };
  }
  async notify(userIds, text) {
    if (!userIds.length || !this.appReady()) return { ok: false, detail: "未配置企业微信应用消息或提醒对象" };
    try {
      await this.client("app").sendAppText({ agentId: this.config().agentId, userIds, text: text.slice(0, 1500) });
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  }
}
