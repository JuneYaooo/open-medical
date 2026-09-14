import http from "node:http";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { check, AppError } from "../errors.mjs";

export class CredentialVault {
  constructor(db, directory) {
    this.db = db;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "credentials.key");
    if (!existsSync(path))
      writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    const stat = lstatSync(path);
    check(
      stat.isFile() && !stat.isSymbolicLink() && stat.size === 32,
      "CREDENTIAL_KEY",
      "本机凭据加密密钥无效",
    );
    check(
      process.platform === "win32" || (stat.mode & 0o077) === 0,
      "CREDENTIAL_KEY",
      "凭据密钥文件不能允许其他用户读取",
    );
    this.key = readFileSync(path);
    db.exec(
      "CREATE TABLE IF NOT EXISTS agent_credentials (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
    );
  }
  get(id) {
    const row = this.db
      .prepare("SELECT data FROM agent_credentials WHERE id=?")
      .get(id);
    if (!row) return {};
    const { iv, tag, data } = JSON.parse(row.data);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(iv, "base64"),
    );
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(data, "base64")),
        decipher.final(),
      ]).toString(),
    );
  }
  set(id, value) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    this.db
      .prepare("INSERT OR REPLACE INTO agent_credentials VALUES (?,?)")
      .run(
        id,
        JSON.stringify({
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          data: data.toString("base64"),
        }),
      );
  }
  delete(id) {
    this.db.prepare("DELETE FROM agent_credentials WHERE id=?").run(id);
  }
}

export function oauthOrigins(config) {
  const origins = config.oauth?.origins || [];
  check(
    Array.isArray(origins) && origins.length > 0 && origins.length <= 10,
    "OAUTH_CONFIG",
    "OAuth 需要明确授权认证服务器来源列表",
  );
  return [
    ...new Set([
      new URL(config.url).origin,
      ...origins.map((input) => {
        const url = new URL(input);
        check(
          url.origin === input &&
            !url.username &&
            !url.password &&
            (url.protocol === "https:" ||
              (url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))),
          "OAUTH_ORIGIN",
          "认证来源必须为 HTTPS origin，本机测试可用 HTTP",
        );
        return url.origin;
      }),
    ]),
  ];
}

export class MCPOAuth {
  constructor(store) {
    this.store = store;
    const file = store.db
      .prepare("PRAGMA database_list")
      .all()
      .find((r) => r.name === "main")?.file;
    this.directory = file ? dirname(file) : null;
    this.pending = new Map();
  }
  get vault() {
    check(this.directory, "OAUTH_STORAGE", "OAuth 需要持久化数据库");
    return (this._vault ||= new CredentialVault(this.store.db, this.directory));
  }
  key(owner, config) {
    return createHash("sha256")
      .update(JSON.stringify([owner, config.id, config.url, config.oauth]))
      .digest("hex");
  }
  fetch(config) {
    const origins = oauthOrigins(config);
    return async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      check(
        origins.includes(url.origin) && !url.username && !url.password,
        "OAUTH_ORIGIN",
        "认证请求超出已授权来源",
        403,
      );
      const response = await fetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          ...(init.signal ? [init.signal] : []),
          AbortSignal.timeout(15000),
        ]),
      });
      if (!response.body) return response;
      let size = 0;
      return new Response(
        response.body.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              size += chunk.byteLength;
              check(size <= 1000000, "OAUTH_RESPONSE", "认证响应过大");
              controller.enqueue(chunk);
            },
          }),
        ),
        { status: response.status, headers: response.headers },
      );
    };
  }
  provider(owner, config, flow) {
    const key = this.key(owner, config),
      vault = this.vault;
    const read = () => vault.get(key);
    const save = (change) => vault.set(key, { ...read(), ...change });
    return {
      get redirectUrl() {
        return flow?.redirectUrl || read().redirectUrl;
      },
      get clientMetadata() {
        return {
          client_name: "Open Medical Agent",
          redirect_uris: [flow?.redirectUrl || read().redirectUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      },
      state: () => flow?.state,
      clientInformation: () =>
        read().client ||
        (config.oauth.clientId
          ? { client_id: config.oauth.clientId }
          : undefined),
      saveClientInformation: (client) => save({ client }),
      tokens: () => read().tokens,
      saveTokens: (tokens) => {
        if (!flow) return save({ tokens, savedAt: Date.now() });
        this.store.update(owner, (w) => {
          check(!w.runs.some((r) => r.status === "running"), "RUN_ACTIVE", "任务执行期间不能更换账户，请结束任务后重新连接", 409);
          w.contextEpoch = (w.contextEpoch || 0) + 1;
          save({ tokens, savedAt: Date.now() });
        });
      },
      redirectToAuthorization: (url) => {
        check(
          flow && oauthOrigins(config).includes(url.origin),
          "OAUTH_REQUIRED",
          "请在扩展面板重新连接账户",
          412,
        );
        flow.authorizationUrl = url.href;
      },
      saveCodeVerifier: (verifier) => save({ verifier }),
      codeVerifier: () => {
        const verifier = read().verifier;
        check(verifier, "OAUTH_STATE", "授权会话已过期");
        return verifier;
      },
      invalidateCredentials: (scope) => {
        if (scope === "all") vault.delete(key);
        else if (scope === "tokens") save({ tokens: undefined });
        else if (scope === "client") save({ client: undefined });
        else if (scope === "verifier") save({ verifier: undefined });
      },
    };
  }
  async start(owner, config) {
    oauthOrigins(config);
    const key = this.key(owner, config);
    this.stop(key);
    const state = randomBytes(32).toString("hex"),
      flow = { owner, state };
    const listener = http.createServer(async (req, res) => {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      try {
        const url = new URL(req.url, flow.redirectUrl);
        const candidate = Buffer.from(url.searchParams.get("state") || "");
        check(
          req.method === "GET" &&
            url.pathname === "/callback" &&
            req.headers.host === new URL(flow.redirectUrl).host &&
            candidate.length === state.length &&
            timingSafeEqual(candidate, Buffer.from(state)) &&
            !flow.used,
          "OAUTH_STATE",
          "无效或已使用的授权回调",
          403,
        );
        flow.used = true;
        check(
          !url.searchParams.has("error") && url.searchParams.get("code"),
          "OAUTH_DENIED",
          "账户授权未完成",
        );
        const current = this.store
          .get(owner)
          .extensions?.mcpServers.find((s) => s.id === config.id);
        check(
          current && this.key(owner, current) === key,
          "OAUTH_CHANGED",
          "服务器配置已变化",
        );
        const result = await auth(this.provider(owner, config, flow), {
          serverUrl: config.url,
          authorizationCode: url.searchParams.get("code"),
          fetchFn: this.fetch(config),
        });
        check(result === "AUTHORIZED", "OAUTH_FAILED", "授权未完成");
        this.store.event(owner, "manual", "oauth.connected", {
          serverId: config.id,
        });
        res.end("账户已连接。请返回 Agent 工作区，点击连接／重连。");
        this.stop(key);
      } catch (error) {
        res.statusCode = error.status || 400;
        res.end(
          error instanceof AppError
            ? error.message
            : "账户授权失败，请重新连接",
        );
        if (flow.used) this.stop(key);
      }
    });
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(config.oauth.redirectPort || 0, "127.0.0.1", resolve);
    });
    flow.redirectUrl = `http://127.0.0.1:${listener.address().port}/callback`;
    const saved = this.vault.get(key);
    this.vault.set(key, {
      ...saved,
      tokens: undefined,
      verifier: undefined,
      client: saved.redirectUrl === flow.redirectUrl ? saved.client : undefined,
      redirectUrl: flow.redirectUrl,
    });
    flow.listener = listener;
    flow.timer = setTimeout(() => this.stop(key), 300000);
    flow.timer.unref();
    this.pending.set(key, flow);
    try {
      const result = await auth(this.provider(owner, config, flow), {
        serverUrl: config.url,
        fetchFn: this.fetch(config),
      });
      if (result === "AUTHORIZED") {
        this.stop(key);
        return { connected: true };
      }
      check(flow.authorizationUrl, "OAUTH_FAILED", "服务器没有提供授权链接");
      return { authorizationUrl: flow.authorizationUrl, expiresIn: 300 };
    } catch (error) {
      this.stop(key);
      throw error;
    }
  }
  status(owner, config) {
    return {
      connected: Boolean(this.vault.get(this.key(owner, config)).tokens),
    };
  }
  revoke(owner, config) {
    const key = this.key(owner, config);
    this.stop(key);
    this.vault.delete(key);
  }
  stop(key) {
    const flow = this.pending.get(key);
    if (flow) {
      clearTimeout(flow.timer);
      flow.listener.close();
      this.pending.delete(key);
    }
  }
  close(owner) {
    for (const [key, flow] of this.pending)
      if (!owner || flow.owner === owner) this.stop(key);
  }
}
