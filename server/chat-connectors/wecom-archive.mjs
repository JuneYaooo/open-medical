import { check, AppError } from '../errors.mjs';

export function collectorUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('CHAT_CONFIG', '请填写采集器地址'); }
  check(!url.username && !url.password && !url.search && !url.hash, 'CHAT_CONFIG', '采集器地址不能包含密码、查询参数或片段');
  check(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'CHAT_CONFIG', '远程采集器必须使用 HTTPS，本机可使用回环 HTTP');
  return url.href.replace(/\/$/, '');
}
export function sequence(value) {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n, 'ARCHIVE_PROTOCOL', '采集器游标须为 uint64 十进制字符串', 502);
  return value;
}
export class WecomArchiveClient {
  constructor({ fetch: fetchImpl = fetch } = {}) { this.fetch = fetchImpl; }
  async request(config, path, input, signal) {
    const base = collectorUrl(config.endpoint);
    check(config.token, 'CHAT_CONFIG', '请配置采集器连接密钥');
    let response;
    try {
      response = await this.fetch(base + path, { method: input ? 'POST' : 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
    } catch { throw new AppError('ARCHIVE_CONNECTION', '采集器连接失败或已取消，请检查地址、证书和运行状态', 502); }
    check(response.ok, 'ARCHIVE_CONNECTION', response.status === 401 ? '采集器连接密钥无效' : '采集器未能完成请求，请检查存档权限与 SDK 状态', 502);
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; check(size <= 4_000_000, 'ARCHIVE_LIMIT', '采集器响应过大', 502); chunks.push(value); } } finally { await reader.cancel(); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new AppError('ARCHIVE_PROTOCOL', '采集器未返回有效 JSON', 502); }
    check(body.version === 1 && body.corpId === config.accountId, 'ARCHIVE_IDENTITY', '采集器协议或企业 ID 与配置不一致', 502);
    return body;
  }
  async status(config, signal) { const body = await this.request(config, '/v1/status', null, signal); check(body.ready === true, 'ARCHIVE_NOT_READY', '采集器 SDK 或企业存档权限尚未就绪', 503); return { ready: true, message: '采集器已连接；实际可读取范围以存档授权为准' }; }
  async conversations(config, signal) {
    const body = await this.request(config, '/v1/conversations', null, signal);
    check(Array.isArray(body.conversations) && body.conversations.length <= 500 && body.conversations.every(c => typeof c.id === 'string' && c.id.length > 0 && c.id.length <= 300), 'ARCHIVE_PROTOCOL', '采集器会话列表格式无效', 502);
    return { conversations: body.conversations.map(c => ({ id: c.id, lastMessageAt: typeof c.lastMessageAt === 'string' && Number.isFinite(Date.parse(c.lastMessageAt)) ? c.lastMessageAt : null })), partial: body.partial === true };
  }
  async read(config, cursor, signal) {
    const body = await this.request(config, '/v1/messages', { cursor: sequence(cursor), limit: 100, conversations: config.conversations || [] }, signal);
    sequence(body.nextCursor);
    check(Array.isArray(body.messages) && body.messages.length <= 100 && typeof body.hasMore === 'boolean', 'ARCHIVE_PROTOCOL', '采集器消息分页格式无效', 502);
    check(BigInt(body.nextCursor) >= BigInt(cursor) && (!body.hasMore || BigInt(body.nextCursor) > BigInt(cursor)), 'ARCHIVE_PROTOCOL', '采集器游标没有向前推进', 502);
    let previous = BigInt(cursor);
    for (const m of body.messages) {
      sequence(m.seq);
      check(BigInt(m.seq) > previous && BigInt(m.seq) <= BigInt(body.nextCursor), 'ARCHIVE_PROTOCOL', '采集器消息序号无效', 502); previous = BigInt(m.seq);
      check(typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 200 && typeof m.conversationId === 'string' && m.conversationId.length > 0 && m.conversationId.length <= 300 && typeof m.senderId === 'string' && m.senderId.length <= 200, 'ARCHIVE_PROTOCOL', '采集器消息身份无效', 502);
      check(typeof m.text === 'string' && m.text.length <= 20000 && typeof m.type === 'string' && ['in','out','unknown'].includes(m.direction), 'ARCHIVE_PROTOCOL', '采集器消息内容无效', 502);
      check(m.sentAt === null || (typeof m.sentAt === 'string' && Number.isFinite(Date.parse(m.sentAt))), 'ARCHIVE_PROTOCOL', '采集器消息时间无效', 502);
    }
    return body;
  }
}
