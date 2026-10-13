import { useEffect, useRef } from "react";

// 到期待办提醒：应用运行期间每分钟核对一次「今日待办」，发现新到期的患者
// 事项、且当前窗口不在前台时，经桌面壳弹系统通知，点击通知回到今日待办。
// 启动后与重新开启后的第一轮只记基线不提醒——打开应用前就已到期的事项
// 不算「新」，避免一开机连响数声；浏览器环境（无 window.omwDesktop）不启动。
const STORE_KEY = "omw-due-notify";
const POLL_MS = 60000;
const KIND_LABELS = {
  risk: "高危风险",
  visit: "复诊",
  followup: "随访到期",
  tracking: "检查检验",
  messages: "患者消息",
  trial: "试验入组",
  custom: "我的规则",
};

let seen = new Set();
let baseline = false;

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
  const current = (result.items || []).map((item) => item.id);
  if (!baseline) {
    seen = new Set(current);
    baseline = true;
    return;
  }
  const fresh = current.filter((id) => !seen.has(id));
  seen = new Set(current);
  if (!fresh.length || document.hasFocus() || !window.omwDesktop?.showNotification)
    return;
  const items = (result.items || []).filter((item) => fresh.includes(item.id));
  if (items.length === 1) {
    const item = items[0];
    window.omwDesktop.showNotification({
      title: `${item.patientName || "待办"}：${item.title}`,
      body: item.detail || KIND_LABELS[item.kind] || "打开今日待办查看",
      view: "agenda",
    }).catch(() => {});
    return;
  }
  const counts = {};
  for (const item of items) {
    const label = KIND_LABELS[item.kind] || item.kind;
    counts[label] = (counts[label] || 0) + 1;
  }
  window.omwDesktop.showNotification({
    title: `今日待办新增 ${items.length} 项`,
    body: Object.entries(counts).map(([label, n]) => `${label} ${n}`).join(" · "),
    view: "agenda",
  }).catch(() => {});
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
