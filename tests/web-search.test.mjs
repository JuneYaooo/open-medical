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

  // Default: Bing RSS first.
  let calls = 0;
  const bing = await searchWeb("pelican\u0007bike", {}, null, async (url) => {
    calls++;
    assert.match(url, /^https:\/\/www\.bing\.com\/search\?q=/);
    assert.doesNotMatch(url, /%07/); // control characters stripped
    return new Response(rss, { headers: { "content-type": "text/xml" } });
  });
  assert.equal(bing.engine, "bing");
  assert.equal(bing.results.length, 2);
  assert.equal(bing.results[0].title, "Pelican & Bike");
  assert.equal(bing.results[0].snippet, "A pelican riding a bicycle");
  assert.equal(bing.results[1].url, "http://example.com/b?x=1");

  // Bing empty → DuckDuckGo lite fallback with uddg redirect resolution.
  const duckResult = await searchWeb("test", {}, null, async (url) =>
    url.startsWith("https://www.bing.com")
      ? new Response("<rss></rss>", { headers: { "content-type": "text/xml" } })
      : new Response(duck, { headers: { "content-type": "text/html" } }),
  );
  assert.equal(duckResult.engine, "duckduckgo");
  assert.equal(duckResult.results[0].url, "https://example.com/c");
  assert.equal(duckResult.results[0].title, "Third result");

  // Both engines empty → explicit error, never fabricated results.
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
        ["www.bing.com", "lite.duckduckgo.com"].includes(target.host),
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

