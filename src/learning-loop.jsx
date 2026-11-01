import { useEffect, useState } from "react";
import { api } from "./agent-runtime";
import { useHabitMutation } from "./habit-mutation";
import { useHabitDraft } from "./habit-drafts";
import { CuratedCaseSources } from "./curated-case-sources";
import { AiConsentNote, notifyAiConsentChanged, useAiConsent } from "./ai-consent";
import "./learning-loop.css";
const sectionNames = {
  diagnoses: "诊断",
  medications: "用药",
  labs: "检验",
  visits: "就诊",
  clinicalSummary: "病史摘要",
  identity: "身份",
  tags: "标签",
  groups: "分组",
  allergies: "过敏原",
  allergy: "过敏史",
};
const fieldNames = {
  name: "名称",
  item: "项目",
  unit: "单位",
  status: "状态",
  value: "数值",
  text: "正文",
  date: "日期",
  dose: "剂量",
  frequency: "频次",
  note: "备注",
  reason: "原因",
  gender: "性别",
  birthYear: "出生年",
  phone: "电话",
  patientNumber: "编号",
  allergyStatus: "过敏情况",
};
const percent = (n) => (n == null ? "暂无" : `${Math.round(n * 100)}%`);
const stated = (h) =>
  h.origin === "stated" || h.origin === "explicit" || h.kind === "explicit";
export function memorySourceLabel(m) {
  const labels = {
    stated: "你说的",
    explicit: "你说的",
    review_diffs: "从修改学到",
    repeated_feedback: "从你重复写过的说明学到",
    review_rejected: "拒绝时的说明",
    artifact_edited: "修改草稿时的说明",
    manual: "手动添加",
  };
  return (
    labels[m.source?.type] ||
    (m.source?.via === "manual"
      ? "手动添加"
      : stated(m)
        ? "你说的"
        : m.source?.mode === "model"
          ? "从你的说明归纳"
          : m.origin === "learned"
            ? "从修改学到"
            : "你写过的说明")
  );
}
function displayValue(value) {
  if (value == null || value === "") return "（无）";
  if (Array.isArray(value)) return value.map(displayValue).join("、");
  if (typeof value === "object")
    return (
      Object.entries(value)
        .filter(([k]) => fieldNames[k])
        .map(([k, v]) => `${fieldNames[k]}：${displayValue(v)}`)
        .join("；") || "（无）"
    );
  return (
    {
      confirmed: "确诊",
      suspected: "疑似待排",
      finding: "影像检验发现",
      unknown: "待核对",
      active: "正在使用",
      stopped: "已停用",
      male: "男",
      female: "女",
      none_known: "无已知过敏",
      recorded: "已记录过敏原",
    }[value] || String(value)
  );
}
function download(value, name) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function LearningSettings() {
  const [prefs, setPrefs] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [provider, setProvider] = useState("");
  useEffect(() => {
    api("/api/learning/settings")
      .then(setPrefs)
      .catch((e) => setError(e.message));
    api("/api/bootstrap")
      .then((v) => setProvider(v?.config?.provider || v?.provider || ""))
      .catch(() => {});
  }, []);
  const save = async (value) => {
    const previous = prefs;
    setPrefs({ ...prefs, ...value });
    setBusy(true);
    try {
      setPrefs(await api("/api/learning/settings", "PUT", value));
      setError("");
      if ("defaultExternalConsent" in value) notifyAiConsentChanged(value.defaultExternalConsent);
    } catch (e) {
      setPrefs(previous);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="learning-settings" aria-label="学习与隐私">
      <h3>学习与隐私</h3>
      <p className="muted">让整理更贴近你的习惯，由你决定参考哪些内容。</p>
      {error && <p role="alert">{error}</p>}
      {prefs && (
        <>
          <div className="learning-switches">
            {[
              [
                "personalContext",
                "整理时参考我的习惯和知识",
                "带上你确认的习惯、相关知识和适用技能。",
              ],
              [
                "habits",
                "从核对修改中学习写法",
                "记住你反复修改的写法，随时可以停用或删除。",
              ],
              [
                "similarCards",
                "提示过去的相似病例",
                "打开患者档案时，展示你过去的相关病例。",
              ],
              [
                "defaultExternalConsent",
                "允许 AI 功能使用患者资料",
                "关闭后，每次使用 AI 功能前会单独询问。",
              ],
            ].map(([key, label, help]) => (
              <label className="learning-switch-row" key={key}>
                <span>
                  <strong>{label}</strong>
                  <small id={`help-${key}`}>{help}</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={label}
                  aria-describedby={`help-${key}`}
                  checked={Boolean(prefs[key])}
                  disabled={busy}
                  onChange={(e) => save({ [key]: e.target.checked })}
                />
              </label>
            ))}
          </div>
          <fieldset className="learning-privacy" disabled={busy}>
            <legend>用我过去的档案作为 AI 参考范例</legend>
            {provider &&
              provider !== "local" &&
              (prefs.examples || "local") === "local" && (
                <p className="muted" role="note">
                  当前使用云端模型（{provider}
                  ），「仅本地模型」实际不会参考历史档案；如需参考请选择「始终使用」（会先脱敏）。
                </p>
              )}
            <div className="learning-radio-cards">
              {[
                [
                  "local",
                  "仅本地模型",
                  "默认选项。只在本地模型整理时参考过去的档案。",
                ],
                [
                  "always",
                  "始终使用",
                  "移除身份信息后，将范例发送给当前模型服务。",
                ],
                ["never", "从不使用", "整理时不参考其他患者的历史档案。"],
              ].map(([value, label, help]) => (
                <label
                  className={`learning-radio-card ${prefs.examples === value ? "selected" : ""}`}
                  key={value}
                >
                  <input
                    type="radio"
                    name="learning-examples"
                    aria-label={label}
                    aria-describedby={`examples-${value}`}
                    checked={(prefs.examples || "local") === value}
                    onChange={() => save({ examples: value })}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small id={`examples-${value}`}>{help}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <details className="learning-advanced">
            <summary>高级</summary>
            <h4>试点评估</h4>
            <label className="learning-switch-row">
              <span>
                <strong>参与效果比较</strong>
                <small id="help-pilot">
                  在本机记录核对统计，随机让 20%
                  的建档不使用个性化参考，以比较效果。
                </small>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label="参与效果比较"
                aria-describedby="help-pilot"
                checked={Boolean(prefs.pilot)}
                disabled={busy}
                onChange={(e) =>
                  save({
                    pilot: e.target.checked,
                    pilotConsent: e.target.checked,
                  })
                }
              />
            </label>
            <button
              className="secondary"
              onClick={async () => {
                try {
                  download(
                    await api("/api/learning/export"),
                    "learning-statistics.json",
                  );
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              导出评估统计
            </button>
          </details>
        </>
      )}
    </section>
  );
}
// Combine cohorts by their original denominators when evaluation is off.
function weeklySeries(series, pilot) {
  if (pilot) return series;
  const weeks = new Map();
  for (const s of series) {
    const row = weeks.get(s.week) || {
      week: s.week,
      group: "all",
      items: 0,
      edits: 0,
      count: 0,
      serTotal: 0,
      ferTotal: 0,
      summaryTotal: 0,
      fastZero: 0,
      sections: {},
    };
    row.items += s.items;
    row.edits += s.edits;
    row.count += s.count;
    row.serTotal += (s.ser || 0) * s.items;
    row.ferTotal += (s.fer || 0) * s.items;
    row.summaryTotal += (s.summaryDistance || 0) * s.count;
    row.fastZero += s.fastZero || 0;
    for (const [key, part] of Object.entries(s.sections || {})) {
      const previous = row.sections[key] || { items: 0, edits: 0 };
      row.sections[key] = {
        items: previous.items + part.items,
        edits: previous.edits + part.edits,
      };
    }
    weeks.set(s.week, row);
  }
  return [...weeks.values()].map((r) => ({
    ...r,
    rate: r.items ? r.edits / r.items : null,
    ser: r.items ? r.serTotal / r.items : null,
    fer: r.items ? r.ferTotal / r.items : null,
    summaryDistance: r.summaryTotal / r.count,
    sections: Object.fromEntries(
      Object.entries(r.sections).map(([key, s]) => [
        key,
        { ...s, rate: s.items ? s.edits / s.items : null },
      ]),
    ),
  }));
}
function WeeklyLearningChart({ series, pilot }) {
  const valid = series.filter((s) => s.rate != null);
  const weeks = [...new Set(valid.map((s) => s.week))].sort();
  if (weeks.length < 2) return null;
  const maximum = Math.max(
    0.1,
    Math.ceil(Math.max(...valid.map((s) => s.rate)) * 10) / 10,
  );
  const groups = pilot
    ? [
        ["baseline", "基线", "#777"],
        ["learning", "学习", "#31745e"],
        ["holdout", "留出", "#b07732"],
      ]
    : [["all", "改动率", "#31745e"]];
  const x = (week) => 65 + (weeks.indexOf(week) * 470) / (weeks.length - 1),
    y = (rate) => 140 - (100 * rate) / maximum;
  return (
    <div className="learning-chart">
      <svg
        role="img"
        aria-label={
          pilot ? "每周平均改动率，按基线、学习与留出分组" : "每周平均改动率"
        }
        viewBox="0 0 580 175"
      >
        <text x="4" y="16" fontSize="12">
          改动率
        </text>
        {[0, maximum / 2, maximum].map((tick) => (
          <g key={tick}>
            <text x="48" y={y(tick) + 4} textAnchor="end" fontSize="12">
              {percent(tick)}
            </text>
            <line
              x1="60"
              x2="545"
              y1={y(tick)}
              y2={y(tick)}
              stroke="currentColor"
              opacity=".12"
            />
          </g>
        ))}
        {groups.map(([group, label, color]) => (
          <g key={group}>
            <polyline
              points={valid
                .filter((s) => s.group === group)
                .sort((a, b) => a.week.localeCompare(b.week))
                .map((s) => `${x(s.week)},${y(s.rate)}`)
                .join(" ")}
              fill="none"
              stroke={color}
              strokeWidth="2"
            />
            {valid
              .filter((s) => s.group === group)
              .map((s) => (
                <circle
                  key={s.week}
                  cx={x(s.week)}
                  cy={y(s.rate)}
                  r="4"
                  fill={color}
                >
                  <title>
                    {s.week} {label}：{percent(s.rate)}
                  </title>
                </circle>
              ))}
          </g>
        ))}
        {weeks
          .filter(
            (_, i) =>
              i % Math.max(1, Math.ceil(weeks.length / 6)) === 0 ||
              i === weeks.length - 1,
          )
          .map((week) => (
            <text
              key={week}
              x={x(week)}
              y="164"
              textAnchor="middle"
              fontSize="12"
            >
              {week.slice(5)}
            </text>
          ))}
      </svg>
      <p className="learning-chart-legend">
        {groups.map(([key, label, color]) => (
          <span key={key} style={{ color }}>
            ● {label}
          </span>
        ))}
      </p>
    </div>
  );
}
export function LearningStats() {
  const [selectedSection, setSelectedSection] = useState("all"),
    [stats, setStats] = useState(null),
    [pilot, setPilot] = useState(false),
    [error, setError] = useState(""),
    [details, setDetails] = useState(null);
  useEffect(() => {
    const load = () => {
      setDetails(null);
      api("/api/review-stats?range=90d")
        .then(setStats)
        .catch((e) => setError(e.message));
      api("/api/learning/settings")
        .then((p) => setPilot(p.pilot))
        .catch((e) => setError(e.message));
    };
    load();
    window.addEventListener("learning-cleared", load);
    return () => window.removeEventListener("learning-cleared", load);
  }, []);
  const series = weeklySeries(stats?.series || [], pilot);
  const comparison =
    stats?.previousAverage == null
      ? ""
      : `之前 ${stats.previousAverage.toFixed(1)} 处${stats.previousAverage > 0 ? `，${stats.recentAverage <= stats.previousAverage ? "↓" : "↑"}${Math.round((Math.abs(stats.recentAverage - stats.previousAverage) / stats.previousAverage) * 100)}%` : ""}`;
  return (
    <section
      className="doctor-section learning-stats"
      aria-label="它学得怎么样"
    >
      <h3>它学得怎么样</h3>
      {error && <p role="alert">{error}</p>}
      {stats &&
        (stats.count < 5 ? (
          <p className="muted">
            再确认 {stats.remaining} 份建档后，这里会显示 AI 草稿的改动趋势
          </p>
        ) : (
          <>
            <p className="learning-headline">
              最近 {Math.min(stats.count, 30)} 份建档，你平均每份改{" "}
              <strong>{stats.recentAverage.toFixed(1)}</strong> 处
              {comparison && (
                <span className="learning-comparison">{comparison}</span>
              )}
            </p>
            {new Set(series.map((s) => s.week)).size >= 2 && (
              <>
                <label className="learning-section-filter">
                  按分区查看{" "}
                  <select
                    value={selectedSection}
                    onChange={(e) => setSelectedSection(e.target.value)}
                  >
                    <option value="all">全部分区</option>
                    {Object.entries(sectionNames).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <WeeklyLearningChart
                  pilot={pilot}
                  series={
                    selectedSection === "all"
                      ? series
                      : series.map((s) => ({
                          ...s,
                          rate: s.sections?.[selectedSection]?.rate ?? null,
                        }))
                  }
                />
              </>
            )}
            <p className="muted">
              核对用时中位数：{Math.round(stats.medianReviewMs / 1000)} 秒
            </p>
            {!!stats.sections.length && (
              <div className="learning-top-edits">
                <h4>改得最多的地方</h4>
                {stats.sections.slice(0, 3).map((s) => {
                  const [section, field] = s.key.split("."),
                    label = `${sectionNames[section] || "其他"}${fieldNames[field] || ""}`;
                  return (
                    <button
                      className="secondary"
                      key={s.key}
                      onClick={() => {
                        setDetails(null);
                        api(
                          `/api/review-details?${new URLSearchParams({ section, field })}`,
                        )
                          .then((result) => setDetails({ ...result, label }))
                          .catch((e) => setError(e.message));
                      }}
                    >
                      {label}{" "}
                      <span>
                        {s.count} 处 ·{" "}
                        {percent(
                          s.count /
                            Math.max(
                              1,
                              stats.sections.reduce((n, v) => n + v.count, 0),
                            ),
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <details className="learning-breakdown">
              <summary>哪些是写法、哪些是内容</summary>
              <p className="muted">
                写法包括名称、单位和格式；内容包括状态、剂量和数值，内容改动不会自动变成习惯。
              </p>
              <div className="learning-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>周</th>
                      {pilot && <th>组别</th>}
                      <th>写法改动率</th>
                      <th>内容改动率</th>
                      <th>摘要改动幅度</th>
                      <th>20 秒内未修改</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.map((s) => (
                      <tr key={`${s.week}:${s.group}`}>
                        <td>{s.week}</td>
                        {pilot && (
                          <td>
                            {
                              {
                                baseline: "基线",
                                learning: "学习",
                                holdout: "留出",
                              }[s.group]
                            }
                          </td>
                        )}
                        <td>{percent(s.ser)}</td>
                        <td>{percent(s.fer)}</td>
                        <td>{percent(s.summaryDistance)}</td>
                        <td>
                          {s.fastZero}/{s.count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <small>病史摘要改动单独记录，不计入写法改动率。</small>
            </details>
          </>
        ))}
      {details && (
        <section
          className="learning-edit-details"
          aria-label={`${details.label}最近修改`}
        >
          <h4>{details.label} · 最近修改</h4>
          {details.diffs.length ? (
            details.diffs.map((d) => (
              <p key={d.id}>
                某患者：{displayValue(d.before)} → {displayValue(d.after)}
              </p>
            ))
          ) : (
            <p className="muted">暂无修改记录。</p>
          )}
          <button className="secondary" onClick={() => setDetails(null)}>
            收起明细
          </button>
        </section>
      )}
    </section>
  );
}
export function LearningDangerZone({ onClear }) {
  const [confirmClear, setConfirmClear] = useState(false),
    [includeStated, setIncludeStated] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="doctor-section learning-danger" aria-label="危险操作">
      <h3>危险操作</h3>
      <p className="muted">清空核对记录和学到的习惯，患者档案仍会保留。</p>
      {error && <p role="alert">{error}</p>}
      <button
        className="secondary danger"
        disabled={busy}
        onClick={() => setConfirmClear(true)}
      >
        清空学习记录
      </button>
      {confirmClear && (
        <div role="alert" className="learning-clear-confirm">
          <p>
            确定清空所有核对记录、学习候选和从修改学到的习惯？此操作无法撤销。
          </p>
          <label>
            <input
              type="checkbox"
              checked={includeStated}
              disabled={busy}
              onChange={(e) => setIncludeStated(e.target.checked)}
            />
            同时删除我亲口说过的习惯（默认保留）
          </label>
          <div className="toolbar-actions">
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("/api/learning/clear", "POST", {
                    confirmed: true,
                    includeStated,
                  });
                  setConfirmClear(false);
                  setIncludeStated(false);
                  setError("");
                  window.dispatchEvent(new Event("learning-cleared"));
                  await onClear?.();
                } catch (e) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认清空学习记录
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setConfirmClear(false);
                setIncludeStated(false);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
export function HabitLedger({ onChange }) {
  const mutate = useHabitMutation();
  const [conflict, setConflict] = useHabitDraft("conflict", null);
  const [habits, setHabits] = useState([]),
    [error, setError] = useState(""),
    [editing, setEditing] = useHabitDraft("editing", null),
    [text, setText] = useHabitDraft("text", ""),
    [busy, setBusy] = useState(false);
  const load = () =>
    api("/api/learning/habits")
      .then((r) => {
        setHabits(r.habits);
        if (/^#habit-\d+$/.test(location.hash))
          setTimeout(
            () =>
              document
                .getElementById(location.hash.slice(1))
                ?.scrollIntoView({ block: "center" }),
            0,
          );
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    window.addEventListener("learning-cleared", load);
    window.addEventListener("habits-changed", load);
    return () => {
      window.removeEventListener("learning-cleared", load);
      window.removeEventListener("habits-changed", load);
    };
  }, []);
  const decide = async (memory, decision, extra = {}) => {
    const id = memory.id;
    setBusy(true);
    try {
      await mutate(`/api/learning/habits/${id}/decision`, "POST", memory, {
        decision,
        ...extra,
      });
      setEditing(null);
      setText("");
      setConflict(null);
      setError("");
      await load();
      await onChange?.();
    } catch (e) {
      setError(e.message);
      if (e.status === 409 || e.code === "REVISION_CONFLICT") {
        try {
          const current = await api(`/api/learning/habits/${id}`);
          setConflict(current);
          await load();
        } catch (readError) {
          setError(`${e.message}；${readError.message}`);
        }
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="doctor-section habit-ledger" aria-label="我的习惯">
      <h3>我的习惯</h3>
      {error && <p role="alert">{error}</p>}
      {editing && (
        <div className="habit-editor" role="region" aria-label="编辑习惯措辞">
          <p className="muted">开始编辑时：{editing.content}</p>
          <label>
            习惯措辞
            <textarea value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          {conflict && (
            <div role="status">
              <p>当前记录已调整。你的草稿已保留，请对照以下当前内容。</p>
              {(conflict.related?.length ? conflict.related : [conflict]).map(
                (current) => (
                  <div key={current.id}>
                    <p>
                      当前内容：{current.content}（
                      {{
                        confirmed: "生效中",
                        paused: "已停用",
                        deleted: "已删除",
                        dismissed: "已被替代",
                      }[current.status] || current.status}
                      ）
                    </p>
                    {current.status !== "dismissed" && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          setEditing(current);
                          setConflict(null);
                          setError("");
                        }}
                      >
                        已核对，保留草稿并基于此版本继续编辑
                      </button>
                    )}
                  </div>
                ),
              )}
            </div>
          )}
          <div className="habit-actions">
            <button
              disabled={busy || !text.trim() || !!conflict}
              onClick={() => decide(editing, "edit", { content: text })}
            >
              保存措辞
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setText("");
                setConflict(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {!habits.length && (
        <p className="muted">你说出的偏好和反复修改的写法，会记在这里。</p>
      )}
      {habits.map((h) => {
        const ledger = h.ledger || {},
          counts = [
            ledger.applied ? `用上 ${ledger.applied} 次` : "还没用上",
            ledger.reverted ? `改回 ${ledger.reverted} 次` : "",
          ]
            .filter(Boolean)
            .join(" · ");
        return (
          <article
            className={`habit-row ${h.status !== "confirmed" ? "habit-inactive" : ""}`}
            key={h.id}
            id={`habit-${h.id}`}
            aria-label={h.content}
          >
            <div className="habit-row-main">
              <div>
                <p className="habit-content">
                  {h.content}{" "}
                  <span className="habit-origin">
                    {stated(h) ? "你说的" : `从你 ${h.count} 次修改学到`}
                  </span>
                </p>
                <p className="habit-stats">{counts}</p>
              </div>
              <div className="habit-actions">
                <button
                  className="secondary"
                  disabled={busy || !!editing}
                  onClick={() =>
                    decide(h, h.status === "confirmed" ? "disable" : "restore")
                  }
                >
                  {h.status === "confirmed" ? "停用" : "恢复"}
                </button>
                <button
                  className="secondary"
                  disabled={busy || !!editing}
                  onClick={() => {
                    setEditing(h);
                    setConflict(null);
                    setError("");
                    setText(h.content);
                  }}
                >
                  编辑
                </button>
                {h.status !== "deleted" && (
                  <button
                    className="secondary"
                    disabled={busy || !!editing}
                    onClick={() => decide(h, "delete")}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
            {h.status === "paused" && (
              <p className="habit-status muted">
                已暂停{ledger.conflict ? "：最近常被你改回" : ""} ·{" "}
                <button
                  className="text-button"
                  disabled={busy || !!editing}
                  onClick={() => decide(h, "restore")}
                >
                  恢复
                </button>
              </p>
            )}
            {h.status === "deleted" && (
              <p className="habit-status muted">已删除，可恢复</p>
            )}
            {stated(h) && ledger.conflict && h.status === "confirmed" && (
              <p className="habit-status muted">最近常被改回，可能已不适用</p>
            )}
            <details className="habit-details">
              <summary>详情</summary>
              <p>来源：{memorySourceLabel(h)}</p>
              {ledger.notApplicable > 0 && (
                <p>这次不适用：{ledger.notApplicable} 次</p>
              )}
              {ledger.rates && (
                <p>
                  启用前后 30 天{sectionNames[h.rule?.section] || "相关分区"}
                  改动率：{percent(ledger.rates.before)} →{" "}
                  {percent(ledger.rates.after)}
                </p>
              )}
              {h.dryrun && (
                <p>
                  上线前在你过去的档案上试过：会改对 {h.dryrun.correct}{" "}
                  处，会改错 {h.dryrun.wrong} 处
                </p>
              )}
              {h.dryrun?.examples?.length > 0 && (
                <>
                  <h4>来源修改</h4>
                  {h.dryrun.examples.map((e, i) => (
                    <p key={i}>
                      某患者：
                      {e.changes
                        .map(
                          (c) =>
                            `${displayValue(c.before)} → ${displayValue(c.after)}`,
                        )
                        .join("；")}
                    </p>
                  ))}
                </>
              )}
              {stated(h) &&
                h.evidence
                  ?.filter((e) => typeof e === "string")
                  .map((e, i) => <p key={i}>{e}</p>)}
            </details>
          </article>
        );
      })}
      {!!habits.length && (
        <button
          className="secondary habit-export"
          onClick={() =>
            download(
              habits
                .filter((h) => h.status === "confirmed")
                .map((h) => ({ content: h.content, rule: h.rule })),
              "my-habits.json",
            )
          }
        >
          导出我的习惯
        </button>
      )}
    </section>
  );
}
export function RememberedNotice({ memories: initial = [] }) {
  const mutate = useHabitMutation();
  const [memories, setMemories] = useState(initial),
    [error, setError] = useState("");
  useEffect(() => {
    if (error) return;
    const timer = setTimeout(() => setMemories([]), 5000);
    return () => clearTimeout(timer);
  }, [error]);
  if (!memories.length) return null;
  return (
    <div className="review-save-warning remembered-notice" role="status">
      ✓ 记下了：
      {memories.length > 1
        ? `${memories.length} 条习惯`
        : memories[0].content}{" "}
      <button
        className="text-button"
        onClick={async () => {
          try {
            for (const m of memories)
              await mutate(`/api/learning/habits/${m.id}/decision`, "POST", m, {
                decision: "undo",
              });
            setMemories([]);
            window.dispatchEvent(new Event("habits-changed"));
          } catch (e) {
            setError(e.message);
          }
        }}
      >
        撤销
      </button>{" "}
      ·{" "}
      <a
        href={`/?view=settings&doctor=1#habit-${memories[0].id}`}
        onClick={() =>
          api("/api/learning/events", "POST", {
            type: "habit-viewed",
            subject: String(memories[0].id),
          }).catch(() => {})
        }
      >
        查看
      </a>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function HabitSuggestion({ patientId }) {
  const [memories] = useState(() => {
    const raw = sessionStorage.getItem(`habit-suggestion:${patientId}`);
    sessionStorage.removeItem(`habit-suggestion:${patientId}`);
    try {
      const value = raw ? JSON.parse(raw) : [];
      return Array.isArray(value) ? value : [value];
    } catch {
      return [];
    }
  });
  const [paused] = useState(() => {
    const raw = sessionStorage.getItem(`habit-paused:${patientId}`);
    sessionStorage.removeItem(`habit-paused:${patientId}`);
    try {
      return JSON.parse(raw || "[]");
    } catch {
      return [];
    }
  });
  return (
    <>
      <RememberedNotice memories={memories} />
      {paused.map((id) => (
        <p role="status" key={id}>
          已暂停一条习惯：最近常被你改回 ·{" "}
          <a href={`/?view=settings&doctor=1#habit-${id}`}>查看并恢复</a>
        </p>
      ))}
    </>
  );
}
export function PersonalReferences({ action }) {
  const p = action.payload.personalization;
  const [error, setError] = useState(""),
    [feedback, setFeedback] = useState([]);
  if (!p?.habits) return null;
  if (action.payload.learningContext?.holdout)
    return <p className="muted">本次未使用参考</p>;
  return (
    <section>
      {p.examplesSkipped && <p className="muted">{p.examplesSkipped}</p>}
      <details
        onToggle={(e) => {
          if (e.currentTarget.open)
            api("/api/learning/events", "POST", {
              type: "references-expanded",
              subject: action.id,
            }).catch((err) => setError(err.message));
        }}
      >
        <summary>
          本次参考了：{p.habits.length} 条你的习惯 · {p.examples.length}{" "}
          份历史档案 · {p.knowledge.length} 篇知识
        </summary>
        {p.habits.map((h) => (
          <p key={h.id}>
            {h.content}{" "}
            <button
              disabled={feedback.includes(h.id)}
              onClick={async () => {
                try {
                  const result = await api("/api/learning/feedback", "POST", {
                    actionId: action.id,
                    habitId: h.id,
                  });
                  if (result.paused)
                    setError(
                      `暂停了习惯「${h.content}」：最近常被你改回，可在「我的习惯」恢复。`,
                    );
                  setFeedback([...feedback, h.id]);
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              {feedback.includes(h.id) ? "已记录" : "这次不适用"}
            </button>
          </p>
        ))}
        {p.examples.map((e) => (
          <p key={e.id}>
            <a
              href={`/?view=patients&patient=${encodeURIComponent(e.patientId)}`}
            >
              打开参考档案 {e.ref}
            </a>
          </p>
        ))}
        {p.knowledge.map((k) => (
          <details key={k.ref}>
            <summary>
              {k.title} 第 {k.startLine} 行
            </summary>
            <p>{k.text}</p>
          </details>
        ))}
        {p.skills?.map((s) => (
          <p key={s.id}>技能：{s.title}</p>
        ))}
      </details>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
export function SimilarCaseCard({ patientId }) {
  const [result, setResult] = useState({ patientId: null, status: "loading", matches: [], enabled: true });
  const [retry, setRetry] = useState(0), [collapsed, setCollapsed] = useState(false),
    [actionError, setActionError] = useState(""), [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setResult({ patientId, status: "loading", matches: [], enabled: true });
    setCollapsed(false); setActionError("");
    api(`/api/learning/similar/${patientId}`, { signal: controller.signal })
      .then(r => { if (!controller.signal.aborted) setResult({ patientId, status: "ready", matches: r.matches || [], enabled: r.enabled }); })
      .catch(e => { if (!controller.signal.aborted) setResult({ patientId, status: "failed", matches: [], enabled: true, error: e.message }); });
    return () => controller.abort();
  }, [patientId, retry]);
  const event = type => api("/api/learning/events", "POST", { type, subject: patientId }).catch(() => {});
  const current = result.patientId === patientId ? result : { status: "loading", matches: [], enabled: true };
  const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleDateString("zh-CN") : "日期未记录";
  return <section className="doctor-section local-case-clues" aria-label="本地相关病例线索">
    <div className="review-heading">
      <h3>本地相关病例线索{current.status === "ready" && current.enabled ? `（${current.matches.length}）` : ""}</h3>
      {current.status === "ready" && current.enabled && <>
        <button onClick={() => { setCollapsed(!collapsed); event(collapsed ? "similar-expanded" : "similar-collapsed"); }}>{collapsed ? "展开" : "收起"}</button>
        <button disabled={saving} onClick={async () => {
          setSaving(true); setActionError("");
          try { await api("/api/learning/settings", "PUT", { similarCards: false }); setResult(value => ({ ...value, enabled: false })); event("similar-disabled"); }
          catch (e) { setActionError(e.message); }
          finally { setSaving(false); }
        }}>不再提示</button>
      </>}
    </div>
    {current.status === "loading" ? <p role="status">正在查找本地病例线索…</p>
      : current.status === "failed" ? <div role="alert"><p>病例线索暂未读取：{current.error}</p><button onClick={() => setRetry(v => v + 1)}>重试病例检索</button></div>
      : !current.enabled ? <p className="muted">病例线索提示已关闭。<a href="/?view=settings&doctor=1">管理提示设置</a></p>
      : !collapsed && <>
        <p className="muted">按诊断与术语检索，病程、治疗和结局仍需核对。</p>
        {!current.matches.length && <p>暂未找到本地相关病例。</p>}
        {current.matches.map(m => {
          const text = String(m.diagnosis || "").replace(/（[^（）]*OCR[^（）]*）/g, "").replace(/\s+/g, " ").trim();
          const source = m.clinicalSource, snapshot = source?.type === "case-snapshot";
          const reasons = Array.isArray(m.reasons) ? m.reasons : [];
          return <article key={m.caseId} className="local-case-clue">
            {text.length > 120 ? <details><summary>{text.slice(0, 120)}…（展开诊断全文）</summary><p>{text}</p></details> : <h4>{text || "诊断未记录"}</h4>}
            <p className="muted">{snapshot ? `历史案例快照 · 保存于 ${date(source.capturedAt)}` : `患者当前档案 · 更新于 ${date(source?.updatedAt)}`}
              {Number.isInteger(m.age) ? ` · 约 ${m.age} 岁` : ""}{m.gender === "male" ? " · 男" : m.gender === "female" ? " · 女" : ""}</p>
            {reasons.length ? <><ul>{reasons.slice(0, 2).map((reason, index) => <li key={index}>{reason}</li>)}</ul>
              {reasons.length > 2 && <details><summary>其余匹配依据（{reasons.length - 2}）</summary><ul>{reasons.slice(2).map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>}</>
              : <p>匹配依据未提供，请打开记录核对。</p>}
            {m.curatedSources?.length ? <CuratedCaseSources sources={m.curatedSources}/> : m.lessons ? <p>你的案例笔记：{m.lessons}</p> : null}
            <a href={m.caseId.startsWith("patient:") ? `/?view=patients&patient=${encodeURIComponent(m.caseId.slice(8))}` : `/?view=cases&case=${encodeURIComponent(source?.caseId || m.caseId)}`}
              onClick={() => event("similar-opened")}>打开{snapshot ? "历史案例" : "患者档案"}</a>
          </article>;
        })}
      </>}
    {actionError && <p role="alert">{actionError}</p>}
  </section>;
}
export function LearningMonth() {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    api("/api/learning/month")
      .then(setSummary)
      .catch(() => {});
  }, []);
  return summary?.show ? (
    <section className="doctor-section">
      <p>
        上个月记下了 {summary.learned} 条新习惯
        {summary.fewerEdits > 0
          ? `，每份建档平均少改 ${summary.fewerEdits.toFixed(1)} 处`
          : ""}
        。<a href="/?view=settings&doctor=1">看看</a>
      </p>
    </section>
  ) : null;
}
export function LearningChanges({ emptyText = "" } = {}) {
  const mutate = useHabitMutation();
  const [changes, setChanges] = useState([]),
    [error, setError] = useState("");
  const load = () =>
    api("/api/learning/changes")
      .then((r) => setChanges(r.changes))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    window.addEventListener("learning-cleared", load);
    return () => window.removeEventListener("learning-cleared", load);
  }, []);
  return (
    <section aria-label="习惯启停记录">
      {!changes.length && !error && emptyText && <p className="muted">{emptyText}</p>}
      {changes.map((c) => (
        <p key={c.id}>
          <a href={`/?view=settings&doctor=1#habit-${c.habit_id}`}>这条习惯</a>{" "}
          ·{" "}
          {{
            activated: "学会了",
            stated: "记下了",
            "auto-paused": "自动暂停",
            disable: "已停用",
            restore: "已恢复",
            undo: "已撤销",
            delete: "已删除",
            superseded: "已由新习惯替代",
            edit: "已编辑",
          }[c.decision] || "已调整"}{" "}
          · {new Date(c.created_at).toLocaleDateString("zh-CN")}{" "}
          <button
            onClick={async () => {
              try {
                await mutate(
                  `/api/learning/habits/${c.habit_id}/decision`,
                  "POST",
                  c,
                  {
                    historyId: c.id,
                    decision: ["activated", "stated", "restore"].includes(
                      c.decision,
                    )
                      ? "undo"
                      : "restore",
                  },
                );
                window.dispatchEvent(new Event("habits-changed"));
                await load();
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            撤销这次调整
          </button>
        </p>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function PersonalRegressionSettings() {
  const [state, setState] = useState(null),
    [error, setError] = useState(""),
    [localConsent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false);
  const { granted: aiGranted } = useAiConsent();
  const consent = aiGranted || localConsent;
  const running = state?.run?.status === "running";
  // Read once on open; keep polling only while the section is open or a run
  // is still in progress.
  useEffect(() => {
    if (!open && !running) return undefined;
    let alive = true;
    const load = () =>
      api("/api/learning/regression")
        .then((value) => {
          if (alive) setState(value);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, running]);
  const act = async (method) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/learning/regression", method, { consent });
      setState(await api("/api/learning/regression"));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const run = state?.run;
  return (
    <details className="model-jev-section" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>用我的历史档案测一下这个模型</summary>
      <p>
        用最近最多 10
        份已确认档案的去标识化资料重新整理，比较改动率。使用已保存的模型配置，可能产生模型调用费用；结果不会写回患者档案或参与学习。
      </p>
      {state && !state.local && aiGranted && <p><AiConsentNote /></p>}
      {state && !state.local && !aiGranted && (
        <label>
          <input
            type="checkbox"
            checked={localConsent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          同意把去标识化资料发送给当前云端模型进行本次评测
        </label>
      )}
      <button
        type="button"
        disabled={
          !state ||
          busy ||
          run?.status === "running" ||
          (!state.local && !consent)
        }
        onClick={() => act("POST")}
      >
        开始评测
      </button>
      {run?.status === "running" && (
        <button type="button" disabled={busy} onClick={() => act("DELETE")}>
          停止评测
        </button>
      )}
      {run && (
        <div role="status">
          <p>
            {
              {
                running: "正在评测",
                completed: "评测完成",
                cancelled: "评测已停止",
                failed: "评测未完成",
                interrupted: "评测已中断",
              }[run.status]
            }{" "}
            · {run.completed}/{run.total} 份 · {run.model}
          </p>
          {run.message && <p>{run.message}</p>}
          {run.results?.map((r) => (
            <p key={r.sample}>
              第 {r.sample} 份：改动率 {percent(r.rate)} · 摘要改动幅度{" "}
              {percent(r.summaryDistance)}
            </p>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
