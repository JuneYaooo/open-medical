import { useEffect, useState } from "react";
import { api } from "../agent-runtime";
export function RemoteJobs({ current, refresh }) {
  const [url, setUrl] = useState(""),
    [token, setToken] = useState(""),
    [prompt, setPrompt] = useState(""),
    [paths, setPaths] = useState(""),
    [consent, setConsent] = useState(false),
    [jobs, setJobs] = useState([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const base = `/api/workspaces/${current.id}/remote-jobs`;
  useEffect(() => {
    let alive = true;
    api(base, "POST", { action: "list" })
      .then((d) => {
        if (alive) {
          setJobs(d.jobs);
          setUrl(d.url || "");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [base]);
  async function run(input) {
    setBusy(true);
    setError("");
    try {
      const d = await api(base, "POST", input);
      if (d.jobs) setJobs(d.jobs);
      if (input.action === "configure") setToken("");
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>远程执行与云端 Worker</summary>
      <p>
        文件发送到你部署的队列，由 Worker
        上配置的模型执行。结果先回到本地审批，不覆盖当前文件。
      </p>
      <label>
        队列地址
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://agent.example.com/"
        />
      </label>
      <label>
        客户端令牌
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        授权连接并上传下方指定文件与任务
      </label>
      <button
        disabled={!consent || !token || busy}
        onClick={() => run({ action: "configure", url, token, consent })}
      >
        保存加密连接
      </button>
      <label>
        任务说明
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <label>
        文件相对路径，每行一项
        <textarea value={paths} onChange={(e) => setPaths(e.target.value)} />
      </label>
      <button
        disabled={!consent || !prompt.trim() || busy}
        onClick={() =>
          run({
            action: "submit",
            prompt,
            paths: paths
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            consent,
          })
        }
      >
        提交远程任务
      </button>
      {jobs.map((job) => (
        <article key={job.id}>
          <p>
            {job.id} · {job.status}
          </p>
          {job.error && <p>{job.error}</p>}
          <button
            disabled={busy}
            onClick={() => run({ action: "refresh", id: job.id })}
          >
            重新查询
          </button>
          <button
            disabled={
              busy || !consent || !["running", "queued"].includes(job.status)
            }
            onClick={() => run({ action: "cancel", id: job.id, consent })}
          >
            取消
          </button>
          <button
            disabled={
              busy ||
              !consent ||
              !["interrupted", "failed", "cancelled"].includes(job.status)
            }
            onClick={() => run({ action: "retry", id: job.id, consent })}
          >
            重新执行
          </button>
          <button
            disabled={
              busy ||
              !consent ||
              job.imported ||
              !["completed", "failed"].includes(job.status)
            }
            onClick={() => run({ action: "import", id: job.id, consent })}
          >
            {job.imported ? "已导入审批" : "导入结果与文件审批"}
          </button>
          <button
            disabled={
              busy || !consent || ["running", "queued"].includes(job.status)
            }
            onClick={() => run({ action: "remove", id: job.id, consent })}
          >
            删除远端记录
          </button>
        </article>
      ))}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
