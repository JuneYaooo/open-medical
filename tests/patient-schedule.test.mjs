import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { scheduleTools } from "../server/medical/schedule-tools.mjs";

const local = (offset = 0) => { const d = new Date(Date.now() + offset * 86400000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

test("return visits appear the day before, the day itself and after, until an outcome is recorded", async (t) => {
  const f = await fixture(t, { followupOptions: { autoStart: false } });
  const p = (await f.json("/api/patients", "POST", { name: "复诊患者" })).data;
  const url = `/api/patients/${p.id}/appointments`;
  assert.equal((await f.json(url, "POST", { date: local(-1) })).status, 400);
  assert.equal((await f.json(url, "POST", { date: local(1), time: "25:00" })).status, 400);
  const later = (await f.json(url, "POST", { date: local(5), reason: "术后复查" })).data;
  const tomorrow = (await f.json(url, "POST", { date: local(1), time: "09:30", reason: "调整降压药", place: "专家门诊" })).data;
  let visits = (await f.json("/api/doctor/overview?kind=visit")).data.items;
  assert.deepEqual(visits.map((i) => i.title), ["明天复诊"]);
  assert.match(visits[0].detail, /09:30.*调整降压药.*提醒患者/);
  assert.equal(visits[0].action.tab, "appointments");
  assert.equal((await f.json(`/api/appointments/${tomorrow.id}`, "PATCH", { status: "attended" })).status, 400, "cannot record an outcome before the date");

  // Moving the clock: the schedule's view of "today".
  f.server.schedule.now = () => Date.now() + 2 * 86400000;
  visits = (await f.json("/api/doctor/overview?kind=visit")).data.items;
  assert.deepEqual(visits.map((i) => i.title), ["复诊未登记到诊情况"]);
  assert.equal((await f.json(`/api/appointments/${tomorrow.id}`, "PATCH", { status: "missed", note: "电话未接通" })).data.status, "missed");
  assert.equal((await f.json("/api/doctor/overview?kind=visit")).data.total, 0);
  f.server.schedule.now = () => Date.now() + 5 * 86400000;
  assert.deepEqual((await f.json("/api/doctor/overview?kind=visit")).data.items.map((i) => i.title), ["今天复诊"]);
  const list = (await f.json(url)).data.appointments;
  assert.deepEqual(list.map((a) => [a.id, a.status]), [[tomorrow.id, "missed"], [later.id, "scheduled"]]);
  assert.equal(list[0].history[0].status, "scheduled");
});

test("labs present at creation are the baseline; only later additions are listed until marked read", async (t) => {
  const f = await fixture(t, { followupOptions: { autoStart: false } });
  const p = (await f.json("/api/patients", "POST", { name: "检验患者", labs: [{ item: "肌酐", value: 80, unit: "umol/L", date: "2026-09-01" }] })).data;
  assert.equal((await f.json("/api/doctor/overview?kind=tracking")).data.items.find((i) => i.id === `labs:${p.id}`), undefined, "建档时就有的检验是基线，不算新结果");
  assert.equal((await f.json(`/api/patients/${p.id}/labs/new`)).data.labs.length, 0);
  const current = (await f.json(`/api/patients/${p.id}`)).data;
  await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: current.revision, labs: [...current.labs, { item: "肌酐", value: 150, unit: "umol/L", date: "2026-09-28" }] });
  let item = (await f.json("/api/doctor/overview?kind=tracking")).data.items.find((i) => i.id === `labs:${p.id}`);
  assert.equal(item.title, "新检验结果 1 项"); assert.equal(item.action.tab, "labs");
  assert.match(item.detail, /肌酐 150umol\/L（2026-09-28）/);
  assert.equal((await f.json(`/api/patients/${p.id}/labs/reviewed`, "POST", {})).data.remaining, 0);
  assert.equal((await f.json("/api/doctor/overview?kind=tracking")).data.total, 0);
  const tools = Object.fromEntries(scheduleTools(() => f.server.schedule).map((x) => [x.definition.function.name, x.execute]));
  assert.equal(tools.patient_new_labs({ patientId: p.id }).labs.length, 0);
  await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: (await f.json(`/api/patients/${p.id}`)).data.revision, labs: [...(await f.json(`/api/patients/${p.id}`)).data.labs, { item: "肌酐", value: 190, unit: "umol/L", date: "2026-10-01" }] });
  assert.equal(tools.patient_new_labs({ patientId: p.id }).labs.length, 1);
  assert.equal(tools.patient_new_labs({ patientId: p.id, markReviewed: true }).remaining, 0);
  const booked = tools.appointment_create({ patientId: p.id, date: local(1), reason: "复查肌酐" });
  assert.equal(tools.appointment_list({ patientId: p.id }).appointments[0].id, booked.id);
});

test("browser: agenda opens the patient's appointments; new results can be marked read on the chart", async (t) => {
  const { existsSync } = await import("node:fs");
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome) || !existsSync("dist/index.html")) return t.skip("Chrome/build unavailable");
  const { chromium } = await import("playwright-core");
  const f = await fixture(t, { followupOptions: { autoStart: false } });
  const p = (await f.json("/api/patients", "POST", { name: "孙复诊", patientNumber: "V-001" })).data;
  const baseline = (await f.json(`/api/patients/${p.id}`)).data;
  await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: baseline.revision, labs: [{ item: "血红蛋白", value: 102, unit: "g/L", date: "2026-09-27" }] });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  page.setDefaultTimeout(12000);
  const shots = process.env.SCHEDULE_SHOTS || "";
  await page.goto(f.origin + "/?view=agenda");
  await page.locator(".agenda-item", { hasText: "新检验结果 1 项" }).click();
  const notice = page.getByRole("status", { name: "新检验结果" });
  await notice.getByText(/血红蛋白 102g\/L/).waitFor();
  await notice.getByRole("button", { name: "已查看，标记已阅" }).click();
  await notice.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "沟通与随访", exact: true }).click();
  await page.getByRole("button", { name: "复诊预约", exact: true }).click();
  const panel = page.getByRole("region", { name: "复诊预约" });
  await panel.getByRole("button", { name: "预约复诊" }).click();
  await panel.getByLabel("日期").fill(local(1));
  await panel.getByLabel("复诊事项").fill("复查血常规");
  await panel.getByRole("button", { name: "保存预约" }).click();
  await panel.getByText("复诊已预约。").waitFor();
  if (shots) await page.screenshot({ path: `${shots}-panel.png`, fullPage: true });
  await panel.getByRole("button", { name: "起草提醒消息" }).click();
  await panel.getByText(/已生成复诊提醒草稿/).waitFor();
  await page.getByRole("navigation", { name: "主要业务" }).getByRole("button", { name: "今日待办" }).click();
  const row = page.locator(".agenda-item", { hasText: "明天复诊" });
  await row.getByText(/复查血常规/).waitFor();
  assert.equal(await page.locator(".agenda-item", { hasText: "新检验结果" }).count(), 0);
  if (shots) await page.screenshot({ path: `${shots}-agenda.png`, fullPage: true });
  await row.click();
  await page.getByRole("region", { name: "复诊预约" }).getByText("复查血常规").waitFor();
  assert.deepEqual(errors, []);
  void p;
});
