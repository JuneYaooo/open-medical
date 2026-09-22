import { sseFrames } from "../shared/sse.mjs";
let auth;
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
    auth = fetch("/api/bootstrap")
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
  const res = await fetch(path, {
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
