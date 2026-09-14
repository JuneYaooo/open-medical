import http from "node:http";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { WorkspaceDatabase } from "../server/core/database.mjs";
import { RemoteQueue } from "../server/core/remote-queue.mjs";
import { check } from "../server/errors.mjs";
export function coordinator({ db, clientToken, workerToken }) {
  check(
    clientToken?.length >= 32 &&
      workerToken?.length >= 32 &&
      clientToken !== workerToken,
    "REMOTE_TOKEN",
    "需要两个不同的至少 32 字符的访问令牌",
  );
  const queue = new RemoteQueue(db);
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, "http://localhost"),
        parts = url.pathname.split("/").filter(Boolean),
        worker = parts[0] === "worker";
      const expected = Buffer.from(worker ? workerToken : clientToken),
        provided = Buffer.from(
          (req.headers.authorization || "").replace(/^Bearer /, ""),
        );
      check(
        provided.length === expected.length &&
          timingSafeEqual(provided, expected),
        "REMOTE_AUTH",
        "访问令牌无效",
        401,
      );
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        check(size <= 16_000_000, "BODY_LIMIT", "请求超出限制", 413);
        chunks.push(chunk);
      }
      let input = {};
      if (size) {
        try {
          input = JSON.parse(Buffer.concat(chunks));
        } catch {
          check(false, "INVALID_JSON", "JSON 无效");
        }
      }
      queue.expire();
      let result;
      if (worker && req.method === "POST") {
        if (parts[1] === "claim") result = { job: queue.claim(input.worker) };
        else if (parts[1] === "heartbeat")
          result = queue.heartbeat(input.id, input.lease);
        else if (parts[1] === "complete")
          result = queue.complete(input.id, input.lease, input.result);
        else check(false, "ROUTE", "未知操作", 404);
      } else if (parts[0] === "jobs") {
        if (req.method === "POST" && !parts[1]) result = queue.create(input);
        else if (req.method === "GET")
          result = parts[1]
            ? queue.get(parts[1])
            : {
                jobs: queue
                  .list()
                  .map(
                    ({ files: _files, result: _result, lease: _lease, ...j }) =>
                      j,
                  ),
              };
        else if (req.method === "POST" && parts[2] === "cancel")
          result = queue.cancel(parts[1]);
        else if (req.method === "POST" && parts[2] === "retry")
          result = queue.retry(parts[1]);
        else if (req.method === "POST" && parts[2] === "remove")
          result = queue.remove(parts[1]);
        else check(false, "ROUTE", "未知操作", 404);
      } else check(false, "ROUTE", "未知操作", 404);
      // Lease tokens belong exclusively to workers.
      if (!worker && result) {
        const { lease: _lease, ...safe } = result;
        result = safe;
      }
      send(200, result);
    } catch (e) {
      send(e.status || 400, { error: e.message });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const database = new WorkspaceDatabase(
    process.env.REMOTE_DATABASE || "server/data/remote-queue.sqlite",
  );
  const server = coordinator({
    db: database.db,
    clientToken: process.env.REMOTE_CLIENT_TOKEN,
    workerToken: process.env.REMOTE_WORKER_TOKEN,
  });
  server.listen(
    Number(process.env.PORT || 8795),
    process.env.REMOTE_BIND || "127.0.0.1",
    () => console.log("Remote coordinator listening"),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () =>
      server.close(() => {
        database.close();
        process.exit(0);
      }),
    );
}
