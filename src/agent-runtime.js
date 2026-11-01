import { sseFrames } from "../shared/sse.mjs";
let auth;
export const OFFLINE_MESSAGE = "无法连接本机服务，请稍后重试或重启 Open Medical";
// fetch 在连不上本机服务时抛 TypeError("Failed to fetch")；换成医生能看懂的提示。
// 主动取消（AbortError）保持原样，调用方据此判断。
export async function localFetch(...args) {
  try {
    return await fetch(...args);
  } catch (error) {
    if (error instanceof TypeError) throw Object.assign(new Error(OFFLINE_MESSAGE), { code: "OFFLINE", cause: error });
    throw error;
  }
}
export const PENDING_REFRESH_EVENT = "care-pending-refresh";
export const PLUGIN_CONFIG_EVENT = "medical-plugin-config-changed";
// 任意组件都可请求打开「模型与识别」窗口（App 监听此事件），无需层层传 props。
export const OPEN_MODEL_SETTINGS_EVENT = "om-open-model-settings";
export function openModelSettings() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OPEN_MODEL_SETTINGS_EVENT));
}
// App Shell 能力判定:优先读 bootstrap 的 capabilities(通用平台显式声明),
// 医疗应用(旧 bootstrap 无 capabilities)回退到 patientsEnabled。
// 返回 false 时前端不得请求 /api/sessions 等医疗接口、不渲染患者导航与医疗默认任务。
export function medicalEnabled(config) {
  if (config?.capabilities)
    return Boolean(config.capabilities.medical);
  return Boolean(config?.patientsEnabled);
}
export async function bootstrap(force = false) {
  if (force) auth = null;
  if (!auth)
    auth = localFetch("/api/bootstrap")
      .then(async (res) => {
        if (!res.ok) throw new Error("无法连接本地 Agent 运行时");
        return res.json();
      })
      .catch((error) => {
        auth = null;
        throw error;
      });
  return auth;
}
// Re-read bootstrap after a connection change so plugin activation (and the
// lazily registered plugin UI) updates without restarting the app.
export async function refreshPlugins() {
  const config = await bootstrap(true);
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(PLUGIN_CONFIG_EVENT, { detail: config }));
  return config;
}
export async function api(path, options = {}, dataOrRetried = false) {
  const retried = dataOrRetried === true;
  if (typeof options === "string") {
    options = {
      method: options,
      ...(dataOrRetried && typeof dataOrRetried === "object"
        ? { body: JSON.stringify(dataOrRetried) }
        : {}),
    };
  }
  const config = await bootstrap();
  const res = await localFetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Medical-Token": config.token,
      ...options.headers,
    },
  });
  if (res.status === 401 && !retried) {
    await bootstrap(true);
    return api(path, options, true);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { code: data.code, status: res.status });
  }
  if (options.method === "POST" && /^\/api\/pending-actions\/[^/]+\/(confirm|reject)$/.test(path) && typeof window !== "undefined")
    window.dispatchEvent(new Event(PENDING_REFRESH_EVENT));
  return options.raw ? res : res.json();
}
export async function streamTurn(sessionId, body, onEvent, signal) {
  const response = await api(`/api/chat/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    body: JSON.stringify(body),
    raw: true,
    signal,
  });
  if (!response.body) throw new Error("运行时没有返回数据流");
  let terminal = false;
  for await (const frame of sseFrames(response.body)) {
    let event;
    try {
      event = JSON.parse(frame.data);
    } catch {
      throw new Error("运行时返回了无效事件");
    }
    onEvent(event);
    if (["message.complete", "run.cancelled", "error"].includes(event.type))
      terminal = true;
    if (event.type === "error")
      throw new Error(event.payload.error || "执行失败");
  }
  if (!terminal)
    throw new Error("连接已中断。本次内容未标记完成，请查看执行记录。");
}
export async function downloadSession(session, format) {
  const response = await api(
    `/api/sessions/${session.id}/export?format=${format}`,
    { raw: true },
  );
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${session.title.replace(/[\\/:*?"<>|]/g, "_")}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
