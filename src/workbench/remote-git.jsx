import { useState } from "react";
import { api } from "../agent-runtime";
export function RemoteGit({ current, disabled }) {
  const [state, setState] = useState(null),
    [review, setReview] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState(false),
    [result, setResult] = useState(null);
  const [form, setForm] = useState({ base: "main", title: "", body: "" });
  async function call(action, more = {}) {
    setBusy(true);
    setError("");
    try {
      const data = await api(
        `/api/workspaces/${current.id}/remote-git`,
        "POST",
        {
          action,
          consent,
          revision: current.revision,
          expectedHead: state?.local.head,
          ...more,
        },
      );
      if (action === "status") setState(data);
      else if (action === "review") setReview(data);
      else setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>GitHub 推送与 Pull Request</summary>
      <p>使用本机 GitHub CLI 登录。首次使用可在系统终端执行 gh auth login。</p>
      <fieldset disabled={disabled || busy}>
        <label className="workspace-checkbox">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          允许连接 GitHub；点击推送会上传提交历史，创建草稿 PR
          会发布下方标题与说明。
        </label>
        <button disabled={!consent} onClick={() => call("status")}>
          读取账号与仓库
        </button>
        {state && (
          <>
            <p>
              {state.account} · {state.repository} · {state.local.branch}
            </p>
            <button
              disabled={!consent || !current.permissions.grants["git.write"]}
              onClick={() => call("push")}
            >
              推送当前任务分支
            </button>
            {Object.entries({
              base: "目标分支",
              title: "PR 标题",
              body: "PR 说明",
            }).map(([key, label]) => (
              <label key={key}>
                {label}
                {key === "body" ? (
                  <textarea
                    value={form[key]}
                    onChange={(e) =>
                      setForm({ ...form, [key]: e.target.value })
                    }
                  />
                ) : (
                  <input
                    value={form[key]}
                    onChange={(e) =>
                      setForm({ ...form, [key]: e.target.value })
                    }
                  />
                )}
              </label>
            ))}
            <button
              disabled={
                !consent ||
                !form.title ||
                !current.permissions.grants["git.write"]
              }
              onClick={() => call("create", form)}
            >
              创建草稿 PR
            </button>
            <button
              disabled={!consent || !current.permissions.grants["git.write"]}
              onClick={() => call("fetch")}
            >
              获取远端最新分支
            </button>
            <h3>打开的 PR</h3>
            {state.pulls.map((p) => (
              <div key={p.number}>
                <button
                  disabled={!consent}
                  onClick={() => call("review", { number: p.number })}
                >
                  #{p.number} {p.title}
                </button>
              </div>
            ))}
          </>
        )}
        {review && (
          <section>
            <h3>
              #{review.number} {review.title}
            </h3>
            <a href={review.url} target="_blank" rel="noreferrer">
              在 GitHub 打开
            </a>
            <p>
              HEAD {review.head} ·{" "}
              {review.mergeable === false
                ? "存在合并冲突"
                : review.mergeable === true
                  ? "可以合并"
                  : "合并状态待计算"}
            </p>
            {review.truncated && <p>文件过多，未完整载入。</p>}
            {review.files.map((f) => (
              <details key={f.path}>
                <summary>
                  {f.path} +{f.additions} −{f.deletions}
                </summary>
                <pre>{f.patch || "二进制或过大文件，请在 GitHub 查看。"}</pre>
              </details>
            ))}
          </section>
        )}
      </fieldset>
      {result && (
        <p>
          {result.url ? (
            <a href={result.url} target="_blank" rel="noreferrer">
              打开 PR #{result.number}
            </a>
          ) : (
            "推送已完成"
          )}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
