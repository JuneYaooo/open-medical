import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { fixture } from "./helpers.mjs";
import {
  organizerProvider,
  library,
} from "./knowledge-organization-helpers.mjs";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test(
  "doctor uploads once, leaves background processing, opens a graph with traceable original",
  { skip: !existsSync(chrome) },
  async (t) => {
    const f = await fixture(t, { provider: organizerProvider });
    await library(f, "教学资料");
    const browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(f.origin + "/?view=knowledge");
    await page
      .locator(".library-card", { hasText: "教学资料" })
      .getByRole("button", { name: "打开知识库", exact: true })
      .click();
    await page
      .getByLabel("自动整理上传文件", { exact: true })
      .setInputFiles({
        name: "合成讲座.srt",
        mimeType: "text/plain",
        buffer: Buffer.from(
          "1\n00:00:01,000 --> 00:00:05,000\n合成疾病讨论合成检查。",
        ),
      });
    await page.getByText(/已提交 1 份资料/).waitFor();
    await page
      .getByRole("button", { name: "← 全部知识库", exact: true })
      .click();
    await page
      .locator(".library-card", { hasText: "教学资料" })
      .getByRole("button", { name: "打开知识库", exact: true })
      .click();
    await page.getByRole("button", { name: "知识地图", exact: true }).click();
    await page
      .getByRole("button", { name: "知识点：合成疾病", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "知识点：合成疾病", exact: true })
      .click();
    await page.getByText("资料讨论", { exact: false }).first().waitFor();
    mkdirSync("output/knowledge-media", { recursive: true });
    await page.screenshot({
      path: "output/knowledge-media/knowledge-map.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: /查看依据 · 第/ })
      .first()
      .click();
    await page
      .getByRole("heading", { name: "合成资料主题", exact: true })
      .waitFor();
    assert.match(
      await page.locator(".guidelines-text").innerText(),
      /00:00:01/,
    );
    await page.getByRole("button", { name: /打开原文件/ }).click();
    const link = page.getByRole("link", {
      name: "查看或下载原文件",
      exact: true,
    });
    await link.waitFor();
    const response = await page.request.get(
      new URL(await link.getAttribute("href"), f.origin).href,
    );
    assert.equal(response.status(), 200);
    assert.match(await response.text(), /00:00:01,000/);
    await page.getByRole("button", { name: "返回列表", exact: true }).click();
    await page
      .getByRole("button", { name: "转写服务：未配置", exact: true })
      .click();
    await page
      .getByLabel("转写接口地址", { exact: true })
      .fill("http://127.0.0.1:8765/v1");
    await page.getByLabel("转写模型", { exact: true }).fill("whisper-1");
    await page
      .getByRole("button", { name: "保存转写连接", exact: true })
      .click();
    await page.getByText(/转写连接已保存，尚未验证实际转写/).waitFor();
    assert.deepEqual(errors, []);
  },
);
