// Offline stand-in for the public web used by web_search / web_fetch.
// Search engines: 360 and DuckDuckGo fail, Bing RSS returns `results`;
// pages are served from `pages` (url -> { title, text }). Loopback requests
// (the test server itself) pass through to the real fetch.
export function installFakeWeb({ results = [], pages = {} } = {}) {
  const realFetch = globalThis.fetch;
  const requests = [];
  const html = (title, text) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><article><h1>${title}</h1><p>${text}</p></article></body></html>`;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (["127.0.0.1", "localhost"].includes(url.hostname)) return realFetch(input, init);
    requests.push(url.href);
    if (url.hostname === "www.bing.com") {
      const items = results.map((r) => `<item><title>${r.title}</title><link>${r.url}</link><description>${r.snippet || ""}</description></item>`).join("");
      return new Response(`<?xml version="1.0" encoding="utf-8"?><rss><channel>${items}</channel></rss>`, { status: 200, headers: { "content-type": "application/rss+xml; charset=utf-8" } });
    }
    const page = pages[url.href];
    if (page) return new Response(html(page.title, page.text), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } });
  };
  return { requests, restore: () => { globalThis.fetch = realFetch; } };
}
