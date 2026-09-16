// 交互重设计 · 端到端（浏览器）：加载构建产物 + 内存库服务，跑全部场景剧本。
// 前置：npm run build；本机装有 Google Chrome。
import test from "node:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fixture } from "./helpers.mjs";
import { chromium } from "playwright-core";
import { SCENARIOS } from "./redesign-scenarios.mjs";

const DIST = resolve(process.cwd(), "dist/index.html");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const canRun = existsSync(DIST) && existsSync(CHROME);

for (const scenario of SCENARIOS) {
  test(scenario.name, { skip: !canRun }, async (t) => {
    const f = await fixture(t);
    const browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on("pageerror", (err) => {
      throw new Error(`页面脚本错误：${err.message}`);
    });
    await page.goto(f.origin);
    await page.waitForSelector(".app-navigation", { timeout: 15000 });
    await scenario.fn({ page, seed: f, origin: f.origin });
  });
}
