import { useEffect, useState } from "react";
import { api } from "../agent-runtime";
export function BrowserPanel({ current, running, onSettings }) {
  const [url, setUrl] = useState(""),
    [page, setPage] = useState(null),
    [screen, setScreen] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [environment, setEnvironment] = useState(null), [checkVersion, setCheckVersion] = useState(0), [origins, setOrigins] = useState([]);
  useEffect(() => {
    let alive = true;
    setEnvironment(null); setError("");
    api(`/api/workspaces/${current.id}/extensions`).then(value => { if (alive) { setEnvironment(value.browser); setOrigins(value.config.origins || []); } }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [checkVersion, current.id, current.revision]);
  const needsOrigins = environment?.backend === "electron-chromium" && !origins.length;
  async function inspect(navigate) {
    if (busy || running || !environment?.available || needsOrigins) return;
    setBusy(true);
    setError("");
    if (navigate) { setPage(null); setScreen(null); }
    const tool = (name, args = {}) =>
      api(`/api/workspaces/${current.id}/tools`, "POST", {
        tool: name,
        arguments: args,
      });
    try {
      if (navigate) await tool("browser_open", { url });
      setPage(await tool("browser_snapshot"));
      setScreen(await tool("browser_screenshot"));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="wb-browser">
      <h3>浏览器预览</h3>
      {!environment?.available && <div><p role="status">{environment ? `当前不可用：${environment.reason}` : error ? "无法检查浏览器运行环境" : "正在检查浏览器运行环境…"}</p><button onClick={() => setCheckVersion(v => v + 1)}>重新检查浏览器</button></div>}
      {!current.permissions.grants["browser.read"] || needsOrigins ? (
        <>
          <p>{needsOrigins ? "此项目尚未添加允许访问的网址。请在连接面板填写网址来源（例如 https://example.com）并保存授权。" : "先在连接面板启用浏览器，并添加允许访问的网址来源。"}</p>
          <button onClick={onSettings}>配置浏览器</button>
        </>
      ) : (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              inspect(true);
            }}
          >
            <label>
              预览网址
              <input
                disabled={busy || running || !environment?.available}
                type="url"
                aria-label="预览网址"
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
              />
            </label>
            <button disabled={busy || running || !url || !environment?.available}>打开网页</button>
            <button
              type="button"
              disabled={busy || running || !environment?.available}
              onClick={() => inspect(false)}
            >
              刷新当前页面
            </button>
          </form>
          {busy && <p role="status">正在读取页面…</p>}
          {screen && (
            <img
              alt="当前浏览器页面截图"
              src={`data:${screen.mimeType};base64,${screen.data}`}
            />
          )}
          {page && (
            <details>
              <summary>页面内容</summary>
              <pre>
                {typeof page === "string"
                  ? page
                  : JSON.stringify(page, null, 2)}
              </pre>
            </details>
          )}
          <p>
            显示浏览器截图与页面内容；点击、填写和操作审批可在工作区设置中处理。
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
