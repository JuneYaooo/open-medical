import { useEffect, useState } from "react";
import { api } from "./agent-runtime";
import { writeLocation } from "./navigation";
import "./cohort-card.css";

// 按条件找患者的结果卡片。模型只拿到条件和汇总；这里用同一组条件在本机
// 重新查询，显示姓名并可打开档案。重新查询也反映档案的最新状态。
const STATUS = { match: "符合", unclear: "待核对", mismatch: "不符合" };
const GENDER = { male: "男", female: "女" };

function openPatient(id) {
  writeLocation("patients", { id, tab: "overview" });
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function CohortCard({ artifact, variant, onOpen }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("match"),
    [showMismatch, setShowMismatch] = useState(false);
  const spec = artifact?.spec;
  useEffect(() => {
    if (!spec || variant === "teaser") return;
    let alive = true;
    setError("");
    api("/api/cohort/query", "POST", { spec, includeMismatch: showMismatch })
      .then((value) => alive && setData(value))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [spec, variant, showMismatch]);
  if (!spec) return null;
  const counts = (variant === "teaser" ? null : data?.counts) || artifact.counts || {};
  const conditions = spec.conditions || [];
  const summary = (
    <p className="cohort-counts">
      共 {counts.total ?? 0} 位患者：<strong>符合 {counts.match ?? 0}</strong> · 待核对 {counts.unclear ?? 0} · 不符合 {counts.mismatch ?? 0}
    </p>
  );
  if (variant === "teaser")
    return (
      <section className="cohort-card" aria-label="按条件找患者">
        <header>
          <span className="cohort-eyebrow">按条件找患者 · 待复核</span>
          <h3>{spec.title}</h3>
        </header>
        {summary}
        <ul className="cohort-conditions">
          {conditions.map((c, i) => (
            <li key={i}>{c.description || c.label}</li>
          ))}
        </ul>
        {onOpen && (
          <button type="button" onClick={onOpen}>
            查看患者名单与判断依据
          </button>
        )}
      </section>
    );
  const rows = (data?.rows || []).filter((row) => filter === "all" || row.status === filter);
  return (
    <section className="cohort-card" aria-label="按条件找患者">
      <header>
        <span className="cohort-eyebrow">按条件找患者 · 待复核</span>
        <h3>{spec.title}</h3>
      </header>
      <details open className="cohort-spec">
        <summary>筛选条件（助手根据你的描述整理，请核对口径）</summary>
        <ol>
          {conditions.map((c, i) => {
            const tally = data?.perCondition?.[i];
            return (
              <li key={i}>
                <span>{c.description || c.label}</span>
                {c.label && c.description && c.label !== c.description && <small>原文：{c.label}</small>}
                {tally && (
                  <small>
                    符合 {tally.met} · 不符合 {tally.not_met} · 待核对 {tally.unknown}
                  </small>
                )}
              </li>
            );
          })}
        </ol>
      </details>
      {summary}
      <p className="cohort-note">缺资料、单位不同或只有出生年份在边界上的患者列为“待核对”，不当作不符合。名单是初筛草稿，不能直接作为入组或诊疗决定。</p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">正在按条件查询本机患者档案…</p>}
      {data && (
        <>
          <div className="cohort-filter" role="group" aria-label="按结果筛选">
            {[["match", "符合"], ["unclear", "待核对"], ...(showMismatch ? [["mismatch", "不符合"]] : []), ["all", "全部"]].map(([key, label]) => (
              <button type="button" key={key} aria-pressed={filter === key} className={filter === key ? "" : "secondary"} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
            <label>
              <input type="checkbox" checked={showMismatch} onChange={(e) => setShowMismatch(e.target.checked)} />
              同时列出不符合的患者
            </label>
          </div>
          {rows.length ? (
            <table className="cohort-table">
              <thead>
                <tr>
                  <th scope="col">患者</th>
                  <th scope="col">结果</th>
                  <th scope="col">需要核对的条件</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const open = row.results.filter((r) => r.verdict !== "met");
                  return (
                    <tr key={row.patientId}>
                      <td>
                        <button type="button" className="text-button" onClick={() => openPatient(row.patientId)}>
                          {row.name || "未命名患者"}
                        </button>
                        <small>
                          {[row.patientNumber, GENDER[row.gender], row.birthYear ? `${row.birthYear} 年生` : ""].filter(Boolean).join(" · ")}
                        </small>
                      </td>
                      <td>
                        <span className={`cohort-status ${row.status}`}>{STATUS[row.status]}</span>
                      </td>
                      <td>
                        {open.length ? (
                          <ul>
                            {open.map((r) => (
                              <li key={r.index}>
                                第 {r.index + 1} 条{r.verdictLabel}：{r.evidence}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <details>
                            <summary>全部条件符合</summary>
                            <ul>
                              {row.results.map((r) => (
                                <li key={r.index}>
                                  第 {r.index + 1} 条：{r.evidence}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p>这一类没有患者。</p>
          )}
          {data.truncated && <p className="cohort-note">名单较长，只显示前 500 位。</p>}
          <p className="cohort-note">按 {new Date(data.evaluatedAt).toLocaleString("zh-CN")} 的档案查询。</p>
        </>
      )}
    </section>
  );
}
