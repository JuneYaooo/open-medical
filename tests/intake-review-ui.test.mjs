import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium, _electron } from "playwright-core";
import { DeepSeekProvider } from "../server/provider.mjs";
import { saveLearningPrefs } from "../server/medical/personal-context.mjs";
import { fixture as baseFixture } from "./helpers.mjs";
import { openIntake } from "./navigation-ui.mjs";
async function fixture(t, options) {
  const f = await baseFixture(t, options);
  saveLearningPrefs(f.server.store.db, { personalContext: true, habits: true });
  return f;
}
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
async function launchReviewBrowser() {
  if (process.env.LEARNING_UI_DESKTOP !== "1")
    return chromium.launch({ executablePath: chrome, headless: true });
  const directory = await mkdtemp(join(tmpdir(), "learning-desktop-e2e-"));
  const env = { ...process.env, MEDICAL_DESKTOP_TEST_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [resolve("desktop/main.cjs"), "--e2e"],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".app-navigation", { timeout: 30000 });
  return {
    newPage: async (options) => {
      if (options?.viewport) await page.setViewportSize(options.viewport);
      return page;
    },
    close: async () => {
      await app.close();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    },
  };
}
const base = {
  name: "合成界面患者",
  gender: "male",
  summary: "合成核对草稿",
  clinicalSummary: {
    text: "2026-01-01门诊检查，既往高血压。",
    source: "history.txt 第1行",
  },
  diagnoses: [
    { name: "HTN", status: "confirmed", source: "history.txt 第1行" },
    { name: "肝囊肿", status: "finding", source: "history.txt 第1行" },
  ],
  medications: [{ name: "合成药物", dose: "5mg", status: "unknown" }],
  labs: [{ item: "血糖", value: 5, unit: "mmol/L", date: "2026-01-01" }],
  visits: [{ date: "2026-01-01", reason: "门诊复查" }],
};
function provider() {
  const p = new DeepSeekProvider({
    apiKey: "synthetic",
    model: "learning-ui-protocol",
  });
  p.complete = async (messages) => {
    const results = messages
      .filter((m) => m.role === "tool")
      .map((m) => {
        try {
          return JSON.parse(m.content);
        } catch {
          return {};
        }
      });
    const call = (name, args) => ({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: `${name}-${messages.length}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    });
    if (results.some((r) => r.status === "pending" || r.payload?.name))
      return { message: { role: "assistant", content: "草稿已整理。" } };
    const batch = results.findLast((r) => r.materials || r.intakeNotesSaved);
    if (batch?.materials)
      return call("save_intake_notes", {
        notes: "合成界面患者 高血压 肝囊肿 血糖5mmol/L，来源history.txt第1行",
        batchId: batch.batchId,
      });
    if (!batch?.complete) return call("read_intake_batch", {});
    if (!results.some((r) => Object.hasOwn(r, "habitIds")))
      return call("read_personal_context", {});
    return call("patient_create_propose", base);
  };
  return p;
}
test(
  "E1/E7/E8 editable review persists through refresh, provenance survives, errors retain edits and clear works",
  { skip: !existsSync(chrome), timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { provider: provider() });
    const browser = await launchReviewBrowser();
    t.after(() => browser.close());
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1100 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(f.origin + "/?view=home");
    await openIntake(page);
    let dialog = page.getByRole("dialog", { name: "上传资料建档" });
    await dialog.locator("input[type=file]").setInputFiles({
      name: "history.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "合成界面患者 高血压 肝囊肿 血糖 5 mmol/L 2026-01-01",
      ),
    });
    await dialog
      .getByRole("button", { name: "确认建档", exact: true })
      .waitFor({ timeout: 30000 });
    const diagnoses = dialog.getByRole("region", {
      name: "诊断与问题",
      exact: true,
    });
    await diagnoses
      .getByRole("button", { name: "改", exact: true })
      .first()
      .click();
    await diagnoses.getByLabel("诊断名称").fill("高血压");
    await diagnoses.getByRole("button", { name: "保存", exact: true }).click();
    const labs = dialog.getByRole("region", { name: "检验", exact: true });
    await labs.getByRole("button", { name: "改", exact: true }).click();
    await labs.getByLabel("检验数值").fill("6");
    await labs.getByRole("button", { name: "保存", exact: true }).click();
    await diagnoses
      .getByRole("button", { name: "删", exact: true })
      .nth(1)
      .click();
    await diagnoses
      .getByLabel("诊断与问题第2条删除原因")
      .selectOption("不该算诊断");
    await dialog.getByRole("button", { name: "添加标签", exact: true }).click();
    const tags = dialog.getByRole("region", { name: "标签", exact: true });
    await tags.getByLabel("标签", { exact: true }).fill("吸烟史");
    await tags.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.getByText("修改已保存", { exact: true }).waitFor();
    assert.equal(
      f.server.pending.list()[0].reviewDraft.payload.tags[0],
      "吸烟史",
    );
    await page.reload();
    await openIntake(page);
    dialog = page.getByRole("dialog", { name: "上传资料建档" });
    await dialog
      .getByRole("button", { name: "核对这份草稿", exact: true })
      .click();
    await dialog
      .getByText("已恢复你上次的 4 处修改", { exact: true })
      .waitFor();
    await page.route("**/api/pending-actions/*/review-draft", (route) =>
      route.abort(),
    );
    await dialog.getByRole("button", { name: "编辑身份信息" }).click();
    await dialog.getByLabel("电话", { exact: true }).fill("12345");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.getByText(/修改暂未保存到本机/).waitFor();
    assert.equal(
      await dialog.getByRole("button", { name: /确认建档（含你的/ }).count(),
      1,
    );
    await page.unroute("**/api/pending-actions/*/review-draft");
    mkdirSync("output/playwright", { recursive: true });
    await dialog.screenshot({ path: "output/playwright/learning-review.png" });
    await dialog.getByRole("button", { name: /确认建档（含你的/ }).click();
    await dialog.waitFor({ state: "hidden" });
    const patient = f.server.patients.all()[0];
    assert.equal(patient.diagnoses[0].name, "高血压");
    assert.equal(patient.diagnoses.length, 1);
    assert.equal(patient.labs[0].value, 6);
    assert.equal(patient.phone, "12345");
    assert.equal(f.server.pending.reviewLog.stats().count, 1);
    await page.goto(f.origin + "/?view=settings&doctor=1");
    const profile = page
      .getByRole("dialog")
      .filter({ has: page.getByRole("heading", { name: "它学得怎么样" }) });
    await profile.getByRole("region", { name: "危险操作" }).waitFor();
    assert.equal(await profile.getByRole("button", { name: "生效中", exact: true }).count(), 0);
    await profile
      .getByRole("button", { name: "清空学习记录", exact: true })
      .click();
    await profile
      .getByRole("button", { name: "确认清空学习记录", exact: true })
      .click();
    await profile
      .getByText("再确认 5 份建档后，这里会显示 AI 草稿的改动趋势")
      .waitFor();
    assert.equal(f.server.patients.all().length, 1);
    assert.deepEqual(errors, []);
  },
);

test(
  "E2 preserve/discard paths retain superseded edits; single-item and all restore are reversible",
  { skip: !existsSync(chrome), timeout: 90000 },
  async (t) => {
    const p = provider(),
      seen = [];
    const complete = p.complete;
    p.complete = async (...args) => {
      seen.push(JSON.stringify(args[0]));
      const result = await complete(...args);
      const call = result.message.tool_calls?.find(
        (c) => c.function.name === "patient_create_propose",
      );
      if (
        call &&
        JSON.stringify(args[0]).includes("请在新草稿保留医生的手动修改")
      ) {
        const value = JSON.parse(call.function.arguments);
        value.diagnoses[0].name = "高血压";
        call.function.arguments = JSON.stringify(value);
      }
      return result;
    };
    const f = await fixture(t, { provider: p }),
      browser = await launchReviewBrowser();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(f.origin + "/?view=home");
    await openIntake(page);
    const dialog = page.getByRole("dialog", { name: "上传资料建档" });
    await dialog.locator("input[type=file]").setInputFiles({
      name: "history.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("合成界面患者 HTN 肝囊肿"),
    });
    await dialog
      .getByRole("button", { name: "确认建档", exact: true })
      .waitFor({ timeout: 30000 });
    const diagnoses = dialog.getByRole("region", {
      name: "诊断与问题",
      exact: true,
    });
    const rename = async (value) => {
      await diagnoses
        .getByRole("button", { name: "改", exact: true })
        .first()
        .click();
      await diagnoses.getByLabel("诊断名称").fill(value);
      await diagnoses
        .getByRole("button", { name: "保存", exact: true })
        .click();
    };
    await rename("高血压");
    await diagnoses
      .getByRole("button", { name: "已改 ↺", exact: true })
      .click();
    assert.match(await diagnoses.innerText(), /HTN/);
    await rename("高血压");
    await dialog.getByRole("button", { name: "全部还原", exact: true }).click();
    await dialog.getByRole("button", { name: "继续核对", exact: true }).click();
    assert.match(await diagnoses.innerText(), /高血压/);
    await dialog.getByLabel("需要补充或纠正？直接告诉我").fill("核对以上修改");
    await dialog.getByRole("button", { name: "按补充内容重新整理" }).click();
    await dialog
      .getByRole("button", { name: "继续重新整理", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "确认建档", exact: true })
      .waitFor({ timeout: 30000 });
    assert.match(await diagnoses.innerText(), /高血压/);
    assert.ok(seen.some((s) => s.includes("请在新草稿保留医生的手动修改")));
    assert.equal(
      f.server.store.db
        .prepare("SELECT COUNT(*) n FROM review_diffs WHERE superseded=1")
        .get().n,
      1,
    );
    await rename("HTN");
    await dialog.getByLabel("需要补充或纠正？直接告诉我").fill("再次核对");
    await dialog.getByRole("button", { name: "按补充内容重新整理" }).click();
    await dialog.getByLabel("丢弃我的修改", { exact: true }).check();
    await dialog
      .getByRole("button", { name: "继续重新整理", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "确认建档", exact: true })
      .waitFor({ timeout: 30000 });
    assert.equal(
      f.server.store.db
        .prepare("SELECT COUNT(*) n FROM review_diffs WHERE superseded=1")
        .get().n,
      2,
    );
    assert.equal(f.server.pending.reviewLog.stats().count, 0);
  },
);

test(
  "E3b/E4/E5 learned habit activates with undo notice, next draft is labeled and reverting increments ledger",
  { skip: !existsSync(chrome), timeout: 90000 },
  async (t) => {
    const f = await fixture(t, { provider: provider() });
    for (let i = 0; i < 2; i++) {
      const p = f.server.pending.propose({
        type: "patient-create",
        summary: "合成学习",
        payload: {
          name: `学习患者${i}`,
          diagnoses: [{ name: "HTN", status: "confirmed" }],
        },
      });
      f.server.pending.confirm(p.id, {
        payload: {
          ...p.payload,
          diagnoses: [{ name: "高血压", status: "confirmed" }],
        },
      });
    }
    const browser = await launchReviewBrowser();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(f.origin + "/?view=home");
    await openIntake(page);
    let dialog = page.getByRole("dialog", { name: "上传资料建档" });
    const upload = async () => {
      await dialog.locator("input[type=file]").setInputFiles({
        name: "history.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("合成界面患者 HTN 肝囊肿"),
      });
      await dialog
        .getByRole("button", { name: "确认建档", exact: true })
        .waitFor({ timeout: 30000 });
    };
    await upload();
    const diagnoses = dialog.getByRole("region", {
      name: "诊断与问题",
      exact: true,
    });
    await diagnoses
      .getByRole("button", { name: "改", exact: true })
      .first()
      .click();
    await diagnoses.getByLabel("诊断名称").fill("高血压");
    await diagnoses.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.getByRole("button", { name: /确认建档（含你的/ }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText(/记下了：诊断名称「HTN」写成「高血压」/).waitFor();
    const memory = f.server.doctor
      .memories({ status: "confirmed" })
      .find((m) => m.origin === "learned");
    assert.ok(memory);
    assert.equal(
      await page.getByRole("button", { name: "记住", exact: true }).count(),
      0,
    );
    await page.goto(f.origin + "/?view=home");
    await openIntake(page);
    dialog = page.getByRole("dialog", { name: "上传资料建档" });
    await upload();
    await dialog
      .getByRole("button", { name: `按习惯 H${memory.id} · 还原`, exact: true })
      .click();
    await dialog.getByText(/未使用历史档案（当前为云端模型/).waitFor();
    await dialog.getByRole("button", { name: "编辑身份信息" }).click();
    await dialog.getByLabel("姓名", { exact: true }).fill("第四位合成患者");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.getByRole("button", { name: /确认建档（含你的/ }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(f.server.pending.reviewLog.ledger(memory.id).reverted, 1);
    f.server.pending.habitLearner.decide(memory.id, "undo");
    assert.equal(f.server.pending.habitLearner.aggregate().length, 0);
  },
);

test(
  "E3a explicit chat and correction preferences save immediately; E6 local similar cases collapse and disable",
  { skip: !existsSync(chrome), timeout: 90000 },
  async (t) => {
    const p = provider(),
      original = p.complete;
    p.complete = async (messages, ...rest) => {
      if (
        messages.some(
          (m) => m.role === "user" && m.content === "以后诊断都写全称",
        )
      ) {
        if (
          messages.some(
            (m) =>
              m.role === "tool" && String(m.content).includes('"saved":true'),
          )
        )
          return {
            message: {
              role: "assistant",
              content: "已记下，以后诊断都写全称。",
            },
          };
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "remember-explicit",
                type: "function",
                function: {
                  name: "doctor_memory_save",
                  arguments: JSON.stringify({ content: "以后诊断都写全称" }),
                },
              },
            ],
          },
        };
      }
      return original(messages, ...rest);
    };
    const f = await fixture(t, { provider: p }),
      session = await f.session();
    const chat = await f.chat(session.id, "以后诊断都写全称", {
      mode: "model",
      externalConsent: true,
    });
    assert.equal(chat.status, 200);
    const stated = f.server.doctor.memories({ status: "confirmed" });
    assert.equal(stated.length, 1);
    assert.equal(stated[0].origin, "stated");
    const browser = await launchReviewBrowser();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(f.origin + "/?view=home");
    await openIntake(page);
    const dialog = page.getByRole("dialog", { name: "上传资料建档" });
    await dialog.locator("input[type=file]").setInputFiles({
      name: "history.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("合成界面患者 HTN 肝囊肿"),
    });
    await dialog
      .getByRole("button", { name: "确认建档", exact: true })
      .waitFor({ timeout: 30000 });
    assert.match(
      await dialog
        .getByRole("region", { name: "诊断与问题", exact: true })
        .innerText(),
      /高血压/,
    );
    await dialog
      .getByLabel("需要补充或纠正？直接告诉我")
      .fill("血糖单位统一 mmol/L；第二份报告是术前检查");
    await dialog.getByRole("button", { name: "按补充内容重新整理" }).click();
    await dialog
      .getByText("✓ 记下了：血糖单位统一 mmol/L", { exact: false })
      .waitFor();
    assert.equal(f.server.doctor.memories({ status: "confirmed" }).length, 2);
    assert.equal(
      await dialog.getByRole("button", { name: "记住", exact: true }).count(),
      0,
    );
    await dialog
      .getByRole("button", { name: "确认建档", exact: true })
      .waitFor({ timeout: 30000 });
    await dialog.getByRole("button", { name: "确认建档", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const first = f.server.patients.all()[0];
    const second = f.server.patients.create({
      name: "相似合成患者",
      diagnoses: [{ name: "高血压", status: "confirmed" }],
    });
    await page.goto(f.origin + `/?view=patients&patient=${second.id}`);
    const card = page.getByRole("region", { name: "你过去的相似病例" });
    await card.waitFor();
    assert.ok(
      await card.getByRole("link", { name: "打开", exact: true }).count(),
    );
    assert.ok(
      (await f.json(`/api/learning/similar/${second.id}`)).data.matches.some(
        (m) => m.caseId === `patient:${first.id}`,
      ),
    );
    await card.getByRole("button", { name: "收起", exact: true }).click();
    assert.equal(
      await card.getByRole("link", { name: "打开", exact: true }).count(),
      0,
    );
    await card.getByRole("button", { name: "展开", exact: true }).click();
    await card.getByRole("button", { name: "不再提示", exact: true }).click();
    await card.waitFor({ state: "hidden" });
    assert.equal(
      (await f.json("/api/learning/settings")).data.similarCards,
      false,
    );
  },
);
