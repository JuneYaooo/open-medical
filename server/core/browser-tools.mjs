import { chromium } from "playwright-core";
import { check } from "../errors.mjs";
import { resolve, sep } from "node:path";
import { existsSync } from "node:fs";

// Local-only fallbacks so self-verification works without any configuration.
const browserCandidates = () =>
  process.env.AGENT_BROWSER_EXECUTABLE
    ? [process.env.AGENT_BROWSER_EXECUTABLE]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
          ];

export function permittedURL(input, origins, root) {
  const url = new URL(input);
  // Workspace-local files are allowed for self-verification: contained to the
  // authorized root, with every WorkspaceFiles path protection applied by the
  // caller before turning the path into a file:// URL.
  if (url.protocol === "file:") {
    check(
      typeof root === "string" && root.length > 1,
      "BROWSER_ORIGIN",
      "本地文件浏览仅限授权工作区内的文件",
      403,
    );
    const target = resolve(decodeURIComponent(url.pathname));
    check(
      target === root || target.startsWith(root + sep),
      "BROWSER_ORIGIN",
      "本地文件浏览仅限授权工作区内的文件",
      403,
    );
    return url.href;
  }
  check(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      origins.includes(url.origin),
    "BROWSER_ORIGIN",
    "网址不在用户授权的来源内",
    403,
  );
  return url.href;
}
export class BrowserTools {
  constructor({
    factory,
    executablePath = browserCandidates().find(existsSync),
  } = {}) {
    this.factory = factory;
    this.executablePath = executablePath;
    this.pages = new Map();
  }
  status() {
    return {
      available: Boolean(this.factory || this.executablePath),
      backend: this.factory ? "electron-chromium" : "playwright",
      reason:
        this.factory || this.executablePath
          ? undefined
          : "未找到可用的本机浏览器（Chrome / Edge / Chromium）",
    };
  }
  async get(owner, origins, root) {
    const existing = this.pages.get(owner);
    if (existing) {
      check(
        JSON.stringify(existing.origins) === JSON.stringify(origins),
        "BROWSER_CHANGED",
        "浏览器授权已变化，请重新打开",
      );
      return existing.driver;
    }
    check(this.pages.size < 4, "BROWSER_LIMIT", "浏览器会话超过上限");
    let driver;
    if (this.factory) driver = await this.factory(origins);
    else {
      check(
        this.executablePath,
        "BROWSER_UNAVAILABLE",
        "当前运行方式未配置浏览器",
        503,
      );
      const browser = await chromium.launch({
        executablePath: this.executablePath,
        headless: true,
        chromiumSandbox: true,
      });
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
        permissions: [],
      });
      await context.route("**/*", (route) => {
        try {
          permittedURL(route.request().url(), origins, root);
          return route.continue();
        } catch {
          return route.abort("blockedbyclient");
        }
      });
      await context.routeWebSocket("**/*", (ws) => ws.close());
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("popup", (p) => p.close());
      page.on("dialog", (d) => d.dismiss());
      page.on("download", (d) => d.cancel());
      driver = {
        navigate: async (url) => {
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 20000,
          });
          return { url: page.url(), title: await page.title() };
        },
        snapshot: async () => ({
          url: page.url(),
          title: await page.title(),
          text: (await page.locator("body").innerText()).slice(0, 20000),
          elements: await page
            .locator("a,button,input,textarea,select")
            .evaluateAll((elements) =>
              elements.slice(0, 150).map((e, index) => ({
                index,
                tag: e.tagName,
                text: (e.innerText || e.getAttribute("aria-label") || "").slice(
                  0,
                  100,
                ),
                id: e.id,
                name: e.getAttribute("name"),
                type: e.getAttribute("type"),
                href: e.getAttribute("href"),
              })),
            ),
        }),
        act: async ({ action, selector, value }) => {
          const target = page.locator(selector);
          check(
            (await target.count()) === 1,
            "BROWSER_SELECTOR",
            "选择器必须只匹配一个元素",
          );
          if (action === "fill") {
            check(
              !["password", "file"].includes(await target.getAttribute("type")),
              "BROWSER_INPUT",
              "不支持密码或文件输入",
            );
            await target.fill(value);
          } else await target.click();
          return { url: page.url() };
        },
        screenshot: async () => ({
          mimeType: "image/png",
          data: (await page.screenshot({ fullPage: false })).toString("base64"),
        }),
        close: () => browser.close(),
      };
    }
    this.pages.set(owner, { driver, origins: [...origins] });
    return driver;
  }
  async navigate(owner, origins, url, root) {
    const target = permittedURL(url, origins, root),
      driver = await this.get(owner, origins, root);
    return driver.navigate(target);
  }
  async snapshot(owner, origins) {
    return (await this.get(owner, origins)).snapshot();
  }
  async act(owner, origins, args) {
    check(
      ["click", "fill"].includes(args.action) &&
        typeof args.selector === "string" &&
        args.selector.length <= 500,
      "BROWSER_ACTION",
      "只支持 click / fill 和明确的 CSS 选择器",
    );
    check(
      args.action !== "fill" ||
        (typeof args.value === "string" && args.value.length <= 10000),
      "BROWSER_INPUT",
      "填写内容过长",
    );
    return (await this.get(owner, origins)).act(args);
  }
  async close(owner) {
    const entries = [...this.pages].filter(([id]) => !owner || id === owner);
    for (const [id, { driver }] of entries) {
      this.pages.delete(id);
      await driver.close().catch(() => {});
    }
  }
}
