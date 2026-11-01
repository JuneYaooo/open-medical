import { createHash, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { FeishuRegistration } from "./feishu-registration.mjs";
import { check } from "../../../server/errors.mjs";
import { sqliteTransaction } from "../../../server/sqlite-transaction.mjs";
import { providerConfigured } from "../../../server/core/provider-status.mjs";
import {
  MessageTransport,
  wechatHeaders,
  wechatOrigin,
} from "./transports.mjs";

const key = (id) => `message-channel:${id}`;
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeText = (value, max) =>
  typeof value === "string" && value.length <= max;
const command = (text) =>
  ({
    "/new": "new",
    新会话: "new",
    "/reset": "new",
    "/stop": "stop",
    停止任务: "stop",
    "/status": "status",
    "/test": "test",
    连接测试: "test",
  })[text];

export class MessageGateway {
  constructor({
    store,
    vault,
    bridge,
    getProvider,
    knowledgeBot,
    getKnowledgeBot,
    ...options
  }) {
    Object.assign(this, {
      db: store.db,
      vault,
      bridge,
      getProvider,
      knowledgeBot,
      getKnowledgeBot:
        getKnowledgeBot || (() => this.knowledgeBot),
      options,
    });
    this.feishuBinding = new FeishuRegistration({
      vault,
      fetchImpl: options.fetchImpl,
      now: options.now,
      canStart: () => {
        check(
          !this.rows("message_channels").some((c) => c.platform === "feishu") &&
            !this.busy.has("feishu"),
          "CONNECTION_EXISTS",
          "飞书已连接，请先管理现有连接。",
          409,
        );
      },
      accept: (flow, complete) => this.acceptFeishuBinding(flow, complete),
    });
    this.transports = new Map();
    this.states = new Map();
    this.jobs = new Map();
    this.sends = new Map();
    this.starts = new Map();
    this.busy = new Set();
    this.stopped = true;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS message_channels(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_peers(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_inbox(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,message_id TEXT NOT NULL,peer_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(channel_id,message_id));`);
    // An interrupted turn must never be run again automatically: it may have changed data.
    for (const row of this.rows("message_inbox")) {
      if (row.status === "running") {
        const run = this.findRun(row);
        row.reply =
          run && !["running", "queued"].includes(run.status)
            ? this.resultText(row, run)
            : "上次任务被中断，请在工作台查看已完成的步骤，再决定是否继续。";
        row.status = "ready";
        this.write("message_inbox", row);
      } else if (row.status === "sending") {
        row.status = "unknown";
        this.write("message_inbox", row);
      }
    }
  }
  rows(table) {
    return this.db
      .prepare(`SELECT data FROM ${table}`)
      .all()
      .map((r) => JSON.parse(r.data));
  }
  read(table, id) {
    const r = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    return r ? JSON.parse(r.data) : null;
  }
  write(table, row) {
    if (table === "message_channels")
      this.db
        .prepare("INSERT OR REPLACE INTO message_channels VALUES (?,?)")
        .run(row.id, JSON.stringify(row));
    if (table === "message_peers")
      this.db
        .prepare("INSERT OR REPLACE INTO message_peers VALUES (?,?,?)")
        .run(row.id, row.channelId, JSON.stringify(row));
    if (table === "message_inbox")
      this.db
        .prepare("INSERT OR REPLACE INTO message_inbox VALUES (?,?,?,?,?)")
        .run(
          row.id,
          row.channelId,
          row.messageId,
          row.peerId,
          JSON.stringify(row),
        );
  }
  model() {
    const p = this.getProvider();
    return providerConfigured(p)
      ? {
          provider: p.provider || "",
          model: p.model || "",
          baseUrl: p.baseUrl || "",
          local: p.local === true,
        }
      : null;
  }
  modelKey() {
    return hash(this.model());
  }
  settings() {
    return {
      model: this.model(),
      modelFingerprint: this.modelKey(),
      feishuBinding: this.feishuBinding.publicStatus(),
      channels: this.rows("message_channels").map((c) => ({
        ...c,
        cursor: undefined,
        hasSecret: Boolean(
          this.vault.get(key(c.id)).appSecret ||
          this.vault.get(key(c.id)).botToken,
        ),
        state: this.states.get(c.id) || (c.enabled ? "stopped" : "disabled"),
        needsConsent: c.consentModel !== this.modelKey(),
        peers: this.rows("message_peers").filter((p) => p.channelId === c.id),
        deliveries: this.rows("message_inbox")
          .filter((m) => m.channelId === c.id)
          .slice(-30)
          .reverse()
          .map(
            ({ id, peerId, status, sessionId, runId, at, sentAt, error }) => ({
              id,
              peerId,
              status,
              sessionId,
              runId,
              at,
              sentAt,
              error,
            }),
          ),
      })),
    };
  }
  acceptFeishuBinding(flow, complete) {
    const { appId, appSecret, openId } = flow.credentials;
    check(
      /^cli_[a-zA-Z0-9]{8,64}$/.test(appId),
      "INVALID_CONNECTION",
      "飞书应用标识无效",
    );
    this.assertNoKnowledgeConflict(appId);
    const existing = this.rows("message_channels").find(
      (c) => c.platform === "feishu",
    );
    // A manually configured connection must never be overwritten by a late scan result.
    check(!existing, "CONNECTION_EXISTS", "已有飞书连接", 409);
    check(!this.busy.has("feishu"), "BUSY", "正在保存飞书连接", 409);
    const c = {
      id: randomUUID(),
      platform: "feishu",
      name: "飞书医生助手",
      appId,
      enabled: true,
      revision: 1,
      cursor: "",
      consentModel: flow.consentModel || "",
      boundUserId: /^ou_[\w]{1,200}$/.test(openId) ? openId : "",
    };
    flow.channelId = c.id;
    sqliteTransaction(this.db, () => {
      this.vault.set(key(c.id), { appSecret });
      this.write("message_channels", c);
      complete();
    });
    if (!this.stopped) this.startChannel(c);
    return c.id;
  }
  async startFeishuBinding(input) {
    check(
      input &&
        (input.authorizeModel === undefined ||
          typeof input.authorizeModel === "boolean"),
      "INVALID_INPUT",
      "绑定选项无效",
    );
    if (input.authorizeModel === true) {
      check(this.model(), "MODEL_NOT_CONFIGURED", "请先配置模型");
      check(
        input.expectedModel === this.modelKey(),
        "MODEL_CHANGED",
        "模型配置已变化，请刷新后重新确认。",
        409,
      );
    }
    return this.feishuBinding.begin(
      input.authorizeModel === true ? this.modelKey() : "",
    );
  }
  assertNoKnowledgeConflict(appId) {
    const c = this.getKnowledgeBot()?.config();
    check(
      !c?.enabled || c.appId !== appId,
      "CONNECTION_CONFLICT",
      "该应用正在用于飞书分身。请为医生助手创建独立的飞书应用，或先停用原连接。",
      409,
    );
  }
  async save(input) {
    check(
      input && ["feishu", "wechat"].includes(input.platform),
      "INVALID_INPUT",
      "渠道类型无效",
    );
    const old = input.id ? this.read("message_channels", input.id) : null;
    check(!input.id || old, "NOT_FOUND", "连接不存在", 404);
    check(
      !old || input.expectedRevision === old.revision,
      "REVISION_CONFLICT",
      "配置已变化，请刷新后保存",
      409,
    );
    check(
      !this.busy.has(input.id || input.platform),
      "BUSY",
      "正在更新连接",
      409,
    );
    check(
      typeof input.enabled === "boolean" &&
        safeText(input.name, 60) &&
        input.name.trim(),
      "INVALID_INPUT",
      "请填写连接名称",
    );
    check(
      !old || old.platform === input.platform,
      "INVALID_INPUT",
      "不能更改渠道类型",
    );
    check(
      old ||
        !this.rows("message_channels").some(
          (c) => c.platform === input.platform,
        ),
      "CONNECTION_EXISTS",
      "请编辑已有的同类连接",
      409,
    );
    const secret = old ? this.vault.get(key(old.id)) : {};
    if (input.platform === "feishu") {
      check(
        /^cli_[a-zA-Z0-9]{8,64}$/.test(input.appId || ""),
        "INVALID_INPUT",
        "请填写飞书 App ID",
      );
      check(
        !old || old.appId === input.appId,
        "INVALID_INPUT",
        "更换应用请先断开并删除原连接",
      );
      check(
        input.appSecret === undefined || safeText(input.appSecret, 512),
        "INVALID_INPUT",
        "密钥格式无效",
      );
      if (input.appSecret?.trim()) secret.appSecret = input.appSecret.trim();
      check(secret.appSecret, "NOT_CONFIGURED", "请填写 App Secret");
      if (input.enabled) this.assertNoKnowledgeConflict(input.appId);
    } else check(old && secret.botToken, "NOT_CONFIGURED", "请先扫码连接微信");
    if (input.authorizeModel === true)
      check(this.model(), "MODEL_NOT_CONFIGURED", "请先配置模型");
    const lock = input.id || input.platform;
    this.busy.add(lock);
    try {
      if (old) await this.stopChannel(old.id);
      const next = {
        id: old?.id || randomUUID(),
        platform: input.platform,
        name: input.name.trim(),
        enabled: input.enabled,
        appId: input.platform === "feishu" ? input.appId : "",
        revision: (old?.revision || 0) + 1,
        consentModel:
          input.authorizeModel === true
            ? this.modelKey()
            : old?.consentModel || "",
        cursor: old?.cursor || "",
        boundUserId: old?.boundUserId || "",
      };
      sqliteTransaction(this.db, () => {
        this.vault.set(key(next.id), secret);
        this.write("message_channels", next);
      });
      if (input.platform === "feishu")
        this.feishuBinding.cancel(this.feishuBinding.current().id);
      if (!this.stopped) this.startChannel(next);
      return this.settings();
    } finally {
      this.busy.delete(lock);
    }
  }
  async remove(id, revision) {
    const c = this.read("message_channels", id);
    check(
      c && c.revision === revision,
      "REVISION_CONFLICT",
      "配置已变化，请刷新后操作",
      409,
    );
    check(!this.busy.has(id), "BUSY", "正在更新连接", 409);
    this.busy.add(id);
    try {
      await this.stopChannel(id);
      sqliteTransaction(this.db, () => {
        this.vault.delete(key(id));
        this.feishuBinding.clearForChannel(id);
        for (const p of this.rows("message_peers").filter(
          (p) => p.channelId === id,
        ))
          this.vault.delete(key(p.id));
        this.db.prepare("DELETE FROM message_peers WHERE channel_id=?").run(id);
        this.db.prepare("DELETE FROM message_inbox WHERE channel_id=?").run(id);
        this.db.prepare("DELETE FROM message_channels WHERE id=?").run(id);
      });
      this.states.delete(id);
      return this.settings();
    } finally {
      this.busy.delete(id);
    }
  }
  async authorize(peerId, { allowed, expectedRevision }) {
    const p = this.read("message_peers", peerId);
    check(
      p && p.revision === expectedRevision,
      "REVISION_CONFLICT",
      "账号授权已变化，请刷新",
      409,
    );
    check(typeof allowed === "boolean", "INVALID_INPUT", "授权选项无效");
    check(!this.busy.has(p.channelId), "BUSY", "正在更新连接", 409);
    p.allowed = allowed;
    p.revision++;
    this.write("message_peers", p);
    if (!allowed) {
      if (p.sessionId) this.bridge.cancel(p.sessionId);
      for (const m of this.rows("message_inbox").filter(
        (m) =>
          m.peerId === p.id &&
          ["queued", "ready", "failed", "unknown"].includes(m.status),
      )) {
        m.status = "revoked";
        this.write("message_inbox", m);
      }
    }
    return this.settings();
  }
  start() {
    this.stopped = false;
    this.feishuBinding.start();
    this.db
      .prepare(
        "DELETE FROM message_inbox WHERE json_extract(data,'$.at') < ? AND json_extract(data,'$.status') IN ('sent','ignored','cancelled','revoked')",
      )
      .run(Date.now() - 30 * 86400000);
    for (const c of this.rows("message_channels")) this.startChannel(c);
  }
  startChannel(c) {
    if (!c.enabled || this.stopped || this.transports.has(c.id)) {
      if (!c.enabled) this.states.set(c.id, "disabled");
      return;
    }
    try {
      if (c.platform === "feishu") this.assertNoKnowledgeConflict(c.appId);
    } catch {
      this.states.set(c.id, "conflict");
      return;
    }
    const transport = new MessageTransport({
      connection: c,
      secret: this.vault.get(key(c.id)),
      ...this.options,
      cursor: c.cursor,
      saveCursor: (cursor) => {
        const current = this.read("message_channels", c.id);
        if (current) this.write("message_channels", { ...current, cursor });
      },
      state: (state) => {
        if (this.transports.get(c.id) === transport)
          this.states.set(c.id, state);
      },
      receive: (message) => {
        if (this.transports.get(c.id) === transport)
          this.receive(c.id, message);
      },
      getContext: (sender) =>
        this.vault.get(key(hash([c.id, sender, sender]))).contextToken,
      saveContext: (sender, token) =>
        this.vault.set(key(hash([c.id, sender, sender])), {
          contextToken: token,
        }),
    });
    this.transports.set(c.id, transport);
    const start = transport.start().catch(() => {
      if (this.transports.get(c.id) === transport)
        this.states.set(c.id, "failed");
    });
    this.starts.set(c.id, start);
    void start.finally(() => {
      if (this.starts.get(c.id) === start) this.starts.delete(c.id);
    });
    for (const p of this.rows("message_peers").filter(
      (p) => p.channelId === c.id,
    ))
      this.pump(p.id);
  }
  receive(channelId, message) {
    const c = this.read("message_channels", channelId);
    if (this.stopped || !c?.enabled || this.busy.has(channelId)) return;
    if (
      ![message.id, message.chatId, message.senderId].every(
        (v) => safeText(v, 256) && v,
      ) ||
      !safeText(message.text, 20000) ||
      !message.text.trim()
    )
      return;
    if (
      this.db
        .prepare(
          "SELECT id FROM message_inbox WHERE channel_id=? AND message_id=?",
        )
        .get(channelId, message.id)
    )
      return;
    const peerId = hash([channelId, message.chatId, message.senderId]);
    let peer = this.read("message_peers", peerId);
    if (!peer) {
      if (
        this.rows("message_peers").filter((p) => p.channelId === channelId)
          .length >= 100
      )
        return;
      peer = {
        id: peerId,
        channelId,
        chatId: message.chatId,
        senderId: message.senderId,
        allowed:
          c.boundUserId === message.senderId &&
          !this.rows("message_peers").some(
            (p) => p.channelId === channelId && p.senderId === message.senderId,
          ),
        revision: 0,
        sessionId: "",
        firstSeen: Date.now(),
      };
      this.write("message_peers", peer);
    }
    // Discovery retains identifiers only, never unauthorized message content.
    const id = hash([channelId, message.id]);
    if (!peer.allowed) {
      this.write("message_inbox", {
        id,
        channelId,
        peerId,
        messageId: message.id,
        status: "ignored",
        at: Date.now(),
      });
      return;
    }
    const row = {
      id,
      channelId,
      peerId,
      peerRevision: peer.revision,
      messageId: message.id,
      text: message.text.trim(),
      status: "queued",
      at: Date.now(),
      consentModel: c.consentModel,
      sessionId: "",
      runId: "",
      reply: "",
      sentParts: 0,
    };
    if (row.text === "/stop" || row.text === "停止任务") {
      if (peer.sessionId) this.bridge.cancel(peer.sessionId);
      for (const m of this.rows("message_inbox").filter(
        (m) => m.peerId === peerId && m.status === "queued",
      )) {
        m.status = "cancelled";
        this.write("message_inbox", m);
      }
      row.reply =
        "已请求停止当前任务，并取消排队中的消息。已完成的操作请在工作台核对。";
      row.status = "ready";
    }
    if (
      this.rows("message_inbox").filter(
        (m) => m.peerId === peerId && m.status === "queued",
      ).length >= 30
    ) {
      row.reply = "待处理消息较多，请稍后再试，或发送 /stop 停止当前任务。";
      row.status = "ready";
    }
    this.write("message_inbox", row);
    if (row.status === "ready") void this.deliver(row.id);
    else this.pump(peerId);
  }
  authorized(row) {
    const c = this.read("message_channels", row.channelId),
      p = this.read("message_peers", row.peerId);
    return (
      !this.stopped &&
      c?.enabled &&
      p?.allowed &&
      p.revision === row.peerRevision &&
      !this.busy.has(row.channelId)
    );
  }
  pump(peerId) {
    if (this.jobs.has(peerId) || this.stopped) return;
    const job = Promise.resolve()
      .then(async () => {
        const pending = this.rows("message_inbox").filter(
          (m) => m.peerId === peerId && ["queued", "ready"].includes(m.status),
        );
        for (const snapshot of pending) {
          const row = this.read("message_inbox", snapshot.id);
          if (!row || !["queued", "ready"].includes(row.status)) continue;
          if (!this.authorized(row)) {
            if (!this.stopped) {
              row.status = "revoked";
              this.write("message_inbox", row);
            }
            continue;
          }
          if (row.status === "queued") await this.run(row);
          await this.deliver(row.id);
        }
      })
      .catch(() => {})
      .finally(() => {
        this.jobs.delete(peerId);
        if (
          !this.stopped &&
          this.rows("message_inbox").some(
            (m) =>
              m.peerId === peerId &&
              m.status === "queued" &&
              this.authorized(m),
          )
        )
          this.pump(peerId);
      });
    this.jobs.set(peerId, job);
  }
  findRun(row) {
    try {
      return this.bridge
        .workspace(row.sessionId)
        .runs.find((r) => r.id === row.runId || r.requestId === row.id);
    } catch {
      return null;
    }
  }
  resultText(row, run) {
    const session = this.bridge.get(row.sessionId);
    const answer = session.messages
      .filter((m) => m.role === "assistant" && m.runId === run.id)
      .at(-1)?.content;
    const status = run.status;
    const note = ["waiting_approval", "waiting_input"].includes(status)
      ? "\n请在工作台打开此会话，核对待确认内容或补充信息。"
      : ["failed", "cancelled", "interrupted"].includes(status)
        ? "\n任务未完成，请在工作台查看执行记录后继续。"
        : "";
    return `${typeof answer === "string" && answer.trim() ? answer.trim() : "任务记录已保存。"}${note}\n\n工作台会话：${session.title}（${session.id.slice(0, 8)}）`;
  }
  async run(row) {
    const peer = this.read("message_peers", row.peerId),
      c = this.read("message_channels", row.channelId);
    try {
      const cmd = command(row.text);
      if (cmd === "test")
        row.reply =
          "Open Medical 连接测试成功：已收到你的消息，此账号已获授权。";
      else if (cmd === "new") {
        peer.sessionId = "";
        this.write("message_peers", peer);
        row.reply = "已开启新会话，历史仍保存在工作台。";
      } else if (cmd === "status") {
        row.reply = peer.sessionId
          ? `工作台会话：${this.bridge.get(peer.sessionId).title}\n状态：${this.bridge.workspace(peer.sessionId).runs.at(-1)?.status || "尚未运行"}`
          : "已连接，尚未开始会话。";
      } else {
        check(
          this.model() &&
            c.consentModel === this.modelKey() &&
            row.consentModel === c.consentModel,
          "CONSENT_REQUIRED",
          "请在工作台消息渠道中授权当前模型，再重新发送任务。",
        );
        if (peer.sessionId && !this.bridge.isSessionWorkspace(peer.sessionId)) {
          peer.sessionId = "";
          this.write("message_peers", peer);
        }
        if (!peer.sessionId) {
          const session = this.bridge.createSession({
            title: `${c.name} · ${row.text.slice(0, 35)}`,
            channelSource: {
              channelId: c.id,
              peerId: peer.id,
              platform: c.platform,
            },
          });
          peer.sessionId = session.id;
          this.write("message_peers", peer);
        }
        row.sessionId = peer.sessionId;
        row.status = "running";
        this.write("message_inbox", row);
        const prepared = this.bridge.prepareSend(peer.sessionId, {
          message: row.text,
          mode: "model",
          externalConsent: true,
          requestId: row.id,
        });
        row.runId = prepared.handle.run.id;
        this.write("message_inbox", row);
        await this.bridge.executeSend(prepared);
        row.reply = this.resultText(row, this.findRun(row));
      }
    } catch (error) {
      row.reply =
        error.code === "CONSENT_REQUIRED"
          ? error.message
          : "本次任务未完成。请在工作台检查模型、会话状态和执行记录后再发送任务。";
      row.error = error.code || "TASK_FAILED";
    }
    row.status = this.stopped || this.authorized(row) ? "ready" : "revoked";
    this.write("message_inbox", row);
  }
  async deliver(id, retry = false) {
    if (this.sends.has(id)) return this.sends.get(id);
    const job = this.send(id, retry).finally(() => this.sends.delete(id));
    this.sends.set(id, job);
    return job;
  }
  async send(id, retry) {
    const row = this.read("message_inbox", id);
    if (
      !row ||
      !(retry ? ["failed", "unknown", "ready"] : ["ready"]).includes(row.status)
    )
      return;
    if (!this.authorized(row)) {
      if (!this.stopped) {
        row.status = "revoked";
        this.write("message_inbox", row);
      }
      return;
    }
    const transport = this.transports.get(row.channelId);
    if (!transport) return;
    const peer = this.read("message_peers", row.peerId);
    // A reply's parts and IDs are stable across retry. Never re-run its agent turn.
    row.parts ||= Array.from(
      row.reply.matchAll(/[\s\S]{1,3000}/gu),
      (m) => m[0],
    );
    row.status = "sending";
    this.write("message_inbox", row);
    try {
      for (let index = row.sentParts; index < row.parts.length; index++) {
        check(this.authorized(row), "REVOKED", "授权已撤销");
        await transport.send(
          peer,
          row.parts[index],
          hash([row.id, index]).slice(0, 32),
        );
        row.sentParts = index + 1;
        this.write("message_inbox", row);
      }
      row.status = "sent";
      row.sentAt = Date.now();
      row.error = "";
      peer.lastVerifiedAt = row.sentAt;
      // Re-read before writing to avoid undoing a concurrent revocation or /new.
      const current = this.read("message_peers", peer.id);
      if (current)
        this.write("message_peers", { ...current, lastVerifiedAt: row.sentAt });
    } catch (error) {
      row.status =
        error.code === "REVOKED"
          ? "revoked"
          : error.code === "PLATFORM_REJECTED"
            ? "failed"
            : "unknown";
      row.error = error.code || "DELIVERY_UNKNOWN";
    }
    this.write("message_inbox", row);
  }
  async retry(id) {
    const row = this.read("message_inbox", id);
    check(
      row && this.authorized(row),
      "NOT_AUTHORIZED",
      "连接或账号授权已撤销",
      403,
    );
    check(
      ["failed", "unknown", "ready"].includes(row.status),
      "DELIVERY_STATE",
      "该回复无需重试",
      409,
    );
    await this.deliver(id, true);
    return this.settings();
  }
  async stopChannel(id) {
    const transport = this.transports.get(id);
    this.transports.delete(id);
    const peers = this.rows("message_peers").filter((p) => p.channelId === id);
    for (const p of peers) if (p.sessionId) this.bridge.cancel(p.sessionId);
    await transport?.stop();
    await this.starts.get(id);
    await Promise.allSettled([
      ...peers.map((p) => this.jobs.get(p.id)).filter(Boolean),
      ...this.rows("message_inbox")
        .filter((row) => row.channelId === id)
        .map((row) => this.sends.get(row.id))
        .filter(Boolean),
    ]);
    this.states.set(id, "disabled");
  }
  async stop() {
    this.stopped = true;
    await this.feishuBinding.stop();
    for (const c of this.rows("message_channels")) await this.stopChannel(c.id);
    await this.qrTransport?.stop();
    this.qr = null;
  }
  async startQr() {
    check(
      !this.rows("message_channels").some((c) => c.platform === "wechat"),
      "CONNECTION_EXISTS",
      "请先删除原微信连接，再重新扫码",
    );
    await this.qrTransport?.stop();
    this.qrTransport = new MessageTransport({
      fetchImpl: this.options.fetchImpl,
    });
    const data = await this.qrTransport.request(
      "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3",
      { headers: wechatHeaders() },
    );
    check(
      safeText(data.qrcode, 4096) &&
        data.qrcode &&
        safeText(data.qrcode_img_content, 4096) &&
        data.qrcode_img_content,
      "QR_FAILED",
      "微信未返回有效二维码",
    );
    const qr = {
      id: randomUUID(),
      code: data.qrcode,
      expiresAt: Date.now() + 300000,
    };
    this.qr = qr;
    return {
      id: qr.id,
      expiresAt: qr.expiresAt,
      image: await QRCode.toDataURL(data.qrcode_img_content, {
        width: 240,
        margin: 2,
      }),
    };
  }
  async cancelQr(id) {
    if (this.qr?.id === id) {
      this.qr = null;
      await this.qrTransport?.stop();
    }
    return { cancelled: true };
  }
  async pollQr(id) {
    const qr = this.qr;
    check(
      qr?.id === id && qr.expiresAt > Date.now(),
      "QR_EXPIRED",
      "二维码已过期，请重新生成",
    );
    const data = await this.qrTransport.request(
      `https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.code)}`,
      { headers: wechatHeaders() },
      40000,
    );
    check(this.qr === qr && !this.stopped, "QR_EXPIRED", "二维码已失效");
    if (data.status !== "confirmed")
      return {
        status: ["wait", "scaned", "scanned", "expired"].includes(data.status)
          ? data.status
          : "wait",
      };
    check(
      !this.rows("message_channels").some((c) => c.platform === "wechat"),
      "CONNECTION_EXISTS",
      "微信已连接",
    );
    const secret = {
      botToken: data.bot_token || data.token,
      userId: data.ilink_user_id || data.user_id,
      botId: data.ilink_bot_id || data.bot_id || "",
      baseUrl: wechatOrigin(data.baseurl),
    };
    check(
      safeText(secret.botToken, 4096) &&
        secret.botToken &&
        safeText(secret.userId, 256) &&
        secret.userId &&
        safeText(secret.botId, 256),
      "QR_FAILED",
      "微信未返回完整连接信息",
    );
    const c = {
      id: randomUUID(),
      name: "微信医生助手",
      platform: "wechat",
      boundUserId: secret.userId,
      enabled: false,
      revision: 1,
      consentModel: "",
      cursor: "",
    };
    sqliteTransaction(this.db, () => {
      this.vault.set(key(c.id), secret);
      this.write("message_channels", c);
    });
    this.qr = null;
    return { status: "confirmed", ...this.settings() };
  }
}

export async function messagingApi(gateway, req, url, { body, send }) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "message-channels") return false;
  if (parts.length === 2 && req.method === "GET") send(200, gateway.settings());
  else if (parts.length === 2 && req.method === "PUT")
    send(200, await gateway.save(await body()));
  else if (
    parts[2] === "feishu-binding" &&
    parts.length === 3 &&
    req.method === "POST"
  )
    send(200, await gateway.startFeishuBinding(await body()));
  else if (
    parts[2] === "feishu-binding" &&
    parts.length === 3 &&
    req.method === "DELETE"
  )
    send(200, gateway.feishuBinding.cancel((await body()).id));
  else if (
    parts[2] === "feishu-binding" &&
    parts[3] === "status" &&
    parts.length === 4 &&
    req.method === "POST"
  )
    send(200, await gateway.feishuBinding.poll((await body()).id));
  else if (parts[2] === "qrcode" && req.method === "POST")
    send(200, await gateway.startQr());
  else if (parts[2] === "qrcode-status" && req.method === "POST")
    send(200, await gateway.pollQr((await body()).id));
  else if (parts[2] === "qrcode-cancel" && req.method === "POST")
    send(200, await gateway.cancelQr((await body()).id));
  else if (parts[2] === "peers" && parts.length === 4 && req.method === "PUT")
    send(200, await gateway.authorize(parts[3], await body()));
  else if (
    parts[2] === "deliveries" &&
    parts.length === 4 &&
    req.method === "POST"
  )
    send(200, await gateway.retry(parts[3]));
  else if (parts.length === 3 && req.method === "DELETE")
    send(200, await gateway.remove(parts[2], (await body()).expectedRevision));
  else return false;
  return true;
}
