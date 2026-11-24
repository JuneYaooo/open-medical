import { expect, test } from "@playwright/test";
import { capture, open, PATIENT_NAME } from "./helpers.mjs";

// The pre-visit questionnaire reaches patients over a channel, so this flow
// only exists in the connected run (MEDICAL_E2E_CONNECTED=1, channel-fake).
const CONNECTED = process.env.MEDICAL_E2E_CONNECTED === "1";

test("约复诊时勾选诊前问卷：排上提醒，接诊准备里显示问卷状态", async ({ page, request }) => {
  test.skip(!CONNECTED, "requires MEDICAL_E2E_CONNECTED=1");
  const { token } = await (await request.get("/api/bootstrap")).json();
  const { patients } = await (await request.get("/api/patients?summary=1", { headers: { "x-medical-token": token } })).json();
  const patient = patients.find((item) => item.name === PATIENT_NAME);

  await open(page, `/?view=patients&patient=${encodeURIComponent(patient.id)}&tab=appointments`);
  await page.getByRole("button", { name: "预约复诊" }).click();
  await page.getByRole("button", { name: "+2周" }).click();
  const previsit = page.getByRole("checkbox", { name: /复诊前 1 天发诊前问卷/ });
  await expect(previsit).toBeChecked();
  await capture(page, "06a-booking-previsit.png", { scroll: ".patients-view" });
  await page.getByRole("button", { name: "保存预约" }).click();
  await expect(page.getByRole("status").filter({ hasText: "复诊已预约" })).toContainText("复诊前一天会生成诊前问卷提醒");

  await open(page, `/?view=patients&patient=${encodeURIComponent(patient.id)}`);
  const prep = page.getByRole("region", { name: "接诊准备" });
  await expect(prep.locator(".visit-prep-survey")).toContainText("诊前问卷");
  await capture(page, "06b-visit-prep-previsit.png", { scroll: ".patients-view" });
});
