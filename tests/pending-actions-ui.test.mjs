import {openPatient} from "./navigation-ui.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { fixture } from "./helpers.mjs";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test(
  "patient proposal conflict is visible in UI and preserves newer physician edits",
  {
    skip: !existsSync(chrome) || !existsSync("dist/index.html"),
    timeout: 30000,
  },
  async (t) => {
    const f = await fixture(t);
    const patient = (
      await f.json("/api/patients", "POST", { name: "合成冲突验收" })
    ).data;
    const proposal = f.server.runtime.toolPlugins
      .get("patient_record_propose")
      .execute({
        patientId: patient.id,
        medications: [{ name: "旧提案合成条目" }],
        summary: "待核对旧提案",
      });
    const browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(f.origin + "/?view=home");
  await page.locator(".app-navigation").waitFor();
    await openPatient(page, patient.name);
    await page.getByRole("button", { name: "核对变更", exact: true }).waitFor();
    // The global queue stays reachable without covering the chart's review action.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const badge = page.locator('.pending-badge');
      const header = await page.locator('.topbar').boundingBox();
      const badgeBounds = await badge.boundingBox();
      assert.ok(badgeBounds.y + badgeBounds.height <= header.y + header.height, 'queue remains inside the header');
      await badge.click();
      const queue = page.getByRole('region', { name: '待确认的操作' });
      await queue.waitFor();
      const bounds = await queue.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      await page.keyboard.press('Escape');
      await queue.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: '核对变更', exact: true }).click();
      await page.getByRole('button', { name: '返回核对', exact: true }).click();
      const chartUrl = page.url();
      await page.getByRole('button', { name: '打开病例工作区', exact: true }).click();
      await page.locator('.display-modes').waitFor();
      const workHeader = await page.locator('.topbar').boundingBox();
      for (const button of await page.locator('.top-actions button').all()) {
        if (!await button.isVisible()) continue;
        const box = await button.boundingBox();
        assert.ok(box.y + box.height <= workHeader.y + workHeader.height + 1, 'workspace controls remain inside the header');
      }
      await page.goto(chartUrl);
      await page.getByRole('button', { name: '核对变更', exact: true }).waitFor();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const edited = await f.json(`/api/patients/${patient.id}`, "PATCH", {
      expectedRevision: patient.revision,
      medications: [{ name: "医生最新合成条目" }],
    });
    assert.equal(edited.status, 200);
    await page.getByRole("button", { name: "核对变更", exact: true }).click();
    await page.getByRole("button", { name: "确认这些变更并写入", exact: true }).click();
    await page
      .locator('[role="alert"]')
      .filter({ hasText: /变化|版本|冲突|重新/ }).first()
      .waitFor();
    assert.equal(
      (await f.json(`/api/pending-actions?patientId=${patient.id}`)).data.actions.find(a => a.id === proposal.id)?.status,
      "pending",
    );
    assert.equal(
      (await f.json(`/api/patients/${patient.id}`)).data.medications[0].name,
      "医生最新合成条目",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "核对变更", exact: true })
        .isEnabled(),
      true,
    );
    assert.deepEqual(errors, []);
    await page.getByRole("button", { name: "返回核对", exact: true }).click();
    await page.getByRole("button", { name: "忽略", exact: true }).click();
    await page
      .getByRole("button", { name: "核对变更", exact: true })
      .waitFor({ state: "detached" });
    assert.equal(
      (await f.json(`/api/pending-actions?patientId=${patient.id}&status=rejected`)).data.actions.find(a => a.id === proposal.id)?.status,
      "rejected",
    );
  },
);
