import { useEffect, useState } from "react";
import { api } from "./agent-runtime";
const labels = {
  running: "正在自动核对",
  completed: "AI 初筛已完成",
  failed: "本次未完成",
  cancelled: "已停止",
  interrupted: "上次处理中断",
};
export function TrialAIReview({ trial, patientId, onAdopt }) {
  const [job, setJob] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("attention");
  const base = `/api/trials/${trial.id}/screenings/${patientId}/ai`;
  useEffect(() => {
    let live = true,
      timer;
    const load = async () => {
      try {
        const data = await api(base);
        if (live) {
          setJob(data.jobs[0] || null);
          setError("");
        }
      } catch (e) {
        if (live) setError(e.message);
      } finally {
        if (live) timer = setTimeout(load, 2000);
      }
    };
    load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [base]);
  const action = async (fn) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setJob(await fn());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const conflict = (c) =>
    c.value ===
    (trial.criteria.find((t) => t.id === c.id)?.kind === "include"
      ? "no"
      : "yes");
  const checks = (job?.checks || []).filter(
    (c) => filter === "all" || c.value === "unknown" || conflict(c),
  );
  return (
    <section className="trial-ai" aria-label="AI 自动纳排">
      <div className="module-head">
        <div>
          <h2>AI 自动纳排</h2>
          <p>
            读取已有病历，逐条判断入选与排除条件。你只需核对依据、处理待补资料。
          </p>
        </div>
        <button
          className="primary"
          disabled={busy || job?.status === "running"}
          onClick={() =>
            action(() => api(base, "POST", { externalConsent: true }))
          }
        >
          {job ? "重新自动初筛" : "开始自动初筛"}
        </button>
      </div>
      <small className="muted">
        所选患者资料将交由当前配置模型处理。可离开此页，处理与结果保存在本机。
      </small>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {job && (
        <>
          <div className="trial-ai-state" role="status">
            <b>{labels[job.status] || job.status}</b>
            <span>
              已核对 {job.checks.length} / {job.total} 项 · 筛选日期{" "}
              {job.screeningDate}
            </span>
            {job.status === "running" && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => action(() => api(`${base}/${job.id}`, "DELETE"))}
              >
                停止初筛
              </button>
            )}
          </div>
          {job.status === "running" && (
            <progress
              aria-label="纳排核对进度"
              value={job.checks.length}
              max={job.total}
            />
          )}
          {job.error && <p className="form-notice">{job.error}</p>}
          {job.stale && (
            <p className="form-error">
              患者资料在本次初筛后有变化，请重新初筛后再采用。
            </p>
          )}
          <div className="trial-ai-stats">
            <div>
              <strong>{job.conflicts}</strong>条件冲突
            </div>
            <div>
              <strong>{job.missing}</strong>待补资料
            </div>
            <div>
              <strong>{job.checks.length - job.conflicts - job.missing}</strong>
              已有依据支持
            </div>
          </div>
          {job.status === "completed" && (
            <p>
              {job.conflicts
                ? "存在条件冲突，请先查看具体原因。"
                : job.missing
                  ? "请先补齐关键资料，暂不能判断全部符合。"
                  : "已逐项形成初筛判断，可提交研究团队进一步确认。"}{" "}
              正式资格以当前完整方案和研究团队筛选为准。
            </p>
          )}
          <div className="module-actions">
            <button
              className={filter === "attention" ? "primary" : "secondary"}
              onClick={() => setFilter("attention")}
            >
              先看冲突与待补
            </button>
            <button
              className={filter === "all" ? "primary" : "secondary"}
              onClick={() => setFilter("all")}
            >
              全部条件（{job.total}）
            </button>
          </div>
          {checks.length === 0 && (
            <p className="muted">
              {job.status === "running"
                ? "AI 正在读取病历并核对条件，首批结果会自动出现在这里。"
                : job.checks.length
                  ? "已完成项目中没有冲突或待补项，可查看全部条件。"
                  : "尚未生成逐项判断，可重新初筛。"}
            </p>
          )}
          <div className="trial-ai-results">
            {checks.map((c) => {
              const criterion = trial.criteria.find((t) => t.id === c.id);
              return (
                <article
                  className={`trial-ai-item ${conflict(c) ? "is-conflict" : c.value === "unknown" ? "is-missing" : "is-supported"}`}
                  key={c.id}
                >
                  <div className="trial-ai-item-head">
                    <small>
                      {criterion.kind === "include" ? "入选条件" : "排除条件"}
                    </small>
                    <b>
                      {c.value === "unknown"
                        ? "待补资料"
                        : conflict(c)
                          ? criterion.kind === "include"
                            ? "不满足"
                            : "触发排除"
                          : criterion.kind === "include"
                            ? "满足"
                            : "未触发"}
                    </b>
                  </div>
                  <h3>{criterion.text}</h3>
                  <p>{c.reason}</p>
                  {c.missing && (
                    <p>
                      <b>需补充：</b>
                      {c.missing}
                    </p>
                  )}
                  {c.evidenceDate && <small>资料日期：{c.evidenceDate}</small>}
                  {c.citations.length > 0 && (
                    <details>
                      <summary>查看病历依据（{c.citations.length}）</summary>
                      {c.citations.map((ref, i) => (
                        <blockquote key={i}>
                          <p>{ref.quote}</p>
                          <small>
                            {ref.sourceName} · 第 {ref.startLine}–{ref.endLine}{" "}
                            行
                          </small>
                        </blockquote>
                      ))}
                    </details>
                  )}
                </article>
              );
            })}
          </div>
          {job.status === "completed" && (
            <button
              className="secondary"
              disabled={job.stale || busy}
              onClick={() => onAdopt(job)}
            >
              将 AI 结果带入医生核对
            </button>
          )}
          <small className="muted">
            AI 草稿独立保存，不会修改患者档案或覆盖医生核对记录。
          </small>
        </>
      )}
    </section>
  );
}
