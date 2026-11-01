import { expect } from "@playwright/test";

// Shared by every screenshot spec: the E2E server and the browser clock both
// start at this instant, so demo dates and relative timestamps stay stable.
export const FIXED_TIME = new Date("2026-10-28T10:00:00+08:00");
export const PATIENT_NAME = "示例·张沪生";

export async function open(page, path) {
  await page.clock.install({ time: FIXED_TIME });
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);
}

const MAX_SCREENSHOT_HEIGHT = 4000;

// The app shell is a fixed 100dvh frame with an internal scroll area, so
// fullPage alone only captures the first viewport. Grow the viewport until the
// page's own scroller has no overflow; width stays 1440.
export async function expandMainContent(page, selector) {
  const scroller = page.locator(selector).first();
  await expect(scroller).toBeVisible();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { scrollHeight, clientHeight } = await scroller.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    if (scrollHeight <= clientHeight + 1) break;

    const viewport = page.viewportSize();
    const height = Math.min(
      MAX_SCREENSHOT_HEIGHT,
      viewport.height + (scrollHeight - clientHeight) + 32,
    );
    if (height <= viewport.height) break;
    await page.setViewportSize({ width: viewport.width, height });
    await page.waitForTimeout(100);
  }

  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
}

// 截图只保存到 test-results/e2e-screens 供人工查看，不做逐像素对比：
// 像素基准图对字体、样式的细微变化过于敏感，维护成本高于收益。
// 页面是否正常由各用例中的 expect 断言检查。
export async function capture(page, name, { scroll, mask = [] } = {}) {
  // Wait for all page-initiated requests (including async cards and lists)
  // before freezing the layout for the frame.
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  if (scroll) await expandMainContent(page, scroll);
  await page.screenshot({
    path: `test-results/e2e-screens/${name}`,
    fullPage: true,
    animations: "disabled",
    caret: "hide",
    mask,
  });
}
