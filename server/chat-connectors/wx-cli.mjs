import { createHash } from "node:crypto";
import { check, AppError } from "../errors.mjs";
import { collectorUrl } from "./wecom-archive.mjs";

const LIMIT = 100;
const protocol = (ok, message = "wx-cli 返回的数据格式不兼容") =>
  check(ok, "WXCLI_PROTOCOL", message, 502);
const integer = (value) => {
  const s =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : value;
  protocol(typeof s === "string" && /^-?\d{1,20}$/.test(s));
  return s;
};
const iso = (value) => {
  protocol(Number.isSafeInteger(value) && value >= 0 && value <= 253402300799);
  return new Date(value * 1000).toISOString();
};
const conversation = (value) =>
  value.endsWith("@chatroom") ? `room:${value}` : value;

export class WxCliClient {
  constructor({ fetch: fetchImpl = fetch, now = Date.now } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
  }
  async request(config, path, params = {}, signal) {
    const endpoint = collectorUrl(config.endpoint);
    const url = new URL(endpoint + "/api/v1/" + path);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, String(value));
    let response;
    try {
      response = await this.fetch(url, {
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
        headers: config.token
          ? { authorization: `Bearer ${config.token}` }
          : {},
      });
    } catch {
      throw new AppError(
        "WXCLI_CONNECTION",
        "无法连接 wx-cli，请检查服务地址和运行状态，或重试已取消的请求",
        502,
      );
    }
    check(
      response.ok,
      "WXCLI_CONNECTION",
      response.status === 401
        ? "wx-cli 连接密钥无效"
        : "wx-cli 查询失败，请检查账号与数据库状态",
      502,
    );
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        check(size <= 4_000_000, "WXCLI_LIMIT", "wx-cli 响应超过 4 MB", 502);
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    try {
      // Rust emits i64 as JSON numbers; retain their original digits before JS rounds them.
      return JSON.parse(
        Buffer.concat(chunks).toString(),
        (_key, value, context) => {
          if (
            typeof value === "number" &&
            Number.isInteger(value) &&
            !Number.isSafeInteger(value)
          ) {
            protocol(context?.source && /^-?\d+$/.test(context.source));
            return context.source;
          }
          return value;
        },
      );
    } catch {
      throw new AppError(
        "WXCLI_PROTOCOL",
        "wx-cli 未返回有效 JSON 或精确整数",
        502,
      );
    }
  }
  async health(config, signal) {
    const body = await this.request(config, "health", {}, signal);
    check(
      body?.ready === true,
      "WXCLI_NOT_READY",
      "wx-cli 数据库尚未就绪",
      503,
    );
    check(
      body.current_account?.wxid === config.accountId,
      "WXCLI_IDENTITY",
      "wx-cli 当前账号与填写的账号 ID 不一致，请核对 server status 的 current_account.wxid",
      409,
    );
    protocol(typeof body.worker_id === "string" && body.worker_id.length > 0);
    return body;
  }
  async status(config, signal) {
    await this.health(config, signal);
    return {
      ready: true,
      message: "wx-cli 已连接并核对账号；可读取本机已有聊天记录",
    };
  }
  envelope(body) {
    protocol(
      body &&
        Array.isArray(body.items) &&
        body.items.length <= LIMIT &&
        typeof body.paging?.has_more === "boolean",
    );
    check(
      !body.stats?.shard_warnings?.length && !body.stats?.skipped,
      "WXCLI_PARTIAL",
      "wx-cli 存在未读取的数据分片或消息，请修复数据库后重试；同步进度未推进",
      502,
    );
    return body;
  }
  async conversations(config, signal) {
    const before = await this.health(config, signal);
    const result = [];
    let more = false;
    for (let offset = 0; offset < 500; offset += LIMIT) {
      const body = this.envelope(
        await this.request(
          config,
          "sessions",
          { limit: LIMIT, offset },
          signal,
        ),
      );
      for (const item of body.items) {
        protocol(
          typeof item.username === "string" &&
            item.username.length > 0 &&
            item.username.length <= 280,
        );
        result.push({
          id: conversation(item.username),
          title:
            typeof item.display_name === "string"
              ? item.display_name.slice(0, 150)
              : item.username,
          lastMessageAt: iso(item.sort_timestamp),
        });
      }
      more = body.paging.has_more;
      if (!more) break;
    }
    protocol(
      (await this.health(config, signal)).worker_id === before.worker_id,
      "wx-cli 服务已重启，请重试",
    );
    return { conversations: result, partial: more };
  }
  async read(config, cursor, signal) {
    const before = await this.health(config, signal);
    let state = { version: 1, chats: {}, index: 0 };
    if (cursor !== "0") {
      try {
        state = JSON.parse(cursor);
      } catch {
        protocol(false, "wx-cli 同步进度无效，请重新扫描历史");
      }
      protocol(
        state.version === 1 &&
          state.chats &&
          Number.isSafeInteger(state.index) &&
          state.index >= 0,
      );
    }
    const ids = [...new Set(config.conversations)].sort();
    protocol(ids.length > 0 && ids.length <= 500);
    const index = state.index % ids.length,
      id = ids[index];
    const talker = id.startsWith("room:") ? id.slice(5) : id;
    const saved = Object.hasOwn(state.chats, id)
      ? state.chats[id]
      : { since: 0, offset: 0 };
    const until = saved.until ?? Math.floor(this.now() / 1000);
    const { since, offset } = saved;
    protocol(
      [since, until, offset].every((n) => Number.isSafeInteger(n) && n >= 0) &&
        until >= since,
    );
    const body = this.envelope(
      await this.request(
        config,
        "messages",
        { contact: talker, limit: LIMIT, offset, order: "asc", since, until },
        signal,
      ),
    );
    protocol(body.paging.offset === offset && body.paging.limit === LIMIT);
    const messages = body.items.map((item) => {
      protocol(
        item.talker === talker &&
          typeof item.sender === "string" &&
          item.sender.length <= 200 &&
          Number.isInteger(item.msg_type),
      );
      const serverId = integer(item.server_id),
        sortSeq = integer(item.sort_seq);
      const text =
        typeof item.content?.Text === "string"
          ? item.content.Text
          : item.snippet;
      protocol(typeof text === "string" && text.length <= 20000);
      const sentAt = iso(item.create_time);
      protocol(item.create_time >= since && item.create_time <= until);
      return {
        id: createHash("sha256")
          .update(
            JSON.stringify([
              id,
              serverId === "0" ? ["local", sortSeq] : serverId,
            ]),
          )
          .digest("hex"),
        conversationId: id,
        senderId: item.sender,
        direction:
          item.sender === config.accountId
            ? "out"
            : item.sender
              ? "in"
              : "unknown",
        type: item.msg_type === 1 ? "text" : `wechat:${item.msg_type}`,
        text,
        sentAt,
        partial: item.msg_type !== 1,
        evidence: {
          coverage: "wx-cli-local",
          serverId,
          sortSeq,
          mediaDecoded: false,
        },
      };
    });
    protocol(
      (await this.health(config, signal)).worker_id === before.worker_id,
      "wx-cli 服务已重启，请重试",
    );
    // Advance by the upstream window, including sender-hidden rows; never request show_hidden.
    const next = body.paging.has_more
      ? { since, until, offset: offset + LIMIT }
      : { since: Math.max(0, until - 300), offset: 0 };
    const chats = Object.fromEntries(
      ids
        .filter((key) => Object.hasOwn(state.chats, key))
        .map((key) => [key, state.chats[key]]),
    );
    Object.defineProperty(chats, id, {
      value: next,
      enumerable: true,
      configurable: true,
    });
    return {
      messages,
      nextCursor: JSON.stringify({
        version: 1,
        chats,
        index: body.paging.has_more ? index : (index + 1) % ids.length,
      }),
      hasMore: body.paging.has_more || index < ids.length - 1,
    };
  }
}
