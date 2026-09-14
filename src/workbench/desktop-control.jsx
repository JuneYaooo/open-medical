import { useState } from "react";
import { api } from "../agent-runtime";
export function DesktopPanel({ current }) {
  const [state, setState] = useState(null),
    [app, setApp] = useState(""),
    [consent, setConsent] = useState(false),
    [result, setResult] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(input) {
    setBusy(true);
    setError("");
    try {
      const r = await api(
        `/api/workspaces/${current.id}/desktop`,
        "POST",
        input,
      );
      if (input.action !== "status") setResult(r);
      const state = await api(`/api/workspaces/${current.id}/desktop`, "POST", {
        action: "status",
      });
      state.apps = [...new Map(state.apps.map((a) => [a.id, a])).values()];
      setState(state);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>系统桌面控制</h3>
      <p>
        选择一个已打开的 macOS 应用，授权十五分钟。Agent
        的输入和点击逐项在这里确认；切换前台应用时拒绝继续输入。
      </p>
      <button disabled={busy} onClick={() => run({ action: "status" })}>
        检查系统权限与应用
      </button>
      {state && (
        <>
          <p>
            辅助功能：
            {state.accessibility ? "可用" : "请在系统设置中授权 native-control"}{" "}
            · 屏幕录制：{state.screenRecording ? "可用" : "未授权"}
          </p>
          <select
            aria-label="授权应用"
            value={app}
            onChange={(e) => {
              setApp(e.target.value);
              setConsent(false);
            }}
          >
            <option value="">选择应用</option>
            {state.apps
              ?.filter((a) => a.id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
          <label>
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            允许查看和操作所选应用
          </label>
          <button
            disabled={!app || !consent || busy}
            onClick={() => run({ action: "authorize", app, consent })}
          >
            授权所选应用
          </button>
          {state.session && (
            <>
              <p>授权应用：{state.session.app}</p>
              <button
                disabled={busy}
                onClick={() => run({ action: "focus", consent: true })}
              >
                切到授权应用
              </button>
              <button
                disabled={busy}
                onClick={() => run({ action: "snapshot", consent: true })}
              >
                读取当前窗口
              </button>
              <button onClick={() => run({ action: "stop" })}>
                立即撤销桌面授权
              </button>
            </>
          )}
          {state.pending?.map((p) => (
            <article key={p.id}>
              <pre>{JSON.stringify(p.input, null, 2)}</pre>
              <button
                disabled={busy}
                onClick={() => run({ action: "approve", proposalId: p.id })}
              >
                执行此操作
              </button>
              <button
                disabled={busy}
                onClick={() => run({ action: "reject", proposalId: p.id })}
              >
                拒绝
              </button>
            </article>
          ))}
        </>
      )}
      {result?.text && <pre>{result.text}</pre>}
      {result?.artifact && <p>窗口截图已保存到成果区。</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
