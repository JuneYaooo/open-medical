import { useState } from "react";
import { api } from "../agent-runtime";
export function BrowserPanel({ current, running, onSettings }) {
  const [url, setUrl] = useState(""),
    [page, setPage] = useState(null),
    [screen, setScreen] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function inspect(navigate) {
    if (busy || running) return;
    setBusy(true);
    setError("");
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
      {!current.permissions.grants["browser.read"] ? (
        <>
          <p>先在工作区设置中启用浏览器，并添加允许访问的网址来源。</p>
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
                type="url"
                aria-label="预览网址"
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
              />
            </label>
            <button disabled={busy || running || !url}>打开网页</button>
            <button
              type="button"
              disabled={busy || running}
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
