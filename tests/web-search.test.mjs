import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
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
const xmlResponse = (body) =>
  new Response(body, { headers: { "content-type": "text/xml" } });
const jsonResponse = (payload) =>
  new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });

test("web search uses searxng when configured and falls back to bing rss then duckduckgo", async () => {
  const searx = await searchWeb(
    "searx",
    {
      searchUrl: "https://searx.example/search",
      origins: ["https://searx.example"],
    },
    null,
    async (url) => {
      assert.equal(
        new URL(url).origin + new URL(url).pathname,
        "https://searx.example/search",
      );
      assert.equal(new URL(url).searchParams.get("q"), "searx");
      return jsonResponse({
        results: [
          { title: "SearX hit", url: "https://s.example/x", content: "ok" },
        ],
      });
    },
  );
  assert.equal(searx.engine, "searxng");
  assert.equal(searx.query, "searx");
  assert.equal(searx.quality, "ok");
  assert.ok(searx.retrievedAt);
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
    return xmlResponse(rss);
  });
  assert.equal(bing.engine, "bing");
  assert.equal(bing.quality, "ok");
  assert.equal(bing.results.length, 2);
  assert.equal(bing.results[0].title, "Pelican & Bike");
  assert.equal(bing.results[0].snippet, "A pelican riding a bicycle");
  assert.equal(bing.results[1].url, "http://example.com/b?x=1");

  // Bing empty → DuckDuckGo lite fallback with uddg redirect resolution.
  // “Third result”与查询词无交集：结果保留但必须标记为低相关，不能冒充正常结果。
  const duckResult = await searchWeb("test", {}, null, async (url) => {
    const host = new URL(url).host;
    if (host === "www.bing.com") return xmlResponse("<rss></rss>");
    if (host === "www.so.com")
      return new Response("<html><body>captcha</body></html>", {
        headers: { "content-type": "text/html" },
      });
    return new Response(duck, { headers: { "content-type": "text/html" } });
  });
  assert.equal(duckResult.engine, "duckduckgo");
  assert.equal(duckResult.quality, "low-relevance");
  assert.match(duckResult.warnings.join(" "), /相关性低/);
  assert.equal(duckResult.results[0].url, "https://example.com/c");
  assert.equal(duckResult.results[0].title, "Third result");

  // All engines empty → structured no-results, never fabricated results.
  const empty = await searchWeb("test", {}, null, async () =>
    xmlResponse("<rss></rss>"),
  );
  assert.equal(empty.quality, "no-results");
  assert.deepEqual(empty.results, []);
  assert.match(empty.warnings.join(" "), /没有返回可用结果/);
  assert.ok(calls >= 1);
});

test("all sources failing is reported as source-failure with per-engine errors", async () => {
  const result = await searchWeb("查询", {}, null, async () => {
    throw new Error("boom");
  });
  assert.equal(result.quality, "source-failure");
  assert.equal(result.engine, null);
  assert.deepEqual(result.results, []);
  const joined = result.warnings.join(" ");
  for (const engine of ["so360", "bing", "duckduckgo"]) {
    assert.match(joined, new RegExp(`${engine} 源失败`));
  }
});

test("a failing source is skipped without masking the next engine", async () => {
  const result = await searchWeb("pelican", {}, null, async (url) => {
    if (new URL(url).host === "www.so.com") throw new Error("so down");
    return xmlResponse(rss);
  });
  assert.equal(result.engine, "bing");
  assert.equal(result.quality, "ok");
  assert.match(result.warnings.join(" "), /so360 源失败/);
  assert.equal(result.results.length, 2);
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
      return xmlResponse(rss);
    });
  }
  await fetchWeb; // keep import referenced
});

test("brave search is preferred over keyless engines when a key is present", async () => {
  const used = [];
  const result = await searchWeb(
    "brave",
    { braveSearch: true },
    null,
    async (url, options = {}) => {
      used.push(new URL(url).host);
      if (new URL(url).host === "api.search.brave.com") {
        assert.equal(options.headers["x-subscription-token"], "BSA_test_key");
        return jsonResponse({
          web: {
            results: [
              {
                title: "Brave hit",
                url: "https://b.example/x",
                description: "d",
              },
            ],
          },
        });
      }
      return xmlResponse("<rss></rss>");
    },
    "BSA_test_key",
  );
  assert.equal(result.engine, "brave");
  assert.equal(result.quality, "ok");
  assert.deepEqual(result.results[0], {
    title: "Brave hit",
    url: "https://b.example/x",
    snippet: "d",
  });
  assert.deepEqual(used, ["api.search.brave.com"]); // never touched bing/ddg
});

test("permittedURL allows workspace-local files and nothing beyond", async () => {
  const { permittedURL } = await import("../server/core/browser-tools.mjs");
  const root = resolve(tmpdir(), "omw-root");
  const inside = pathToFileURL(resolve(root, "site/index.html")).href;
  assert.equal(permittedURL(inside, [], root), inside);
  // Traversal-style encodings that escape the root are rejected.
  assert.throws(
    () =>
      permittedURL(pathToFileURL(root).href + "/../../etc/passwd", [], root),
    { code: "BROWSER_ORIGIN" },
  );
  assert.throws(
    () => permittedURL(pathToFileURL(resolve(root, "../hosts")).href, [], root),
    {
      code: "BROWSER_ORIGIN",
    },
  );
  assert.throws(
    () =>
      permittedURL(
        pathToFileURL(resolve(root, "../omw-other/x.html")).href,
        [],
        root,
      ),
    {
      code: "BROWSER_ORIGIN",
    },
  );
  // Without a root, local browsing is entirely disabled.
  assert.throws(() => permittedURL(inside, []), { code: "BROWSER_ORIGIN" });
  // 无白名单（默认）时放行任意 http(s) 来源；配置白名单后收紧。
  assert.equal(
    permittedURL("https://example.com/", [], root),
    "https://example.com/",
  );
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
      if (target.host === "www.bing.com") return xmlResponse(noise);
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
  assert.equal(result.quality, "ok");
  assert.match(result.results[0].title, /电子病历/);
});

test("so360 results expose the real target url from data-mdurl", async () => {
  const html = `<html><body>
  <h3><a href="https://www.so.com/link?m=wrap" data-mdurl="https://ccgp.example/emr-bid" rel="noopener">电子病历系统采购项目中标公告</a></h3>
  <p class="res-desc">电子病历 厂商 报价 相关内容</p>
  <h3><a href="javascript:;" data-mdurl="">广告位无真实地址</a></h3>
  </body></html>`;
  const direct = await searchWeb(
    "电子病历 厂商 报价",
    {},
    null,
    async (url) => {
      const host = new URL(url).host;
      if (host === "www.so.com")
        return new Response(html, { headers: { "content-type": "text/html" } });
      throw new Error("should not be called");
    },
  );
  assert.equal(direct.engine, "so360");
  assert.equal(direct.quality, "ok");
  assert.equal(direct.results.length, 1);
  assert.equal(direct.results[0].url, "https://ccgp.example/emr-bid");
  assert.match(direct.results[0].title, /中标公告/);
  assert.match(direct.results[0].snippet, /电子病历/);
});

test("keyless search keeps bing results without an extra duckduckgo call when they match the query", async () => {
  const bingRss = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>电子病历系统排名与选型</title><link>https://hit.example/emr</link><description>主流电子病历厂商对比</description></item>
  </channel></rss>`;
  const hosts = [];
  const result = await searchWeb("电子病历 厂商", {}, null, async (url) => {
    hosts.push(new URL(url).host);
    return xmlResponse(bingRss);
  });
  assert.deepEqual(hosts, ["www.so.com", "www.bing.com"]);
  assert.equal(result.engine, "bing");
  assert.equal(result.results.length, 1);
});

test("all-irrelevant results across engines stay flagged as low-relevance", async () => {
  const soNoise = `<html><body>
  <h3><a href="https://g.example/1" data-mdurl="https://g.example/1">热门八卦盘点</a></h3>
  <p class="res-desc">明星动态汇总</p>
  </body></html>`;
  const noiseRss = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>热门八卦</title><link>https://g.example/2</link><description>明星动态</description></item>
  </channel></rss>`;
  const result = await searchWeb("电子病历 采购", {}, null, async (url) => {
    const host = new URL(url).host;
    if (host === "www.so.com")
      return new Response(soNoise, {
        headers: { "content-type": "text/html" },
      });
    if (host === "www.bing.com") return xmlResponse(noiseRss);
    return new Response(duck, { headers: { "content-type": "text/html" } });
  });
  assert.equal(result.quality, "low-relevance");
  assert.equal(result.engine, "so360");
  assert.ok(result.results.length >= 1);
  assert.match(result.warnings.join(" "), /相关性低/);
  assert.match(result.warnings.join(" "), /改写关键词/);
});

test("cancellation propagates immediately without trying remaining engines", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  let calls = 0;
  await assert.rejects(
    searchWeb("pelican", {}, preAborted.signal, async () => {
      calls++;
      return xmlResponse(rss);
    }),
    (error) => error.name === "AbortError",
  );
  assert.equal(calls, 0);

  const mid = new AbortController();
  const hosts = [];
  const pending = searchWeb("pelican", {}, mid.signal, async (url) => {
    hosts.push(new URL(url).host);
    if (new URL(url).host === "www.so.com") {
      await new Promise((_, reject) => {
        if (mid.signal.aborted) return reject(mid.signal.reason);
        mid.signal.addEventListener("abort", () => reject(mid.signal.reason), {
          once: true,
        });
      });
    }
    return xmlResponse(rss);
  });
  setTimeout(() => mid.abort(), 10);
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.deepEqual(hosts, ["www.so.com"]);
});

test("domain filter applies locally and reports what it did", async () => {
  const mixed = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>电子病历指南</title><link>https://docs.example/emr-guide</link><description>电子病历 指南</description></item>
  <item><title>电子病历其他站点</title><link>https://other.example/emr</link><description>电子病历 其他</description></item>
  </channel></rss>`;
  const fake = async () => xmlResponse(mixed);
  const filtered = await searchWeb("电子病历", {}, null, fake, null, {
    domains: ["docs.example"],
  });
  assert.equal(filtered.quality, "ok");
  assert.deepEqual(
    filtered.results.map((r) => r.url),
    ["https://docs.example/emr-guide"],
  );
  assert.equal(filtered.filters.domains.requested, true);
  assert.equal(filtered.filters.domains.applied, true);
  assert.match(filtered.filters.domains.note, /本地过滤/);
  assert.match(filtered.filters.domains.note, /2 条 → 1 条/);

  const none = await searchWeb("电子病历", {}, null, fake, null, {
    domains: ["nothing.example"],
  });
  assert.equal(none.quality, "no-results");
  assert.deepEqual(none.results, []);
  assert.match(none.filters.domains.note, /2 条 → 0 条/);
});

test("date filter on searxng: coarse time_range plus local publishedDate refinement", async () => {
  const day = 86_400_000;
  const now = Date.now();
  const payload = {
    results: [
      {
        title: "新文档",
        url: "https://s.example/new",
        content: "电子病历 新",
        publishedDate: new Date(now - 5 * day).toISOString(),
      },
      {
        title: "旧文档",
        url: "https://s.example/old",
        content: "电子病历 旧",
        publishedDate: new Date(now - 400 * day).toISOString(),
      },
    ],
  };
  const urls = [];
  const fake = async (url) => {
    urls.push(url);
    return jsonResponse(payload);
  };
  const config = {
    searchUrl: "https://searx.example/search",
    origins: ["https://searx.example"],
  };

  // 近 10 天窗口：粗粒度 time_range 传给引擎，publishedDate 本地精筛删旧留新。
  const recent = await searchWeb("电子病历", config, null, fake, null, {
    since: new Date(now - 10 * day).toISOString().slice(0, 10),
  });
  assert.deepEqual(
    recent.results.map((r) => r.url),
    ["https://s.example/new"],
  );
  assert.equal(recent.filters.dates.applied, true);
  assert.match(recent.filters.dates.note, /publishedDate/);
  const timeRange = new URL(urls.at(-1)).searchParams.get("time_range");
  assert.ok(
    ["day", "week", "month", "year"].includes(timeRange),
    `unexpected time_range ${timeRange}`,
  );

  // 远期区间超出 time_range 能力：不传参数，只做本地过滤并如实说明。
  const historic = await searchWeb("电子病历", config, null, fake, null, {
    since: "2020-01-01",
    until: "2020-02-01",
  });
  assert.equal(historic.quality, "no-results");
  assert.equal(new URL(urls.at(-1)).searchParams.get("time_range"), null);
  assert.equal(historic.filters.dates.applied, true);
  assert.match(historic.filters.dates.note, /2 条 → 0 条/);

  // 结果不带日期：明确声明未生效，而不是假装过滤。
  const undated = await searchWeb(
    "电子病历",
    config,
    null,
    async () =>
      jsonResponse({
        results: [
          {
            title: "无日期文档",
            url: "https://s.example/nd",
            content: "电子病历",
          },
        ],
      }),
    null,
    { since: "2026-01-01" },
  );
  assert.equal(undated.quality, "ok");
  assert.equal(undated.results.length, 1);
  assert.equal(undated.filters.dates.applied, false);
  assert.match(undated.filters.dates.note, /未携带/);
});

test("date filter on engines without dates declares non-application honestly", async () => {
  const result = await searchWeb(
    "pelican",
    {},
    null,
    async () => xmlResponse(rss),
    null,
    {
      since: "2026-01-01",
    },
  );
  assert.equal(result.engine, "bing");
  assert.equal(result.quality, "ok");
  assert.equal(result.filters.dates.requested, true);
  assert.equal(result.filters.dates.applied, false);
  assert.match(result.filters.dates.note, /未生效/);
  assert.equal(result.results.length, 2); // 结果原样保留，未假装过滤
});

test("searxng results are relevance-checked and low-relevance is not masked", async () => {
  const config = {
    searchUrl: "https://searx.example/search",
    origins: ["https://searx.example"],
  };
  const irrelevant = await searchWeb("电子病历", config, null, async () =>
    jsonResponse({
      results: [
        { title: "热门八卦", url: "https://s.example/1", content: "明星动态" },
      ],
    }),
  );
  assert.equal(irrelevant.engine, "searxng");
  assert.equal(irrelevant.quality, "low-relevance");

  const empty = await searchWeb("电子病历", config, null, async () =>
    jsonResponse({ results: [] }),
  );
  assert.equal(empty.quality, "no-results");
  assert.deepEqual(empty.results, []);
});

test("configured SearXNG failures use the same structured contract without fallback", async () => {
  const config = {
    searchUrl: "https://searx.example/search",
    origins: ["https://searx.example"],
  };
  for (const response of [
    () => new Response("down", { status: 503 }),
    () => jsonResponse({ bad: true }),
    () => {
      throw new Error("offline");
    },
  ]) {
    let calls = 0;
    const result = await searchWeb("example", config, null, async () => {
      calls++;
      return response();
    });
    assert.equal(calls, 1);
    assert.equal(result.quality, "source-failure");
    assert.equal(result.degraded, true);
    assert.deepEqual(result.results, []);
    assert.equal(result.attempts[0].ok, false);
    assert.match(result.warnings.join(" "), /searxng 源失败/);
  }
});

test("mixed dated results report partial date filtering without claiming full application", async () => {
  const result = await searchWeb(
    "example",
    { searchUrl: "https://searx.example/search" },
    null,
    async () =>
      jsonResponse({
        results: [
          {
            title: "example dated",
            url: "https://example.com/d",
            publishedDate: "2026-09-20",
          },
          { title: "example undated", url: "https://example.com/u" },
        ],
      }),
    null,
    { since: "2026-09-01" },
  );
  assert.equal(result.filters.dates.applied, false);
  assert.equal(result.filters.dates.partial, true);
  assert.equal(result.results.length, 2);
});

test("oversized sources degrade and invalid date ranges are rejected", async () => {
  const result = await searchWeb(
    "example",
    {},
    null,
    async () => new Response("x".repeat(1_000_001)),
  );
  assert.equal(result.quality, "source-failure");
  assert.equal(result.attempts.length, 3);
  await assert.rejects(
    searchWeb(
      "x",
      {},
      null,
      async () => {
        throw new Error("must not fetch");
      },
      null,
      { since: "2026-09-20", until: "2026-09-01" },
    ),
    { code: "SEARCH_FILTER" },
  );
});

test(
  "configured search propagates cancellation while consuming a stalled body",
  { timeout: 1000 },
  async () => {
    const controller = new AbortController();
    const pending = searchWeb(
      "example",
      { searchUrl: "https://searx.example/search" },
      controller.signal,
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("{"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, { name: "AbortError" });
  },
);

test("fixed search engines never forward API credentials across an origin redirect", async () => {
  const hosts = [];
  const result = await searchWeb(
    "pelican",
    {},
    null,
    async (url, init) => {
      const host = new URL(url).hostname;
      hosts.push(host);
      assert.equal(init.redirect, "manual");
      if (host === "api.search.brave.com")
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/" },
        });
      assert.equal(init.headers["x-subscription-token"], undefined);
      return xmlResponse(rss);
    },
    "synthetic-key",
  );
  assert.equal(result.quality, "ok");
  assert.equal(result.degraded, true);
  assert.deepEqual(hosts, [
    "api.search.brave.com",
    "www.so.com",
    "www.bing.com",
  ]);
});
