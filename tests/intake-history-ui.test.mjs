import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { fixture } from "./helpers.mjs";
import { openIntake } from "./navigation-ui.mjs";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("intake chooser finds old drafts and hides completed tasks beyond 100 history entries", { skip: !existsSync(chrome) }, async (t) => {
  const f = await fixture(t);
  const pending = f.server.pendingActions;
  const create = async (name) => {
    const session = await f.session("上传资料建档");
    await f.json(`/api/sessions/${session.id}/files`, "POST", { name: `${name}.txt`, text: "隔离验收资料" });
    const draft = pending.propose({ type: "patient-create", summary: name, payload: { name, sourceSessionId: session.id } });
    return { session, draft };
  };
  const old = await create("待核对历史任务"), completed = await create("已完成历史任务");
  pending.confirm(completed.draft.id);
  f.server.store.db.prepare("UPDATE pending_actions SET updated_at='2000-01-01'").run();
  for (let i = 0; i < 105; i++) {
    for (const status of ["pending", "applied"]) {
      const filler = pending.propose({ type: "patient-create", summary: "无关提案", payload: { name: `其他${i}`, sourceSessionId: `other-${i}` } });
      f.server.store.db.prepare("UPDATE pending_actions SET status=? WHERE id=?").run(status, filler.id);
    }
  }
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(f.origin + "/?view=home");
  await openIntake(page);
  const dialog = page.getByRole("dialog", { name: "上传资料建档" });
  const draft = dialog.getByRole("article", { name: "建档任务：待核对历史任务.txt" });
  await draft.getByRole("button", { name: "核对这份草稿" }).waitFor();
  assert.equal(await dialog.getByRole("article", { name: "建档任务：已完成历史任务.txt" }).count(), 0);
  await draft.getByRole("button", { name: "核对这份草稿" }).click();
  await dialog.getByRole("button", { name: "确认建档", exact: true }).waitFor();
  assert.equal(pending.row(old.draft.id).status, "pending");
});
