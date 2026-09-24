import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { DeepSeekProvider } from "../server/provider.mjs";
import { fixture } from "./helpers.mjs";
const tc = (name, args = {}) => ({
  id: crypto.randomUUID(),
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test(
  "doctor starts AI screening, leaves page, returns to durable evidence, adopts and saves review",
  { skip: !existsSync(chrome) },
  async (t) => {
    let file,
      trial,
      calls = 0;
    const provider = new DeepSeekProvider({
      apiKey: "synthetic",
      model: "test",
    });
    provider.complete = async () => {
      calls++;
      const tools =
        calls === 1
          ? [
              tc("read_trial_criteria"),
              tc("read_source", {
                sourceId: file.id,
                startLine: 1,
                endLine: 2,
              }),
            ]
          : [
              tc("save_trial_eligibility_batch", {
                checks: trial.criteria.map((c, i) => ({
                  id: c.id,
                  value: i === 1 ? "unknown" : "yes",
                  reason: i === 1 ? "未提供7天内检查" : "病历明确记载",
                  evidenceDate: "2026-09-24",
                  missing: i === 1 ? "7天内肝功能报告" : "",
                  citations:
                    i === 1
                      ? []
                      : [
                          {
                            sourceId: file.id,
                            startLine: 1,
                            endLine: 2,
                            quote:
                              i === 0
                                ? "患者年龄45岁。"
                                : "正在参加另一干预试验。",
                          },
                        ],
                })),
              }),
            ];
      return { message: { role: "assistant", content: "", tool_calls: tools } };
    };
    const f = await fixture(t, { provider }),
      p = (await f.json("/api/patients", "POST", { name: "合成纳排患者" }))
        .data;
    await f.json(`/api/sessions/${p.sessionId}/files`, "POST", {
      name: "合成病历.txt",
      text: "患者年龄45岁。\n正在参加另一干预试验。",
    });
    file = (await f.json(`/api/sessions/${p.sessionId}`)).data.files[0];
    trial = (
      await f.json("/api/trials", "POST", {
        title: "合成研究方案",
        version: "测试版 2026-09",
        inclusion: "年龄至少18岁\n近7天肝功能正常",
        exclusion: "正在参加另一干预试验",
      })
    ).data;
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
    await page.goto(f.origin + "/?view=research");
    await page
      .locator(".trial-card", { hasText: "合成研究方案" })
      .getByRole("button", { name: "打开初筛" })
      .click();
    await page.getByLabel("选择初筛患者", { exact: true }).selectOption(p.id);
    await page
      .getByRole("button", { name: "开始自动初筛", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "主要业务" })
      .getByRole("button", { name: "患者", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "主要业务" })
      .getByRole("button", { name: "临床试验", exact: true })
      .click();
    await page
      .locator(".trial-card", { hasText: "合成研究方案" })
      .getByRole("button", { name: "打开初筛" })
      .click();
    await page.getByLabel("选择初筛患者", { exact: true }).selectOption(p.id);
    await page.getByText("AI 初筛已完成", { exact: true }).waitFor();
    assert.equal(await page.locator(".trial-ai-item").count(), 2);
    await page
      .getByRole("button", { name: "全部条件（3）", exact: true })
      .click();
    assert.equal(await page.locator(".trial-ai-item").count(), 3);
    await page.getByText("查看病历依据（1）", { exact: true }).first().click();
    await page.getByText("患者年龄45岁。", { exact: true }).waitFor();
    mkdirSync("output/playwright", { recursive: true });
    await page.screenshot({
      path: "output/playwright/trial-ai-desktop.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "将 AI 结果带入医生核对", exact: true })
      .click();
    await page
      .getByRole("button", { name: "保存初筛记录", exact: true })
      .click();
    await page.getByText("上次保存结论：", { exact: false }).waitFor();
    assert.equal(
      (await f.json(`/api/trials/${trial.id}/screenings/${p.id}`)).data
        .revision,
      1,
    );
    await page.setViewportSize({ width: 760, height: 1000 });
    await page.screenshot({
      path: "output/playwright/trial-ai-narrow.png",
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    assert.deepEqual(errors, []);
  },
);
