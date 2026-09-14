import { Conflicts } from "./workbench/conflicts";
import { RemoteGit } from "./workbench/remote-git";
import { useState } from "react";
import { api } from "./agent-runtime";

export function WorkspaceDevelopment({ current, busy, act, refresh, select }) {
  const [git, setGit] = useState(null),
    [branch, setBranch] = useState(""),
    [consent, setConsent] = useState(false);
  const [command, setCommand] = useState("node --test"),
    [result, setResult] = useState(null);
  const [selected, setSelected] = useState([]),
    [commitMessage, setCommitMessage] = useState(""),
    [diff, setDiff] = useState("");
  const base = `/api/workspaces/${current.id}`;
  const pending = current.approvals.filter((a) => a.status === "pending");
  return (
    <>
      <Conflicts
        key={`conflicts-${current.id}`}
        current={current}
        disabled={busy}
        refresh={refresh}
      />
      <RemoteGit key={current.id} current={current} disabled={busy} />
      {current.artifacts?.length > 0 && (
        <section className="workspace-artifacts">
          <h3>生成的文件</h3>
          {current.artifacts.map((item) => (
            <div className="workspace-toolbar" key={item.id}>
              <span>
                {item.name} · {(item.size / 1024).toFixed(1)} KB
              </span>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const response = await api(base + "/artifacts/" + item.id, {
                      raw: true,
                    });
                    const url = URL.createObjectURL(await response.blob());
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = item.name.split(/[\\/]/).at(-1);
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  })
                }
              >
                下载
              </button>
            </div>
          ))}
        </section>
      )}
      <details className="workspace-development">
        <summary>代码验证与 Git 工作树</summary>
        <p className="workspace-note">
          使用项目文本快照和待审批修改运行命令，结果保存在下方。宿主文件仍需逐项批准。
        </p>
        <label>
          验证命令
          <input value={command} onChange={(e) => setCommand(e.target.value)} />
        </label>
        <button
          className="secondary"
          disabled={
            busy || !command || !current.permissions.grants["process.spawn"]
          }
          onClick={() =>
            act(async () => {
              const r = await api(base + "/tools", "POST", {
                tool: "terminal_run",
                arguments: {
                  command,
                  snapshot: true,
                  approvalIds: pending.map((a) => a.id),
                },
              });
              setResult(r);
              await refresh();
            })
          }
        >
          在隔离快照中验证 {pending.length} 项提案
        </button>
        {!current.permissions.grants["process.spawn"] && (
          <p className="workspace-note">
            先在「工具、插件与记忆」启用终端并选择本地镜像。
          </p>
        )}
        {result && (
          <pre>
            {result.status} · exit {result.exitCode ?? "等待"}
            {"\n"}
            {result.output}
            {result.error && `\n${result.error}`}
          </pre>
        )}
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            act(async () => {
              setGit(
                await api(base + "/tools", "POST", {
                  tool: "git_status",
                  arguments: {},
                }),
              );
              setSelected([]);
            })
          }
        >
          读取 Git 状态
        </button>
        {git && (
          <div>
            <p>
              {git.branch || "游离 HEAD"} ·{" "}
              {git.head?.slice(0, 12) || "尚无提交"}
            </p>
            <pre>
              {git.entries.map((e) => `${e.status} ${e.path}`).join("\n") ||
                "无可见变更"}
            </pre>
          </div>
        )}
        {git?.head && (
          <div>
            {git.entries.map((entry) => (
              <div className="workspace-toolbar" key={entry.path}>
                <label className="workspace-checkbox">
                  <input
                    type="checkbox"
                    disabled={busy || !entry.committable}
                    checked={selected.includes(entry.path)}
                    onChange={(e) =>
                      setSelected((old) =>
                        e.target.checked
                          ? [...old, entry.path]
                          : old.filter((p) => p !== entry.path),
                      )
                    }
                  />
                  {entry.path}
                </label>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    act(async () =>
                      setDiff(
                        (
                          await api(base + "/tools", "POST", {
                            tool: "git_diff",
                            arguments: { path: entry.path },
                          })
                        ).diff,
                      ),
                    )
                  }
                >
                  查看 diff
                </button>
              </div>
            ))}
            {diff && <pre>{diff}</pre>}
            <label>
              本地提交说明
              <input
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
              />
            </label>
            <button
              className="secondary"
              disabled={
                busy ||
                !selected.length ||
                !commitMessage.trim() ||
                !current.permissions.grants["filesystem.write"]
              }
              onClick={() =>
                act(async () => {
                  await api(base + "/commit", "POST", {
                    consent: true,
                    revision: current.revision,
                    expectedHead: git.head,
                    message: commitMessage,
                    files: git.entries
                      .filter((e) => selected.includes(e.path))
                      .map(({ path, hash }) => ({ path, hash })),
                  });
                  setGit(
                    await api(base + "/tools", "POST", {
                      tool: "git_status",
                      arguments: {},
                    }),
                  );
                  setSelected([]);
                  setCommitMessage("");
                  await refresh();
                })
              }
            >
              确认提交 {selected.length} 个所选文件到本地 Git
            </button>
          </div>
        )}
        <label>
          新分支
          <input
            placeholder="agent/my-task"
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value);
              setConsent(false);
            }}
          />
        </label>
        <label className="workspace-checkbox">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          从已提交 HEAD 创建独立工作树和新分支；未提交文件不复制。
        </label>
        <button
          className="secondary"
          disabled={
            busy ||
            !consent ||
            !git?.head ||
            !/^agent\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}$/.test(branch)
          }
          onClick={() =>
            act(async () => {
              const w = await api(base + "/worktree", "POST", {
                revision: current.revision,
                expectedHead: git.head,
                branch,
                consent,
              });
              await select(w.id);
            })
          }
        >
          创建隔离工作树
        </button>
      </details>
      {current.plan && (
        <section className="workspace-plan">
          <h3>执行计划</h3>
          <ol>
            {current.plan.steps.map((step, i) => (
              <li key={i}>
                <b>
                  {
                    {
                      pending: "待执行",
                      in_progress: "执行中",
                      completed: "已完成",
                      blocked: "受阻",
                    }[step.status]
                  }
                </b>{" "}
                · {step.title}
              </li>
            ))}
          </ol>
        </section>
      )}
      {current.verifications?.length > 0 && (
        <details>
          <summary>命令验证记录（{current.verifications.length}）</summary>
          {current.verifications
            .slice(-10)
            .reverse()
            .map((v) => (
              <article key={v.id}>
                <b>{v.exitCode === 0 ? "通过" : "未通过"}</b> · exit{" "}
                {v.exitCode ?? "—"} · 隔离容器<pre>{v.command}</pre>
                <small>
                  快照 {v.inputs.length} 个文件 · 提案 {v.approvalIds.length} 项
                  · {new Date(v.completedAt).toLocaleString("zh-CN")}
                </small>
              </article>
            ))}
        </details>
      )}
    </>
  );
}
