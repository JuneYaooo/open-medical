import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { fixture } from "./helpers.mjs";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const skip = !existsSync(chrome) || !existsSync("dist/index.html");
async function browserFixture(t) {
  const f = await fixture(t, { followupOptions: { autoStart: false } });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  mkdirSync("output/doctor-workbench-8h-20260922/screenshots", { recursive: true });
  return { ...f, page };
}

test("doctor experience: results receipt, review, communication and follow-up form one visible chain", { skip }, async (t) => {
  const f = await browserFixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "何跟进", patientNumber: "DEMO-TRACK" })).data;
  await f.json(`/api/patients/${patient.id}/care-tasks`, "POST", { title: "复查报告返回后核对", kind: "test", dueAt: new Date(Date.now() - 10000).toISOString() });
  await f.page.goto(f.origin);
  await f.page.getByRole("button", { name: "今日待办", exact: true }).click();
  await f.page.locator(".agenda-item", { hasText: "复查报告返回后核对" }).click();
  await f.page.getByRole("button", { name: "登记已收到结果", exact: true }).click();
  await f.page.getByLabel("结果来源", { exact: true }).fill("合成患者上传的复查报告");
  await f.page.getByLabel("处理记录", { exact: true }).fill("已收到完整报告");
  await f.page.getByRole("dialog").getByRole("button", { name: "登记已收到结果", exact: true }).click();
  await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  await f.page.getByRole("button", { name: "保存医生核对", exact: true }).click();
  await f.page.getByLabel("处理记录", { exact: true }).fill("已核对报告原文，按既有计划复诊");
  await f.page.getByRole("dialog").getByRole("button", { name: "保存医生核对", exact: true }).click();
  await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  await f.page.screenshot({ path: "output/doctor-workbench-8h-20260922/screenshots/results-tracking.png", fullPage: false });
  await f.page.getByRole("button", { name: "登记告知并结束", exact: true }).click();
  await f.page.getByLabel("处理记录", { exact: true }).fill("电话告知复诊安排，患者已知晓");
  const due = new Date(Date.now() + 86400000); due.setMinutes(due.getMinutes() - due.getTimezoneOffset());
  await f.page.getByLabel("下次随访时间（可选）", { exact: true }).fill(due.toISOString().slice(0, 16));
  await f.page.getByRole("dialog").getByRole("button", { name: "登记告知并结束", exact: true }).click();
  await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  await f.page.getByText("暂时没有待跟进事项。", { exact: false }).waitFor();
  await f.page.getByRole("button", { name: "已结束", exact: true }).click();
  await f.page.locator(".care-tracking-card", { hasText: "已安排下次随访" }).waitFor();
  assert.equal((await f.json("/api/doctor/overview?kind=tracking")).data.total, 0);
  assert.equal((await f.json(`/api/patients/${patient.id}/followups`)).data.jobs.length, 1);
});

test("doctor experience: patient list paginates and search resets to matching page", { skip }, async (t) => {
  const f = await browserFixture(t);
  for (let i = 0; i < 30; i++) await f.json("/api/patients", "POST", { name: `容量患者${i}`, patientNumber: `CAPACITY-${String(i).padStart(2, "0")}` });
  await f.page.goto(f.origin);
  await f.page.getByRole("button", { name: "管理", exact: true }).click();
  await f.page.locator(".patient-card").first().waitFor();
  assert.equal(await f.page.locator(".patient-card").count(), 24);
  await f.page.getByLabel("患者分页").getByRole("button", { name: "下一页" }).click();
  assert.equal(await f.page.locator(".patient-card").count(), 6);
  await f.page.getByLabel("搜索患者", { exact: true }).fill("CAPACITY-29");
  assert.equal(await f.page.locator(".patient-card").count(), 1);
  await f.page.locator(".patient-card").click();
  await f.page.locator(".detail-head", { hasText: "CAPACITY-29" }).waitFor();
});

test("doctor experience: paste a patient table, distinguish duplicates, import and open the new chart", { skip }, async (t) => {
  const f = await browserFixture(t);
  await f.json("/api/patients", "POST", { name: "合成同名", patientNumber: "IMPORT-OLD" });
  await f.page.goto(f.origin);
  await f.page.getByRole("button", { name: "管理", exact: true }).click();
  await f.page.getByRole("button", { name: "导入已有患者", exact: true }).click();
  await f.page.getByLabel("患者表格文本", { exact: true }).fill("姓名,患者编号,出生年份\n合成同名,IMPORT-OLD,1960\n合成新患者,IMPORT-NEW,1980\n合成同名,IMPORT-OTHER,1990");
  await f.page.getByRole("button", { name: "预览并检查", exact: true }).click();
  await f.page.getByText("1 条同名待核对", { exact: true }).waitFor();
  assert.equal((await f.json("/api/patients")).data.patients.length, 1);
  await f.page.getByLabel("选择第 4 行，已核对是另一位同名患者", { exact: true }).check();
  await f.page.screenshot({ path: "output/doctor-workbench-8h-20260922/screenshots/patient-import.png", fullPage: false });
  await f.page.getByRole("button", { name: "新建 2 位患者", exact: true }).click();
  await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  await f.page.locator(".patient-card", { hasText: "IMPORT-NEW" }).click();
  await f.page.locator(".detail-head", { hasText: "IMPORT-NEW" }).waitFor();
  assert.equal((await f.json("/api/patients")).data.patients.length, 3);
});

test("doctor experience: patient chart is not a project and record replacement shows a before/after review", { skip }, async (t) => {
  const f = await browserFixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "合成变更复核", medications: [{ name: "合成药物", status: "active" }], labs: [{ item: "合成既往检验", value: 1, unit: "TEST", date: "2026-09-01" }] })).data;
  f.server.runtime.toolPlugins.get("patient_record_propose").execute({ patientId: p.id, summary: "核对停用记录", updateMode: "replace", medications: [{ name: "合成药物", status: "stopped", source: "合成门诊记录 L2" }] });
  await f.page.goto(f.origin);
  await f.page.locator('nav[aria-label="患者"] .session', { hasText: p.name }).click();
  assert.equal(await f.page.locator('nav[aria-label="项目"] .session', { hasText: p.name }).count(), 0);
  await f.page.getByRole("button", { name: "核对变更", exact: true }).click();
  const comparison = f.page.locator(".proposal-comparison");
  assert.match(await comparison.innerText(), /正在使用/); assert.match(await comparison.innerText(), /已停用/);
  assert.match(await comparison.innerText(), /将移除/); assert.match(await comparison.innerText(), /新增/);
  await f.page.screenshot({ path: "output/doctor-workbench-8h-20260922/screenshots/clinical-proposal-review.png", fullPage: false });
  await f.page.getByRole("button", { name: "确认这些变更并写入", exact: true }).click();
  await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  const saved = (await f.json(`/api/patients/${p.id}`)).data;
  assert.equal(saved.medications[0].status, "stopped"); assert.equal(saved.labs.length, 1);
});

test("doctor experience: archived patient can be found and restored without losing its chart", { skip }, async (t) => {
  const f = await browserFixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "合成归档患者", patientNumber: "ARCHIVE-1", diagnoses: [{ name: "合成既往记录" }] })).data;
  await f.page.goto(f.origin);
  await f.page.locator('nav[aria-label="患者"] .session', { hasText: p.name }).click();
  await f.page.getByRole("button", { name: "归档患者", exact: true }).click();
  await f.page.getByLabel("患者档案状态", { exact: true }).selectOption("archived");
  await f.page.locator(".patient-card", { hasText: "ARCHIVE-1" }).click();
  await f.page.getByRole("button", { name: "恢复患者", exact: true }).click();
  await f.page.getByLabel("患者档案状态", { exact: true }).selectOption("active");
  await f.page.locator(".patient-card", { hasText: "ARCHIVE-1" }).waitFor();
  assert.equal((await f.json(`/api/patients/${p.id}`)).data.diagnoses[0].name, "合成既往记录");
});

test("doctor experience: today's agenda opens the correct patient and tracks completed follow-up", { skip }, async (t) => {
  const f = await browserFixture(t);
  const patient = (await f.json("/api/patients", "POST", { name: "赵随访", patientNumber: "DEMO-031", birthYear: 1962 })).data;
  const job = f.server.followups.create(patient.id, { name: "复诊资料核对", once: true, checklist: ["核对复诊资料"], firstDueAt: new Date(Date.now() + 60000).toISOString() });
  f.server.followups.createReminder(patient, job, "计划提醒");
  const risk = (await f.json("/api/patients", "POST", { name: "钱复核", patientNumber: "DEMO-032", labs: [{ item: "血钾", value: 2.5, unit: "mmol/L", date: "2026-09-21" }] })).data;
  f.server.patients.ingest([{ direction: "in", text: "合成复诊反馈" }], { patientId: risk.id });
  await f.page.goto(f.origin);
  await f.page.getByRole("button", { name: "今日待办", exact: true }).click();
  await f.page.locator(".agenda-item").first().waitFor();
  assert.match(await f.page.locator(".agenda-item").first().innerText(), /钱复核/);
  await f.page.screenshot({ path: "output/doctor-workbench-8h-20260922/screenshots/today-agenda.png", fullPage: false });
  await f.page.getByRole("button", { name: /^随访1$/ }).click();
  await f.page.getByLabel("搜索今日待办").fill("DEMO-031");
  await f.page.locator(".agenda-item", { hasText: "赵随访" }).click();
  await f.page.locator(".detail-head", { hasText: "DEMO-031" }).waitFor();
  await f.page.getByRole("button", { name: "登记结果", exact: true }).click();
  await f.page.getByLabel("随访记录", { exact: true }).fill("合成患者已提供复查材料，待医生复核。");
  await f.page.getByRole("button", { name: "保存随访结果", exact: true }).click();
  await f.page.getByRole("status").filter({ hasText: "随访结果已保存" }).waitFor();
  assert.equal((await f.json("/api/doctor/overview?kind=followup")).data.total, 0);
});

test("doctor experience: same-name registration offers existing chart or explicit distinct patient", { skip }, async (t) => {
  const f = await browserFixture(t);
  await f.json("/api/patients", "POST", { name: "周同名", patientNumber: "DEMO-A", birthYear: 1960 });
  await f.page.goto(f.origin);
  await f.page.getByRole("button", { name: "建档", exact: true }).click();
  await f.page.locator(".modal-form input").first().fill("周同名");
  await f.page.locator(".identity-matches").waitFor();
  assert.equal(await f.page.getByRole("button", { name: "创建患者档案", exact: true }).isDisabled(), true);
  assert.match(await f.page.locator(".identity-matches").innerText(), /DEMO-A/);
  await f.page.getByLabel("已核对，这是另一位同名患者", { exact: true }).check();
  await f.page.getByLabel("患者编号（可选）", { exact: true }).fill("DEMO-B");
  await f.page.getByRole("button", { name: "创建患者档案", exact: true }).click();
  await f.page.locator(".detail-head", { hasText: "DEMO-B" }).waitFor();
  assert.equal((await f.json("/api/patients?q=周同名")).data.patients.length, 2);
});

test("doctor experience: previsit summary refreshes context into an unsent patient task and basic details are editable", { skip }, async (t) => {
  const f = await browserFixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "陈接诊", patientNumber: "DEMO-BRIEF", medications: [{ name: "合成用药记录", status: "unknown" }], diagnoses: [{ name: "既往合成诊断", date: "2026-08-01", source: "合成病历第 2 页" }], labs: [{ item: "合成指标", value: 4, unit: "U", date: "2026-08-01" }, { item: "合成指标", value: 6, unit: "U", date: "2026-09-21" }] })).data;
  await f.page.goto(f.origin);
  await f.page.getByRole("navigation", { name: "患者", exact: true }).getByRole("button", { name: /陈接诊/ }).click();
  await f.page.getByRole("region", { name: "诊前速览" }).waitFor();
  await f.page.getByText("过敏史尚未核对", { exact: true }).first().waitFor();
  await f.page.getByRole("button", { name: "出生年份未记录" }).click();
  await f.page.getByLabel("出生年份", { exact: true }).fill("1970");
  await f.page.getByRole("button", { name: "保存基本信息", exact: true }).click();
  await f.page.locator(".detail-head", { hasText: "1970 年生" }).waitFor();
  await f.page.locator(".brief-lab-grid", { hasText: "+2 U" }).waitFor();
  await f.page.screenshot({ path: "output/doctor-workbench-8h-20260922/screenshots/previsit-brief.png", fullPage: false });
  f.server.patients.ingest([{ direction: "in", text: "准备任务前刚收到的合成反馈" }], { patientId: p.id });
  await f.page.getByRole("button", { name: "准备本次接诊", exact: true }).click();
  const composer = f.page.locator("textarea:visible").first();
  await composer.waitFor();
  const value = await composer.inputValue();
  assert.match(value, /准备任务前刚收到的合成反馈/);
  assert.match(value, /合成病历第 2 页/);
  assert.match(value, /unknown/);
  const session = (await f.json(`/api/sessions/${p.sessionId}`)).data;
  assert.equal(session.runs.length, 0, "preparing a chart does not send its contents to a model");
});

test("doctor experience: knowledge source review and retirement remain visible in filtered search", { skip }, async (t) => {
  const f = await browserFixture(t);
  await f.json("/api/knowledge", "POST", { title: "门诊随访合成资料", collection: "门诊资料", text: "合成随访资料，需要核对患者反馈、来源日期和后续计划。".repeat(8) });
  await f.page.goto(f.origin);
  await f.page.getByRole("button", { name: "打开", exact: true }).click();
  await f.page.getByRole("button", { name: "知识库 指南导入与检索", exact: true }).click();
  await f.page.getByRole("button", { name: "整页打开 knowledge", exact: true }).click();
  await f.page.getByRole("button", { name: /门诊随访合成资料/ }).click();
  await f.page.getByRole("button", { name: "管理来源与版本", exact: true }).click();
  await f.page.getByLabel("来源链接", { exact: true }).fill("https://example.org/synthetic-followup");
  await f.page.getByLabel("版本说明", { exact: true }).fill("2026 合成版本");
  await f.page.getByLabel("来源状态", { exact: true }).selectOption("reviewed");
  await f.page.getByLabel("核对记录或停用原因", { exact: true }).fill("合成测试：已核对文件与发布页一致");
  await f.page.getByRole("button", { name: "保存来源信息", exact: true }).click();
  await f.page.locator(".knowledge-state", { hasText: "来源已核对" }).waitFor();
  assert.equal(await f.page.getByRole("link", { name: "打开来源发布页" }).getAttribute("href"), "https://example.org/synthetic-followup");
  await f.page.screenshot({ path: "output/doctor-workbench-8h-20260922/screenshots/knowledge-source.png", fullPage: false });
  await f.page.getByRole("button", { name: "管理来源与版本", exact: true }).click();
  await f.page.getByLabel("来源状态", { exact: true }).selectOption("retired");
  await f.page.getByLabel("核对记录或停用原因", { exact: true }).fill("合成测试：已有更新版本");
  await f.page.getByRole("button", { name: "保存来源信息", exact: true }).click();
  await f.page.locator(".knowledge-state", { hasText: "已停用" }).waitFor();
  await f.page.getByRole("button", { name: "返回列表", exact: true }).click();
  assert.equal(await f.page.locator(".guideline-doc").count(), 0);
  await f.page.getByLabel("来源状态", { exact: true }).selectOption("retired");
  await f.page.locator(".guideline-doc").waitFor();
  await f.page.locator(".literature-query").fill("随访");
  await f.page.getByRole("button", { name: "检索", exact: true }).click();
  await f.page.locator(".knowledge-hit-meta", { hasText: "已停用" }).waitFor();
});

test("doctor experience: record an unscheduled contact, append a correction and carry both into a task", { skip }, async (t) => {
  const f = await browserFixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "主动联系患者" })).data;
  await f.page.goto(f.origin);
  await f.page.getByRole("navigation", { name: "患者", exact: true }).getByRole("button", { name: /主动联系患者/ }).click();
  await f.page.getByRole("button", { name: "随访计划", exact: true }).click();
  await f.page.getByRole("button", { name: "记录一次联系", exact: true }).click();
  await f.page.getByLabel("联系主题", { exact: true }).fill("核对合成复诊材料");
  await f.page.getByLabel("随访记录", { exact: true }).fill("原始联系记录：患者说明资料尚未取回");
  await f.page.getByRole("button", { name: "保存随访结果", exact: true }).click();
  await f.page.getByRole("status").filter({ hasText: "随访结果已保存" }).waitFor();
  await f.page.getByRole("button", { name: /^随访记录 1$/ }).click();
  await f.page.getByRole("button", { name: "补充或更正", exact: true }).click();
  await f.page.getByLabel("补充或更正内容", { exact: true }).fill("补充：次日已收到复诊材料，等待医生核对");
  await f.page.getByRole("button", { name: "保存补充记录", exact: true }).click();
  await f.page.locator(".followup-addendum", { hasText: "次日已收到" }).waitFor();
  await f.page.getByRole("button", { name: "基于记录继续任务", exact: true }).click();
  await f.page.locator(".composer textarea").waitFor();
  await f.page.waitForFunction(() => document.querySelector(".composer textarea")?.value.includes("原始联系记录"));
  const draft = await f.page.locator(".composer textarea").inputValue();
  assert.match(draft, /原始联系记录/);
  assert.match(draft, /次日已收到/);
  assert.equal((await f.json(`/api/reminders?patientId=${p.id}&status=done`)).data.total, 1);
});

test("doctor experience: narrow screens keep context and settings reachable with keyboard dismissal", { skip }, async (t) => {
  const f = await browserFixture(t);
  const p = (await f.json("/api/patients", "POST", { name: "合成窄屏患者长姓名", patientNumber: "MOBILE-DEMO" })).data;
  await f.page.goto(f.origin);
  for (const width of [320, 390, 700]) {
    await f.page.setViewportSize({ width, height: 844 });
    await f.page.locator(".patient-pill").click();
    await f.page.getByLabel("搜索并切换患者", { exact: true }).fill(p.patientNumber);
    await f.page.locator(".ps-item", { hasText: p.name }).click();
    const bounds = await f.page.locator(".topbar button:visible").evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { label: button.textContent || button.title, left: box.left, right: box.right };
    }));
    assert.ok(bounds.every((box) => box.left >= 0 && box.right <= width), JSON.stringify({ width, bounds }));
    await f.page.locator(".patient-pill").click();
    const menu = await f.page.locator(".pt-switch-menu").boundingBox();
    assert.ok(menu.x >= 0 && menu.x + menu.width <= width);
    await f.page.keyboard.press("Escape");
    await f.page.locator(".pt-switch-menu").waitFor({ state: "hidden" });
    assert.equal(await f.page.locator(".patient-pill").evaluate((el) => el === document.activeElement), true);
    await f.page.getByRole("button", { name: "运行设置", exact: true }).click();
    await f.page.getByRole("dialog").waitFor();
    await f.page.keyboard.press("Escape");
    await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  }
  await f.page.setViewportSize({ width: 390, height: 844 });
  await f.page.screenshot({ path: "output/doctor-workbench-8h-20260922/screenshots/mobile-patient-fixed.png" });
});


test("new task stays focused and agenda round-trip preserves draft on desktop and narrow screens", {skip}, async(t)=>{
  const f=await browserFixture(t);await f.page.goto(f.origin);
  await f.page.getByRole("heading",{name:"这次需要做什么？"}).waitFor();
  assert.equal(await f.page.getByRole("region",{name:"今日待办",exact:true}).count(),0);
  assert.equal(await f.page.getByRole("heading",{name:"继续最近的工作"}).count(),0);
  const input=f.page.getByRole("textbox",{name:"医疗任务内容",exact:true});
  assert.ok((await input.boundingBox()).y<400);
  await input.fill("保留这份未发送的任务草稿");
  await f.page.getByRole("button",{name:"今日待办",exact:true}).click();
  await f.page.getByRole("region",{name:"今日待办",exact:true}).waitFor();
  await f.page.getByRole("button",{name:"返回新建任务",exact:true}).click();
  assert.equal(await input.inputValue(),"保留这份未发送的任务草稿");
  await f.page.getByRole("button",{name:"更多场景",exact:true}).click();
  await f.page.getByRole("button",{name:/出院小结草稿/}).click();
  assert.match(await input.inputValue(),/出院小结/);
  await f.page.getByRole("button",{name:"新建任务",exact:true}).click();
  assert.equal(await input.inputValue(),"");
  for(const width of [1200,390,320]){
    await f.page.setViewportSize({width,height:850});
    assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await f.page.screenshot({path:`output/doctor-workbench-8h-20260922/screenshots/new-task-${width}.png`});
  }
});
