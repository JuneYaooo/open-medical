// 企业微信智能机器人长连接协议客户端(wss://openws.work.weixin.qq.com)。
// 协议:连接后发 aibot_subscribe(bot_id+secret)完成认证;每 30s ping 保活;
// 收 aibot_msg_callback / aibot_event_callback 推送;回复用 aibot_respond_msg 透传 req_id。
// 响应帧没有 cmd,靠 req_id 前缀/登记路由(errcode 在顶层);认证失败不重连,断线指数退避。
// 单机器人同时只允许一条有效连接,新连接会把旧连接踢下线,因此这里只维护一条。
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export const AIBOT_WS_URL = "wss://openws.work.weixin.qq.com";
const MAX_BACKOFF = 30000;

// 群聊会话统一 room: 前缀(与 wx-cli/导出一致,抑制自动草稿,走人工分配);
// 单聊直接用对方 userid。@ 机器人名的前缀由客户端拼接,剥掉再入库。
export function toChatMessage(body, observedAt = new Date().toISOString()) {
  const userid = body?.from?.userid;
  if (!userid) return null;
  const conversationId =
    body.chattype === "group" ? (body.chatid ? `room:${body.chatid}` : null) : userid;
  if (!conversationId) return null;
  const type = typeof body.msgtype === "string" ? body.msgtype : "unknown";
  let text = "";
  if (type === "text" && body.text)
    text = String(body.text.content || "")
      .replace(/^@\S+\s+/, "")
      .slice(0, 20000);
  return {
    id: `aibot:${body.msgid}`,
    conversationId,
    text,
    type,
    direction: "in",
    senderId: userid,
    sentAt: null,
    observedAt,
    partial: false,
  };
}

export class AibotSocket extends EventEmitter {
  constructor({ botId, secret, url = AIBOT_WS_URL, WebSocketImpl = WebSocket, log = () => {} }) {
    super();
    Object.assign(this, { botId, secret, url, WebSocketImpl, log });
    this.ws = null;
    this.authed = false;
    this.stopped = false;
    this.backoff = 1000;
    this.pending = new Map(); // req_id -> {type, resolve, reject, timer}
  }
  connect() {
    this.stopped = false;
    this.open();
  }
  open() {
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.on("open", () => {
      const reqId = this.request("aibot_subscribe", { bot_id: this.botId, secret: this.secret }, "auth");
      void reqId;
    });
    ws.on("message", (raw) => this.receive(String(raw)));
    ws.on("close", () => this.teardown("连接关闭"));
    ws.on("error", (e) => this.log(`长连接错误:${e?.message || e}`));
  }
  receive(raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    if (frame?.cmd) {
      if (frame.cmd === "aibot_msg_callback") return this.emit("message", frame);
      if (frame.cmd === "aibot_event_callback") return this.emit("event", frame);
      return; // disconnected_event 等通知:被踢后的断线由 close 事件统一走重连。
    }
    const entry = this.pending.get(frame?.headers?.req_id || "");
    if (!entry) return;
    this.pending.delete(entry.reqId);
    if (entry.timer) clearTimeout(entry.timer);
    const code = frame?.errcode;
    if (entry.type === "auth") {
      if (code === 0) {
        this.authed = true;
        this.backoff = 1000;
        const ping = setInterval(() => this.request("ping", {}, "ping"), 30000);
        ping.unref?.();
        this.ping = ping;
        this.emit("authenticated");
      } else {
        // 凭据被拒:不重连,停在离线等配置更新后由服务重新拉起。
        this.stopped = true;
        this.ws?.close();
        this.emit("authError", code, frame?.errmsg || "认证失败");
      }
      return;
    }
    if (entry.type === "reply") {
      return code === 0
        ? entry.resolve(frame)
        : entry.reject(new Error(`回复失败 errcode=${code} ${frame?.errmsg || ""}`));
    }
    if (code !== 0) this.log(`心跳异常 errcode=${code}`);
  }
  request(cmd, body, type, extraHeaders) {
    const reqId = `${cmd}-${randomUUID()}`;
    const entry = { reqId, type };
    this.pending.set(reqId, entry);
    this.send({ cmd, headers: { req_id: reqId, ...extraHeaders }, body });
    return entry;
  }
  send(frame) {
    if (this.ws?.readyState === this.ws?.OPEN) this.ws.send(JSON.stringify(frame));
  }
  // 被动回复:透传消息回调的 req_id,服务端据此路由回原会话。
  reply(frame, body) {
    return this.respond("aibot_respond_msg", frame?.headers?.req_id, body);
  }
  // 主动推送(aibot_send_msg):用户近期与机器人有过会话即可发;单聊 chatid 传对方 userid。
  push(chatId, body) {
    return this.respond("aibot_send_msg", null, { chatid: chatId, chat_type: 0, ...body });
  }
  respond(cmd, reqId, body) {
    return new Promise((resolve, reject) => {
      if (!this.authed) return reject(new Error("长连接未就绪"));
      if (cmd === "aibot_respond_msg" && (!reqId || this.pending.has(reqId)))
        return reject(new Error("缺少可用的回调 req_id"));
      const key = reqId || `${cmd}-${randomUUID()}`;
      const entry = { reqId: key, type: "reply", resolve, reject };
      this.pending.set(key, entry);
      entry.timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error("回复超时"));
      }, 8000);
      entry.timer.unref?.();
      this.send({ cmd, headers: { req_id: key }, body });
    });
  }
  teardown(reason) {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject?.(new Error(`连接断开:${reason}`));
    }
    this.pending.clear();
    this.authed = false;
    this.emit("disconnected", reason);
    if (this.stopped) return;
    this.log(`${reason},${Math.round(this.backoff / 1000)}s 后重连`);
    const timer = setTimeout(() => this.open(), this.backoff);
    timer.unref?.();
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
  }
  close() {
    this.stopped = true;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    this.ws?.close();
    this.ws = null;
    this.authed = false;
  }
  get live() {
    return Boolean(this.ws && this.authed && this.ws.readyState === this.ws.OPEN);
  }
}
