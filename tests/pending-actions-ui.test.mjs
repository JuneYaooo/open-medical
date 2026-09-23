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
  await page.locator(".advanced-nav>summary").click();
    await page
      .locator('.app-navigation nav[aria-label="患者"] .session', {
        hasText: patient.name,
      })
      .first()
      .click();
    await page.getByRole("button", { name: "核对变更", exact: true }).waitFor();
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
