import { useEffect, useState } from "react";
import { api } from "./agent-runtime";
import { useDevInfo } from "./dev-info";
import { AiConsentNote, useAiConsent } from "./ai-consent";

const labels = {
  active: "等待执行",
  running: "执行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  interrupted: "已中断",
};
const initialTime = () => {
  const date = new Date(Date.now() + 5 * 60000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
export function TaskCenter({ session, fileIds, config, onSandbox, onChanged, onModelSettings }) {
  const [devInfo] = useDevInfo();
  const [tabValue, setTab] = useState("schedules"),
    [jobs, setJobs] = useState([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [name, setName] = useState("医疗资料定期整理"),
    [message, setMessage] = useState(
      "请整理当前材料的病历时间线，保留原文来源。",
    ),
    [runAt, setRunAt] = useState(initialTime),
    [interval, setIntervalValue] = useState("0"),
    [localConsent, setConsent] = useState(false);
  const { granted: aiGranted } = useAiConsent();
  const consent = aiGranted || localConsent;
  const [code, setCode] = useState(
    'result = {"资料数": len(sources), "原文行数": sum(len(s["text"].splitlines()) for s in sources)}',
  );
  // 隔离计算（沙箱 Python）属于开发者工具，未开启开发者信息时只显示计划任务。
  const tab = devInfo ? tabValue : "schedules";
  const base = `/api/sessions/${session.id}/schedules`;
  const scopeKey = fileIds.join(",");
  useEffect(() => {
    setConsent(false);
  }, [scopeKey]);
  const refresh = async () => setJobs((await api(base)).jobs);
  useEffect(() => {
    let live = true;
    const load = () =>
      api(base)
        .then((data) => {
          if (live) setJobs(data.jobs);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    load();
    const timer = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [base]);
  const act = async (action) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="task-center">
      <div className="task-tabs">
        <button
          className={tab === "schedules" ? "active" : ""}
          onClick={() => setTab("schedules")}
        >
          计划任务
        </button>
        {devInfo && <button
          className={tab === "sandbox" ? "active" : ""}
          onClick={() => setTab("sandbox")}
        >
          隔离计算
        </button>}
      </div>
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}
      {tab === "schedules" ? (
        <>
          <p className="muted">
            计划保存在本机，需要本地服务保持运行。错过的多次执行会合并一次；运行失败后暂停，避免反复生成错误草稿。
          </p>
          <form
            className="task-form"
            onSubmit={(e) => {
              e.preventDefault();
              act(async () => {
                await api(base, {
                  method: "POST",
                  body: JSON.stringify({
                    name,
                    sessionRevision: session.revision,
                    message,
                    runAt: new Date(runAt).toISOString(),
                    intervalMinutes: Number(interval),
                    mode: "model",
                    externalConsent: consent,
                    fileIds,
                  }),
                });
                setConsent(false);
              });
            }}
          >
            <label>
              计划名称
              <input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              任务内容
              <textarea
                required
                rows={2}
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  setConsent(false);
                }}
              />
            </label>
            <div className="task-grid">
              <label>
                首次执行（本机时区）
                <input
                  type="datetime-local"
                  step="1"
                  required
                  value={runAt}
                  onChange={(e) => {
                    setRunAt(e.target.value);
                    setConsent(false);
                  }}
                />
              </label>
              <label>
                重复间隔
                <select
                  value={interval}
                  onChange={(e) => {
                    setIntervalValue(e.target.value);
                    setConsent(false);
                  }}
                >
                  <option value="0">只执行一次</option>
                  {(devInfo || interval === "1") && <option value="1">每分钟（验证用）</option>}
                  <option value="60">每小时</option>
                  <option value="1440">每 24 小时</option>
                  <option value="10080">每 7 天</option>
                </select>
              </label>
            </div>
            {!config?.modelConfigured && (
              <p className="task-error">需先连接模型：计划任务由模型按时执行。{onModelSettings && <> <button type="button" className="text-button" onClick={onModelSettings}>连接模型</button></>}</p>
            )}
            <p className="muted">
              固定使用当前选中的 {fileIds.length}{" "}
              份材料；新增材料不会自动加入。修改材料或模型服务后需重新创建模型计划。
            </p>
            {aiGranted && <p><AiConsentNote /></p>}
            {!aiGranted && <label className="task-check">
              <input
                type="checkbox"
                checked={localConsent}
                disabled={!config?.modelConfigured}
                onChange={(e) => setConsent(e.target.checked)}
              />
              我已核对任务及选中材料，授权该计划按上述频率重复发送给当前模型服务，直至暂停或删除。
            </label>}
            <button
              className="primary"
              disabled={busy || !config?.modelConfigured || !consent}
            >
              保存计划
            </button>
          </form>
          <h3>已有计划 · {jobs.length}</h3>
          {!jobs.length && <p className="muted">还没有计划任务。</p>}
          {jobs.map((job) => (
            <section className="schedule-card" key={job.id}>
              <div>
                <b>{job.name}</b>
                <span className={`badge ${job.status}`}>
                  {labels[job.status]}
                </span>
              </div>
              <p>{job.message}</p>
              <small>
                {new Date(job.nextRunAt).toLocaleString("zh-CN")} ·{" "}
                {job.intervalMinutes
                  ? `每 ${job.intervalMinutes} 分钟`
                  : "单次"}
              </small>
              {job.lastError && <p className="task-error">{job.lastError}</p>}
              <div className="task-actions">
                {job.status === "running" ? (
                  <button
                    disabled={busy}
                    onClick={() =>
                      act(() =>
                        api(`/api/chat/${session.id}/cancel`, {
                          method: "POST",
                          body: "{}",
                        }),
                      )
                    }
                  >
                    停止本次执行
                  </button>
                ) : (
                  <>
                    {job.status !== "completed" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          act(() =>
                            api(`${base}/${job.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({
                                revision: job.revision,
                                status:
                                  job.status === "paused" ? "active" : "paused",
                              }),
                            }),
                          )
                        }
                      >
                        {job.status === "paused" ? "恢复" : "暂停"}
                      </button>
                    )}
                    <button
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          api(`${base}/${job.id}`, {
                            method: "DELETE",
                            body: JSON.stringify({ revision: job.revision }),
                          }),
                        )
                      }
                    >
                      删除计划
                    </button>
                  </>
                )}
              </div>
              {job.history.length > 0 && (
                <details>
                  <summary>执行记录（{job.history.length}）</summary>
                  {job.history
                    .slice()
                    .reverse()
                    .map((h, i) => (
                      <p key={`${h.time}-${i}`}>
                        {new Date(h.time).toLocaleString("zh-CN")} ·{" "}
                        {labels[h.status] || h.status}
                        {h.error ? ` · ${h.error}` : ""}
                        <small>
                          {h.runId ? `运行 ID：${h.runId}` : "执行前检查未通过"}
                        </small>
                      </p>
                    ))}
                </details>
              )}
            </section>
          ))}
        </>
      ) : (
        <>
          <p>
            当前沙箱：
            <b>
              {config?.sandbox?.available ? config.sandbox.backend : "不可用"}
            </b>
          </p>
          <p className="muted">
            Python
            标准库，可读取本次选中资料和任务文本。禁止联网、写入文件及创建子进程；5
            秒超时，输出最多 64KB。将计算结果赋给 <code>result</code>
            ，运行后可在本次任务中查看结果。本次将传入 {fileIds.length} 份资料（
            <code>sources</code>，最后一项是任务文本），合计不超过 500KB。
          </p>
          {!config?.sandbox?.available && (
            <p className="task-error">{config?.sandbox?.reason}</p>
          )}
          <label className="task-code">
            Python 代码
            <textarea
              rows={8}
              spellCheck={false}
              aria-label="沙箱 Python 代码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={!config?.sandbox?.available || !code.trim()}
            onClick={() => onSandbox(code)}
          >
            在沙箱中执行
          </button>
        </>
      )}
    </div>
  );
}
