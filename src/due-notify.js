import { useEffect, useRef } from "react";

// 到期待办提醒：应用运行期间每分钟核对一次「今日待办」，发现新到期的患者
// 事项、且当前窗口不在前台时，经桌面壳弹系统通知，点击通知回到今日待办。
// 启动后的第一轮只记基线，并汇总弹一条「今日待办 N 项」——打开应用前就已
// 到期的事项不逐条提醒，避免一开机连响数声；重新开启提醒时只记基线。
// 按患者汇总的事项（如 messages:<pid>）条数增加时也算新事项。
// 浏览器环境（无 window.omwDesktop）不启动。
const STORE_KEY = "omw-due-notify";
const POLL_MS = 60000;
const KIND_LABELS = {
  risk: "高危风险",
  visit: "复诊",
  "plan-review": "方案复评",
  followup: "随访到期",
  tracking: "检查检验",
  messages: "患者消息",
  trial: "试验入组",
  custom: "我的规则",
};

let seen = new Map();
let baseline = false;
let summarized = false;
const countOf = (item) => (Number.isFinite(item.count) ? item.count : 1);

export function dueNotifyEnabled() {
  try {
    return localStorage.getItem(STORE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setDueNotifyEnabled(on) {
  try {
    if (on) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, "off");
  } catch {}
  if (on) baseline = false;
}

export async function pollOnce(api) {
  if (!dueNotifyEnabled()) {
    baseline = false;
    return;
  }
  const result = await api("/api/doctor/overview?kind=all&limit=100");
  const all = result.items || [];
  const previous = seen;
  seen = new Map(all.map((item) => [item.id, countOf(item)]));
  if (!baseline) {
    baseline = true;
    // Once per app run: a single summary of what was already due at open.
    if (summarized) return;
    summarized = true;
    const total = result.total ?? all.length;
    if (total > 0 && window.omwDesktop?.showNotification)
      window.omwDesktop.showNotification({
        title: `今日待办 ${total} 项`,
        body: summaryBody(all) || "打开今日待办查看",
        view: "agenda",
      }).catch(() => {});
    return;
  }
  const items = all.filter((item) => !previous.has(item.id) || countOf(item) > previous.get(item.id));
  if (!items.length || document.hasFocus() || !window.omwDesktop?.showNotification)
    return;
  if (items.length === 1) {
    const item = items[0];
    window.omwDesktop.showNotification({
      title: `${item.patientName || "待办"}：${item.title}`,
      body: item.detail || KIND_LABELS[item.kind] || "打开今日待办查看",
      view: "agenda",
    }).catch(() => {});
    return;
  }
  window.omwDesktop.showNotification({
    title: `今日待办新增 ${items.length} 项`,
    body: summaryBody(items),
    view: "agenda",
  }).catch(() => {});
}

function summaryBody(items) {
  const counts = {};
  for (const item of items) {
    const label = KIND_LABELS[item.kind] || item.kind;
    counts[label] = (counts[label] || 0) + 1;
  }
  return Object.entries(counts).map(([label, n]) => `${label} ${n}`).join(" · ");
}

// Test hook: forget the baseline and the once-per-run summary.
export function resetDueNotify() {
  seen = new Map();
  baseline = false;
  summarized = false;
}

export function startDueNotify(api) {
  if (!window.omwDesktop?.showNotification) return () => {};
  const tick = () => pollOnce(api).catch(() => {});
  tick();
  const timer = setInterval(tick, POLL_MS);
  return () => clearInterval(timer);
}

// 挂在应用根部的空组件：驱动轮询，并接住桌面壳通知点击后发回的视图切换。
export function DueNotifyWatcher({ api, onNavigate }) {
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  useEffect(() => {
    const stop = startDueNotify(api);
    window.omwDesktop?.onOpenView?.((view) => {
      if (typeof view === "string" && view) navigateRef.current(view);
    });
    return stop;
  }, [api]);
  return null;
}
