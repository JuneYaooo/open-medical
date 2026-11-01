import { useEffect, useState } from "react";
import { api, bootstrap, openModelSettings, PLUGIN_CONFIG_EVENT } from "./agent-runtime";

// 全局「允许 AI 功能使用患者资料」授权。医生连接模型时授权一次，
// 之后各 AI 功能不再逐次勾选；仅当医生在设置中关闭时才恢复逐次询问。
// 服务端仍按每次请求的 externalConsent 校验，这里只决定是否展示勾选框。
export const AI_CONSENT_EVENT = "om-ai-consent-changed";
let cached = null; // Promise<{ granted, stored }>

// stored：设置里保存的全局开关；granted：是否可省略逐次勾选（本机模型不外发，视为已授权）。
async function readConsent() {
  const config = await bootstrap().catch(() => null);
  const local = config?.provider === "local";
  try {
    const prefs = await api("/api/learning/settings");
    if (typeof prefs?.defaultExternalConsent === "boolean")
      return { stored: prefs.defaultExternalConsent, granted: prefs.defaultExternalConsent || local };
  } catch {
    /* 学习插件关闭或接口失败时回退到模型配置 */
  }
  const stored = Boolean(config?.modelConfigured && config?.modelConsented);
  return { stored, granted: stored || local };
}

export function loadAiConsent(force = false) {
  if (force || !cached) cached = readConsent();
  return cached;
}

// 设置变更后调用：刷新缓存并通知所有使用中的组件。
export function notifyAiConsentChanged(granted) {
  cached = null;
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(AI_CONSENT_EVENT, { detail: { granted } }));
}

// 保存全局授权并广播。失败时抛出，由调用方提示。
export async function saveAiConsent(granted) {
  const prefs = await api("/api/learning/settings", "PUT", { defaultExternalConsent: Boolean(granted) });
  notifyAiConsentChanged(Boolean(prefs?.defaultExternalConsent));
  return prefs;
}

export function useAiConsent() {
  const [state, setState] = useState({ granted: false, stored: false, loading: true });
  useEffect(() => {
    let live = true;
    const load = () => loadAiConsent().then((value) => {
      if (live) setState({ ...value, loading: false });
    });
    load();
    // 模型切换（本机/云端）也会改变结果，一并刷新。
    const onChange = () => load();
    const onConfig = () => { cached = null; load(); };
    window.addEventListener(AI_CONSENT_EVENT, onChange);
    window.addEventListener(PLUGIN_CONFIG_EVENT, onConfig);
    return () => {
      live = false;
      window.removeEventListener(AI_CONSENT_EVENT, onChange);
      window.removeEventListener(PLUGIN_CONFIG_EVENT, onConfig);
    };
  }, []);
  return state;
}

// 已授权时替代勾选框的一行小字。
export function AiConsentNote({ className = "" }) {
  return (
    <small className={`muted ai-consent-note ${className}`.trim()}>
      已授权 AI 使用患者资料 ·{" "}
      <button type="button" className="text-button" onClick={openModelSettings}>在设置中修改</button>
    </small>
  );
}
