import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { fixture } from "./helpers.mjs";
import { saveLearningPrefs } from "../server/medical/personal-context.mjs";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const options = { skip: !existsSync(chrome), timeout: 60000 };
async function setup(t) {
  const f = await fixture(t);
  saveLearningPrefs(f.server.store.db, { habits: true });
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  return { ...f, page };
}

test(
  "profile has one compact habit list; edits, restore, source labels and danger clear work",
  options,
  async (t) => {
    const f = await setup(t),
      { page } = f;
    const said = f.server.doctor.saveStated({ content: "以后检查结果分段写" });
    const learned = f.server.doctor.addMemory({
      kind: "consolidated",
      status: "confirmed",
      content: "检验单位统一大小写",
      source: { type: "review_diffs" },
    });
    f.server.store.db
      .prepare(
        "UPDATE doctor_memories SET origin='learned',count=3,dryrun=? WHERE id=?",
      )
      .run(JSON.stringify({ correct: 3, wrong: 0 }), learned.id);
    for (let i = 0; i < 5; i++)
      f.server.pending.reviewLog.feedback(learned.id, `a${i}`, "applied");
    for (let i = 0; i < 2; i++)
      f.server.pending.reviewLog.feedback(learned.id, `r${i}`, "reverted");
    for (let i = 0; i < 5; i++)
      f.server.pending.reviewLog.feedback(said.id, `s${i}`, "applied");
    for (let i = 0; i < 2; i++)
      f.server.pending.reviewLog.feedback(said.id, `sr${i}`, "reverted");
    f.server.doctor.addMemory({
      kind: "consolidated",
      content: "候选写法",
      source: { type: "repeated_feedback" },
    });
    await page.goto(f.origin + "/?view=settings&doctor=1");
    const ledger = page.getByRole("region", { name: "我的习惯", exact: true });
    await ledger.getByText("从你 3 次修改学到", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "生效中", exact: true }).count(),
      0,
    );
    assert.equal(await ledger.locator("article").count(), 2);
    assert.doesNotMatch(
      await ledger.innerText(),
      /H\d|review_diffs|stated|会改对/,
    );
    await ledger
      .getByText("最近常被改回，可能已不适用", { exact: true })
      .waitFor();
    const paused = ledger.getByRole("article", { name: "检验单位统一大小写" });
    assert.match(await paused.innerText(), /已暂停：最近常被你改回/);
    await paused
      .getByRole("button", { name: "恢复", exact: true })
      .first()
      .click();
    await paused.getByRole("button", { name: "停用", exact: true }).waitFor();
    await paused.getByText("详情", { exact: true }).click();
    await paused
      .getByText("上线前在你过去的档案上试过：会改对 3 处，会改错 0 处", {
        exact: true,
      })
      .waitFor();
    await paused.getByRole("button", { name: "编辑", exact: true }).click();
    await paused.getByLabel("习惯措辞").fill("以后单位写成标准格式");
    await paused.getByRole("button", { name: "保存措辞", exact: true }).click();
    await ledger
      .getByRole("article", { name: "以后单位写成标准格式" })
      .waitFor();
    await page.getByLabel("直接写下一条偏好").fill("以后小结先写本次变化");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    const added = ledger.getByRole("article", { name: "以后小结先写本次变化" });
    await added.waitFor();
    assert.match(await added.innerText(), /还没用上/);
    assert.doesNotMatch(await added.innerText(), /改回 0|用上 0/);
    await added.getByRole("button", { name: "删除", exact: true }).click();
    await added.getByText("已删除，可恢复").waitFor();
    await page.getByText("从你重复写过的说明学到", { exact: true }).waitFor();
    const danger = page.getByRole("region", { name: "危险操作" });
    assert.ok(
      await danger.evaluate((el) =>
        [...el.parentElement.children].every(
          (s) =>
            s === el ||
            s.getBoundingClientRect().top < el.getBoundingClientRect().top,
        ),
      ),
    );
    await danger
      .getByRole("button", { name: "清空学习记录", exact: true })
      .click();
    await danger.getByRole("button", { name: "取消", exact: true }).click();
    assert.ok(f.server.doctor.memories().length > 0);
    await danger
      .getByRole("button", { name: "清空学习记录", exact: true })
      .click();
    await danger.getByRole("checkbox").check();
    await danger
      .getByRole("button", { name: "确认清空学习记录", exact: true })
      .click();
    await ledger
      .getByRole("article", { name: "以后单位写成标准格式" })
      .waitFor({ state: "hidden" });
    assert.equal(f.server.doctor.memories({ status: "confirmed" }).length, 0);
  },
);

test(
  "learning stats hide single week chart, combine cohorts, label axis and request exact field details",
  options,
  async (t) => {
    const f = await setup(t),
      { page } = f;
    for (let i = 0; i < 5; i++) {
      const p = f.server.pending.propose({
        type: "patient-create",
        summary: "统计",
        payload: {
          name: `合成统计${i}`,
          labs: [
            { item: "血糖", value: 5, unit: "mmol/l", date: "2026-10-01" },
          ],
        },
      });
      f.server.pending.confirm(p.id, {
        payload: {
          ...p.payload,
          labs: [
            { item: "血糖", value: 6, unit: "mmol/L", date: "2026-10-01" },
          ],
        },
      });
    }
    await page.goto(f.origin + "/?view=settings&doctor=1");
    const stats = page.getByRole("region", { name: "它学得怎么样" });
    await stats.getByText(/最近 5 份建档，你平均每份改/).waitFor();
    assert.equal(await stats.getByRole("img").count(), 0);
    const request = page.waitForRequest((r) =>
      r.url().includes("/api/review-details?"),
    );
    await stats.getByRole("button", { name: /检验单位/ }).click();
    const url = new URL((await request).url());
    assert.equal(url.searchParams.get("section"), "labs");
    assert.equal(url.searchParams.get("field"), "unit");
    await stats.getByRole("region", { name: "检验单位最近修改" }).waitFor();
    assert.doesNotMatch(
      await stats.getByRole("region", { name: "检验单位最近修改" }).innerText(),
      /数值|labs|unit/,
    );
    const actual = (await f.json("/api/review-stats")).data;
    const week = actual.series[0];
    await page.route("**/api/review-stats?*", (route) =>
      route.fulfill({
        json: {
          ...actual,
          count: 60,
          recentAverage: 2,
          previousAverage: 4,
          series: [
            {
              ...week,
              week: "2026-09-28",
              group: "baseline",
              items: 10,
              edits: 2,
              count: 3,
            },
            {
              ...week,
              week: "2026-09-28",
              group: "learning",
              items: 30,
              edits: 6,
              count: 2,
            },
            {
              ...week,
              week: "2026-10-05",
              group: "learning",
              items: 20,
              edits: 2,
              count: 5,
            },
          ],
        },
      }),
    );
    await page.reload();
    await stats
      .getByRole("img", { name: "每周平均改动率", exact: true })
      .waitFor();
    assert.match(await stats.innerText(), /之前 4.0 处，↓50%/);
    assert.equal(await stats.locator("svg polyline").count(), 1);
    assert.equal(await stats.locator("svg circle").count(), 2);
    assert.match(
      await stats.locator("svg circle title").first().textContent(),
      /20%/,
    );
    assert.match(await stats.locator("svg").textContent(), /改动率.*0%/s);
    assert.doesNotMatch(await stats.innerText(), /基线|留出/);
    await stats.getByText("哪些是写法、哪些是内容", { exact: true }).click();
    assert.equal(
      await stats
        .getByRole("columnheader", { name: "组别", exact: true })
        .count(),
      0,
    );
    saveLearningPrefs(f.server.store.db, { pilot: true, pilotConsent: true });
    await page.reload();
    await stats
      .getByRole("img", { name: "每周平均改动率，按基线、学习与留出分组" })
      .waitFor();
    assert.equal(await stats.locator("svg polyline").count(), 3);
  },
);

test(
  "learning settings use explained switches, persist privacy and hide pilot under advanced",
  options,
  async (t) => {
    const f = await setup(t),
      { page } = f;
    await page.goto(f.origin + "/?view=settings");
    const settings = page.getByRole("region", { name: "学习与隐私" });
    await settings
      .getByRole("radio", { name: "仅本地模型", exact: true })
      .waitFor();
    assert.equal(
      await settings
        .getByRole("radio", { name: "仅本地模型", exact: true })
        .isChecked(),
      true,
    );
    assert.equal(await settings.getByRole("switch").count(), 3);
    assert.equal(
      await settings.getByRole("switch", { name: "参与效果比较" }).isVisible(),
      false,
    );
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/learning/settings") &&
        r.request().method() === "PUT",
    );
    await settings
      .getByRole("radio", { name: "从不使用", exact: true })
      .check();
    await saved;
    await page.reload();
    await settings
      .getByRole("radio", { name: "从不使用", exact: true })
      .waitFor();
    assert.equal(
      await settings
        .getByRole("radio", { name: "从不使用", exact: true })
        .isChecked(),
      true,
    );
    const switcher = settings.getByRole("switch", {
      name: "从核对修改中学习写法",
    });
    await switcher.uncheck();
    await settings.getByText("高级", { exact: true }).click();
    await settings.getByRole("switch", { name: "参与效果比较" }).waitFor();
    assert.equal((await f.json("/api/learning/settings")).data.habits, false);
  },
);

test(
  "pending tray remembers rejection and confirmation, survives last action and supports undo/view",
  options,
  async (t) => {
    const f = await setup(t),
      { page } = f;
    f.server.pending.propose({
      type: "patient-create",
      summary: "合成待办",
      payload: { name: "合成托盘患者" },
    });
    await page.goto(f.origin + "/?view=home");
    await page.locator(".pending-badge").click();
    await page.getByRole("button", { name: "拒绝", exact: true }).click();
    await page.getByLabel("拒绝原因（建档提案）").fill("以后小结都写成段落");
    await page.getByRole("button", { name: "记录并拒绝", exact: true }).click();
    const notice = page.locator(".pending-tray").getByRole("status");
    await notice.waitFor();
    assert.match(await notice.innerText(), /记下了：以后小结都写成段落/);
    assert.equal(await page.locator(".pending-badge").count(), 0);
    assert.match(
      await notice.getByRole("link", { name: "查看" }).getAttribute("href"),
      /#habit-\d+$/,
    );
    const memory = f.server.doctor.memories({ status: "confirmed" })[0];
    await notice.getByRole("button", { name: "撤销", exact: true }).click();
    await notice.waitFor({ state: "hidden" });
    assert.equal(f.server.doctor.memoryRow(memory.id).status, "deleted");
    const next = f.server.pending.propose({
      type: "patient-create",
      summary: "第二份待办",
      payload: { name: "合成托盘患者乙" },
    });
    await page.route(
      `**/api/pending-actions/${next.id}/confirm`,
      async (route) => {
        const response = await route.fetch(),
          data = await response.json();
        const m = f.server.doctor.saveStated({ content: "以后摘要先写变化" });
        await route.fulfill({ response, json: { ...data, remembered: [m] } });
      },
    );
    await page.reload();
    await page.locator(".pending-badge").click();
    await page.getByRole("button", { name: "确认执行", exact: true }).click();
    await notice.waitFor();
    assert.match(await notice.innerText(), /记下了：以后摘要先写变化/);
    await notice.getByRole("link", { name: "查看" }).click();
    await page
      .getByRole("region", { name: "我的习惯" })
      .getByRole("article", { name: "以后摘要先写变化" })
      .waitFor();
  },
);
