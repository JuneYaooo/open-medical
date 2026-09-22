// W2 通用 App Shell:独立通用服务的能力声明与前端任务闭环。
// - 服务端用例(始终运行):bootstrap 声明通用 capabilities、医疗接口 404、
//   工作区接口可用。
// - 浏览器用例(playwright-core + 本机 Edge/Chrome headless,需先 npm run
//   build):加载生产构建页面,断言无医疗 API 请求、无「接口不存在」,并完成
//   创建→执行→产物预览→继续 闭环;另验证医疗入口不回归。
// 浏览器用例中的模型为脚本 provider(非真实模型),仅验证前端与平台链路。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createWorkspaceServer } from "../server/platform.mjs";
import { createServer as createMedicalServer } from "../server/agent.mjs";

const DIST = resolve(process.cwd(), "dist/index.html");
const BROWSER = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);
const canBrowse = existsSync(DIST) && Boolean(BROWSER);
const MEDICAL_API = /^\/api\/(sessions|patients|reminders|inbox|risk-alerts|doctor)/;

test("独立通用服务 bootstrap 声明通用能力,医疗接口不存在,工作区接口可用", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "platform-shell-"));
  const server = createWorkspaceServer({
    database: join(dir, "app.sqlite"),
    provider: {
      apiKey: "synthetic",
      model: "scripted",
      async complete() {
        return { message: { role: "assistant", content: "ok" }, usage: {} };
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await server.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const boot = await (await fetch(origin + "/api/bootstrap")).json();
  assert.equal(boot.engine, "generic-runtime");
  assert.deepEqual(boot.capabilities, {
    workspaces: true,
    modelSettings: true,
    medical: false,
  });
  const request = (path) =>
    fetch(origin + path, { headers: { "x-agent-token": server.token } });
  assert.equal((await request("/api/sessions")).status, 404);
  assert.equal((await request("/api/patients")).status, 404);
  assert.equal((await request("/api/reminders")).status, 404);
  const list = await request("/api/workspaces");
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).workspaces, []);
});

test(
  "通用 App Shell:无医疗请求、无接口不存在,创建→执行→产物→继续闭环(脚本模型)",
  { skip: !canBrowse },
  async (t) => {
    const { chromium } = await import("playwright-core");
    const dir = mkdtempSync(join(tmpdir(), "platform-shell-ui-"));
    const project = join(dir, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "note.txt"), "初始材料");
    let turn = 0;
    const server = createWorkspaceServer({
      database: join(dir, "app.sqlite"),
      provider: {
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
                        path: "summary.md",
                        content: "# 通用闭环\n\n脚本模型生成的产物。",
                      }),
                    },
                  },
                ],
              },
            };
          return {
            message: { role: "assistant", content: `第 ${turn} 轮完成。` },
          };
        },
      },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      await server.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({
      executablePath: BROWSER,
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const medicalRequests = [];
    const api404 = [];
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("request", (req) => {
      const pathname = new URL(req.url()).pathname;
      if (MEDICAL_API.test(pathname)) medicalRequests.push(pathname);
    });
    page.on("response", (res) => {
      const url = new URL(res.url());
      if (res.status() === 404 && url.pathname.startsWith("/api/"))
        api404.push(url.pathname);
    });
    await page.goto(origin);
    await page.waitForSelector(".app-navigation", { timeout: 15000 });

    // 无医疗能力:侧栏无患者导航/医生记忆,品牌为通用工作台,默认进入工作区视图
    await page.waitForSelector(".workspace-hub-empty, .workspace-shell");
    assert.equal(await page.locator('nav[aria-label="患者"]').count(), 0);
    assert.equal(await page.locator('nav[aria-label="最近任务"]').count(), 0);
    assert.equal(await page.locator(".workspace-account").count(), 0);
    assert.match(await page.locator(".brand-caption").innerText(), /通用工作台/);

    // 创建:侧栏「新建任务」直达工作区创建弹窗,连接本地文件夹
    await page.locator("button.new-session").click();
    await page.locator(".modal input").nth(0).fill("闭环演示");
    await page.locator(".modal input").nth(1).fill(project);
    await page.locator('.modal input[type="checkbox"]').check();
    await page.locator('button:has-text("创建工作区")').click();
    await page.waitForSelector(".workspace-shell .composer textarea", {
      timeout: 15000,
    });
    assert.match(
      await page.locator(".conversation-head h1").innerText(),
      /闭环演示/,
    );

    // 授权「自动 · 工作区内」,让脚本模型的写文件提案自动应用
    await page.locator('select[aria-label="授权模式"]').selectOption(
      "workspace-write",
    );

    // 执行:一句话交办(脚本模型先写 summary.md 再汇报)
    await page.locator(".composer textarea").fill("请把材料整理成 summary.md");
    await page.locator(".composer textarea").press("Enter");
    await page.waitForSelector('.desk-messages .message:has-text("第 2 轮完成")', {
      timeout: 60000,
    });

    // 产物:文件面板浏览工作区并预览生成的 summary.md(markdown 预览)
    await page.locator('button:has-text("浏览工作区文件")').click();
    await page.locator('.wb-file-row:has-text("summary.md")').click();
    await page.waitForSelector(".wb-md-preview", { timeout: 15000 });
    assert.match(await page.locator(".wb-md-preview").innerText(), /通用闭环/);

    // 继续:同一工作区追加第二轮任务
    await page.locator(".composer textarea").fill("继续,补充说明");
    await page.locator(".composer textarea").press("Enter");
    await page.waitForSelector('.desk-messages .message:has-text("第 3 轮完成")', {
      timeout: 60000,
    });

    // 继续历史:重新进入页面,自动回到上次工作区并保留全部记录
    await page.reload();
    await page.waitForSelector(".workspace-shell .composer textarea", {
      timeout: 15000,
    });
    await page.waitForSelector('.desk-messages .message:has-text("第 3 轮完成")', {
      timeout: 15000,
    });

    // 全程无医疗 API 请求、无 /api 404、无全局错误态、无脚本错误
    assert.deepEqual(medicalRequests, []);
    assert.deepEqual(api404, []);
    assert.deepEqual(pageErrors, []);
    const body = await page.evaluate(() => document.body.innerText);
    assert.equal(body.includes("接口不存在"), false);
    assert.equal(body.includes("刷新连接"), false);
  },
);

test(
  "医疗入口不回归:医疗服务上患者导航、医疗首页与 /api/sessions 照常",
  { skip: !canBrowse },
  async (t) => {
    const { chromium } = await import("playwright-core");
    const server = createMedicalServer({ database: ":memory:", apiKey: "" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.shutdown());
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({
      executablePath: BROWSER,
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const pageErrors = [];
    let sessionsStatus = 0;
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("response", (res) => {
      if (new URL(res.url()).pathname === "/api/sessions")
        sessionsStatus = res.status();
    });
    await page.goto(origin);
    await page.waitForSelector('nav[aria-label="主要业务"]', { timeout: 15000 });
    await page.waitForSelector(".patients-view");
    await page.getByRole("button", { name: "AI 工作台", exact: true }).click();
    assert.match(await page.locator(".brand-caption").innerText(), /医疗工作台/);
    assert.equal(
      await page.locator('nav[aria-label="最近任务"]').count(),
      1,
    );
    await page.waitForSelector(".hub-scenarios", { timeout: 15000 });
    const body = await page.evaluate(() => document.body.innerText);
    assert.equal(body.includes("这次需要做什么？"), true);
    assert.equal(body.includes("接口不存在"), false);
    assert.equal(sessionsStatus, 200);
    assert.deepEqual(pageErrors, []);
  },
);
