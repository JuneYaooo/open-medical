import { expect, test } from "@playwright/test";
import { capture, open } from "./helpers.mjs";

test("研究页：本机数据概况、提问、各阶段入口", async ({ page }) => {
  await open(page, "/?view=study");
  await expect(page.getByRole("heading", { name: "研究", exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "主要业务" });
  await expect(nav.getByRole("button", { name: "研究" })).toHaveAttribute("aria-current", "page");

  const data = page.getByLabel("本机数据概况");
  await expect(data).toContainText("患者");
  const diagnosis = page.getByRole("group", { name: "常见诊断" }).getByRole("button").first();
  await expect(diagnosis).toBeVisible();
  await diagnosis.click();
  await expect(page.getByLabel("研究问题")).toHaveValue(/^我的「.+」患者/);

  await expect(page.getByRole("heading", { name: "文献研究", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "科研统计", exact: true })).toBeVisible();
  await capture(page, "40-research-hub.png", { scroll: ".work-directory" });

  // 子页面的面包屑回到研究，侧栏仍高亮研究。
  await page.getByRole("heading", { name: "文献研究", exact: true }).click();
  const trail = page.getByRole("navigation", { name: "当前位置" });
  await expect(trail.getByRole("button", { name: "研究" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "研究" })).toHaveAttribute("aria-current", "page");
  await trail.getByRole("button", { name: "研究" }).click();

  // 写作模板带着模板回到新建任务。
  await page.getByRole("heading", { name: "个案报告写作", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "个案报告写作" })).toBeVisible();
  await expect(page.getByLabel("任务内容")).toHaveValue(/个案报告/);
});
