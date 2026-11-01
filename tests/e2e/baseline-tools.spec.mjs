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

  const patient = patients.find((item) => item.name === PATIENT_NAME);
  expect(patient, `${PATIENT_NAME} should be seeded`).toBeTruthy();
  patientId = patient.id;
});

test("资料与工具目录", async ({ page }) => {
  await open(page, "/?view=tools");
  await expect(
    page.getByRole("heading", { name: "资料与工具", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "文献研究", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("搜索工具")).toBeVisible();
  await expect(page.locator(".directory-tools article").first()).toBeVisible();

  await capture(page, "09-tools-directory.png", {
    scroll: ".work-directory",
  });
});

test("文献研究", async ({ page }) => {
  await open(page, "/?view=literature");
  await expect(
    page.getByRole("heading", { name: "文献研究", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("围绕问题查找、阅读和比较证据，形成有来源的总结。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("想研究什么问题？")).toBeVisible();

  await capture(page, "10-literature.png", {
    scroll: ".module-view",
  });
});

test("科研统计", async ({ page }) => {
  await open(page, "/?view=data-analysis");
  await expect(
    page.getByRole("heading", { name: "科研统计", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("研究问题")).toBeVisible();

  await capture(page, "11-research-stats.png", {
    scroll: ".module-view",
  });
});

test("临床速查 量表计算", async ({ page }) => {
  await open(page, "/?view=clinical-ref");
  await expect(
    page.getByRole("heading", { name: "临床速查", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /量表计算/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "量表与计算器", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /填入 BMI 示例/ }),
  ).toBeVisible();
  await expect(
    page
      .getByLabel("选择量表")
      .locator("option", { hasText: "BMI 体重指数" }),
  ).toHaveCount(1);

  await capture(page, "12-clinical-ref-scales.png", {
    scroll: ".module-view",
  });
});

test("临床速查 检验速查", async ({ page }) => {
  await open(page, "/?view=clinical-ref");
  await expect(
    page.getByRole("heading", { name: "临床速查", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /检验速查/ }).click();
  await expect(
    page.getByRole("heading", { name: "检验指标速查", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("检验指标名称或缩写")).toBeVisible();

  await capture(page, "13-clinical-ref-labs.png", {
    scroll: ".module-view",
  });
});

test("临床速查 手术编码", async ({ page }) => {
  await open(page, "/?view=clinical-ref");
  await expect(
    page.getByRole("heading", { name: "临床速查", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /手术编码/ }).click();
  await expect(
    page.getByRole("heading", { name: /手术操作编码/ }),
  ).toBeVisible();
  await expect(page.getByLabel("手术名称或编码")).toBeVisible();

  await capture(page, "14-clinical-ref-codes.png", {
    scroll: ".module-view",
  });
});

test("临床速查 不良反应筛查", async ({ page }) => {
  await open(page, "/?view=clinical-ref");
  await expect(
    page.getByRole("heading", { name: "临床速查", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /不良反应筛查/ }).click();
  await expect(
    page.getByRole("heading", { name: "不良反应筛查", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /填入虚构筛查示例/ }),
  ).toBeVisible();
  await expect(page.getByLabel("当前用药")).toBeVisible();

  await capture(page, "15-clinical-ref-adr.png", {
    scroll: ".module-view",
  });
});

test("临床试验", async ({ page }) => {
  await open(page, "/?view=research");
  await expect(
    page.getByRole("heading", { name: "临床试验入组初筛", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "示例·糖尿病随访观察方案（虚构）",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "打开初筛", exact: true }).first(),
  ).toBeVisible();

  await capture(page, "16-trials.png", {
    scroll: ".module-view",
  });
});

test("病例库", async ({ page }) => {
  await open(page, "/?view=cases");
  await expect(
    page.getByRole("heading", { name: "案例库", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /病例列表/ })).toBeVisible();
  await expect(page.locator("li[data-case-id]")).toHaveCount(3);

  await capture(page, "17-cases.png", {
    scroll: ".module-view",
  });
});

test("DRG", async ({ page }) => {
  await open(page, "/?view=drg");
  await expect(
    page.getByRole("heading", { name: "DRG 示例测算", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /单例分组/ }),
  ).toBeVisible();
  await expect(page.getByLabel("主要诊断")).toBeVisible();
  await expect(page.locator(".drg-view .module-phase")).toContainText(
    "CHS-DRG 1.1",
  );

  await capture(page, "18-drg.png", {
    scroll: ".module-view",
  });
});

test("示例·张沪生 检查与转诊", async ({ page }) => {
  await open(
    page,
    `/?view=patients&patient=${encodeURIComponent(patientId)}&tab=tracking`,
  );
  await expect(
    page.getByRole("heading", { name: "检查与转诊跟进", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "进行中", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".care-tracking .care-empty, .care-tracking .care-tracking-card").first(),
  ).toBeVisible();

  await capture(page, "19-patient-tracking.png", {
    scroll: ".patients-view",
  });
});

test("示例·张沪生 复诊预约", async ({ page }) => {
  await open(
    page,
    `/?view=patients&patient=${encodeURIComponent(patientId)}&tab=appointments`,
  );
  await expect(
    page.getByRole("heading", { name: "复诊预约", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "预约复诊", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("示例·携带测量记录复诊", { exact: true }),
  ).toBeVisible();

  await capture(page, "20-patient-appointments.png", {
    scroll: ".patients-view",
  });
});

test("知识库 知识图谱", async ({ page }) => {
  await open(
    page,
    `/?view=knowledge&collection=${encodeURIComponent("示例体验资料库")}&knowledgeTab=map`,
  );
  await expect(
    page.getByRole("heading", { name: "知识图谱", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "知识视图" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "自动选择", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "正在加载知识图谱" }),
  ).toBeHidden();

  await capture(page, "21-knowledge-graph.png", {
    scroll: ".module-view.library-hub",
    // Only rendered once a graph generation has completed; the wall-clock
    // timestamp would otherwise change between runs.
    mask: [page.getByText(/^更新于 /)],
  });
});

test("设置 技能与规则", async ({ page }) => {
  await open(page, "/?view=settings&settingsTab=skills");
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "技能", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /内置技能/ })).toBeVisible();
  await expect(page.locator(".ext-builtin-skills li").first()).toBeVisible();

  await capture(page, "22-settings-skills.png", {
    scroll: ".app-settings-page",
  });
});

test("设置 工具与服务", async ({ page }) => {
  await open(page, "/?view=settings&settingsTab=connections");
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "工具与服务", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("配置所属项目")).toBeVisible();

  await capture(page, "23-settings-connections.png", {
    scroll: ".app-settings-page",
  });
});

test("设置 消息渠道 医生分身", async ({ page }) => {
  await open(page, "/?view=settings&settingsTab=knowledge-bot");
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "医生分身", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("button", { name: "连接飞书", exact: true })
      .or(page.getByRole("button", { name: "重新加载", exact: true })),
  ).toBeVisible();

  await capture(page, "24-settings-knowledge-bot.png", {
    scroll: ".app-settings-page",
  });
});

test("设置 消息渠道 医生提醒", async ({ page }) => {
  await open(page, "/?view=settings&settingsTab=notifications");
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "医生待办提醒", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /微信提醒/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /飞书提醒/ }),
  ).toBeVisible();

  await capture(page, "25-settings-notifications.png", {
    scroll: ".app-settings-page",
  });
});
