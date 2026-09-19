import test from "node:test";
import assert from "node:assert/strict";
import { searchWeb, fetchWeb } from "../server/core/web-tools.mjs";

const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Pelican &amp; Bike</title><link>https://example.com/a</link><description><![CDATA[A pelican <b>riding</b> a bicycle]]></description></item>
<item><title>Second</title><link>http://example.com/b?x=1</link><description>snippet two</description></item>
<item><title>Empty link skipped</title><link></link><description>x</description></item>
</channel></rss>`;
const duck = `<table>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fc&amp;rut=abc">Third result</a></td></tr>
<tr><td class="result-snippet">duck snippet</td></tr>
</table>`;

test("web search uses searxng when configured and falls back to bing rss then duckduckgo", async () => {
  const searx = await searchWeb(
    "pelican",
    { searchUrl: "https://searx.example/search", origins: ["https://searx.example"] },
    null,
    async (url) => {
      assert.equal(
        new URL(url).origin + new URL(url).pathname,
        "https://searx.example/search",
      );
      assert.equal(new URL(url).searchParams.get("q"), "pelican");
      return new Response(
        JSON.stringify({
          results: [{ title: "SearX hit", url: "https://s.example/x", content: "ok" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  assert.equal(searx.engine, "searxng");
  assert.deepEqual(searx.results, [
    { title: "SearX hit", url: "https://s.example/x", snippet: "ok" },
  ]);

  // Default chain: 360 first (skipped when it yields nothing), then Bing RSS.
  let calls = 0;
  const bing = await searchWeb("pelican\u0007bike", {}, null, async (url) => {
    calls++;
    const host = new URL(url).host;
    assert.ok(
      ["www.so.com", "www.bing.com"].includes(host),
      `unexpected engine host ${host}`,
    );
    if (host === "www.bing.com") {
      assert.match(url, /^https:\/\/www\.bing\.com\/search\?q=/);
      assert.doesNotMatch(url, /%07/); // control characters stripped
    }
    return new Response(rss, { headers: { "content-type": "text/xml" } });
  });
  assert.equal(bing.engine, "bing");
  assert.equal(bing.results.length, 2);
  assert.equal(bing.results[0].title, "Pelican & Bike");
  assert.equal(bing.results[0].snippet, "A pelican riding a bicycle");
  assert.equal(bing.results[1].url, "http://example.com/b?x=1");

  // Bing empty → DuckDuckGo lite fallback with uddg redirect resolution.
  const duckResult = await searchWeb("test", {}, null, async (url) => {
    const host = new URL(url).host;
    if (host === "www.bing.com")
      return new Response("<rss></rss>", {
        headers: { "content-type": "text/xml" },
      });
    if (host === "www.so.com")
      return new Response("<html><body>captcha</body></html>", {
        headers: { "content-type": "text/html" },
      });
    return new Response(duck, { headers: { "content-type": "text/html" } });
  });
  assert.equal(duckResult.engine, "duckduckgo");
  assert.equal(duckResult.results[0].url, "https://example.com/c");
  assert.equal(duckResult.results[0].title, "Third result");

  // All engines empty → explicit error, never fabricated results.
  await assert.rejects(
    searchWeb(
      "test",
      {},
      null,
      async () =>
        new Response("<rss></rss>", {
          headers: { "content-type": "text/xml" },
        }),
    ),
    { code: "SEARCH_RESPONSE" },
  );
  assert.ok(calls >= 1);
});

test("search only ever targets fixed https engine hosts", async () => {
  for (const config of [{}, { searchUrl: "" }]) {
    await searchWeb("q", config, null, async (url) => {
      const target = new URL(url);
      assert.equal(target.protocol, "https:");
      assert.ok(
        ["www.so.com", "www.bing.com", "lite.duckduckgo.com"].includes(
          target.host,
        ),
        target.host,
      );
      return new Response(rss, { headers: { "content-type": "text/xml" } });
    });
  }
  await fetchWeb; // keep import referenced
});

test("brave search is preferred over keyless engines when a key is present", async () => {
  const used = [];
  const result = await searchWeb(
    "pelican",
    { braveSearch: true },
    null,
    async (url, options = {}) => {
      used.push(new URL(url).host);
      if (new URL(url).host === "api.search.brave.com") {
        assert.equal(options.headers["x-subscription-token"], "BSA_test_key");
        return new Response(
          JSON.stringify({
            web: { results: [{ title: "Brave hit", url: "https://b.example/x", description: "d" }] },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("<rss></rss>", { headers: { "content-type": "text/xml" } });
    },
    "BSA_test_key",
  );
  assert.equal(result.engine, "brave");
  assert.deepEqual(result.results[0], {
    title: "Brave hit",
    url: "https://b.example/x",
    snippet: "d",
  });
  assert.deepEqual(used, ["api.search.brave.com"]); // never touched bing/ddg
});


test("permittedURL allows workspace-local files and nothing beyond", async () => {
  const { permittedURL } = await import("../server/core/browser-tools.mjs");
  const root = "/tmp/omw-root";
  const inside = "file:///tmp/omw-root/site/index.html";
  assert.equal(permittedURL(inside, [], root), inside);
  // Traversal-style encodings that escape the root are rejected.
  assert.throws(
    () => permittedURL("file:///tmp/omw-root/../../etc/passwd", [], root),
    { code: "BROWSER_ORIGIN" },
  );
  assert.throws(() => permittedURL("file:///etc/hosts", [], root), {
    code: "BROWSER_ORIGIN",
  });
  assert.throws(() => permittedURL("file:///tmp/omw-other/x.html", [], root), {
    code: "BROWSER_ORIGIN",
  });
  // Without a root, local browsing is entirely disabled.
  assert.throws(() => permittedURL(inside, []), { code: "BROWSER_ORIGIN" });
  // 无白名单（默认）时放行任意 http(s) 来源；配置白名单后收紧。
  assert.equal(permittedURL("https://example.com/", [], root), "https://example.com/");
  assert.throws(
    () => permittedURL("https://evil.example/", ["https://example.com"], root),
    { code: "BROWSER_ORIGIN" },
  );
  assert.equal(
    permittedURL("https://example.com/a", ["https://example.com"], root),
    "https://example.com/a",
  );
});

test("keyless search falls back past noisy engines to an on-topic one", async () => {
  const noise = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>电子（基本粒子之一）_百度百科</title><link>https://baike.baidu.com/item/电子</link><description>原子的重要组成部分</description></item>
  <item><title>电子发烧友</title><link>https://www.elecfans.com/</link><description>半导体元器件</description></item>
  </channel></rss>`;
  const noiseHtml = `<html><body>
  <h3><a href="https://www.so.com/link?m=wrap" data-mdurl="https://baike.baidu.com/item/电子">电子（基本粒子之一）_百度百科</a></h3>
  <p class="res-desc">原子的重要组成部分</p>
  </body></html>`;
  const duckOnTopic = `<table>
  <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fccgp.example%2Femr&amp;rut=x">电子病历系统采购项目中标公告</a></td></tr>
  <tr><td class="result-snippet">电子病历 厂商 报价 相关内容</td></tr>
  </table>`;
  const hosts = [];
  const result = await searchWeb(
    "电子病历 厂商 报价 方案",
    {},
    null,
    async (url) => {
      const target = new URL(url);
      hosts.push(target.host);
      if (target.host === "www.so.com")
        return new Response(noiseHtml, {
          headers: { "content-type": "text/html" },
        });
      if (target.host === "www.bing.com")
        return new Response(noise, {
          headers: { "content-type": "text/xml" },
        });
      return new Response(duckOnTopic, {
        headers: { "content-type": "text/html" },
      });
    },
  );
  assert.deepEqual(hosts, [
    "www.so.com",
    "www.bing.com",
    "lite.duckduckgo.com",
  ]);
  assert.equal(result.engine, "duckduckgo");
  assert.match(result.results[0].title, /电子病历/);
});

test("so360 results expose the real target url from data-mdurl", async () => {
  const html = `<html><body>
  <h3><a href="https://www.so.com/link?m=wrap" data-mdurl="https://ccgp.example/emr-bid" rel="noopener">电子病历系统采购项目中标公告</a></h3>
  <p class="res-desc">电子病历 厂商 报价 相关内容</p>
  <h3><a href="javascript:;" data-mdurl="">广告位无真实地址</a></h3>
  </body></html>`;
  const direct = await searchWeb("电子病历 厂商 报价", {}, null, async (url) => {
    const host = new URL(url).host;
    if (host === "www.so.com")
      return new Response(html, { headers: { "content-type": "text/html" } });
    throw new Error("should not be called");
  });
  assert.equal(direct.engine, "so360");
  assert.equal(direct.results.length, 1);
  assert.equal(direct.results[0].url, "https://ccgp.example/emr-bid");
  assert.match(direct.results[0].title, /中标公告/);
  assert.match(direct.results[0].snippet, /电子病历/);
});

test("keyless search keeps bing results without an extra duckduckgo call when they match the query", async () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>电子病历系统排名与选型</title><link>https://hit.example/emr</link><description>主流电子病历厂商对比</description></item>
  </channel></rss>`;
  const hosts = [];
  const result = await searchWeb("电子病历 厂商", {}, null, async (url) => {
    hosts.push(new URL(url).host);
    return new Response(rss, { headers: { "content-type": "text/xml" } });
  });
  assert.deepEqual(hosts, ["www.so.com", "www.bing.com"]);
  assert.equal(result.engine, "bing");
  assert.equal(result.results.length, 1);
});
