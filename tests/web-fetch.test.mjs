import test from "node:test";
import assert from "node:assert/strict";
import { fetchWeb } from "../server/core/web-tools.mjs";

const htmlPage = (body, title = "测试页面") =>
  `<html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const okHtml = (body, title) =>
  new Response(htmlPage(body, title), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
const redirect = (location, status = 302) =>
  new Response(null, { status, headers: { location } });

test("fetchWeb follows a bounded redirect chain, re-verifying every hop", async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    if (new URL(url).pathname === "/start") return redirect("/middle");
    if (new URL(url).pathname === "/middle")
      return redirect("https://example.com/final", 301);
    return okHtml("<p>落地内容</p>");
  };
  const result = await fetchWeb(
    "https://example.com/start",
    ["https://example.com"],
    null,
    fake,
  );
  assert.deepEqual(calls, [
    "https://example.com/start",
    "https://example.com/middle",
    "https://example.com/final",
  ]);
  assert.equal(result.url, "https://example.com/final");
  assert.equal(result.redirects, 2);
  assert.match(result.text, /落地内容/);
});

test("a redirect that escapes the origin whitelist is rejected before the next request", async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    return redirect("https://evil.test/steal");
  };
  await assert.rejects(
    fetchWeb("https://example.com/start", ["https://example.com"], null, fake),
    { code: "BROWSER_ORIGIN" },
  );
  assert.deepEqual(calls, ["https://example.com/start"]);
});

test("redirect loops are detected and bounded", async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    return redirect(new URL(url).pathname === "/a" ? "/b" : "/a");
  };
  await assert.rejects(
    fetchWeb("https://example.com/a", ["https://example.com"], null, fake),
    { code: "WEB_REDIRECT", message: /循环/ },
  );
  assert.ok(calls.length <= 6, `too many redirect hops: ${calls.length}`);
});

test("non-http redirect targets are rejected", async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    return redirect("ftp://evil.test/x");
  };
  await assert.rejects(fetchWeb("https://example.com/start", [], null, fake), {
    code: "WEB_REDIRECT",
  });
  assert.deepEqual(calls, ["https://example.com/start"]);
});

test("opaque redirect responses fail closed without an automatic follow", async () => {
  const calls = [];
  await assert.rejects(
    fetchWeb(
      "https://example.com/start",
      ["https://example.com"],
      null,
      async (url, init) => {
        calls.push([url, init.redirect]);
        return { type: "opaqueredirect", status: 0, body: null };
      },
    ),
    { code: "WEB_REDIRECT" },
  );
  assert.deepEqual(calls, [["https://example.com/start", "manual"]]);
});

test("long pages are returned in resumable segments covering the full text", async () => {
  const paragraphs = Array.from(
    { length: 3600 },
    (_, i) => `<p>段落${i}：这是一段用于分段读取测试的中文正文内容。</p>`,
  );
  const expected = paragraphs
    .map((p) => p.replace(/<\/?p[^>]*>/g, ""))
    .join("\n\n");
  const fake = async () => okHtml(paragraphs.join(""));

  const first = await fetchWeb("https://example.com/long", [], null, fake);
  assert.equal(first.totalChars, expected.length);
  assert.equal(first.text, expected.slice(0, 50000));
  assert.equal(first.nextOffset, 50000);
  assert.equal(first.offset, 0);
  assert.equal(first.truncated, true);
  assert.equal(first.contentChanged, false);

  let assembled = first.text;
  let result = first;
  let hops = 1;
  while (result.nextOffset !== null) {
    result = await fetchWeb("https://example.com/long", [], null, fake, {
      offset: result.nextOffset,
      expectedHash: result.hash,
    });
    assert.equal(result.contentChanged, false);
    assert.equal(result.offset, hops * 50000);
    assembled += result.text;
    hops++;
  }
  assert.ok(hops >= 3, `expected at least 3 segments, got ${hops}`);
  assert.equal(assembled, expected);
});

test("expectedHash mismatch flags contentChanged and serves the new content", async () => {
  let version = 0;
  const fake = async () =>
    okHtml(`<p>版本${version}的正文内容，足够长一点。</p>`.repeat(4000));
  const first = await fetchWeb("https://example.com/v", [], null, fake);
  assert.equal(first.nextOffset, 50000);
  version = 1;
  const second = await fetchWeb("https://example.com/v", [], null, fake, {
    offset: first.nextOffset,
    expectedHash: first.hash,
  });
  assert.equal(second.contentChanged, true);
  assert.notEqual(second.hash, first.hash);
  assert.match(second.warnings.join(" "), /不一致/);
  assert.ok(second.text.length > 0);
  assert.equal(second.nextOffset, null);
});

test("offset beyond the end returns an empty final segment", async () => {
  const fake = async () => okHtml("<p>短内容</p>");
  const result = await fetchWeb("https://example.com/short", [], null, fake, {
    offset: 1_000_000,
  });
  assert.equal(result.text, "");
  assert.equal(result.offset, result.totalChars);
  assert.equal(result.nextOffset, null);
});

test("segment options are validated", async () => {
  const fake = async () => okHtml("<p>x</p>");
  await assert.rejects(
    fetchWeb("https://example.com/o", [], null, fake, { offset: -1 }),
    { code: "WEB_OFFSET" },
  );
  await assert.rejects(
    fetchWeb("https://example.com/o", [], null, fake, {
      expectedHash: "abc",
    }),
    { code: "WEB_HASH" },
  );
});

test("GBK-encoded pages decode correctly", async () => {
  // <html><body><meta charset="gbk"><p>中文电子病历测试</p></body></html>
  // 的 GBK/GB2312 字节（“测试”也在字节序列内）。
  const gbkBody = Buffer.concat([
    Buffer.from('<html><body><meta charset="gbk"><p>', "latin1"),
    Buffer.from([
      0xd6, 0xd0, 0xce, 0xc4, 0xb5, 0xe7, 0xd7, 0xd3, 0xb2, 0xa1, 0xc0, 0xfa,
      0xb2, 0xe2, 0xca, 0xd4,
    ]),
    Buffer.from("</p></body></html>", "latin1"),
  ]);
  const fake = async () =>
    new Response(gbkBody, { headers: { "content-type": "text/html" } });
  const result = await fetchWeb("https://example.com/gbk", [], null, fake);
  assert.match(result.text, /中文电子病历测试/);
});

test("fetchWeb propagates cancellation before and during the request", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  let calls = 0;
  await assert.rejects(
    fetchWeb("https://example.com/x", [], preAborted.signal, async () => {
      calls++;
      return okHtml("<p>x</p>");
    }),
    (error) => error.name === "AbortError",
  );
  assert.equal(calls, 0);

  const mid = new AbortController();
  const pending = fetchWeb(
    "https://example.com/y",
    [],
    mid.signal,
    async (_url, _init) => {
      await new Promise((_, reject) => {
        if (mid.signal.aborted) return reject(mid.signal.reason);
        mid.signal.addEventListener("abort", () => reject(mid.signal.reason), {
          once: true,
        });
      });
    },
  );
  setTimeout(() => mid.abort(), 10);
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("html extraction keeps title, paragraphs and link offsets", async () => {
  const body =
    '<h1>标题一</h1><p>第一段，含 <a href="https://example.com/a?x=1&amp;y=2">链接甲</a> 与文字。</p>' +
    '<p><a href="/relative/b">链接乙</a>第二段。</p><a href="javascript:void(0)">脚本链接</a>';
  const result = await fetchWeb(
    "https://example.com/page",
    [],
    null,
    async () => okHtml(body),
  );
  assert.equal(result.title, "测试页面");
  assert.deepEqual(
    result.links.map((l) => l.url),
    ["https://example.com/a?x=1&y=2", "https://example.com/relative/b"],
  );
  assert.equal(result.links[0].text, "链接甲");
  assert.equal(result.links[1].text, "链接乙");
  for (const link of result.links) {
    assert.equal(
      result.text.slice(link.offset, link.offset + link.text.length),
      link.text,
      `offset mismatch for ${link.url}`,
    );
  }
  // javascript: 锚文本保留在正文中，但不进链接列表。
  assert.match(result.text, /脚本链接/);
  assert.match(result.text, /第一段，含 链接甲 与文字。/);
});

test("json responses pass through unchanged without html extraction", async () => {
  const payload = JSON.stringify({ ok: true, note: "<b>not</b> html" });
  const fake = async () =>
    new Response(payload, {
      headers: { "content-type": "application/json" },
    });
  const result = await fetchWeb("https://example.com/api", [], null, fake);
  assert.equal(result.text, payload);
  assert.deepEqual(result.links, []);
  assert.equal(result.title, "");
  assert.equal(result.truncated, false);
});

test("overlong responses still hit the byte limit", async () => {
  const fake = async () =>
    new Response("x".repeat(2_000_001), {
      headers: { "content-type": "text/plain" },
    });
  await assert.rejects(fetchWeb("https://example.com/big", [], null, fake), {
    code: "WEB_LIMIT",
  });
});

test("fetch rejects a sixth redirect before sending its request", async () => {
  let calls = 0;
  await assert.rejects(
    fetchWeb("https://example.com/0", [], null, async () =>
      redirect(`/${++calls}`),
    ),
    { code: "WEB_REDIRECT" },
  );
  assert.equal(calls, 6);
});

test("custom segment lengths accurately report truncation and reassemble content", async () => {
  const result = await fetchWeb(
    "https://example.com/x",
    [],
    null,
    async () => okHtml("abcdef"),
    { segmentChars: 3 },
  );
  assert.equal(result.text, "abc");
  assert.equal(result.truncated, true);
  assert.equal(result.nextOffset, 3);
});

test("anchor entities decode exactly once and offsets match the emitted text", async () => {
  const result = await fetchWeb("https://example.com/x", [], null, async () =>
    okHtml('<p>参考 <a href="/a">&amp;lt;tag&amp;gt; &amp;amp;</a> 结束</p>'),
  );
  assert.equal(result.text, "参考 &lt;tag&gt; &amp; 结束");
  const link = result.links[0];
  assert.equal(
    result.text.slice(link.offset, link.offset + link.text.length),
    link.text,
  );
});
