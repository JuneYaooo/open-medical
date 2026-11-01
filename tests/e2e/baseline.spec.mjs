import { expect, test } from "@playwright/test";
import { PATIENT_NAME, capture, open } from "./helpers.mjs";

let patientId = "";

test.beforeAll(async ({ request }) => {
  const bootstrapResponse = await request.get("/api/bootstrap");
  expect(bootstrapResponse.ok()).toBeTruthy();
  const { token } = await bootstrapResponse.json();

  const patientsResponse = await request.get("/api/patients?summary=1", {
    headers: { "x-medical-token": token },
  });
  expect(patientsResponse.ok()).toBeTruthy();
  const { patients } = await patientsResponse.json();
  expect(patients).toHaveLength(3);

  const patient = patients.find((item) => item.name === PATIENT_NAME);
  expect(patient, `${PATIENT_NAME} should be seeded`).toBeTruthy();
  patientId = patient.id;
});

test("新建任务首页", async ({ page }) => {
  await open(page, "/?view=home");
  await expect(
    page.getByRole("heading", { name: "新任务", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("个人工作空间", { exact: true })).toBeVisible();
  // The cockpit starts with em dashes and fills in after its two API calls.
  await expect(page.locator(".home-activity b").nth(0)).not.toHaveText("—");
  await expect(page.locator(".home-activity b").nth(1)).not.toHaveText("—");

  // The header date is the only wall-clock text on this page.
  await capture(page, "01-home.png", {
    scroll: ".workbench-hub",
    mask: [page.locator(".hub-page-actions > span")],
  });
});

test("患者列表", async ({ page }) => {
  await open(page, "/?view=patients");
  await expect(
    page.getByRole("heading", { name: "患者", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/^3 位在管/)).toBeVisible();
  await expect(page.locator(".patient-card")).toHaveCount(3);
  await expect(page.getByText(PATIENT_NAME, { exact: true })).toBeVisible();

  await capture(page, "02-patients.png", {
    scroll: ".patients-view",
  });
});

test("示例·张沪生 概览", async ({ page }) => {
  await open(page, `/?view=patients&patient=${encodeURIComponent(patientId)}`);
  await expect(
    page.getByRole("heading", { name: "患者概览", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".detail-head b").first()).toContainText(
    PATIENT_NAME,
  );
  await expect(page.getByRole("region", { name: "诊断摘要" })).toBeVisible();
  await expect(page.getByRole("region", { name: "临床要点" })).toBeVisible();
  await expect(page.locator(".patient-attention")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  // Only the hh:mm inside "更新于 hh:mm" is wall-clock dependent; the refresh
  // button and the list of tasks below it must stay part of the comparison.
  await capture(page, "03-patient-overview.png", {
    scroll: ".patients-view",
    mask: [page.locator(".attention-refresh time")],
  });
});

test("示例·张沪生 诊疗辅助 tab", async ({ page }) => {
  await open(
    page,
    `/?view=patients&patient=${encodeURIComponent(patientId)}&tab=assistance`,
  );
  await expect(
    page.getByRole("heading", { name: "本次想了解什么？", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("本次诊疗问题")).toBeVisible();

  await capture(page, "04-patient-assistance.png", {
    scroll: ".patients-view",
  });
});

test("今日待办", async ({ page }) => {
  await open(page, "/?view=agenda");
  await expect(page.locator(".agenda-heading h1")).toContainText("今日待办");
  await expect(page.locator(".agenda-items .agenda-item").first()).toBeVisible();

  await capture(page, "05-agenda.png", {
    scroll: ".work-directory.agenda-page",
  });
});

test("复诊名单", async ({ page }) => {
  await open(page, "/?view=schedule");
  await expect(page.getByRole("heading", { name: "复诊名单", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^待复诊/ })).toBeVisible();
  await capture(page, "05b-revisit-upcoming.png", { scroll: ".work-directory.schedule-page" });

  await page.getByRole("button", { name: "到诊记录" }).click();
  await expect(page.getByRole("heading", { name: /^到诊 \d+ 人次/ })).toBeVisible();
  await capture(page, "05c-revisit-records.png", { scroll: ".work-directory.schedule-page" });
});

test("知识库", async ({ page }) => {
  await open(page, "/?view=knowledge");
  await expect(
    page.getByRole("heading", { name: "知识库", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("示例体验资料库", { exact: true })).toBeVisible();

  await capture(page, "06-knowledge.png", {
    scroll: ".module-view.library-hub",
  });
});

test("示例体验", async ({ page }) => {
  await open(page, "/?view=examples");
  await expect(
    page.getByRole("heading", { name: "示例体验", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("示例资料已就位，可以随时接着体验", { exact: true }),
  ).toBeVisible();

  await capture(page, "07-examples.png", {
    scroll: ".demo-experience.work-directory",
  });
});

test("设置", async ({ page }) => {
  await open(page, "/?view=settings");
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "模型与运行", exact: true }),
  ).toBeVisible();

  await capture(page, "08-settings.png", {
    scroll: ".app-settings-page",
  });
});
