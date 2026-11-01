import { useEffect, useState } from "react";

// 开发者信息（上下文用量、验证用计划频率、沙箱 Python 等）默认隐藏，
// 由本机 localStorage 标记 om.devInfo 打开。
const KEY = "om.devInfo";
const EVENT = "om-dev-info-changed";

export function devInfoEnabled() {
  try { return globalThis.localStorage?.getItem(KEY) === "1"; } catch { return false; }
}

export function setDevInfoEnabled(on) {
  try {
    if (on) globalThis.localStorage?.setItem(KEY, "1");
    else globalThis.localStorage?.removeItem(KEY);
  } catch { /* storage unavailable */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

export function useDevInfo() {
  const [on, setOn] = useState(devInfoEnabled);
  useEffect(() => {
    const sync = () => setOn(devInfoEnabled());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  return [on, setDevInfoEnabled];
}
