import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { fixture } from "./helpers.mjs";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const skip = !existsSync(chrome) || !existsSync("dist/index.html");
async function browserFixture(t) {
  const f = await fixture(t, { followupOptions: { autoStart: false } });
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  return { ...f, page };
}

test(
  "doctor UI: patient steps, failed clinical save and follow-up outcome survive reload",
  { skip },
  async (t) => {
    const f = await browserFixture(t);
    const patient = (
      await f.json("/api/patients", "POST", { name: "闭环浏览器患者" })
    ).data;
    const job = (
      await f.json(`/api/patients/${patient.id}/followups`, "POST", {
        name: "复诊反馈",
        once: true,
        firstDueAt: new Date(Date.now() + 86400000).toISOString(),
        checklist: ["核对反馈"],
      })
    ).data;
    f.server.followups.createReminder(patient, job, "待联系患者并登记反馈");
    await f.page.goto(f.origin + "/?view=home");
    await f.page
      .locator('.app-navigation nav[aria-label="患者"] .session', {
        hasText: patient.name,
      })
      .click();
    await f.page.getByRole("button", { name: "临床资料", exact: true }).click();
    await f.page.getByPlaceholder("药名", { exact: true }).fill("测试药品");
    await f.page.route(`**/api/patients/${patient.id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "档案已变化，请刷新" }),
      });
    });
    await f.page
      .locator(".clinical-add-med")
      .filter({ has: f.page.getByPlaceholder("药名", { exact: true }) })
      .getByRole("button", { name: "添加" })
      .click();
    await f.page.getByRole("alert").filter({ hasText: "档案已变化" }).waitFor();
    assert.equal(
      await f.page.getByPlaceholder("药名", { exact: true }).inputValue(),
      "测试药品",
    );
    assert.equal(
      await f.page.locator(".clinical-rows").getByText("测试药品").count(),
      0,
    );
    await f.page.unroute(`**/api/patients/${patient.id}`);
    await f.page.getByRole("button", { name: "沟通与随访", exact: true }).click();
    await f.page.getByRole("button", { name: "随访计划", exact: true }).click();
    await f.page.getByRole("button", { name: "登记结果", exact: true }).click();
    await f.page
      .getByLabel("随访记录", { exact: true })
      .fill("已核实患者反馈，保留随访记录。");
    await f.page.getByLabel("核对反馈", { exact: true }).check();
    await f.page
      .getByRole("button", { name: "保存随访结果", exact: true })
      .click();
    await f.page
      .getByRole("status")
      .filter({ hasText: "随访结果已保存" })
      .waitFor();
    await f.page.getByRole("button", { name: /^随访记录/ }).click();
    await f.page
      .getByText("已核实患者反馈，保留随访记录。", { exact: true })
      .waitFor();
    mkdirSync("output/care-continuity", { recursive: true });
    await f.page.screenshot({
      path: "output/care-continuity/patient-followup.png",
      fullPage: true,
    });
    await f.page.reload();
    await f.page
      .locator('.app-navigation nav[aria-label="患者"] .session', {
        hasText: patient.name,
      })
      .click();
    await f.page.getByRole("button", { name: "沟通与随访", exact: true }).click();
    await f.page.getByRole("button", { name: "随访计划", exact: true }).click();
    await f.page.getByRole("button", { name: /^随访记录/ }).click();
    await f.page
      .getByText("已核实患者反馈，保留随访记录。", { exact: true })
      .waitFor();
    await f.page
      .getByRole("button", { name: "基于记录继续任务", exact: true })
      .click();
    await f.page.locator(".composer textarea").waitFor();
    await f.page.waitForFunction(() => document.querySelector(".composer textarea")?.value.includes("已核实患者反馈"));
  },
);

test(
  "doctor UI: knowledge source becomes an unsent task with provenance",
  { skip },
  async (t) => {
    const f = await browserFixture(t);
    await f.page.goto(f.origin + "/?view=home");
    await f.page.getByRole("button", { name: "打开", exact: true }).click();
    await f.page.getByRole("button", { name: /知识库/ }).click();
    await f.page.getByRole("button", { name: /^整页打开/ }).click();
    await f.page.locator('.guidelines-view input[type="file"]').setInputFiles({
      name: "随访记录规范.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "随访记录需要保留患者反馈、核实条目和下次联系计划。".repeat(8),
      ),
    });
    await f.page.getByLabel("文档类别").selectOption("资料");
    await f.page
      .getByRole("button", { name: "导入并建索引", exact: true })
      .click();
    await f.page
      .getByText("资料已导入并建立索引；可打开文档核对来源与版本。", { exact: true })
      .waitFor();
    const doc = (await f.json("/api/knowledge")).data.documents[0];
    assert.equal(doc.kind, "资料");
    await f.page.getByRole("button", { name: /随访记录规范/ }).click();
    await f.page
      .getByRole("button", { name: "用此来源准备循证任务", exact: true })
      .click();
    await f.page.locator(".composer textarea").waitFor();
    const draft = await f.page.locator(".composer textarea").inputValue();
    assert.ok(draft.includes(doc.id));
    assert.match(draft, /随访记录规范/);
    const sessions = (await f.json("/api/sessions")).data.sessions;
    assert.ok(sessions.some((session) => session.title.includes("循证准备")));
    assert.ok(sessions.every((session) => !session.running));
  },
);
