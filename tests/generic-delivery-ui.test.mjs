// N3 UI 层验证(真实浏览器,playwright-core + 本机 Edge/Chrome headless):
// - 真实写入 → 已交付卡片 + 刷新后状态保持(N3-03/N3-08)
// - 声称创建但缺产物 → 交付未完成卡片(缺口可见,不显示成功)+ 刷新保持
// 模型为脚本 provider(非真实模型),只验证前端与服务端链路。
// 需先 npm run build(加载生产构建页面)。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createWorkspaceServer } from "../server/platform.mjs";

const DIST = resolve(process.cwd(), "dist/index.html");
const BROWSER = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);
const canBrowse = existsSync(DIST) && Boolean(BROWSER);

async function bootServer(t, provider) {
  const dir = mkdtempSync(join(tmpdir(), "omw-n3-ui-"));
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  const server = createWorkspaceServer({
    database: join(dir, "app.sqlite"),
    provider,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await server.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, project };
}

async function createWorkspaceViaUI(page, project, title) {
  await page.locator("button.new-session").click();
  await page.locator(".modal input").nth(0).fill(title);
  await page.locator(".modal input").nth(1).fill(project);
  await page.locator('.modal input[type="checkbox"]').check();
  await page.locator('button:has-text("创建工作区")').click();
  await page.waitForSelector(".workspace-shell .composer textarea", {
    timeout: 15000,
  });
  await page
    .locator('select[aria-label="授权模式"]')
    .selectOption("workspace-write");
}

test(
  "N3 UI:真实写入显示已交付,刷新后保持(脚本模型)",
  { skip: !canBrowse },
  async (t) => {
    const { chromium } = await import("playwright-core");
    let turn = 0;
    const { origin, project } = await bootServer(t, {
      apiKey: "synthetic",
      model: "scripted",
      async complete() {
        turn++;
        if (turn === 1)
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "w1",
                  function: {
                    name: "propose_file_write",
                    arguments: JSON.stringify({
                      path: "report.txt",
                      content: "季度总结内容",
                    }),
                  },
                },
              ],
            },
          };
        return { message: { role: "assistant", content: "已创建 report.txt。" } };
      },
    });
    const browser = await chromium.launch({
      executablePath: BROWSER,
      headless: true,
      // 全量扫描下并发浏览器资源紧张,启动挂起必须快速失败而非阻塞扫描。
      timeout: 60_000,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(origin);
    await page.waitForSelector(".workspace-hub-empty, .workspace-shell", {
      timeout: 15000,
    });
    await createWorkspaceViaUI(page, project, "交付演示");
    await page.locator(".composer textarea").fill("请创建报告文件 report.txt,内容写季度总结。");
    await page.locator(".composer textarea").press("Enter");
    await page.waitForSelector(".wb-outcome.delivered", { timeout: 60000 });
    assert.match(await page.locator(".wb-outcome.delivered").innerText(), /已交付/);

    // 刷新:交付事实来自持久化,不只在当前 SSE 中临时显示(N3-08)。
    await page.reload();
    await page.waitForSelector(".wb-outcome.delivered", { timeout: 15000 });
    assert.match(await page.locator(".wb-outcome.delivered").innerText(), /已交付/);
  },
);

test(
  "N3 UI:声称创建但无产物显示交付未完成(不显示成功),刷新后保持",
  { skip: !canBrowse },
  async (t) => {
    const { chromium } = await import("playwright-core");
    const { origin, project } = await bootServer(t, {
      apiKey: "synthetic",
      model: "scripted",
      // 始终只口头声称完成(零工具调用)→ 重试耗尽后 delivery_failed。
      complete: async () => ({
        message: { role: "assistant", content: "已创建 report.txt,任务完成。" },
      }),
    });
    const browser = await chromium.launch({
      executablePath: BROWSER,
      headless: true,
      timeout: 60_000,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(origin);
    await page.waitForSelector(".workspace-hub-empty, .workspace-shell", {
      timeout: 15000,
    });
    await createWorkspaceViaUI(page, project, "缺口演示");
    await page.locator(".composer textarea").fill("请创建报告文件 report.txt,内容写季度总结。");
    await page.locator(".composer textarea").press("Enter");
    await page.waitForSelector(".wb-outcome.answered", { timeout: 120000 });
    const cardText = await page.locator(".wb-outcome.answered").innerText();
    assert.match(cardText, /交付未完成/);
    assert.match(cardText, /report\.txt/);
    assert.equal(cardText.includes("已交付"), false);

    await page.reload();
    await page.waitForSelector(".wb-outcome.answered", { timeout: 15000 });
    assert.match(await page.locator(".wb-outcome.answered").innerText(), /交付未完成/);
  },
);
