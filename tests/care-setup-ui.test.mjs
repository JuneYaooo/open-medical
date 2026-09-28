import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { fixture } from "./helpers.mjs";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const shots = process.env.CARE_SETUP_SHOTS || "";

function wecomFetch(log) {
  return async (url, init = {}) => {
    const u = new URL(url);
    log.push({ path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    const reply = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/gettoken")) return reply(u.searchParams.get("corpsecret") === "appsecret" && !log.some((e) => e.retried)
      ? (log.push({ retried: true }), { errcode: 60020, errmsg: "not allow to access from your ip, hint: [x], from ip: 203.0.113.7" })
      : { errcode: 0, access_token: "tok", expires_in: 7200 });
    if (u.pathname.endsWith("/kf/account/list")) return reply({ errcode: 0, account_list: [{ open_kfid: "wk1", name: "术后随访助手" }] });
    if (u.pathname.endsWith("/kf/add_contact_way")) return reply({ errcode: 0, url: "https://work.weixin.qq.com/kfid/kfc123" });
    if (u.pathname.endsWith("/kf/sync_msg")) return reply({ errcode: 0, msg_list: [], has_more: 0, next_cursor: "" });
    if (u.pathname.endsWith("/message/send")) return reply({ errcode: 0 });
    return reply({ errcode: 404 });
  };
}

test("the WeCom setup wizard walks a new user from nothing to a working 微信客服 link", { skip: !existsSync(chrome) }, async (t) => {
  const log = [];
  const f = await fixture(t, { wecom: {}, care: { fetch: wecomFetch(log), intervalMs: 3600000, kfPollMs: null } });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(12000);
  const shot = (name) => shots ? page.screenshot({ path: `${shots}-${name}.png` }) : null;
  await page.goto(f.origin);
  await page.getByRole("navigation", { name: "主要业务" }).getByRole("button", { name: "患者消息" }).click();
  const banner = page.getByRole("region", { name: "企业微信接入" });
  await banner.getByText("已完成 0/4 项").waitFor();
  await banner.getByRole("button", { name: "开始设置" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "第 1 步：企业信息" }).waitFor();
  await shot("1");
  await dialog.getByLabel("企业 ID").fill("ww1234567890abcd");
  await dialog.getByRole("button", { name: "保存，下一步" }).click();

  await dialog.getByRole("heading", { name: /第 2 步/ }).waitFor();
  await dialog.getByLabel("微信客服 Secret").fill("kfsecret");
  await dialog.getByRole("button", { name: "保存并读取客服账号" }).click();
  await dialog.getByLabel("选择接待患者的客服账号").waitFor();
  assert.equal(await dialog.getByLabel("选择接待患者的客服账号").inputValue(), "wk1");
  await shot("2");
  await dialog.getByRole("button", { name: "保存并测试" }).click();

  await dialog.getByRole("heading", { name: /第 3 步/ }).waitFor();
  await dialog.getByLabel("AgentId").fill("1000002");
  await dialog.getByLabel("应用 Secret").fill("appsecret");
  await dialog.getByLabel(/接收提醒的成员 UserID/).fill("doctor1");
  await dialog.getByRole("button", { name: "保存并测试" }).click();
  await dialog.getByText("203.0.113.7", { exact: true }).waitFor();
  await shot("3-ip");
  await dialog.getByRole("button", { name: "保存并测试" }).click();
  await dialog.getByRole("button", { name: "给医生发一条测试提醒" }).click();
  await dialog.getByText(/已发送给 doctor1/).waitFor();
  assert.ok(log.some((e) => e.path?.endsWith("/message/send")));
  await dialog.getByRole("button", { name: "下一步" }).click();

  await dialog.getByRole("heading", { name: /第 4 步/ }).waitFor();
  await dialog.getByRole("button", { name: "跳过" }).click();
  await dialog.getByRole("heading", { name: /第 5 步/ }).waitFor();
  await dialog.getByRole("button", { name: "生成咨询链接" }).click();
  await dialog.getByText("https://work.weixin.qq.com/kfid/kfc123").waitFor();
  await dialog.getByLabel(/允许把患者消息发送给已配置的模型/).check();
  await shot("5");
  await dialog.getByRole("button", { name: "完成" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await banner.count(), 0);
  const saved = (await f.json("/api/care/settings")).data;
  assert.equal(saved.channels.kf.openKfId, "wk1");
  assert.equal(saved.processing.modelConsent, true);
  assert.deepEqual(saved.alerts.notifyUserIds, ["doctor1"]);
  assert.deepEqual(errors, []);
});
