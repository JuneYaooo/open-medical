// 六大场景 + 框架验收的可复用剧本：web（Chromium）与桌面（Electron）端共用。
// 每个 fn({ page, seed, origin })：page 为已加载应用的窗口，seed 提供节点侧 API。
import assert from "node:assert/strict";

export const SCENARIOS = [
  {
    name: '重设计外壳：分组左栏替代平级页签，顶栏患者切换器就位',
    fn: async ({ page, seed: _seed, origin: _origin }) => {
  for (const label of ["项目", "最近任务", "患者", "工具箱"]) {
    assert.ok(
      await page
        .locator(".app-navigation .nav-label", { hasText: label })
        .first()
        .isVisible(),
      `左栏缺少「${label}」分组`,
    );
  }
  assert.equal(await page.locator(".scenario-tabs").count(), 0, "平级页签应已移除");
  assert.ok(await page.locator(".patient-pill").isVisible(), "顶栏患者切换器缺失");
  assert.match(await page.locator(".patient-pill").innerText(), /未选择患者/);
  await page.locator(".patient-pill").click();
  assert.ok(await page.locator(".pt-switch-menu").isVisible(), "切换器下拉未打开");
  await page.locator(".composer, body").click({ position: { x: 10, y: 10 } });
    },
  },
  {
    name: '患者建档 → 左栏/切换器联动，详情页风险与时间线可用',
    fn: async ({ page, seed, origin: _origin }) => {
  await page.locator('.nav-label button', { hasText: "管理" }).click();
  await page.locator('button:has-text("新建患者")').first().click();
  await page.locator(".modal-form input").first().fill("测试患者甲");
  await page.locator('.modal-form button:has-text("创建患者档案")').click();
  await page.waitForSelector(".detail-head");
  assert.match(await page.locator(".detail-head").innerText(), /测试患者甲/);
  await page.waitForTimeout(400);
  assert.ok(
    await page
      .locator(".app-navigation .session", { hasText: "测试患者甲" })
      .first()
      .isVisible(),
    "左栏患者列表未出现新患者",
  );
  assert.match(await page.locator(".patient-pill").innerText(), /测试患者甲/);
  assert.ok(await page.locator(".pt-sec", { hasText: "关键事件时间线" }).isVisible());
  // 写入检验 → 评估风险 → 概览出现风险卡
  const patient = (await seed.json("/api/patients")).data.patients[0];
  await seed.json(`/api/patients/${patient.id}`, "PATCH", {
    expectedRevision: patient.revision,
    labs: [{ item: "血钾", value: 2.5, unit: "mmol/L", date: "2026-09-10" }],
  });
  await seed.json("/api/risk-alerts/evaluate", "POST", {});
  await page.reload();
  await page.waitForSelector(".app-navigation");
  await page
    .locator('.app-navigation nav[aria-label="患者"] .session', {
      hasText: "测试患者甲",
    })
    .first()
    .click();
  await page.waitForSelector(".detail-head");
  await page.waitForSelector(".risk-card", { timeout: 8000 });
  assert.match(await page.locator(".risk-card").first().innerText(), /血钾/);
    },
  },
  {
    name: '会话：UI 上传材料 → 本地整理 → 产物卡 → 验收视图 → 轻量复核通过',
    fn: async ({ page, seed: _seed, origin: _origin }) => {
  // 先用界面建档
  await page.locator('.nav-label button', { hasText: "管理" }).click();
  await page.locator('button:has-text("新建患者")').first().click();
  await page.locator(".modal-form input").first().fill("验收流程患者");
  await page.locator('.modal-form button:has-text("创建患者档案")').click();
  await page.waitForSelector(".detail-head");
  // 打开病例工作区
  await page.locator('button:has-text("打开病例工作区")').click();
  await page.waitForSelector(".composer");
  // UI 上传材料
  await page.locator('.composer input[type="file"]').setInputFiles({
    name: "出院记录.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      [
        "2026-08-12 患者因突发胸痛入院，急诊 PCI 治疗。",
        "2026-08-14 血肌酐 88 μmol/L，血钾 4.2 mmol/L。",
        "2026-08-20 出院，带药：阿司匹林 100mg qd、阿托伐他汀 20mg qn。",
      ].join("\n"),
      "utf8",
    ),
  });
  await page.waitForSelector(".file-card", { timeout: 10000 });
  // 本地整理（未配置模型 → 默认本地档位）
  await page.locator(".composer textarea").fill(
    "请整理本患者的病例材料：生成病历时间线、检验数值摘录和用药资料核对，保留来源与行号。",
  );
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".artifact-inline", { timeout: 30000 });
  assert.match(await page.locator(".artifact-inline").first().innerText(), /v1/);
  // 验收视图
  await page.locator('button:has-text("打开验收视图")').first().click();
  await page.waitForSelector(".acceptance");
  assert.ok(await page.locator(".accept-bar .seg").isVisible());
  await page.locator('.seg button:has-text("预览")').click();
  assert.ok(await page.locator(".acc-doc").isVisible());
  await page.locator('.seg button:has-text("出处对照")').click();
  // 轻量复核
  await page.locator('.review-acts button:has-text("确认通过")').click();
  await page
    .locator(".review-form input")
    .nth(0)
    .fill("医生 A");
  await page.locator(".review-form input").nth(1).fill("已核对原文与来源");
  await page.locator(".review-form .attest input").check();
  await page.locator('.review-form button:has-text("确认通过")').click();
  await page.waitForSelector(".accept-bar .acc-badge.approved", { timeout: 8000 });
    },
  },
  {
    name: '医生记忆：面板可打开、可新增、列表可见',
    fn: async ({ page, seed: _seed, origin: _origin }) => {
  await page.locator('.workspace-account:has-text("医生记忆")').click();
  await page.waitForSelector(".modal");
  await page
    .locator('.modal .doctor-add input')
    .fill("出院小结按科室模板第三节格式");
  await page.locator('.modal .doctor-add button:has-text("添加")').click();
  await page.waitForSelector(
    '.modal .memory:has-text("出院小结按科室模板第三节格式")',
    { timeout: 5000 },
  );
    },
  },
  {
    name: '风险 → 一键生成处理建议草稿，跳转会话并预填',
    fn: async ({ page, seed, origin: _origin }) => {
  await page.locator('.nav-label button', { hasText: "管理" }).click();
  await page.locator('button:has-text("新建患者")').first().click();
  await page.locator(".modal-form input").first().fill("风险流转患者");
  await page.locator('.modal-form button:has-text("创建患者档案")').click();
  await page.waitForSelector(".detail-head");
  const patient = (await seed.json("/api/patients")).data.patients[0];
  await seed.json(`/api/patients/${patient.id}`, "PATCH", {
    expectedRevision: patient.revision,
    labs: [{ item: "血钾", value: 6.5, unit: "mmol/L", date: "2026-09-11" }],
  });
  await seed.json("/api/risk-alerts/evaluate", "POST", {});
  await page.reload();
  await page.waitForSelector(".app-navigation");
  await page
    .locator('.app-navigation nav[aria-label="患者"] .session', {
      hasText: "风险流转患者",
    })
    .click();
  await page.waitForSelector(".risk-card");
  await page.locator('button:has-text("生成处理建议草稿")').first().click();
  await page.waitForSelector(".composer");
  await page.waitForFunction(
    () => (document.querySelector(".composer textarea")?.value || "").includes("血钾"),
    { timeout: 8000 },
  );
  const draft = await page.locator(".composer textarea").inputValue();
  assert.match(draft, /待医生复核/);
    },
  },
  {
    name: '验收退回 → 自动生成修订指令 → 修订版再复核通过',
    fn: async ({ page, seed, origin }) => {
  const patient = await seed.json("/api/patients", "POST", {
    name: "退回流转患者",
  });
  const work = await seed.json(`/api/sessions/${patient.data.sessionId}`);
  await seed.request(`/api/sessions/${patient.data.sessionId}/files`, "POST", {
    name: "出院记录.txt",
    text: [
      "2026-08-12 患者因胸痛入院，行 PCI 治疗。",
      "2026-08-20 出院，带药：阿司匹林 100mg qd。",
    ].join("\n"),
  });
  void work;
  await page.goto(origin);
  await page.waitForSelector(".app-navigation");
  await page
    .locator('.app-navigation nav[aria-label="患者"] .session', {
      hasText: "退回流转患者",
    })
    .click();
  await page.waitForSelector(".detail-head");
  await page.locator('button:has-text("打开病例工作区")').click();
  await page.waitForSelector(".composer");
  await page.locator(".composer textarea").fill(
    "请整理本患者的病例材料，生成病历时间线，保留来源与行号。",
  );
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".artifact-inline", { timeout: 30000 });
  await page.locator('button:has-text("打开验收视图")').first().click();
  await page.waitForSelector(".acceptance");
  // 退回
  await page.locator('.review-acts button:has-text("退回修订")').click();
  await page.locator('.review-form input[name="reviewer"]').fill("医生 A");
  await page.locator(".review-form input").nth(1).fill("需补充出院诊断依据");
  await page.locator(".review-form .attest input").check();
  await page.locator('.review-form button:has-text("退回并生成修订指令")').click();
  // 退回后自动发起修订 → 新的草稿产物出现（服务端语义：修订=新草稿，旧产物保持已退回）
  await page.waitForFunction(
    () => document.querySelectorAll(".artifact-inline").length >= 2,
    { timeout: 30000 },
  );
  assert.match(
    await page.locator(".artifact-inline").first().innerText(),
    /待复核/,
    "最新产物应为待复核草稿",
  );
  // 旧产物应显示已退回
  assert.match(
    await page.locator(".artifact-inline").nth(1).innerText(),
    /需修订/,
  );
  // 打开最新草稿的验收
  await page.locator('.artifact-inline button:has-text("打开验收视图")').first().click();
  await page.waitForSelector(".acceptance");
  // 通过
  await page.locator('.review-acts button:has-text("确认通过")').click();
  await page.locator(".review-form input").nth(0).fill("医生 A");
  await page.locator(".review-form input").nth(1).fill("修订已核对");
  await page.locator(".review-form .attest input").check();
  await page.locator('.review-form button:has-text("确认通过")').click();
  await page.waitForSelector(".accept-bar .acc-badge.approved", { timeout: 8000 });
    },
  },
  {
    name: '项目：左栏「＋ 新建」打开项目创建入口',
    fn: async ({ page, seed: _seed, origin: _origin }) => {
  await page.locator('.nav-label button', { hasText: "＋ 新建" }).click();
  // 融合后：同一医疗外壳内弹出「连接项目工作区」modal，不再有独立工作区布局
  await page.waitForSelector(".modal-backdrop", { timeout: 10000 });
  assert.match(
    await page.locator(".modal-backdrop").innerText(),
    /连接项目工作区/,
  );
  await page.locator('.modal-backdrop button[title="关闭"]').click();
  await page.waitForSelector(".workspace-shell", { timeout: 10000 });
    },
  },
  {
    name: '知识 tab：会话内检索 → 引用进对话带到输入框',
    fn: async ({ page, seed, origin }) => {
  // 直接通过 API 导入一篇知识文档
  await seed.json("/api/knowledge", "POST", {
    title: "2024 STEMI 诊疗指南（测试）",
    kind: "指南",
    text: "PCI 术后双联抗血小板治疗（DAPT）应维持 12 个月。阿司匹林联合 P2Y12 受体抑制剂是标准方案。高危出血患者可在 3 至 6 个月后评估缩短方案。所有调整需结合患者缺血与出血风险个体化判断，并由主治医生复核确认。",
    fileName: "stemiv.txt",
  });
  const p = await seed.json("/api/patients", "POST", { name: "知识引用患者" });
  void p;
  await page.goto(origin);
  await page.waitForSelector(".app-navigation");
  // 首页一次发送独立任务（本地档位快速完成）
  await page.locator(".app-navigation .new-session").click();
  await page.locator(".hub-composer textarea, textarea").first().fill("患者 PCI 术后用药方案怎么定？");
  await page.locator(".hub-composer-controls .send-button").click();
  await page.waitForSelector(".composer");
  await page.locator(".send-button.stop").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
  // 打开知识 tab 并检索
  await page.locator('.panel-tabs button:has-text("知识")').click();
  await page.locator('.panel-knowledge input').fill("双联抗血小板");
  await page.locator('.panel-knowledge button[aria-label="检索知识库"]').click();
  await page.waitForSelector(".kb-hit", { timeout: 8000 });
  assert.match(await page.locator(".kb-hit").first().innerText(), /STEMI/);
  await page.locator('.kb-hit button:has-text("引用进对话")').first().click();
  const draft = await page.locator(".composer textarea").inputValue();
  assert.match(draft, /【参考：2024 STEMI 诊疗指南（测试）/);
  assert.match(draft, /L\d+–L\d+|L\d+/);
    },
  },
  {
    name: '@患者：无患者会话中 @ 唤出引用菜单，选中后出速览卡与 chip',
    fn: async ({ page, seed, origin }) => {
  await seed.json("/api/patients", "POST", { name: "引用目标患者", tags: ["糖尿病"] });
  await page.goto(origin);
  await page.waitForSelector(".app-navigation");
  await page.locator(".app-navigation .new-session").click();
  await page.locator(".hub-composer textarea, textarea").first().fill("整理一下");
  await page.locator(".hub-composer-controls .send-button").click();
  await page.waitForSelector(".composer");
  await page.locator(".send-button.stop").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
  // 当前会话未绑定患者：@ 应出现“引用患者”分组
  await page.locator(".composer textarea").fill("");
  await page.locator(".composer textarea").pressSequentially("@引");
  await page.waitForSelector(".mention-menu .patient-mention", { timeout: 5000 });
  await page.locator('.mention-menu .patient-mention', { hasText: "引用目标患者" }).click();
  await page.waitForSelector(".ref-patient-cards .patient-summary");
  assert.match(await page.locator(".skill-chip.patient").innerText(), /引用目标患者/);
    },
  },
  {
    name: 'Goal 卡：文书模式执行时出现，完成后保留完成态',
    fn: async ({ page, seed, origin }) => {
  const p = await seed.json("/api/patients", "POST", { name: "目标卡患者" });
  await seed.request(`/api/sessions/${p.data.sessionId}/files`, "POST", {
    name: "出院记录.txt",
    text: "2026-08-12 入院行 PCI。\n2026-08-14 血钾 4.2 mmol/L。\n2026-08-20 出院带药阿司匹林。",
  });
  await page.goto(origin);
  await page.waitForSelector(".app-navigation");
  await page
    .locator('.app-navigation nav[aria-label="患者"] .session', { hasText: "目标卡患者" })
    .click();
  await page.waitForSelector(".detail-head");
  await page.locator('button:has-text("打开病例工作区")').click();
  await page.waitForSelector(".composer");
  // 未配置模型 → 直接用本地档位发起文书整理
  await page.locator(".composer textarea").fill(
    "请整理本患者的病例材料：生成病历时间线、检验数值摘录和用药资料核对，保留来源与行号。",
  );
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".artifact-inline", { timeout: 30000 });
  // 完成态 Goal 卡保留，行项打勾
  await page.waitForSelector(".goal-card.done", { timeout: 8000 });
  const goal = await page.locator(".goal-card").innerText();
  assert.match(goal, /时间线/);
  assert.match(goal, /已完成/);
    },
  },
  {
    name: '记忆标注：有已确认记忆时回答带「已结合 N 条医生记忆」并可展开',
    fn: async ({ page, seed, origin }) => {
  await seed.json("/api/doctor/memories", "POST", {
    content: "出院小结按科室模板第三节格式",
  });
  const p = await seed.json("/api/patients", "POST", { name: "记忆标注患者" });
  await seed.request(`/api/sessions/${p.data.sessionId}/files`, "POST", {
    name: "出院记录.txt",
    text: "2026-08-12 入院行 PCI。\n2026-08-20 出院。",
  });
  await page.goto(origin);
  await page.waitForSelector(".app-navigation");
  await page
    .locator('.app-navigation nav[aria-label="患者"] .session', { hasText: "记忆标注患者" })
    .click();
  await page.waitForSelector(".detail-head");
  await page.locator('button:has-text("打开病例工作区")').click();
  await page.waitForSelector(".composer");
  await page.locator(".composer textarea").fill("请整理本患者的病例材料，生成病历时间线。");
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".artifact-inline", { timeout: 30000 });
  const note = page.locator(".memory-note").first();
  await note.waitFor({ timeout: 8000 });
  assert.match(await note.innerText(), /已结合 1 条医生记忆/);
  await note.locator("button").click();
  await page.waitForSelector('.memory-note li:has-text("出院小结按科室模板第三节格式")');
    },
  },
  {
    name: '工具箱滑出面板：打开 → 进入临床速查 → 整页打开',
    fn: async ({ page }) => {
      await page.locator('.nav-label button:has-text("打开")').click();
      await page.waitForSelector(".tool-slide");
      await page.locator('.ts-menu button:has-text("临床速查")').click();
      await page.waitForSelector('.tool-slide button:has-text("量表计算")');
      await page.locator('.tool-slide button:has-text("整页打开")').click();
      // 整页打开后面板关闭，切换到临床速查整页视图
      await page.waitForSelector('.tool-slide', { state: "detached" });
      await page.waitForSelector('h3:has-text("量表与计算器")', { timeout: 8000 });
    },
  },

/* ================= 场景补全：功能页与闭环链路 ================= */

{
  name: "患者列表：搜索与分组筛选联动",
  fn: async ({ page, seed }) => {
    await seed.json("/api/patients", "POST", { name: "筛选患者甲", groups: ["高血压组"] });
    await seed.json("/api/patients", "POST", { name: "筛选患者乙", groups: ["糖尿病组"] });
    await page.locator('.nav-label button', { hasText: "管理" }).click();
    await page.waitForSelector(".patient-card");
    await page.locator(".patients-filter .search input").fill("筛选患者甲");
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".patient-card").count(), 1);
    await page.locator(".patients-filter .search input").fill("");
    await page.locator('.patients-filter .chip:has-text("糖尿病组")').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".patient-card").count(), 1);
    assert.match(await page.locator(".patient-card").first().innerText(), /筛选患者乙/);
  },
},
{
  name: "待复核队列：徽章计数 → 队列打开草稿 → 验收后徽章清零",
  fn: async ({ page, seed }) => {
    const p = await seed.json("/api/patients", "POST", { name: "复核队列患者" });
    await seed.request(`/api/sessions/${p.data.sessionId}/files`, "POST", {
      name: "出院记录.txt",
      text: "2026-08-12 入院行 PCI。\n2026-08-20 出院带药。",
    });
    await page.locator('.app-navigation nav[aria-label="患者"] .session', { hasText: "复核队列患者" }).click();
    await page.waitForSelector(".detail-head");
    await page.locator('button:has-text("打开病例工作区")').click();
    await page.waitForSelector(".composer");
    await page.locator(".composer textarea").fill("请整理本患者的病例材料，生成病历时间线，保留来源与行号。");
    await page.locator(".composer textarea").press("Enter");
    await page.waitForSelector(".artifact-inline", { timeout: 30000 });
    await page.waitForFunction(
      () => document.querySelector(".nav-label-action.warn")?.textContent.includes("待复核 1"),
      { timeout: 8000 },
    );
    await page.locator(".nav-label-action.warn").click();
    await page.waitForSelector(".hub-task-row", { timeout: 8000 });
    await page.locator(".hub-task-row").first().click();
    await page.waitForSelector(".artifact-inline", { timeout: 10000 });
    await page.locator('button:has-text("打开验收视图")').first().click();
    await page.waitForSelector(".acceptance");
    await page.locator('.review-acts button:has-text("确认通过")').click();
    await page.locator(".review-form input").nth(0).fill("医生 A");
    await page.locator(".review-form input").nth(1).fill("已核对");
    await page.locator(".review-form .attest input").check();
    await page.locator('.review-form button:has-text("确认通过")').click();
    await page.waitForSelector(".accept-bar .acc-badge.approved", { timeout: 8000 });
    await page.locator('button:has-text("‹ 返回对话")').click();
    await page.waitForFunction(
      () => !document.querySelector(".nav-label-action.warn"),
      { timeout: 8000 },
    );
  },
},
{
  name: "风险闭环：知道了（确认）与标记已处理",
  fn: async ({ page, seed }) => {
    const p = await seed.json("/api/patients", "POST", { name: "风险闭环患者" });
    await seed.json(`/api/patients/${p.data.id}`, "PATCH", {
      expectedRevision: p.data.revision,
      labs: [{ item: "血钾", value: 2.5, unit: "mmol/L", date: "2026-09-10" }],
    });
    await seed.json("/api/risk-alerts/evaluate", "POST", {});
    await page.locator('.app-navigation nav[aria-label="患者"] .session', { hasText: "风险闭环患者" }).click();
    await page.waitForSelector(".risk-card");
    await page.locator('.risk-card button:has-text("知道了")').first().click();
    await page.waitForSelector('.risk-card .badge:has-text("已确认")', { timeout: 8000 });
    await page.locator('.risk-card button:has-text("标记已处理")').first().click();
    await page.waitForSelector('.risk-card .badge:has-text("已处理")', { timeout: 8000 });
  },
},
{
  name: "随访管理：模板应用到患者生成排程",
  fn: async ({ page, seed }) => {
    await seed.json("/api/patients", "POST", { name: "随访模板患者" });
    await page.locator('.nav-label button:has-text("打开")').click();
    await page.waitForSelector(".tool-slide");
    await page.locator('.ts-menu button:has-text("随访计划")').click();
    await page.waitForSelector(".tool-slide .followup-apply select");
    await page.locator(".tool-slide .followup-apply select").first().selectOption({ index: 1 });
    await page.locator(".tool-slide .followup-apply select").nth(1).selectOption({ label: "随访模板患者" });
    await page.locator('.tool-slide button:has-text("应用")').click();
    await page.waitForFunction(
      () => {
        const sections = [...document.querySelectorAll(".tool-slide .followups-section")];
        const upcoming = sections.find((section) => section.querySelector("h3")?.textContent.includes("未来与暂停"));
        return upcoming?.querySelector(".job-list")?.textContent.includes("随访模板患者");
      },
      { timeout: 8000 },
    );
  },
},
{
  name: "临床速查：CHA₂DS₂-VASC 量表计算",
  fn: async ({ page }) => {
    await page.locator('.nav-label button:has-text("打开")').click();
    await page.waitForSelector(".tool-slide");
    await page.locator('.ts-menu button:has-text("临床速查")').click();
    await page.waitForSelector(".tool-slide .followup-apply select");
    await page.locator(".tool-slide .followup-apply select").first().selectOption({ index: 1 });
    await page.waitForSelector(".tool-slide .scale-item");
    const selects = page.locator(".tool-slide .scale-item select");
    const n = await selects.count();
    for (let i = 0; i < n; i++) await selects.nth(i).selectOption({ index: 1 });
    await page.locator('.tool-slide form button:has-text("计算")').click();
    await page.waitForSelector(".tool-slide .drg-result", { timeout: 8000 });
    const scaleResult = await page.locator(".tool-slide .drg-result").innerText();
    assert.match(scaleResult, /CHA₂DS₂-VASc/);
    assert.match(scaleResult, /高风险|抗凝/);
  },
},
{
  name: "DRG 测算：单病例分组出 RW 与预估费用",
  fn: async ({ page }) => {
    await page.locator('.nav-label button:has-text("打开")').click();
    await page.waitForSelector(".tool-slide");
    await page.locator('.ts-menu button:has-text("DRG 测算")').click();
    await page.locator('.tool-slide input[placeholder*="主要诊断"]').fill("I21.9");
    await page.locator('.tool-slide button:has-text("分组")').first().click();
    await page.waitForSelector(".tool-slide .drg-result", { timeout: 8000 });
    assert.match(await page.locator(".tool-slide .drg-result").innerText(), /RW/);
  },
},
{
  name: "病例库：收入病例 → 相似检索",
  fn: async ({ page, seed }) => {
    await seed.json("/api/patients", "POST", { name: "病例库患者" });
    await page.locator('.nav-label button:has-text("打开")').click();
    await page.waitForSelector(".tool-slide");
    await page.locator('.ts-menu button:has-text("病例库")').click();
    await page.locator('.tool-slide button:has-text("收入病例")').click();
    await page.locator('.tool-slide input[placeholder*="主要诊断"]').fill("社区获得性肺炎");
    await page.locator('.tool-slide button:has-text("收入病例库")').click();
    await page.waitForSelector('.tool-slide .notice, .tool-slide :text("病例已收入")', { timeout: 8000 });
    await page.locator('.tool-slide input[placeholder*="相似病例搜索"]').fill("肺炎 咳嗽 发热");
    await page.locator('.tool-slide button:has-text("检索")').first().click();
    await page.waitForTimeout(600);
    assert.ok(await page.locator(".tool-slide").isVisible());
  },
},
{
  name: "患者消息粘贴导入",
  fn: async ({ page, seed }) => {
    const p = await seed.json("/api/patients", "POST", { name: "消息导入患者" });
    void p;
    await page.locator('.app-navigation nav[aria-label="患者"] .session', { hasText: "消息导入患者" }).click();
    await page.waitForSelector(".detail-head");
    await page.locator('.tab-row button:has-text("消息记录")').click();
    await page.locator('.paste-box:has-text("粘贴消息记录") textarea').fill("2026-09-07 09:12 | 患者 | 今天血压 150/95，偶有头晕");
    await page.locator('button:has-text("导入到该患者")').click();
    await page.waitForSelector(".msg-row", { timeout: 8000 });
    assert.match(await page.locator(".msg-row").first().innerText(), /血压 150\/95/);
  },
},
{
  name: "临床资料编辑：添加诊断",
  fn: async ({ page, seed }) => {
    await seed.json("/api/patients", "POST", { name: "临床编辑患者" });
    await page.locator('.app-navigation nav[aria-label="患者"] .session', { hasText: "临床编辑患者" }).click();
    await page.waitForSelector(".detail-head");
    await page.locator('.tab-row button:has-text("临床资料")').click();
    await page.waitForSelector(".clinical-panel");
    await page.locator('.clinical-panel input[placeholder*="直接填写"]').first().fill("高血压");
    await page.locator('.clinical-panel button:has-text("添加")').first().click();
    await page.waitForSelector('.clinical-rows :text("高血压")', { timeout: 8000 });
  },
},
{
  name: "会话导出：Markdown 下载（浏览器端下载事件）",
  desktopSkip: true,
  fn: async ({ page, seed }) => {
    const p = await seed.json("/api/patients", "POST", { name: "导出患者" });
    await seed.request(`/api/sessions/${p.data.sessionId}/files`, "POST", {
      name: "出院记录.txt",
      text: "2026-08-12 入院行 PCI。",
    });
    await page.locator('.app-navigation nav[aria-label="患者"] .session', { hasText: "导出患者" }).click();
    await page.waitForSelector(".detail-head");
    await page.locator('button:has-text("打开病例工作区")').click();
    await page.waitForSelector(".composer");
    await page.locator('.head-actions button[title="导出会话"]').click();
    await page.waitForSelector(".modal");
    const downloadPromise = page.waitForEvent("download", { timeout: 8000 });
    await page.locator('.modal button:has-text("Markdown")').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /\.md$/);
  },
},
];
