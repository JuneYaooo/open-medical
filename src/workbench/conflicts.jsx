import { useState } from "react";
import { api } from "../agent-runtime";
import { DiffView } from "./diff";
export function Conflicts({ current, disabled, refresh }) {
  const [ref, setRef] = useState(""),
    [message, setMessage] = useState("合并分支并解决冲突"),
    [data, setData] = useState(null),
    [edits, setEdits] = useState({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState(false);
  const base = `/api/workspaces/${current.id}`;
  async function perform(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const tool = (tool, args) =>
    api(base + "/tools", "POST", { tool, arguments: args });
  async function call(action, extra = {}) {
    const git = await tool("git_status", {});
    const result = await api(base + "/git-conflicts", "POST", {
      action,
      consent,
      revision: current.revision,
      expectedHead: git.head,
      ref,
      message,
      ...extra,
    });
    setData(result);
    await refresh();
  }
  return (
    <details>
      <summary>分支合并与冲突处理</summary>
      <fieldset disabled={disabled || busy}>
        <label className="workspace-checkbox">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          允许在当前项目合并分支、暂存解决后的冲突并创建合并提交
        </label>
        <label>
          待合并分支
          <input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="例如 origin/main"
          />
        </label>
        <button
          disabled={!consent || !ref}
          onClick={() => perform(() => call("merge"))}
        >
          合并到当前分支，暂不提交
        </button>
        <button onClick={() => perform(() => call("inspect"))}>检查冲突</button>
        {data?.status && <p>{data.status}</p>}
        {data?.conflicts?.map((c) => (
          <section key={c.path}>
            <h3>{c.path}</h3>
            <DiffView before={c.ours} after={c.theirs} path={c.path} />
            <div className="workspace-toolbar">
              <button
                onClick={() => setEdits({ ...edits, [c.path]: c.ours || "" })}
              >
                采用当前分支内容
              </button>
              <button
                onClick={() => setEdits({ ...edits, [c.path]: c.theirs || "" })}
              >
                采用合入分支内容
              </button>
            </div>
            <textarea
              aria-label={`解决 ${c.path}`}
              value={edits[c.path] ?? ""}
              onChange={(e) => setEdits({ ...edits, [c.path]: e.target.value })}
            />
            <button
              disabled={edits[c.path] === undefined}
              onClick={() =>
                perform(async () => {
                  const file = await tool("read_file", { path: c.path });
                  await tool("propose_file_write", {
                    path: c.path,
                    content: edits[c.path],
                    expectedHash: file.hash,
                  });
                  await refresh();
                })
              }
            >
              提交解决方案供审批
            </button>
            <button
              disabled={!consent}
              onClick={() =>
                perform(async () => {
                  const file = await tool("read_file", { path: c.path });
                  await call("resolve", {
                    path: c.path,
                    expectedHash: file.hash,
                  });
                  await call("inspect");
                })
              }
            >
              文件审批写入后，标记为已解决
            </button>
          </section>
        ))}
        <label>
          合并提交说明
          <input value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <button
          disabled={!consent}
          onClick={() => perform(() => call("finish"))}
        >
          完成合并提交
        </button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
