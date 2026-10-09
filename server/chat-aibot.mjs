// 企业微信智能机器人通道:长连接实时接收 @ 消息/私聊,直接入聊天随访管线。
// 与轮询通道不同,推送到达即入库;read() 保持空实现仅为兼容现有调度与设置面。
// 会话可见性遵循机器人机制:只收 @ 自己的群消息与单聊,未绑定的会话先记录在
// seen 列表供医生绑定,绑定之前到达的消息不补录。
import { check, AppError } from "./errors.mjs";
import { AIBOT_WS_URL, AibotSocket, toChatMessage } from "./chat-connectors/wecom-aibot-ws.mjs";

export const AIBOT_CHANNEL = "wecom-aibot";
const SEEN_LIMIT = 200;

export class WecomAibotChannel {
  constructor({ url = AIBOT_WS_URL, socketFactory = null, log = () => {}, now = () => new Date().toISOString() } = {}) {
    Object.assign(this, { url, socketFactory, log, now });
    this.followups = null;
    this.socket = null;
    this.signature = "";
    this.secret = "";
    this.seen = new Map();
    this.timer = null;
  }
  attach(followups) {
    this.followups = followups;
  }
  get endpoint() {
    return this.url;
  }
  // ---- registry client 契约 ----
  async status(config) {
    check(config.accountId && String(config.accountId).trim(), "CHAT_CONFIG", "请填写机器人 ID（企业管理后台智能机器人页获取）", 409);
    const secret = String(config.token || "");
    check(secret, "CHAT_CONFIG", "请填写机器人 Secret（与机器人 ID 同页获取）", 409);
    if (this.live && this.secret === secret)
      return { ready: true, message: "长连接在线：群聊 @ 本机器人与单聊消息会实时进入工作台" };
    const ok = await this.probe(config.accountId.trim(), secret);
    return ok
      ? { ready: true, message: "机器人密钥有效，长连接已可建立" }
      : { ready: false, message: "无法建立长连接：请核对机器人 ID 与 Secret，并确认机器人已开启 API 模式（长连接）" };
  }
  async conversations() {
    return { conversations: this.seenList(), partial: false };
  }
  async read(_config, cursor) {
    return { messages: [], nextCursor: String(cursor || "0"), hasMore: false };
  }
  reply(frame, body) {
    return this.socket?.reply(frame, body);
  }
  // ---- 生命周期 ----
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.reconcile().catch(() => {}), 10000);
    this.timer.unref?.();
    this.reconcile().catch(() => {});
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
    this.signature = "";
  }
  get live() {
    return Boolean(this.socket?.live);
  }
  async reconcile() {
    const f = this.followups;
    if (!f || this.timer === null) return;
    let c, secret;
    try {
      c = f.config(AIBOT_CHANNEL);
      secret = f.secret(c).token || "";
    } catch {
      return; // 通道尚未注册(测试/早期启动),等下一轮。
    }
    const want = Boolean(c.enabled && secret);
    const signature = want ? `${c.revision}:${secret}` : "";
    if (signature === this.signature && (!want || this.live)) return;
    this.socket?.close();
    this.socket = null;
    this.signature = signature;
    this.secret = want ? secret : "";
    if (!want) return;
    this.socket = this.socketFactory
      ? this.socketFactory({ botId: c.accountId, secret, url: this.url })
      : new AibotSocket({ botId: c.accountId, secret, url: this.url, log: this.log });
    this.socket.on("message", (frame) => this.onMessage(frame));
    this.socket.on("authError", (code, message) => {
      this.log(`机器人认证失败(${code}):${message}`);
      this.signature = ""; // 凭据被拒,停在离线状态等配置更新。
    });
    this.socket.connect();
    this.log("企业微信智能机器人长连接已启动");
  }
  onMessage(frame) {
    const body = frame?.body || {};
    this.log(`收到消息:chat=${body.chattype || "?"} from=${body.from?.userid || "?"} text=${String(body.text?.content || body.msgtype || "").slice(0, 60)}`);
    const message = toChatMessage(body, this.now());
    if (!message) return;
    this.noteSeen(body);
    const f = this.followups;
    if (!f) return;
    try {
      const c = f.config(AIBOT_CHANNEL);
      if (!c.enabled) return;
      f.ingest(c, [message]);
    } catch (e) {
      this.log(`消息入库失败:${e instanceof AppError ? e.message : e?.message || e}`);
    }
  }
  noteSeen(body) {
    const id = body.chattype === "group" ? (body.chatid ? `room:${body.chatid}` : null) : body?.from?.userid;
    if (!id) return;
    this.seen.set(id, { id, title: id, lastMessageAt: this.now() });
    while (this.seen.size > SEEN_LIMIT) {
      const oldest = [...this.seen.values()].sort((a, b) => String(a.lastMessageAt).localeCompare(String(b.lastMessageAt)))[0];
      this.seen.delete(oldest.id);
    }
  }
  seenList() {
    return [...this.seen.values()].sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));
  }
  // 一次性探测:真实建立一次长连接完成认证即断开。已在线且密钥未变时直接短路,
  // 避免探测连接把在线连接踢下线。
  probe(botId, secret) {
    return new Promise((resolve) => {
      const socket = this.socketFactory
        ? this.socketFactory({ botId, secret, url: this.url })
        : new AibotSocket({ botId, secret, url: this.url, log: () => {} });
      const done = (value) => {
        socket.close();
        resolve(value);
      };
      socket.on("authenticated", () => done(true));
      socket.on("authError", () => done(false));
      socket.on("disconnected", () => done(false));
      socket.connect();
      setTimeout(() => done(false), 6000).unref?.();
    });
  }
}
