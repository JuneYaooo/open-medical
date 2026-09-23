// 真实模型 · 桌面端：Electron 壳（--e2e 隔离数据目录）+ 隔离目录内写入 model.env，
// 验证桌面端在真实模型下咨询直接答。前置同 tests/model-e2e.test.mjs。
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
const apiKey = process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || "";
const MODEL_ENV = [
  `AI_PROVIDER=${process.env.AI_PROVIDER || "anthropic"}`,
  `ANTHROPIC_API_KEY=${apiKey}`,
  `ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL || "https://api.deepseek.com/anthropic"}`,
  `ANTHROPIC_MODEL=${process.env.ANTHROPIC_MODEL || "deepseek-flash"}`,
].join("\n");
const canRun =
  existsSync(DIST) &&
  existsSync(MAIN) &&
  Boolean(electronPath) &&
  Boolean(apiKey.trim()) &&
  process.env.MODEL_E2E !== "off";

test("桌面 · 真实模型咨询直接答：默认档位咨询、回答实质、不产文书", { skip: !canRun }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "omw-model-desktop-"));
  // 隔离数据目录内写入模型配置（桌面壳从 userData/model.env 读取）
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "model.env"), `${MODEL_ENV}\n`, { mode: 0o600 });
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [MAIN, "--e2e"],
    cwd: process.cwd(),
    timeout: 60000,
    // Windows 下空串仍会被 Electron 视为 run-as-node(曾致进程秒退,
    // 此前因 dist 缺失 skip 未暴露);必须真正删除该变量。
    env: (() => {
      const launchEnv = { ...process.env, MEDICAL_DESKTOP_TEST_DIR: directory };
      delete launchEnv.ELECTRON_RUN_AS_NODE;
      return launchEnv;
    })(),
  });
  t.after(async () => {
    try {
      await app.close();
    } catch {
      app.process().kill("SIGKILL");
    }
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".app-navigation", { timeout: 30000 });
  const origin = new URL(page.url()).origin;
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
  const token = bootstrap.token;
  const request = (path, method = "GET", data) =>
    fetch(origin + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-medical-token": token,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
  const seed = {
    json: async (path, method = "GET", data) => {
      const r = await request(path, method, data);
      return { status: r.status, data: await r.json() };
    },
    request,
  };
  const p = await seed.json("/api/patients", "POST", {
    name: "桌面模型咨询患者",
    tags: ["PCI 术后"],
  });
  await seed.request(`/api/sessions/${p.data.sessionId}/files`, "POST", {
    name: "出院记录.txt",
    text: [
      "2026-08-12 患者因突发胸痛入院，诊断急性 ST 段抬高型心肌梗死，急诊 PCI 治疗植入药物涂层支架一枚。",
      "2026-08-20 出院。出院带药：阿司匹林肠溶片 100mg 每日一次；替格瑞洛片 90mg 每日两次。",
      "出院医嘱：低盐低脂饮食，一个月后门诊复查。",
    ].join("\n"),
  });
  await page.goto(origin + "/?view=home");
  await page.locator(".advanced-nav>summary").click();
  // 打开病例工作区
  await page
    .locator('.app-navigation nav[aria-label="患者"] .session', {
      hasText: "桌面模型咨询患者",
    })
    .click();
  await page.waitForSelector(".detail-head");
  await page.locator('button:has-text("打开病例工作区")').click();
  await page.waitForSelector(".composer");
  // 默认档位应为咨询（模型已配置）
  // 无模式档位：会话头/输入区不应出现档位选择器
  assert.equal(await page.locator(".mode-chips").count(), 0);
  // 逐次确认档下勾选外发；默认会话自动无需勾选
  const consent = page.locator(".tb-check input");
  if (await consent.isVisible().catch(() => false)) await consent.check();
  await page.locator(".composer textarea").fill(
    "这位患者出院后饮食能吃辛辣的吗？请结合出院记录直接回答。",
  );
  await page.locator(".composer textarea").press("Enter");
  await page.waitForFunction(
    () => !document.querySelector(".send-button.stop"),
    undefined,
    { timeout: 240000 },
  );
  const last = await page.locator(".message-list .message").last().innerText();
  assert.ok(last.length > 30, "模型应给出实质回答");
  assert.equal(await page.locator(".artifact-inline").count(), 0, "咨询不应产生文书产物");
});
