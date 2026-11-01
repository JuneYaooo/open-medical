import { useState } from "react";
import { api } from "../../../src/agent-runtime";
import { CohortCard } from "../../../src/cohort-card.jsx";
import "../../../src/cohort-card.css";
import "./cohort-comparison.css";

// 队列比较结果卡片：分组口径、各组人数与缺失、检验、p 值、效应量与 CI、警示。
// 数值都来自本机确定性计算；这里只负责呈现。各组名单用同一组条件在本机
// 重新查询（CohortCard），姓名只在本机界面显示。
const fmt = (value, digits = 3) =>
  typeof value === "number" && Number.isFinite(value) ? String(Number(value.toFixed(digits))) : "—";
const pText = (p) => (typeof p !== "number" ? "—" : p < 0.001 ? "< 0.001" : fmt(p, 3));
const ci = (pair, digits = 3) => (Array.isArray(pair) && pair[0] !== null ? `${fmt(pair[0], digits)} 至 ${fmt(pair[1], digits)}` : "—");
const pct = (value) => (typeof value === "number" ? `${fmt(value * 100, 1)}%` : "—");

function groupStat(group, outcome) {
  const s = group.summary || {};
  if (!s.n) return "无可分析数据";
  if (outcome.type === "condition") return `是 ${s.met} / ${s.n}（${pct(s.proportion)}，95% CI ${pct(s.ci95?.[0])}–${pct(s.ci95?.[1])}）`;
  return `均值 ${fmt(s.mean)} ± ${fmt(s.sd)}；中位数 ${fmt(s.median)}（IQR ${fmt(s.q1)}–${fmt(s.q3)}）`;
}

function comparisonInput(artifact) {
  return {
    title: String(artifact.title || "").replace(/^队列比较：/, "") || "队列比较",
    groups: artifact.groups.map((g) => ({ label: g.label, spec: g.spec })),
    outcome: artifact.outcome,
    includeArchived: Boolean(artifact.population?.includeArchived),
  };
}

export function CohortComparison({ artifact, variant, onOpen }) {
  const [openGroup, setOpenGroup] = useState(null),
    [exporting, setExporting] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  if (!artifact?.groups?.length || !artifact.outcome) return null;
  const outcome = artifact.outcome;
  const primary = artifact.tests?.find((t) => t.primary) || null;
  const effect = artifact.effect;
  const headline = (
    <div className="cmp-headline" role="status">
      {primary ? (
        <>
          <strong>p {pText(primary.p)}</strong>
          <span>{primary.name}</span>
        </>
      ) : (
        <strong>未做统计检验</strong>
      )}
      {effect && (
        <span>
          {effect.name} {fmt(effect.estimate)}
          {effect.ci95 ? `（95% CI ${ci(effect.ci95)}）` : ""}
        </span>
      )}
    </div>
  );
  const head = (
    <header>
      <span className="cohort-eyebrow">队列比较 · 探索性草稿 · 本机计算</span>
      <h3>{artifact.title}</h3>
      {artifact.question && <p className="cohort-note">研究问题：{artifact.question}</p>}
      <p>结局：{outcome.description || outcome.label}</p>
    </header>
  );
  if (variant === "teaser")
    return (
      <section className="cohort-card cmp-card" aria-label="队列比较">
        {head}
        {headline}
        <ul className="cohort-conditions">
          {artifact.groups.map((g) => (
            <li key={g.label}>
              {g.label}：可分析 {g.analyzed} 例
            </li>
          ))}
        </ul>
        {onOpen && (
          <button type="button" onClick={onOpen}>
            查看比较详情与缺失情况
          </button>
        )}
      </section>
    );

  const exportCsv = async () => {
    setExporting(true);
    setError("");
    setNotice("");
    try {
      const value = await api("/api/research/cohort-export", "POST", { comparison: comparisonInput(artifact) });
      const url = URL.createObjectURL(new Blob(["﻿", value.csv], { type: "text/csv" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `脱敏队列-${value.title.slice(0, 30)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(`已导出 ${value.rows} 行（按当前档案重新分组）。${value.note}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  };
  const population = artifact.population || {};
  return (
    <section className="cohort-card cmp-card" aria-label="队列比较">
      {head}
      {headline}
      <table className="cohort-table cmp-table">
        <thead>
          <tr>
            <th scope="col">组别</th>
            <th scope="col" className="num">符合条件</th>
            <th scope="col" className="num">可分析</th>
            <th scope="col">结局</th>
            <th scope="col">缺失与排除</th>
          </tr>
        </thead>
        <tbody>
          {artifact.groups.map((g) => (
            <tr key={g.label}>
              <th scope="row">{g.label}</th>
              <td className="num">{g.matched}</td>
              <td className="num">{g.analyzed}</td>
              <td>
                {groupStat(g, outcome)}
                {g.summary?.spanDays && (
                  <small>
                    首末次间隔中位 {g.summary.spanDays.median} 天（{g.summary.spanDays.min}–{g.summary.spanDays.max}）
                  </small>
                )}
              </td>
              <td>
                <ul>
                  {g.outcomeMissing?.map((m) => (
                    <li key={m.reason}>
                      结局缺失·{m.label}：{m.count}
                    </li>
                  ))}
                  {g.excludedUnclear?.count > 0 && <li>分组条件待核对未纳入：{g.excludedUnclear.count}</li>}
                  {!g.outcomeMissing?.length && !g.excludedUnclear?.count && <li>无</li>}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="cohort-note">
        参与判断的患者 {population.total ?? "—"} 位{population.includeArchived ? "（含已归档）" : "（不含已归档）"}
        {population.overlapExcluded ? `；${population.overlapExcluded} 位同时符合多组，已排除` : ""}。缺失不当作阴性或正常。
      </p>

      <h4>统计检验</h4>
      {artifact.tests?.length ? (
        <table className="cohort-table cmp-table">
          <thead>
            <tr>
              <th scope="col">方法</th>
              <th scope="col">统计量</th>
              <th scope="col" className="num">p 值</th>
            </tr>
          </thead>
          <tbody>
            {artifact.tests.map((t) => (
              <tr key={t.method}>
                <td>
                  {t.name}
                  {t.primary && <small>主要结果{t.reason ? `（${t.reason}）` : ""}</small>}
                </td>
                <td>
                  {Object.entries(t.statistic || {})
                    .map(([k, v]) => `${k} = ${fmt(v)}`)
                    .join("，") || "—"}
                </td>
                <td className="num">{pText(t.p)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>未做统计检验，原因见下方提示。</p>
      )}
      {effect && (
        <dl className="cmp-effect">
          <div>
            <dt>{effect.name}</dt>
            <dd>
              {fmt(effect.estimate)}
              {effect.ci95 && `，95% CI ${ci(effect.ci95)}`}
              {effect.ciMethod && <small>（{effect.ciMethod}）</small>}
            </dd>
          </div>
          {effect.standardized && (
            <div>
              <dt>{effect.standardized.name}</dt>
              <dd>{fmt(effect.standardized.estimate)}</dd>
            </div>
          )}
          {effect.oddsRatio && (
            <div>
              <dt>比值比 OR</dt>
              <dd>
                {fmt(effect.oddsRatio.estimate)}，95% CI {ci(effect.oddsRatio.ci95)}
                <small>（{effect.oddsRatio.ciMethod}）</small>
              </dd>
            </div>
          )}
        </dl>
      )}

      {artifact.warnings?.length > 0 && (
        <div className="cmp-warnings">
          <h4>解读前请注意</h4>
          <ul>
            {artifact.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <details className="cohort-spec">
        <summary>各组条件与患者名单（助手根据你的描述整理，请核对口径）</summary>
        {artifact.groups.map((g) => (
          <section key={g.label} className="cmp-group">
            <h4>{g.label}</h4>
            <ol>
              {(g.spec?.conditions || []).map((c, i) => (
                <li key={i}>
                  <span>{c.description || c.label}</span>
                  {g.excludedUnclear?.byCondition?.find((b) => b.index === i) && (
                    <small>该条待核对 {g.excludedUnclear.byCondition.find((b) => b.index === i).count} 人</small>
                  )}
                </li>
              ))}
            </ol>
            <button type="button" className="secondary" aria-expanded={openGroup === g.label} onClick={() => setOpenGroup(openGroup === g.label ? null : g.label)}>
              {openGroup === g.label ? "收起名单" : `查看「${g.label}」患者名单`}
            </button>
            {openGroup === g.label && <CohortCard artifact={{ spec: g.spec }} />}
          </section>
        ))}
      </details>

      <div className="cmp-actions">
        <button type="button" className="secondary" disabled={exporting} onClick={exportCsv}>
          {exporting ? "正在导出…" : "导出脱敏队列 CSV"}
        </button>
        <small>只含假名编号、组别、年龄、性别和结局值；按导出时的档案重新分组。</small>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status" className="cohort-note">{notice}</p>}
      <p className="cohort-note">
        {artifact.analysisNumber ? `本次任务第 ${artifact.analysisNumber} 项分析；` : ""}按 {artifact.evaluatedAt ? new Date(artifact.evaluatedAt).toLocaleString("zh-CN") : "—"} 的档案计算。p 值未做多重比较校正，结果不代表因果或疗效。
      </p>
    </section>
  );
}
