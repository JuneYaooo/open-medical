import { AppError, check } from "../errors.mjs";

const BASE = "https://qyapi.weixin.qq.com/cgi-bin";
// Common configuration mistakes, explained in terms of the admin console.
const HINTS = {
  40001: "Secret 不正确或已重置", 40013: "企业 ID 不正确", 40056: "AgentId 不正确", 40243: "AgentId 不正确",
  41001: "缺少 access_token", 42001: "access_token 已过期", 45009: "调用太频繁，请稍后再试",
  48002: "该应用没有调用此接口的权限（在「客户联系 / 微信客服」中把应用加入可调用应用）",
  60020: "本机公网 IP 不在应用的「企业可信 IP」中",
  95000: "微信客服账号不存在或未授权给该 Secret", 95001: "已超过 48 小时会话窗口，需患者先发消息", 95002: "48 小时内最多回复 5 条，需患者再次发消息",
  95004: "微信客服账号 open_kfid 不正确", 95007: "消息已过期或无效",
  81013: "接收提醒的成员都无效：UserID 不存在或不在应用的可见范围内",
  301002: "AgentId 与应用 Secret 不属于同一个应用",
};
export const wecomHint = (errcode) => HINTS[errcode] || "";
// WeCom names the caller's public IP in 60020 errors ("from ip: 1.2.3.4"),
// which is exactly what the admin must add to the trusted-IP list.
const failure = (body, prefix) => {
  const ip = body.errcode === 60020 ? String(body.errmsg || "").match(/from ip:\s*([0-9a-fA-F.:]+)/)?.[1] || "" : "";
  const error = new AppError("WECOM_API", `${prefix}（错误码 ${body.errcode}${HINTS[body.errcode] ? `：${HINTS[body.errcode]}` : ""}${ip ? `，本机公网 IP 为 ${ip}` : ""}）`, 502);
  error.errcode = body.errcode;
  if (ip) error.ip = ip;
  return error;
};

// Minimal WeCom REST client for one (corpId, secret) pair: cached access
// token, no automatic retry of POSTs (a lost response must never resend).
export class WecomApi {
  constructor({ corpId, secret, fetch: fetchImpl = fetch, now = Date.now }) {
    this.corpId = corpId;
    this.secret = secret;
    this.fetch = fetchImpl;
    this.now = now;
    this.cached = null;
  }
  async json(url, init) {
    let response;
    try {
      response = await this.fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000), ...init });
    } catch {
      throw new AppError("WECOM_CONNECTION", "企业微信连接失败，请检查网络", 502);
    }
    check(response.ok, "WECOM_CONNECTION", `企业微信返回 HTTP ${response.status}`, 502);
    let body;
    try { body = await response.json(); } catch { throw new AppError("WECOM_RESPONSE", "企业微信返回格式无效", 502); }
    return body;
  }
  async token() {
    if (this.cached && this.cached.expires > this.now()) return this.cached.value;
    const body = await this.json(`${BASE}/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.secret)}`);
    if (body.errcode !== 0 || !body.access_token) throw failure(body, "企业微信凭据无效");
    this.cached = { value: body.access_token, expires: this.now() + (Math.max(60, Number(body.expires_in) || 7200) - 300) * 1000 };
    return this.cached.value;
  }
  async post(path, data) {
    const token = await this.token();
    const body = await this.json(`${BASE}${path}?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if ([40014, 42001, 40001].includes(body.errcode)) this.cached = null;
    if (body.errcode !== 0) throw failure(body, "企业微信拒绝请求");
    return body;
  }
  // 微信客服账号列表：用于核对 open_kfid 是否授权给了当前 Secret。
  listKfAccounts() {
    return this.post("/kf/account/list", { offset: 0, limit: 100 });
  }
  async get(path, params = {}) {
    const token = await this.token();
    const query = new URLSearchParams({ access_token: token, ...params });
    const body = await this.json(`${BASE}${path}?${query}`);
    if ([40014, 42001, 40001].includes(body.errcode)) this.cached = null;
    if (body.errcode !== 0) throw failure(body, "企业微信拒绝请求");
    return body;
  }
  // 微信客服：获取客服链接，患者在微信中打开即可发起咨询。
  addKfContactWay({ openKfId, scene }) {
    return this.post("/kf/add_contact_way", { open_kfid: openKfId, scene });
  }
  // 微信客服：拉取客户消息（回调只带 token，不带消息体）。
  syncKf({ cursor = "", token = "", openKfId, limit = 1000 }) {
    return this.post("/kf/sync_msg", { cursor, ...(token ? { token } : {}), limit, open_kfid: openKfId });
  }
  sendKf({ externalUserId, openKfId, text }) {
    return this.post("/kf/send_msg", { touser: externalUserId, open_kfid: openKfId, msgtype: "text", text: { content: text } });
  }
  // 自建应用详情：核对 AgentId 与 Secret 属于同一个应用。
  getAgent(agentId) {
    return this.get("/agent/get", { agentid: String(agentId) });
  }
  // 自建应用消息：用于提醒成员（医生/助理）。errcode 为 0 时仍可能有
  // 成员没收到，他们会列在 invaliduser / unlicenseduser 里。
  sendAppText({ agentId, userIds, text }) {
    return this.post("/message/send", { touser: userIds.join("|"), msgtype: "text", agentid: Number(agentId), text: { content: text } });
  }
}
