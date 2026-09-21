import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { fetchWeb, searchWeb } from "../server/core/web-tools.mjs";

test(
  "native fetch obeys redirects, byte positions, source hashes and cancellation against a local fixture",
  { timeout: 5000 },
  async () => {
    const body = "中文 source paragraph\n".repeat(4000);
    let forbiddenRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/article" }).end();
      } else if (request.url === "/escape") {
        response
          .writeHead(302, {
            location:
              "http://localhost:" + server.address().port + "/forbidden",
          })
          .end();
      } else if (request.url === "/forbidden") {
        forbiddenRequests++;
        response.end("unexpected");
      } else if (request.url.startsWith("/search")) {
        response.writeHead(503).end("fixture unavailable");
      } else if (request.url === "/stall") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("started");
      } else {
        response
          .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          .end(body);
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const first = await fetchWeb(`${origin}/start`, [origin]);
      assert.equal(first.redirects, 1);
      assert.equal(first.hash, createHash("sha256").update(body).digest("hex"));
      const second = await fetchWeb(first.url, [origin], null, fetch, {
        offset: first.nextOffset,
        expectedHash: first.hash,
      });
      assert.equal(first.text + second.text, body);
      assert.equal(second.contentChanged, false);
      await assert.rejects(fetchWeb(`${origin}/escape`, [origin]), {
        code: "BROWSER_ORIGIN",
      });
      assert.equal(forbiddenRequests, 0);
      const failed = await searchWeb("synthetic", {
        searchUrl: `${origin}/search`,
        origins: [origin],
      });
      assert.equal(failed.quality, "source-failure");
      const controller = new AbortController();
      const pending = fetchWeb(`${origin}/stall`, [origin], controller.signal);
      const timer = setTimeout(() => controller.abort(), 20);
      try {
        await assert.rejects(pending, { name: "AbortError" });
      } finally {
        clearTimeout(timer);
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
