// 真实模型端到端：DeepSeek（Anthropic 兼容端点，配置来自 .env）。
// 前置：npm run build；.env 内配置 AI_PROVIDER=anthropic + ANTHROPIC_*；
// 需要外网与有效 API Key，未配置时自动跳过。运行：
//   node --test --test-timeout=240000 tests/model-e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fixture } from "./helpers.mjs";
import { chromium } from "playwright-core";

const DIST = resolve(process.cwd(), "dist/index.html");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (existsSync(".env")) process.loadEnvFile(".env");
const MODEL = {
  providerName: process.env.AI_PROVIDER || "anthropic",
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || "",
  baseUrl: process.env.ANTHROPIC_BASE_URL || process.env.DEEPSEEK_BASE_URL,
  model: process.env.ANTHROPIC_MODEL || process.env.DEEPSEEK_MODEL,
};
const canRun =
  existsSync(DIST) &&
  existsSync(CHROME) &&
  Boolean(MODEL.apiKey) &&
  process.env.MODEL_E2E !== "off";

async function openApp(t) {
  const f = await fixture(t, { ...MODEL });
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto(f.origin);
  await page.waitForSelector(".app-navigation", { timeout: 15000 });
  return { f, page };
}

async function openPatientWorkspace(page, name) {
  await page
    .locator('.app-navigation nav[aria-label="患者"] .session', { hasText: name })
    .first()
    .click();
  await page.waitForSelector(".detail-head");
  await page.locator('button:has-text("打开病例工作区")').click();
  await page.waitForSelector(".composer");
}

async function sendAndWaitDone(page, text) {
  const consent = page.locator(".composer .consent input").first();
  if (await consent.isVisible().catch(() => false)) await consent.check();
  await page.locator(".composer textarea").fill(text);
  await page.locator(".composer textarea").press("Enter");
  // 等待本轮执行结束：发送键从“停止”恢复为可用的发送态
  await page.waitForFunction(
    () => !document.querySelector(".send-button.stop"),
    { timeout: 240000 },
  );
}

test("真实模型 · 咨询直接答：不产文书、回答引用材料", { skip: !canRun }, async (t) => {
  const { f, page } = await openApp(t);
  const p = await f.json("/api/patients", "POST", { name: "模型咨询患者", tags: ["PCI 术后"] });
  await f.request(`/api/sessions/${p.data.sessionId}/files`, "POST", {
    name: "出院记录.txt",
    text: [
      "2026-08-12 患者因突发胸痛入院，诊断急性 ST 段抬高型心肌梗死，急诊 PCI 治疗植入药物涂层支架一枚。",
      "2026-08-20 出院。出院带药：阿司匹林肠溶片 100mg 每日一次；替格瑞洛片 90mg 每日两次；阿托伐他汀钙片 20mg 每晚一次。",
      "出院医嘱：低盐低脂饮食，一个月后门诊复查心电图、血脂与肝肾功能。",
    ].join("\n"),
  });
  await openPatientWorkspace(page, "模型咨询患者");
  // 无档位可选：意图由服务端 policy 判定，模型应自行选择直接回答
  await sendAndWaitDone(
    page,
    "这位患者出院后饮食能吃辛辣的吗？请结合出院记录直接回答。",
  );
  // 直接回答：有实质回答文本
  const last = await page.locator(".message-list .message").last().innerText();
  assert.ok(last.length > 30, "模型应给出实质回答");
  // 咨询不产文书：对话内不应出现产物卡
  assert.equal(await page.locator(".artifact-inline").count(), 0, "咨询不应产生文书产物");
});

test("真实模型 · 文书整理：工具调用 + 产物 + 验收通过", { skip: !canRun }, async (t) => {
  const { f, page } = await openApp(t);
  const p = await f.json("/api/patients", "POST", { name: "模型文书患者" });
  await f.request(`/api/sessions/${p.data.sessionId}/files`, "POST", {
    name: "出院记录.txt",
    text: [
      "2026-08-12 患者因突发胸痛入院，诊断急性 ST 段抬高型心肌梗死，急诊 PCI 治疗植入药物涂层支架一枚。",
      "2026-08-14 检验：血肌酐 88 μmol/L；血钾 4.2 mmol/L；LDL-C 2.4 mmol/L。",
      "2026-08-20 出院。出院带药：阿司匹林肠溶片 100mg 每日一次；替格瑞洛片 90mg 每日两次。",
      "出院医嘱：一个月后门诊复查，低盐低脂饮食。",
    ].join("\n"),
  });
  await openPatientWorkspace(page, "模型文书患者");
  await sendAndWaitDone(
    page,
    "请整理本患者的病例材料：生成病历时间线、检验数值摘录，保留来源与行号。",
  );
  // 真实模型走完工具链后应产出待复核产物
  await page.waitForSelector(".artifact-inline", { timeout: 30000 });
  assert.match(await page.locator(".artifact-inline").first().innerText(), /待复核/);
  // 步骤流可见（真实工具调用被记录）
  await page.locator('button:has-text("打开验收视图")').first().click();
  await page.waitForSelector(".acceptance", { timeout: 15000 });
  await page.locator('.seg button:has-text("出处对照")').click();
  // 轻量复核通过（真实模型产物进入闭环）
  await page.locator('.review-acts button:has-text("确认通过")').click();
  await page.locator(".review-form input").nth(0).fill("医生 A");
  await page.locator(".review-form input").nth(1).fill("真实模型产物抽检通过");
  await page.locator(".review-form .attest input").check();
  await page.locator('.review-form button:has-text("确认通过")').click();
  await page.waitForSelector(".accept-bar .acc-badge.approved", { timeout: 15000 });
});
