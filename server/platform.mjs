import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve, join, extname, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  WorkspaceDatabase,
  WorkspaceService,
  createProvider,
  PythonSandbox,
} from "./core/index.mjs";
import { ModelProfiles } from "./core/model-profiles.mjs";
import { ModelSettings } from "./core/model-settings.mjs";
import { JevSettings } from "./core/jev-settings.mjs";
import { providerConfigured } from "./core/provider-status.mjs";
import { workspaceApi } from "./core/workspace-api.mjs";
import { check, AppError } from "./errors.mjs";

// Generic application composition root: no medical runtime, tables or domain imports.
export function createWorkspaceServer(options = {}) {
  const databasePath =
    options.database ||
    join(homedir(), ".open-medical-workbench", "platform.sqlite");
  const database = new WorkspaceDatabase(databasePath);
  const models = new ModelSettings(
    database.db,
    dirname(databasePath),
    options.provider || createProvider(),
  );
  const profiles = new ModelProfiles(models);
  const jev = new JevSettings(models.vault);
  let provider = models.provider();
  const service = new WorkspaceService(database.db, provider, {
    sandbox: new PythonSandbox(),
    modelProfiles: profiles,
    jev,
    ...options,
  });
  const token = randomBytes(32).toString("hex");
  const pending = new Set();
  const track = async (promise) => {
    pending.add(promise);
    try {
      return await promise;
    } finally {
      pending.delete(promise);
    }
  };
  const send = (res, status, data) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const body = async (req) => {
    check(
      req.headers["content-type"]?.startsWith("application/json"),
      "CONTENT_TYPE",
      "请使用 JSON",
      415,
    );
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      check(bytes <= 1024 * 1024, "BODY_LIMIT", "请求超过 1MB", 413);
      chunks.push(chunk);
    }
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new AppError("INVALID_JSON", "JSON 无效", 400);
    }
    check(
      value && typeof value === "object" && !Array.isArray(value),
      "INVALID_JSON",
      "需要 JSON 对象",
    );
    return value;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    try {
      check(
        req.url.startsWith("/") && !req.url.startsWith("//"),
        "HOST",
        "无效请求路径",
        403,
      );
      const url = new URL(req.url, `http://${req.headers.host}`),
        path = url.pathname;
      check(
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
        "HOST",
        "仅允许本机访问",
        403,
      );
      check(
        (!req.headers.origin ||
          req.headers.origin === `http://${req.headers.host}`) &&
          req.headers["sec-fetch-site"] !== "cross-site",
        "ORIGIN",
        "拒绝跨站访问",
        403,
      );
      if (path === "/api/bootstrap" && req.method === "GET")
        return send(res, 200, {
          token,
          engine: "generic-runtime",
          // 领域无关 App Shell 依据:前端据此渲染通用任务入口,
          // 无医疗能力时不请求医疗接口、不显示医疗默认任务与患者导航。
          capabilities: {
            workspaces: true,
            modelSettings: true,
            medical: false,
          },
          runtimeKey: createHash("sha256")
            .update(resolve(databasePath))
            .digest("hex"),
          modelSettings: true,
          instanceId: options.instanceId,
          provider: provider.provider,
          model: provider.model,
          modelConfigured: providerConfigured(provider),
          directoryPicker: Boolean(options.chooseDirectory),
          domain: service.domain.id,
        });
      if (path.startsWith("/api/")) {
        const supplied =
          req.headers["x-agent-token"] || req.headers["x-medical-token"];
        check(
          typeof supplied === "string" &&
            Buffer.byteLength(supplied) === Buffer.byteLength(token) &&
            timingSafeEqual(Buffer.from(supplied), Buffer.from(token)),
          "UNAUTHORIZED",
          "本地认证失效",
          401,
        );
        if (path === "/api/model-profiles") {
          if (req.method === "GET")
            return send(res, 200, { profiles: profiles.list() });
          check(
            service.active.size === 0 && service.media.active.size === 0,
            "MODEL_BUSY",
            "请等待运行结束后修改团队模型",
            409,
          );
          const input = await body(req);
          if (req.method === "PUT")
            return send(res, 200, { profiles: profiles.save(input.id, input) });
          if (req.method === "DELETE")
            return send(res, 200, { profiles: profiles.remove(input.id) });
        }
        if (path === "/api/jev-settings") {
          if (req.method === "GET") return send(res, 200, jev.public());
          if (req.method === "PUT") return send(res, 200, jev.save(await body(req)));
        }
        if (path === "/api/jev-settings/test" && req.method === "POST")
          return send(res, 200, await track(jev.test(await body(req))));
        if (path === "/api/model-settings") {
          if (req.method === "GET") return send(res, 200, models.public());
          if (req.method === "PUT") {
            const input = await body(req);
            check(
              service.active.size === 0,
              "MODEL_BUSY",
              "有任务正在运行，请等待结束后切换模型",
              409,
            );
            provider = models.save(models.candidate(input));
            service.provider = provider;
            service.agent.provider = provider;
            return send(res, 200, models.public());
          }
        }
        if (path === "/api/model-settings/test" && req.method === "POST") {
          const input = await body(req);
          return send(
            res,
            200,
            await track(models.test(models.candidate(input))),
          );
        }
        if (
          await workspaceApi({
            service,
            path,
            req,
            res,
            url,
            body,
            send,
            track,
          })
        )
          return;
        throw new AppError("NOT_FOUND", "接口不存在", 404);
      }
      check(req.method === "GET", "NOT_FOUND", "接口不存在", 404);
      const dist = await realpath(
        options.dist ||
          resolve(dirname(fileURLToPath(import.meta.url)), "../dist"),
      );
      // 融合后只有一个前端入口：平台模式也服务同一张工作台页面。
      // 前端按 bootstrap capabilities 渲染——通用模式只呈现领域无关的
      // 任务闭环（创建→执行→产物→继续），不请求也不显示医疗入口。
      const target = await realpath(
        resolve(
          dist,
          path === "/" ? "index.html" : "." + decodeURIComponent(path),
        ),
      );
      check(target.startsWith(dist + sep), "PATH_DENIED", "路径越界", 403);
      const mime = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      res.writeHead(200, {
        "content-type": mime[extname(target)] || "application/octet-stream",
      });
      res.end(await readFile(target));
    } catch (error) {
      if (!res.headersSent)
        send(
          res,
          error instanceof AppError
            ? error.status
            : error.code === "ENOENT"
              ? 404
              : 500,
          {
            error: error instanceof AppError ? error.message : "本地服务错误",
            code: error.code || "INTERNAL",
          },
        );
      else res.end();
    }
  });
  Object.assign(server, { service, database, token });
  server.once("listening", () => {
    service.recovery.start();
    service.scheduler.start();
  });
  let shutdownPromise;
  server.shutdown = () =>
    (shutdownPromise ||= (async () => {
      service.stopping = true;
      service.media.stop();
      service.scheduler.stop();
      service.recovery.stop();
      const executions = [...service.active.values()].map(
        (handle) => handle.execution,
      );
      for (const id of service.active.keys()) service.interrupt(id);
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      await Promise.allSettled([...pending, ...executions]);
      await Promise.allSettled([
        service.scheduler.drain(),
        service.recovery.drain(),
      ]);
      service.media.stop();
      service.pty.close();
      await service.extensions.close();
      await closed;
      database.close();
    })());
  return server;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.env.AGENT_SKIP_ENV_FILE !== "1" && existsSync(".env"))
    process.loadEnvFile(".env");
  const server = createWorkspaceServer({
    database: process.env.AGENT_DATABASE,
    instanceId: process.env.AGENT_INSTANCE_ID,
  });
  const port = Number(process.env.AGENT_PORT || 8788);
  server.listen(port, "127.0.0.1", () =>
    console.log(`通用 Agent 工作区 http://127.0.0.1:${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await server.shutdown();
    });
}
