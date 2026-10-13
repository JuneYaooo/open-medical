import test from "node:test";
import assert from "node:assert/strict";

// 到期待办提醒的纯逻辑：基线不响、新增才响、前台不响、开关关闭不响且重开
// 后重记基线。模块持有跨轮询状态（已见集合/基线位），每个用例用查询串拿
// 一个全新实例。
function shims({ focused = false } = {}) {
  const notifications = [];
  globalThis.window = {
    omwDesktop: {
      showNotification: async (options) => {
        notifications.push(options);
        return true;
      },
    },
  };
  globalThis.document = { hasFocus: () => focused };
  globalThis.localStorage = {
    map: new Map(),
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; },
    setItem(key, value) { this.map.set(key, String(value)); },
    removeItem(key) { this.map.delete(key); },
  };
  return notifications;
}
const fresh = async (tag) => await import(`../src/due-notify.js?case=${tag}`);
const overview = (ids) => async () => ({ items: ids.map((id) => ({ id, kind: id.split(":")[0], patientName: "伦飞", title: `事项 ${id}`, detail: "明细" })) });

test("due notify: 启动第一轮只记基线，之后新增才提醒", async () => {
  const notifications = shims();
  const mod = await fresh("baseline");
  await mod.pollOnce(overview(["reminder:1"]));
  assert.equal(notifications.length, 0);
  await mod.pollOnce(overview(["reminder:1"]));
  assert.equal(notifications.length, 0);
  await mod.pollOnce(overview(["reminder:1", "labs:p1"]));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "伦飞：事项 labs:p1");
  assert.equal(notifications[0].view, "agenda");
  // 已见事项不再重复提醒；事项消失后集合收敛。
  await mod.pollOnce(overview(["labs:p1"]));
  assert.equal(notifications.length, 1);
});

test("due notify: 单条新增直接报患者和事项，窗口在前台时不弹", async () => {
  const notifications = shims();
  const mod = await fresh("single");
  await mod.pollOnce(overview([]));
  await mod.pollOnce(overview(["schedule:9"]));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "伦飞：事项 schedule:9");
  const quiet = shims({ focused: true });
  const mod2 = await fresh("focused");
  await mod2.pollOnce(overview([]));
  await mod2.pollOnce(overview(["schedule:9"]));
  assert.equal(quiet.length, 0);
  // 前台错过的这一条已记为已见，之后不会补响。
  const late = shims();
  await mod2.pollOnce(overview(["schedule:9"]));
  assert.equal(late.length, 0);
});

test("due notify: 关闭后不响，重新开启先重记基线", async () => {
  const notifications = shims();
  const mod = await fresh("toggle");
  await mod.pollOnce(overview(["reminder:1"]));
  mod.setDueNotifyEnabled(false);
  await mod.pollOnce(overview(["reminder:1", "reminder:2"]));
  assert.equal(notifications.length, 0);
  mod.setDueNotifyEnabled(true);
  // 关闭期间积压的事项在重开后的第一轮不补响。
  await mod.pollOnce(overview(["reminder:1", "reminder:2"]));
  assert.equal(notifications.length, 0);
  await mod.pollOnce(overview(["reminder:1", "reminder:2", "visit:3"]));
  assert.equal(notifications.length, 1);
  assert.equal(mod.dueNotifyEnabled(), true);
});

test("due notify: 开关持久化在 localStorage", async () => {
  shims();
  const mod = await fresh("persist");
  assert.equal(mod.dueNotifyEnabled(), true);
  mod.setDueNotifyEnabled(false);
  assert.equal(mod.dueNotifyEnabled(), false);
  mod.setDueNotifyEnabled(true);
  assert.equal(mod.dueNotifyEnabled(), true);
});
