// 桌面端 · 项目任务一次发送：首页点发送进入工作区后应自动开始运行，
// 不需要在落地页再点一次发送。真实模型门控与隔离方式同
// tests/model-desktop-e2e.test.mjs。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const DIST = resolve(process.cwd(), "dist/index.html");
const MAIN = resolve(process.cwd(), "desktop/main.cjs");
let electronPath = "";
try {
  electronPath = require("electron");
} catch {}

if (existsSync(".env")) process.loadEnvFile(".env");
const KEY =
  process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || "";
const canRun =
  existsSync(DIST) &&
  existsSync(MAIN) &&
  Boolean(electronPath) &&
  Boolean(KEY) &&
  process.env.MODEL_E2E !== "off";

test("桌面 · 项目任务一次发送：首页发送后自动开始运行", { skip: !canRun }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "omw-one-send-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "omw-one-send-ws-"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "model.env"),
    [
      `AI_PROVIDER=${process.env.AI_PROVIDER || "anthropic"}`,
      `ANTHROPIC_API_KEY=${KEY}`,
      `ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL || "https://api.deepseek.com/anthropic"}`,
      `ANTHROPIC_MODEL=${process.env.ANTHROPIC_MODEL || "deepseek-flash"}`,
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [MAIN, "--e2e"],
    cwd: process.cwd(),
    timeout: 60000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "",
      MEDICAL_DESKTOP_TEST_DIR: directory,
    },
  });
  t.after(async () => {
    try {
      await app.close();
    } catch {
      app.process().kill("SIGKILL");
    }
  });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE-ERR:", m.text().slice(0, 300));
  });
  await page.waitForSelector(".app-navigation", { timeout: 30000 });
  const origin = new URL(page.url()).origin;
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
  const request = (path, method = "GET", data) =>
    fetch(origin + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-medical-token": bootstrap.token,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
  // 种一个项目工作区，模拟「用户已有项目」的落地环境。
  const seeded = await request("/api/workspaces", "POST", {
    title: "一次发送验证",
    root: projectRoot,
    directoryConsent: true,
  });
  assert.ok(seeded.ok, `项目工作区创建失败：${seeded.status}`);
  const seededWorkspace = await seeded.json();

  // 首页：新建任务 → 通用任务 → 输入 → 只点击一次发送。
  await page.getByRole("button", { name: "AI 工作台", exact: true }).click();
  await page.locator(".app-navigation .new-session").click();
  await page.locator(".hub-composer textarea").waitFor();
  await page.locator('.hub-task-type button:has-text("通用任务")').click();
  await page
    .locator(".hub-composer textarea")
    .fill("列出当前目录下的文件名，并用一句话说明这个文件夹的用途。");
  await page.locator('button:has-text("发送并打开工作区")').click();

  // 落地工作区视图，此后不做任何点击：运行应已自动开始。
  await page.waitForTimeout(3000);
  const listDebug = await (await request("/api/workspaces")).json();
  const bodyText = await page.locator("body").innerText();
  console.log(
    "DEBUG list:",
    JSON.stringify(listDebug).slice(0, 600),
    "\nDEBUG view:",
    bodyText.slice(0, 500).replace(/\n+/g, " | "),
  );
  await page.waitForSelector('form.composer textarea[aria-label="项目任务"]');
  let runStarted = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !runStarted) {
    const r = await fetch(`${origin}/api/workspaces/${seededWorkspace.id}`, {
      headers: { "x-medical-token": bootstrap.token },
    });
    const data = await r.json();
    runStarted = (data.runs || []).length > 0;
    if (!runStarted)
      await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(runStarted, "进入工作区后 30 秒内应自动开始运行，无需二次发送");
  // 输入框应已清空（提示词被任务消费，而非留在输入框等二次发送）。
  await page.waitForFunction(
    () =>
      document.querySelector('form.composer textarea[aria-label="项目任务"]')
        ?.value === "",
    { timeout: 10000 },
  );
});
