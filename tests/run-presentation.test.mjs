// W7 交互闭环：前端运行状态与交付呈现。
// - 单元用例（始终运行）：src/workbench/run-status.js 的展示层状态归一、
//   等待提示与证据/缺口文案。
// - 浏览器用例（playwright-core + 本机 Edge/Chrome headless，需先构建）：
//   ① 通用模式审批等待：等待原因可见、有批准入口、批准后写入文件
//     （脚本模型 propose_file_write → 等待 → 完成）；
//   ② 医疗模式完成呈现与执行中追加：真实产物 → delivered + 证据摘要
//     （哈希前 8 位）；空口完成 → answered + 缺口说明，不显示成“已交付”；
//     统一内核会话执行中输入框可用，Enter 追加要求走 steer 队列
//     （delivery/outcome/steer 均为服务端既有行为，前端只消费）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  RUN_STATUS_TEXT,
  blockedText,
  evidenceLine,
  gapLine,
  runChipLabel,
  runDerivedStatus,
  waitingNotice,
} from "../src/workbench/run-status.js";
import { createWorkspaceServer } from "../server/platform.mjs";
import { createServer as createMedicalServer } from "../server/agent.mjs";

const DIST = resolve(process.cwd(), "dist/index.html");
const BROWSER = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);
const canBrowse = existsSync(DIST) && Boolean(BROWSER);

test("run-status 展示层归一：优先服务端派生字段，通用接口按待审批数补齐", () => {
  // 服务端已下发 derivedStatus/waitingReason（医疗会话投影）时直接消费
  assert.equal(
    runDerivedStatus({ status: "running", derivedStatus: "waiting_input" }, 3),
    "waiting_input",
  );
  assert.equal(
    runDerivedStatus({ status: "running", derivedStatus: "blocked" }, 0),
    "blocked",
  );
  // 通用工作区接口（无派生字段）：running + 待审批 → 等待批准；其余保持原值
  assert.equal(runDerivedStatus({ status: "running" }, 2), "waiting_approval");
  assert.equal(runDerivedStatus({ status: "running" }, 0), "running");
  assert.equal(runDerivedStatus({ status: "completed" }, 1), "completed");
  assert.equal(runDerivedStatus(null, 1), "");
  assert.equal(runChipLabel({ status: "running" }, 1), "等待你批准");
  assert.equal(runChipLabel({ status: "running" }, 0), null);
  assert.equal(RUN_STATUS_TEXT.waiting_approval, "等待批准");
});

test("run-status 等待提示给出「在等什么、能做什么」，受阻给出原因与下一步", () => {
  const approval = waitingNotice({
    status: "waiting_approval",
    pendingCount: 2,
  });
  assert.match(approval.title, /等待你批准 2 项文件修改/);
  assert.equal(approval.action, "查看并批准");
  const input = waitingNotice({ status: "waiting_input" });
  assert.match(input.detail, /直接在下方输入并发送/);
  const blocked = waitingNotice({
    status: "blocked",
    reason: "运行记录没有活跃执行体",
  });
  assert.match(blocked.detail, /运行记录没有活跃执行体/);
  assert.match(blocked.detail, /停止/);
  assert.equal(blockedText("blocked"), "任务无法继续推进");
  assert.equal(waitingNotice({ status: "running" }), null);
});

test("run-status 证据/缺口文案：文件与产物带哈希前 8 位，缺口说人话", () => {
  assert.match(
    evidenceLine({ kind: "file", path: "docs/a.md", bytes: 12, hash: "1234567890abcdef" }),
    /^docs\/a\.md · 12 B · SHA-256 12345678$/,
  );
  assert.match(
    evidenceLine({ source: "artifact", type: "observations", hash: "abcdef1234567890" }),
    /observations · SHA-256 abcdef12/,
  );
  assert.equal(evidenceLine({ source: "sandbox", backend: "docker" }), "沙箱执行回执 · docker");
  assert.match(
    gapLine({ reason: "no_verifiable_output", detail: "结束时没有任何产物类工具结果" }),
    /没有任何产物/,
  );
});

test(
  "通用模式审批等待：等待原因可见、有批准入口，批准后写入文件（脚本模型）",
  { skip: !canBrowse },
  async (t) => {
    const { chromium } = await import("playwright-core");
    const dir = mkdtempSync(join(tmpdir(), "w7-approval-"));
    const project = join(dir, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "note.txt"), "初始材料");
    const server = createWorkspaceServer({
      database: join(dir, "app.sqlite"),
      provider: {
        apiKey: "synthetic",
        model: "scripted",
        async complete() {
          if (!this.calls) {
            this.calls = 0;
          }
          this.calls++;
          if (this.calls === 1)
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "w1",
                    function: {
                      name: "propose_file_write",
                      arguments: JSON.stringify({
                        path: "result.md",
                        content: "# 审批后的产物\n\n等待批准后写入。",
                      }),
                    },
                  },
                ],
              },
            };
          // 第二轮先挂起几秒：让“执行中 + 待审批”的等待状态可被观察
          await new Promise((r) => setTimeout(r, 4000));
          return {
            message: { role: "assistant", content: "修改提案已提交，等待批准后写入。" },
            usage: {},
          };
        },
      },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      await server.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({
      executablePath: BROWSER,
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await page.goto(origin);
    await page.waitForSelector(".workspace-hub-empty, .workspace-shell");
    await page.locator("button.new-session").click();
    await page.locator(".modal input").nth(0).fill("审批演示");
    await page.locator(".modal input").nth(1).fill(project);
    await page.locator('.modal input[type="checkbox"]').check();
    await page.locator('button:has-text("创建工作区")').click();
    await page.waitForSelector(".workspace-shell .composer textarea", {
      timeout: 15000,
    });

    // 授权「每次批准」：写入开启、提案必须人工批准
    await page.locator('select[aria-label="授权模式"]').selectOption("review");

    // 一句话交办；执行中输入框保持可用（追加要求入口一致）
    await page.locator(".composer textarea").fill("把材料整理成 result.md");
    await page.locator(".composer textarea").press("Enter");
    await page.waitForFunction(
      () =>
        document.querySelector(".composer textarea")?.placeholder.includes(
          "补充要求",
        ),
      { timeout: 20000 },
    );

    // 等待状态：状态芯片 + 提示条说明“在等什么”，并有批准入口；可停止
    await page.waitForSelector(".wb-run-notice.waiting_approval", {
      timeout: 20000,
    });
    assert.match(
      await page.locator(".wb-run-notice").innerText(),
      /等待你批准 1 项文件修改/,
    );
    assert.match(
      await page.locator(".wb-status-chip").innerText(),
      /等待你批准/,
    );
    assert.equal(
      await page.locator('button[aria-label="停止执行"]').count(),
      1,
    );

    // 运行收尾后提示仍在（待审批是用户侧待办），批准入口可用
    await page.waitForSelector(
      '.desk-messages .message:has-text("修改提案已提交")',
      { timeout: 30000 },
    );
    assert.equal(
      await page.locator(".wb-run-notice.waiting_approval").count(),
      1,
    );
    await page.locator('.wb-run-notice button:has-text("查看并批准")').click();
    await page.waitForSelector(".workspace-approvals article", {
      timeout: 15000,
    });
    await page.locator('button:has-text("批准并写入")').click();
    await page.waitForSelector('.workspace-approvals span:has-text("已写入")', {
      timeout: 15000,
    });

    // 批准后文件真实写入：切到文件面板（自动展开目录）并预览内容
    await page.locator('.panel-tabs button:has-text("文件")').click();
    await page.locator('.wb-file-row:has-text("result.md")').click();
    await page.waitForSelector(".wb-md-preview", { timeout: 15000 });
    assert.match(
      await page.locator(".wb-md-preview").innerText(),
      /审批后的产物/,
    );
    // 通用接口无 delivery：不得宣称“已交付”
    const body = await page.evaluate(() => document.body.innerText);
    assert.equal(body.includes("已交付"), false);
    assert.deepEqual(pageErrors, []);
  },
);

test(
  "医疗模式完成呈现与执行中追加：delivered/answered 如实区分，追加要求走 steer（脚本模型）",
  { skip: !canBrowse },
  async (t) => {
    const { chromium } = await import("playwright-core");
    // 脚本模型按「最后一条用户消息 + 是否已有工具结果」分派：
    // 摘录检验数值（旧内核会话）→ 工具产物后收尾；核对表（旧内核会话）
    // → 纯文字空口完成；整理成清单（统一内核会话）→ 慢响应，期间接受追加。
    const reply = (content) => ({
      message: { role: "assistant", content },
      usage: {},
    });
    const server = createMedicalServer({
      database: ":memory:",
      provider: {
        apiKey: "synthetic",
        model: "scripted",
        async complete(messages) {
          const lastUser =
            [...messages].reverse().find((m) => m.role === "user")?.content ||
            "";
          const hasToolResult = messages.some((m) => m.role === "tool");
          if (lastUser.includes("摘录检验数值"))
            return hasToolResult
              ? reply("已摘录检验数值，产物待复核。")
              : {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "obs-1",
                        function: {
                          name: "extract_observations",
                          arguments: "{}",
                        },
                      },
                    ],
                  },
                };
          if (lastUser.includes("核对表"))
            return reply("已完成整理，核对表文件已创建。");
          if (lastUser.includes("按日期分组"))
            return reply("已收到补充，清单已按日期分组整理完成。");
          if (lastUser.includes("整理成清单")) {
            // 慢响应：为「执行中追加要求」留出可观察窗口
            await new Promise((r) => setTimeout(r, 8000));
            return reply("正在整理资料清单。");
          }
          return reply("已处理。");
        },
      },
    });
    // 旧医疗内核会话（delivery/outcome 由运行时事实计算并随会话下发）
    server.store.create({ title: "交付呈现演示" });
    // 统一内核会话工作区（与项目工作区同一内核，支持执行中 steer）
    server.sessionBridge.createSession({ title: "追加要求演示" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      await server.shutdown();
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({
      executablePath: BROWSER,
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    await page.goto(origin + "/?view=home");
  await page.locator(".advanced-nav>summary").click();
    await page.waitForSelector('nav[aria-label="最近任务"]', { timeout: 15000 });

    // 打开注入的旧内核会话，进入工作台对话
    await page
      .locator('nav[aria-label="最近任务"] button:has-text("交付呈现演示")')
      .click();
    await page.waitForSelector(".composer textarea", { timeout: 15000 });

    // 第一轮：真实工具产物 → 已交付 + 证据摘要（哈希前 8 位）
    await page
      .locator(".composer textarea")
      .fill("请摘录检验数值：血糖 8.9 mmol/L，血红蛋白 105 g/L");
    await page.locator(".composer textarea").press("Enter");
    await page.waitForSelector(".wb-outcome.delivered", { timeout: 60000 });
    const deliveredText = await page
      .locator(".wb-outcome.delivered")
      .innerText();
    assert.match(deliveredText, /已交付/);
    assert.match(deliveredText, /SHA-256 [0-9a-f]{8}/);
    assert.match(deliveredText, /可核对证据/);

    // 第二轮：执行类任务空口完成 → 交付未完成 + 缺口说明，不得显示成已交付
    // (N3 语义,0.9.9 起:执行类未完成不再降格为“已回答”)
    await page
      .locator(".composer textarea")
      .fill("请整理本次材料的检验数值，生成一份核对表");
    await page.locator(".composer textarea").press("Enter");
    await page.waitForSelector(".wb-outcome.answered", { timeout: 60000 });
    const answeredText = await page.locator(".wb-outcome.answered").innerText();
    assert.match(answeredText, /交付未完成/);
    assert.match(answeredText, /没有任何产物类工具结果/);
    // 消息署名如实区分，最后一轮不冒充交付
    assert.match(
      await page
        .locator(".message")
        .last()
        .locator(".message-meta span")
        .last()
        .innerText(),
      /交付未完成/,
    );

    // 统一内核会话：执行中输入框可用（追加要求入口一致），Enter 走 steer
    await page
      .locator('nav[aria-label="最近任务"] button:has-text("追加要求演示")')
      .click();
    await page.waitForSelector(".composer textarea", { timeout: 15000 });
    await page.locator(".composer textarea").fill("把资料整理成清单");
    await page.locator(".composer textarea").press("Enter");
    await page.waitForFunction(
      () =>
        document
          .querySelector(".composer textarea")
          ?.placeholder.includes("补充要求"),
      { timeout: 20000 },
    );
    await page.locator(".composer textarea").fill("补充：按日期分组");
    await page.locator(".composer textarea").press("Enter");
    await page.waitForSelector(".notice:has-text('补充要求已加入队列')", {
      timeout: 15000,
    });
    await page.waitForSelector(
      '.message:has-text("已收到补充，清单已按日期分组整理完成")',
      { timeout: 60000 },
    );
    assert.deepEqual(pageErrors, []);
  },
);

test("resolved file approvals do not ask for missing information that the agent never requested", () => {
  assert.equal(runChipLabel({ status: "waiting_input", outcome: "approval_resolved" }, 0), "修改已处理");
  assert.equal(runChipLabel({ status: "waiting_input" }, 0), "等待你的补充");
});
