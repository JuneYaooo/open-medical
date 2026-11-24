import { test, expect } from "@playwright/test";
import { capture, open, PATIENT_NAME } from "./helpers.mjs";

// Runs after the read-only baseline specs: it marks the demo visit attended
// and enrolls the demo patient in a care pack.
test("到诊后一路走到随访：登记到诊 → 安排随访 → 按诊断推荐管理包并入组", async ({ page }) => {
  await open(page, "/?view=agenda");
  const row = page.locator(".agenda-row", { hasText: PATIENT_NAME }).filter({ hasText: "复诊" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "已到诊" }).click();

  const next = page.locator(".post-visit-next");
  await expect(next).toContainText(`已登记${PATIENT_NAME}到诊`);
  await expect(next.getByRole("button", { name: "准备诊后文书" })).toBeVisible();
  await expect(next.getByRole("button", { name: "约下次复诊" })).toBeVisible();
  await capture(page, "05d-agenda-next-step.png", { scroll: ".work-directory.agenda-page" });

  await next.getByRole("button", { name: "安排随访" }).click();
  await expect(page).toHaveURL(/tab=followups/);
  const suggestion = page.locator(".care-pack-suggestion");
  await expect(suggestion).toContainText("按诊断推荐：高血压管理包");
  await expect(suggestion).toContainText("原发性高血压");
  await capture(page, "05e-care-pack-suggestion.png", { scroll: ".patients-view" });

  await suggestion.getByRole("button", { name: "入组" }).click();
  await expect(page.locator(".care-pack-suggestions .notice")).toContainText("已按「高血压管理包」入组");
  await expect(page.locator(".care-pack-suggestion")).toHaveCount(0);
  await expect(page.getByRole("article", { name: /提醒计划：高血压管理包/ }).first()).toBeVisible();
});

test("随访管理：顶部显示随访概况", async ({ page }) => {
  await open(page, "/?view=followups");
  const stats = page.locator(".followup-stats");
  await expect(stats).toContainText("随访中");
  await expect(stats).toContainText("待登记");
  await expect(stats).toContainText("登记率");
  await capture(page, "05f-followup-stats.png", { scroll: ".followups-view" });
});
