import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers.mjs";
import { ToolRegistry } from "../server/core/tool-registry.mjs";
import { PermissionEngine } from "../server/core/permissions.mjs";
import { extensionTools } from "../server/medical/extension-tools.mjs";

const local = (offset = 0) => { const d = new Date(Date.now() + offset * 86400000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const setup = async (t, options = {}) => {
  const f = await fixture(t, { followupOptions: { autoStart: false }, ...options });
  const definitions = extensionTools(() => f.server.extensions, f.server.pendingActions);
  const registry = new ToolRegistry(definitions);
  const permissions = new PermissionEngine({ profile: "standard" });
  const tools = Object.fromEntries(definitions.map((x) => [x.definition.function.name, (args) => registry.execute(x.definition.function.name, args, {}, permissions)]));
  const confirm = async (proposal) => { const r = await f.json(`/api/pending-actions/${proposal.id}/confirm`, "POST", {}); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.applied; };
  return { ...f, ext: f.server.extensions, tools, confirm };
};
const skillSpec = { name: "出院小结（本院格式）", description: "写出院小结时使用", body: "先写出院诊断，再写住院经过。", template: "一、入院情况\n二、出院带药", appliesTo: ["出院小结草稿"],
  quickTask: { title: "本院出院小结", prompt: "按本院格式写出院小结" } };

test("stale extension proposals cannot overwrite a newer edit or rollback", async (t) => {
  const f = await setup(t);
  const original = f.ext.save({ kind: "skill", spec: skillSpec });
  const proposal = await f.tools.extension_propose({ id: original.id, kind: "skill", spec: { ...skillSpec, body: "旧提案正文" } });
  f.ext.save({ id: original.id, kind: "skill", spec: { ...skillSpec, body: "医生刚修改的正文" } });
  const response = await f.json(`/api/pending-actions/${proposal.id}/confirm`, "POST", {});
  assert.equal(response.status, 409);
  assert.equal(response.data.code, "ACTION_CONFLICT");
  assert.equal(f.ext.row(original.id).body, "医生刚修改的正文");
  assert.equal(f.server.pendingActions.row(proposal.id).status, "pending");
  const fresh = await f.tools.extension_propose({ id: original.id, kind: "skill", spec: { ...skillSpec, body: "最新提案" } });
  assert.equal((await f.confirm(fresh)).body, "最新提案");
});

test("failed extension audit restores the on-disk skill and database version", async (t) => {
  const f = await setup(t);
  const original = f.ext.save({ kind: "skill", spec: skillSpec });
  const file = join(f.ext.skillsDir, original.id, "SKILL.md");
  const before = readFileSync(file, "utf8");
  const audit = f.server.store.audit;
  f.server.store.audit = () => { throw new Error("synthetic audit failure"); };
  try {
    assert.throws(() => f.ext.save({ id: original.id, kind: "skill", spec: { ...skillSpec, body: "不能生效的版本" } }), /synthetic audit failure/);
    assert.equal(f.ext.row(original.id).version, original.version);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.throws(() => f.ext.setStatus(original.id, "disabled"), /synthetic audit failure/);
    assert.equal(f.ext.row(original.id).status, "active");
    assert.equal(readFileSync(file, "utf8"), before);
  } finally { f.server.store.audit = audit; }
});

test("failed confirmation removes a new skill file along with the rolled-back proposal effect", async (t) => {
  const f = await setup(t);
  const proposal = await f.tools.extension_propose({ kind: "skill", spec: skillSpec });
  let written;
  const writeSkill = f.ext.writeSkill.bind(f.ext);
  f.ext.writeSkill = ext => { written = ext.id; return writeSkill(ext); };
  f.server.store.db.exec("CREATE TEMP TRIGGER fail_ext_confirmation BEFORE UPDATE OF status ON pending_actions WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'synthetic confirmation failure'); END");
  assert.throws(() => f.server.pendingActions.confirm(proposal.id), /synthetic confirmation failure/);
  assert.equal(f.server.pendingActions.row(proposal.id).status, "pending");
  assert.equal(f.ext.list().length, 0);
  assert.ok(written);
  assert.equal(existsSync(join(f.ext.skillsDir, written, "SKILL.md")), false);
  f.server.store.db.exec("DROP TRIGGER fail_ext_confirmation");
  assert.ok((await f.confirm(proposal)).id);
});

test("desktop chat route previews and proposes a skill that becomes a home task after confirmation", async (t) => {
  let round = 0, proposal;
  const f = await setup(t, { provider: { provider: "stub", model: "stub", apiKey: "stub", async complete(messages) {
    round++;
    if (round > 1) {
      const result = JSON.parse(messages.findLast((m) => m.role === "tool").content);
      assert.equal(result.error, undefined);
      if (round === 2) assert.match(result.skill, /二、出院带药/);
      else proposal = result;
    }
    if (round <= 2) return { message: { role: "assistant", tool_calls: [{ id: `extension-${round}`, type: "function", function: {
      name: round === 1 ? "extension_preview" : "extension_propose",
      arguments: JSON.stringify({ kind: "skill", spec: { ...skillSpec, appliesTo: "出院小结草稿" } }),
    } }] } };
    return { message: { role: "assistant", content: "已生成技能与快捷任务提案，请确认。" } };
  } } });
  const session = await f.session("模板技能测试");
  const response = await f.chat(session.id, "按模板建立技能并放入首页快捷任务", { mode: "model", externalConsent: true });
  assert.equal(response.status, 200);
  assert.ok(proposal?.id, response.text);
  assert.equal(f.ext.list().length, 0);
  const saved = await f.confirm(proposal);
  assert.equal(saved.template, skillSpec.template);
  assert.deepEqual(saved.appliesTo, ["出院小结草稿"]);
  assert.equal((await f.json("/api/extensions/prefs")).data.quickTasks[0].skillId, saved.id);
});

test("registered extension tools preserve legacy appliesTo and reject invalid payloads before side effects", async (t) => {
  const f = await setup(t);
  const spec = { ...skillSpec, appliesTo: "出院小结草稿" };
  const preview = await f.tools.extension_preview({ kind: "skill", spec });
  assert.match(preview.skill, /二、出院带药/);
  assert.equal(f.ext.list().length, 0);
  const proposal = await f.tools.extension_propose({ kind: "skill", spec });
  assert.equal(f.ext.list().length, 0);
  const saved = await f.confirm(proposal);
  assert.deepEqual(saved.appliesTo, ["出院小结草稿"]);
  assert.equal(saved.template, skillSpec.template);
  assert.equal((await f.json("/api/extensions/prefs")).data.quickTasks[0].prompt, skillSpec.quickTask.prompt);
  for (const bad of [JSON.stringify(spec), { ...spec, unexpected: true }, { ...spec, quickTask: { prompt: 4 } }, { ...spec, appliesTo: [4] }]) {
    await assert.rejects(f.tools.extension_propose({ kind: "skill", spec: bad }), { code: "INVALID_TOOL_ARGS" });
  }
  assert.equal(f.ext.list().length, 1);
});

test("a chat-authored skill becomes a real skill with versions, rollback and disable", async (t) => {
  const f = await setup(t);
  const proposal = await f.tools.extension_propose({ kind: "skill", spec: skillSpec, reason: "医院要求" });
  assert.match(proposal.preview.skill, /二、出院带药/);
  assert.equal(f.ext.list().length, 0, "nothing changes before confirmation");
  const skill = await f.confirm(proposal);
  assert.match(skill.id, /^my-/); assert.equal(skill.source.via, "chat");
  const listed = (await f.json("/api/skills")).data.skills.find((s) => s.id === skill.id);
  assert.equal(listed.title, "出院小结（本院格式）");
  const file = join(f.ext.skillsDir, skill.id, "SKILL.md");
  assert.match(readFileSync(file, "utf8"), /按以下模板[\s\S]*一、入院情况/);
  assert.deepEqual((await f.json("/api/extensions/prefs")).data.quickTasks.map((q) => q.title), ["本院出院小结"]);
  // Edit → v2, roll back → v3 equal to v1.
  const v2 = (await f.json(`/api/extensions/${skill.id}`, "PUT", { spec: { ...skillSpec, body: "只写要点。" } })).data;
  assert.equal(v2.version, 2);
  const v3 = (await f.json(`/api/extensions/${skill.id}/rollback`, "POST", { version: 1 })).data;
  assert.equal(v3.version, 3); assert.equal(v3.body, skillSpec.body); assert.equal(v3.source.via, "rollback");
  assert.equal((await f.json(`/api/extensions/${skill.id}`)).data.versions.length, 3);
  await f.tools.extension_toggle({ id: skill.id, enabled: false });
  assert.equal(existsSync(file), false);
  assert.equal((await f.json("/api/skills")).data.skills.some((s) => s.id === skill.id), false);
  assert.equal((await f.json("/api/extensions/prefs")).data.quickTasks.length, 0);
  await f.tools.extension_toggle({ id: skill.id, enabled: true });
  assert.equal(existsSync(file), true);
});

test("a lab-threshold rule previews on real data, fires only for new results and tracks outcomes", async (t) => {
  const f = await setup(t);
  const p = (await f.json("/api/patients", "POST", { name: "糖友甲", diagnoses: [{ name: "2型糖尿病" }], labs: [{ item: "糖化血红蛋白", value: 9.2, unit: "%", date: local(-3) }] })).data;
  await f.json("/api/patients", "POST", { name: "对照乙", labs: [{ item: "糖化血红蛋白", value: 9.9, unit: "%", date: local(-3) }] });
  const spec = { name: "HbA1c 控制不佳", trigger: { type: "lab", item: "糖化血红蛋白" }, condition: { diagnosis: "糖尿病", lab: { item: "糖化血红蛋白", op: "gt", value: 8 } },
    action: { type: "agenda", title: "HbA1c {数值}，考虑调整方案", detail: "{日期} 结果" } };
  const preview = await f.tools.extension_preview({ kind: "automation", spec });
  assert.equal(preview.count, 1); assert.deepEqual(preview.samples, ["糖友甲：HbA1c 9.2%，考虑调整方案"]);
  await assert.rejects(() => f.tools.extension_preview({ kind: "automation", spec: { ...spec, trigger: { type: "hourly" } } }), /arguments.spec.trigger.type/);
  const rule = await f.confirm(await f.tools.extension_propose({ kind: "automation", spec }));
  await f.ext.tick();
  assert.equal(f.ext.openItems().length, 0, "results that existed before the rule do not fire");
  const cur = (await f.json(`/api/patients/${p.id}`)).data;
  await f.json(`/api/patients/${p.id}`, "PATCH", { expectedRevision: cur.revision, labs: [...cur.labs, { item: "糖化血红蛋白", value: 8.6, unit: "%", date: local(0) }] });
  await f.ext.tick(); await f.ext.tick();
  const items = (await f.json("/api/doctor/overview?kind=custom")).data.items;
  assert.equal(items.length, 1); assert.equal(items[0].title, "HbA1c 8.6%，考虑调整方案"); assert.match(items[0].detail, /来自规则「HbA1c 控制不佳」/);
  await f.json(`/api/extensions/items/${items[0].itemId}`, "POST", { status: "done" });
  assert.deepEqual({ ...f.ext.stats(rule.id), lastAt: undefined }, { produced: 1, open: 0, done: 1, dismissed: 0, lastAt: undefined, failures: 0 });
  assert.equal((await f.json("/api/doctor/overview?kind=custom")).data.total, 0);
});

test("appointment rules draft patient messages; weekly rules build a local summary task", async (t) => {
  const f = await setup(t);
  const p = (await f.json("/api/patients", "POST", { name: "术后丙", tags: ["术后"], labs: [{ item: "血红蛋白", value: 110, unit: "g/L", date: local(-1) }] })).data;
  await f.json(`/api/patients/${p.id}/appointments`, "POST", { date: local(1), time: "09:00", reason: "拆线" });
  await f.ext.save({ kind: "automation", spec: { name: "复诊提醒", trigger: { type: "appointment", daysBefore: 1 }, condition: {}, action: { type: "draft_message", text: "{姓名}您好，提醒您 {复诊日期} 复诊（{复诊事项}）。" } } });
  const weekday = ((new Date().getDay() + 6) % 7) + 1;
  const weekly = f.ext.save({ kind: "automation", spec: { name: "术后周报", trigger: { type: "weekly", weekday, time: "00:00" }, condition: { tag: "术后" }, action: { type: "report", title: "术后患者周报" } } });
  assert.throws(() => f.ext.normalize("automation", { name: "x", trigger: { type: "lab" }, action: { type: "report", title: "x" } }), /汇总只能按每天或每周/);
  await f.ext.tick(); await f.ext.tick();
  const drafts = (await f.json("/api/care/replies?status=draft")).data.replies;
  assert.equal(drafts.length, 1); assert.match(drafts[0].text, new RegExp(`术后丙您好，提醒您 ${local(1)} 09:00 复诊（拆线）`));
  const work = (await f.json("/api/doctor/overview")).data.work.items.find((i) => i.title.startsWith("「术后患者周报」"));
  assert.equal(work.action.type, "task");
  const session = (await f.json(`/api/sessions/${work.action.sessionId}`)).data;
  assert.match(session.files[0].text, /## 术后丙[\s\S]*血红蛋白 110g\/L[\s\S]*下次复诊：/);
  assert.equal(f.ext.stats(weekly.id).produced, 1);
});

test("evolution: frequent quick tasks move up automatically (undoable); repeated edits and ignored rules become suggestions", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 4; i++) await f.json("/api/extensions/usage", "POST", { flowId: "discharge" });
  for (let i = 0; i < 2; i++) await f.json("/api/extensions/usage", "POST", { flowId: "handover" });
  f.ext.evolve();
  const prefs = (await f.json("/api/extensions/prefs")).data;
  assert.deepEqual(prefs.starters, ["discharge", "handover"]);
  const change = (await f.json("/api/extensions")).data.changes[0];
  assert.equal(change.status, "applied");
  assert.ok((await f.json("/api/doctor/overview")).data.work.items.some((i) => i.id === `evolved:${change.id}`));
  const undone = (await f.json(`/api/extensions/changes/${change.id}/undo`, "POST", {})).data;
  assert.equal(undone.prefs.starters, null); assert.equal(undone.prefs.autoOrder, false);
  f.ext.evolve();
  assert.equal((await f.json("/api/extensions/prefs")).data.starters, null, "after undo the layout is left alone");

  for (let i = 0; i < 3; i++) f.ext.recordEdit({ title: `出院小结草稿 · 患者${i}（x.txt）`, type: "checklist", note: i === 2 ? "补充出院带药用法" : undefined });
  f.ext.evolve();
  let suggestion = f.ext.suggestions()[0];
  assert.equal(suggestion.title, "为「出院小结草稿」建立你的专属写法");
  assert.match(suggestion.prompt, /补充出院带药用法[\s\S]*extension_propose/);
  // Answering the suggestion through chat closes it.
  await f.confirm(await f.tools.extension_propose({ kind: "skill", spec: skillSpec, suggestionId: suggestion.id }));
  assert.equal(f.ext.suggestions().length, 0);
  assert.equal(f.ext.list()[0].source.via, "evolution");

  const rule = f.ext.save({ kind: "automation", spec: { name: "吵闹规则", trigger: { type: "daily", time: "00:00" }, condition: {}, action: { type: "agenda", title: "看看{姓名}" } } });
  for (let i = 0; i < 5; i++) f.ext.addItem(rule, null, { title: "x" });
  for (const item of f.ext.openItems()) f.ext.resolveItem(item.id, "dismissed");
  f.ext.evolve();
  suggestion = f.ext.suggestions()[0];
  assert.equal(suggestion.extensionId, rule.id); assert.match(suggestion.evidence, /忽略了 5 条/);
  await f.json(`/api/extensions/suggestions/${suggestion.id}`, "POST", { status: "dismissed" });
  f.ext.evolve();
  assert.equal(f.ext.suggestions().length, 0, "a dismissed suggestion does not come back for the same version");
});

test("browser: 我的工作台 shows skills, rules and suggestions; templates reach the home page; rule to-dos close from the agenda", async (t) => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chrome) || !existsSync("dist/index.html")) return t.skip("Chrome/build unavailable");
  const { chromium } = await import("playwright-core");
  const f = await setup(t);
  const p = (await f.json("/api/patients", "POST", { name: "周规则", diagnoses: [{ name: "2型糖尿病" }] })).data;
  const skill = f.ext.save({ kind: "skill", spec: skillSpec, source: { via: "chat" } });
  const rule = f.ext.save({ kind: "automation", spec: { name: "每日看看糖友", trigger: { type: "daily", time: "00:00" }, condition: { diagnosis: "糖尿病" }, action: { type: "agenda", title: "看看{姓名}的血糖记录" } } });
  await f.ext.tick();
  for (let i = 0; i < 3; i++) f.ext.recordEdit({ title: "交班记录草稿 · 夜班", type: "checklist" });
  f.ext.evolve();
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(12000);
  const shots = process.env.EXT_SHOTS || "";

  await page.goto(f.origin + "/?view=agenda");
  const row = page.locator(".agenda-row", { hasText: "看看周规则的血糖记录" });
  await row.getByText("来自规则「每日看看糖友」").waitFor();
  await page.locator(".agenda-work summary").click();
  await page.getByText("为「交班记录草稿」建立你的专属写法").waitFor();
  if (shots) await page.screenshot({ path: `${shots}-agenda.png`, fullPage: true });
  await row.getByRole("button", { name: "完成" }).click();
  await row.waitFor({ state: "detached" });
  assert.equal(f.ext.stats(rule.id).done, 1);

  await page.goto(f.origin + "/?view=settings");
  await page.getByRole("button", { name: "技能", exact: true }).click();
  await page.getByRole("article", { name: skill.name }).getByText("首页快捷任务「本院出院小结」").waitFor();
  await page.getByRole("button", { name: "我的工作台" }).click();
  const center = page.getByRole("region", { name: "我的工作台" });
  await center.getByRole("article", { name: "每日看看糖友" }).getByText(/已产生 1 条：完成 1/).waitFor();
  if (shots) await page.screenshot({ path: `${shots}-center.png`, fullPage: true });
  await center.getByRole("button", { name: "在对话中完善" }).click();
  const box = page.locator("textarea").first();
  await box.waitFor();
  assert.match(await box.inputValue(), /交班记录草稿[\s\S]*suggestionId 填 /);

  await page.getByRole("button", { name: "更多任务模板" }).click();
  await page.getByRole("button", { name: "我的模板" }).click();
  await page.locator(".agent-template-grid").getByRole("button", { name: /本院出院小结/ }).click();
  assert.equal(await box.inputValue(), skillSpec.quickTask.prompt);
  await page.locator(".skill-chip", { hasText: skillSpec.name }).waitFor();
  assert.equal(f.ext.prefs().usage[`ext:${skill.id}`], 1);
  assert.deepEqual(errors, []);
  void p;
});
