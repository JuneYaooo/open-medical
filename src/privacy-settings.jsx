import { useEffect, useState } from "react";
import { api } from "./agent-runtime";
import "./privacy-settings.css";

// 患者资料去隐私：开启后发给模型的资料先脱敏，原图不发给模型。
export function PrivacySettings() {
  const [data, setData] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [form, setForm] = useState({ baseUrl: "", apiKey: "" }),
    [builtinKey, setBuiltinKey] = useState("");
  useEffect(() => {
    let alive = true;
    api("/api/privacy-settings")
      .then((value) => alive && setData(value))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);
  async function run(fn) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const save = (patch, message) =>
    run(async () => {
      const result = await api("/api/privacy-settings", "PUT", patch);
      setData(result);
      setStatus(`${message}${result.reprocess?.queued ? `，正在为 ${result.reprocess.queued} 份已有资料补做脱敏` : ""}。`);
    });
  if (!data) return error ? <p role="alert">{error}</p> : null;
  // 只填 API Key 时使用内置服务地址。
  const formUrl = form.baseUrl.trim();
  const ownForm = formUrl ? { baseUrl: formUrl, ...(form.apiKey ? { apiKey: form.apiKey } : {}) } : null;
  const builtin = data.builtin;
  const builtinState = !builtin
    ? null
    : !builtin.enabled
      ? { tone: "off", text: "已关闭" }
      : !builtin.hasKey
        ? { tone: "warn", text: "缺 API Key，暂未使用" }
        : builtin.active
          ? { tone: "on", text: "使用中" }
          : { tone: "off", text: `未使用：已改用${data.service?.source === "ocr" ? "文字识别服务" : "自己配置的服务"}` };
  return (
    <section aria-label="患者资料脱敏" className="privacy-settings">
      <p>
        开启后，导入的病历会先脱敏再保存：文字中的姓名、电话、证件号、住址等替换成占位符，图片和扫描件按识别结果把这些位置涂黑，原文和原图不再保留。模型只看到脱敏后的资料；建档时由本机把真实姓名填回提案。
      </p>
      <fieldset disabled={busy}>
        <label>
          <input type="checkbox" checked={data.enabled} onChange={(e) => save({ enabled: e.target.checked }, e.target.checked ? "已开启脱敏" : "已关闭脱敏")} />
          开启患者资料脱敏（默认开启）
        </label>
        {builtin && (
          <div className="privacy-builtin" aria-label="内置脱敏服务">
            <div className="privacy-builtin-head">
              <label>
                <input type="checkbox" checked={builtin.enabled} onChange={(e) => save({ useBuiltin: e.target.checked }, e.target.checked ? "已开启内置脱敏服务" : "已关闭内置脱敏服务")} />
                使用内置脱敏服务（默认开启）
              </label>
              <span className={`privacy-badge ${builtinState.tone}`}>{builtinState.text}</span>
            </div>
            <p>
              服务器地址：<code>{builtin.baseUrl}</code>
            </p>
            <p>
              API Key：
              {builtin.hasKey ? (builtin.keySource === "env" ? "已在 model.env 配置" : "已填写，已在本机加密保存") : "未填写"}
            </p>
            {builtin.enabled && (
              <div className="privacy-builtin-key">
                <input
                  type="password"
                  aria-label="内置服务 API Key"
                  value={builtinKey}
                  placeholder={builtin.hasKey ? "填写新的 Key 可替换" : "填写内置服务的 API Key"}
                  onChange={(e) => setBuiltinKey(e.target.value)}
                />
                <button className="primary" disabled={!builtinKey.trim()} onClick={() => save({ builtinApiKey: builtinKey }, "API Key 已保存").then((ok) => ok && setBuiltinKey(""))}>
                  保存 Key
                </button>
                {builtin.keySource === "settings" && (
                  <button className="secondary" onClick={() => save({ builtinApiKey: "" }, "已清除本页填写的 Key")}>
                    清除 Key
                  </button>
                )}
              </div>
            )}
            {builtin.enabled && <p className="privacy-hint">Key 只保存在本机，加密存储，不会上传或显示出来。</p>}
            {builtin.insecure && builtin.enabled && <p className="privacy-hint">该地址使用明文 HTTP，送去脱敏的原始病历在网络上未加密，建议只在可信网络使用。</p>}
            {!builtin.enabled && <p className="privacy-hint">关闭后不再把病历发到这台服务器；如果也没有配置其他服务，将只用本地规则脱敏，自由文本中的家属姓名、地址可能漏掉。</p>}
          </div>
        )}
        <label>
          服务不可用时
          <select value={data.mode} onChange={(e) => save({ mode: e.target.value }, "已保存")}>
            {Object.entries(data.modes).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p>
          {data.service
            ? `当前脱敏服务：${data.service.baseUrl}${{ ocr: "（沿用文字识别服务）", builtin: "（内置服务）", privacy: "（自己配置的服务）" }[data.service.source] || ""}`
            : "当前没有可用的脱敏服务：只用本地规则脱敏，自由文本中的家属姓名、地址可能漏掉。"}
        </p>
        {data.service?.insecure && data.service.source !== "builtin" && (
          <p role="alert">该地址使用明文 HTTP：送去脱敏的原始病历和 API Key 在网络上未加密。建议改用 HTTPS，或只在可信内网使用。</p>
        )}
        <details>
          <summary>改用自己的脱敏服务（gpu-worker）</summary>
          <label>
            接口地址
            <input value={form.baseUrl} placeholder={data.ownService?.baseUrl || "https://your-worker.example.com"} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </label>
          <label>
            API Key
            <input type="password" value={form.apiKey} placeholder={data.ownService?.hasKey ? "已保存，留空不修改" : "WORKER_API_KEY"} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </label>
          <p>填写后优先使用自己的服务，内置服务不再调用。支持 HTTP 和 HTTPS；经公网访问时建议使用 HTTPS。</p>
          <button className="secondary" disabled={!ownForm} onClick={() => save({ service: ownForm }, "脱敏服务已保存")}>
            保存服务
          </button>
          {data.ownService && (
            <button className="secondary" onClick={() => save({ clearService: true }, "已改回默认服务")}>改回默认服务（文字识别服务或内置服务）</button>
          )}
        </details>
        <button
          className="secondary"
          onClick={() =>
            run(async () => {
              const result = await api("/api/privacy-settings/test", "POST", ownForm ? { service: ownForm } : {});
              setStatus(`${result.message}（${result.ms} 毫秒）：${result.sample}`);
            })
          }
        >
          测试脱敏服务
        </button>
        {data.enabled && (
          <button
            className="secondary"
            onClick={() =>
              run(async () => {
                const result = await api("/api/privacy-settings/reprocess", "POST");
                setStatus(result.queued ? `正在为 ${result.queued} 份资料重新脱敏。` : "所有资料都已经由服务脱敏。");
              })
            }
          >
            重新脱敏未完成的资料
          </button>
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
    </section>
  );
}
