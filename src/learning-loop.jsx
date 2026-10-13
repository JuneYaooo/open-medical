import { useEffect, useState } from "react";
import { api } from "./agent-runtime";
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
  unit: "单位",
  status: "状态",
  value: "数值",
  text: "正文",
  date: "日期",
  dose: "剂量",
  frequency: "频次",
  note: "备注",
};
const percent = (n) => (n == null ? "暂无" : `${Math.round(n * 100)}%`);
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
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/api/learning/settings")
      .then(setPrefs)
      .catch((e) => setError(e.message));
  }, []);
  const save = async (value) => {
    setBusy(true);
    try {
      setPrefs(await api("/api/learning/settings", "PUT", value));
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="学习与隐私">
      <h3>学习与隐私</h3>
      {error && <p role="alert">{error}</p>}
      {prefs && (
        <>
          <fieldset disabled={busy}>
            <legend>用我过去的档案作为 AI 参考范例</legend>
            {[
              ["local", "仅使用本地模型时"],
              ["always", "始终（范例会去标识化后发送给当前模型服务）"],
              ["never", "从不"],
            ].map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="learning-examples"
                  checked={prefs.examples === value}
                  onChange={() => save({ examples: value })}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <label>
            <input
              type="checkbox"
              checked={prefs.personalContext}
              disabled={busy}
              onChange={(e) => save({ personalContext: e.target.checked })}
            />
            整理时参考已确认习惯、知识和适用技能
          </label>
          <label>
            <input
              type="checkbox"
              checked={prefs.habits}
              disabled={busy}
              onChange={(e) => save({ habits: e.target.checked })}
            />
            从核对修改中学习写法习惯（试跑通过后生效）
          </label>
          <details>
            <summary>试点评估</summary>
            <p>
              开启后会在本机记录核对统计，并随机让 20%
              的建档不使用个性化参考，用于比较效果。
            </p>
            <label>
              <input
                type="checkbox"
                checked={prefs.pilot}
                disabled={busy}
                onChange={(e) =>
                  save({
                    pilot: e.target.checked,
                    pilotConsent: e.target.checked,
                  })
                }
              />
              我同意参与随机留出评估
            </label>
            <button
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
function WeeklyLearningChart({ series }) {
  const weeks = [...new Set(series.map((s) => s.week))].sort(),
    maximum = Math.max(0.1, ...series.map((s) => s.rate || 0));
  const groups = [
    ["baseline", "基线", "#777"],
    ["learning", "学习", "#31745e"],
    ["holdout", "留出", "#b07732"],
  ];
  const x = (week) =>
      45 + (weeks.indexOf(week) * 510) / Math.max(1, weeks.length - 1),
    y = (rate) => 105 - (80 * (rate || 0)) / maximum;
  return (
    <>
      <svg
        role="img"
        aria-label="每周平均改动率，按基线、学习与留出分组"
        viewBox="0 0 600 140"
      >
        <line
          x1="40"
          x2="580"
          y1="105"
          y2="105"
          stroke="currentColor"
          opacity=".3"
        />
        <text x="0" y="25" fontSize="10">
          {percent(maximum)}
        </text>
        {groups.map(([group, label, color]) => {
          const points = series
            .filter((s) => s.group === group)
            .sort((a, b) => a.week.localeCompare(b.week));
          return (
            <g key={group}>
              <polyline
                points={points
                  .map((s) => `${x(s.week)},${y(s.rate)}`)
                  .join(" ")}
                fill="none"
                stroke={color}
                strokeWidth="2"
              />
              {points.map((s) => (
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
          );
        })}
        {weeks.map((week) => (
          <text
            key={week}
            x={x(week)}
            y="130"
            textAnchor="middle"
            fontSize="10"
          >
            {week.slice(5)}
          </text>
        ))}
      </svg>
      <p>
        {groups.map(([key, label, color]) => (
          <span key={key} style={{ color, marginRight: 16 }}>
            ● {label}
          </span>
        ))}
      </p>
    </>
  );
}
export function LearningStats({ onClear }) {
  const [selectedSection, setSelectedSection] = useState("all");
  const [stats, setStats] = useState(null),
    [error, setError] = useState(""),
    [details, setDetails] = useState(null),
    [confirmClear, setConfirmClear] = useState(false),
    [busy, setBusy] = useState(false);
  const load = () =>
    api("/api/review-stats?range=90d")
      .then(setStats)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    window.addEventListener("learning-cleared", load);
    return () => window.removeEventListener("learning-cleared", load);
  }, []);
  return (
    <section className="doctor-section" aria-label="它学得怎么样">
      <h3>它学得怎么样</h3>
      {error && <p role="alert">{error}</p>}
      {stats &&
        (stats.count < 5 ? (
          <p>再确认 {stats.remaining} 份建档后，这里会显示 AI 草稿的改动趋势</p>
        ) : (
          <>
            <p>
              最近 {Math.min(stats.count, 30)} 份建档，你平均每份改{" "}
              {stats.recentAverage.toFixed(1)} 处
              {stats.previousAverage !== null
                ? `（之前 30 份：${stats.previousAverage.toFixed(1)} 处）`
                : ""}
            </p>
            <label>
              按分区查看
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
              series={
                selectedSection === "all"
                  ? stats.series
                  : stats.series.map((s) => ({
                      ...s,
                      rate: s.sections?.[selectedSection]?.rate ?? null,
                    }))
              }
            />
            <p>核对用时中位数：{Math.round(stats.medianReviewMs / 1000)} 秒</p>
            <div>
              改得最多的地方：
              {stats.sections.slice(0, 5).map((s) => {
                const [section, field] = s.key.split(".");
                return (
                  <button
                    className="text-button"
                    key={s.key}
                    onClick={() =>
                      api(`/api/review-details?section=${section}`)
                        .then(setDetails)
                        .catch((e) => setError(e.message))
                    }
                  >
                    {sectionNames[section] || section}
                    {fieldNames[field] || ""}（{s.count} 处 ·{" "}
                    {percent(
                      s.count /
                        Math.max(
                          1,
                          stats.sections.reduce((n, v) => n + v.count, 0),
                        ),
                    )}
                    ）
                  </button>
                );
              })}
            </div>
            <details>
              <summary>写法与事实改动统计</summary>
              <table>
                <thead>
                  <tr>
                    <th>周</th>
                    <th>组别</th>
                    <th>写法改动率</th>
                    <th>事实改动率</th>
                    <th>摘要改动幅度</th>
                    <th>20 秒内零修改</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.series.map((s) => (
                    <tr key={`${s.week}:${s.group}`}>
                      <td>{s.week}</td>
                      <td>
                        {
                          {
                            baseline: "基线",
                            learning: "学习",
                            holdout: "留出",
                          }[s.group]
                        }
                      </td>
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
              <small>病史摘要改动单独记录，不计入写法改动率。</small>
            </details>
          </>
        ))}
      {details && (
        <div>
          <h4>最近修改</h4>
          {details.diffs.map((d) => (
            <p key={d.id}>
              某患者 · {sectionNames[d.section]}：{JSON.stringify(d.before)} →{" "}
              {JSON.stringify(d.after)}
            </p>
          ))}
          <button onClick={() => setDetails(null)}>收起明细</button>
        </div>
      )}
      <button
        className="text-button danger"
        onClick={() => setConfirmClear(true)}
      >
        清空学习记录
      </button>
      {confirmClear && (
        <div role="alert">
          <p>
            清空所有核对差异、学习候选和由修改形成的习惯？患者档案仍会保留。
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/api/learning/clear", "POST", { confirmed: true });
                setConfirmClear(false);
                setDetails(null);
                await load();
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
          <button onClick={() => setConfirmClear(false)}>取消</button>
        </div>
      )}
    </section>
  );
}
export function HabitLedger() {
  const [habits, setHabits] = useState([]),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(null),
    [text, setText] = useState("");
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
    return () => window.removeEventListener("learning-cleared", load);
  }, []);
  const decide = async (id, decision, extra = {}) => {
    try {
      await api(`/api/learning/habits/${id}/decision`, "POST", {
        decision,
        ...extra,
      });
      setEditing(null);
      await load();
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <section className="doctor-section" aria-label="习惯账本">
      <h3>习惯账本</h3>
      {error && <p role="alert">{error}</p>}
      {!habits.length && (
        <p className="muted">
          你说出的偏好和反复修改的写法，会在这里留下来源与效果记录。
        </p>
      )}
      {habits.map((h) => (
        <article key={h.id} id={`habit-${h.id}`}>
          <p>
            <b>H{h.id}</b> {h.content} ·{" "}
            {h.status === "confirmed"
              ? "已启用"
              : h.status === "deleted"
                ? "已删除，可恢复"
                : "已暂停"}
          </p>
          <small>
            {h.origin === "stated" ? "你明确说出的" : `来自 ${h.count} 次修改`}{" "}
            · 用上 {h.ledger.applied} 次 · 被改回 {h.ledger.reverted} 次 ·
            不适用 {h.ledger.notApplicable} 次
          </small>
          {h.ledger.rates && (
            <p>
              启用前后 30 天分区改动率：{percent(h.ledger.rates.before)} →{" "}
              {percent(h.ledger.rates.after)}
            </p>
          )}
          {h.ledger.conflict && (
            <p>
              {h.origin === "stated"
                ? "最近常被改回，可能已不适用"
                : "最近常被改回，已自动暂停"}
            </p>
          )}
          {h.dryrun && (
            <p>
              试跑：会改对 {h.dryrun.correct} 处，会改错 {h.dryrun.wrong} 处
            </p>
          )}
          <div className="toolbar-actions">
            <button
              className="secondary"
              onClick={() => {
                setEditing(h.id);
                setText(h.content);
              }}
            >
              编辑
            </button>
            <button
              className="secondary"
              onClick={() =>
                decide(h.id, h.status === "confirmed" ? "disable" : "restore")
              }
            >
              {h.status === "confirmed" ? "停用" : "恢复"}
            </button>
            {h.status !== "deleted" && (
              <button
                className="text-button danger"
                onClick={() => decide(h.id, "delete")}
              >
                删除
              </button>
            )}
          </div>
          {editing === h.id && (
            <div>
              <label>
                习惯措辞
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <button onClick={() => decide(h.id, "edit", { content: text })}>
                保存措辞
              </button>
              <button onClick={() => setEditing(null)}>取消</button>
            </div>
          )}
          <details>
            <summary>查看来源修改</summary>
            {h.dryrun?.examples?.map((e, i) => (
              <p key={i}>
                某患者：
                {e.changes
                  .map(
                    (c) =>
                      `${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`,
                  )
                  .join("；")}
              </p>
            ))}
            {h.origin === "stated" && (
              <p>
                {h.evidence?.filter((e) => typeof e === "string").join("；")}
              </p>
            )}
          </details>
        </article>
      ))}
      {!!habits.length && (
        <button
          className="secondary"
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
  const [memories, setMemories] = useState(initial),
    [error, setError] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setMemories([]), 5000);
    return () => clearTimeout(timer);
  }, []);
  if (!memories.length) return null;
  return (
    <div className="review-save-warning" role="status">
      ✓ 记下了：
      {memories.length > 1
        ? `${memories.length} 条习惯`
        : memories[0].content}{" "}
      <button
        className="text-button"
        onClick={async () => {
          try {
            for (const m of memories)
              await api(`/api/learning/habits/${m.id}/decision`, "POST", {
                decision: "undo",
              });
            setMemories([]);
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
  const [paused, setPaused] = useState(() => {
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
          暂停了习惯「H{id}」：最近常被你改回 ·{" "}
          <button
            onClick={async () => {
              await api(`/api/learning/habits/${id}/decision`, "POST", {
                decision: "restore",
              });
              setPaused(paused.filter((h) => h !== id));
            }}
          >
            恢复
          </button>
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
            H{h.id} {h.content}{" "}
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
                      `暂停了习惯「H${h.id}」：最近常被你改回，可在习惯账本恢复。`,
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
  const [matches, setMatches] = useState([]),
    [hidden, setHidden] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api(`/api/learning/similar/${patientId}`)
      .then((r) => {
        if (live) {
          setMatches(r.matches);
          setHidden(!r.enabled);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [patientId]);
  const event = (type) =>
    api("/api/learning/events", "POST", { type, subject: patientId }).catch(
      (e) => setError(e.message),
    );
  if (hidden || !matches.length) return null;
  return (
    <section className="doctor-section" aria-label="你过去的相似病例">
      <div className="review-heading">
        <h3>你过去的相似病例（{matches.length}）</h3>
        <button
          onClick={() => {
            setCollapsed(!collapsed);
            event(collapsed ? "similar-expanded" : "similar-collapsed");
          }}
        >
          {collapsed ? "展开" : "收起"}
        </button>
        <button
          onClick={async () => {
            try {
              await api("/api/learning/settings", "PUT", {
                similarCards: false,
              });
              await event("similar-disabled");
              setHidden(true);
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          不再提示
        </button>
      </div>
      {!collapsed &&
        matches.map((m) => (
          <p key={m.caseId}>
            {m.diagnosis}
            {m.lessons ? ` · 你的案例笔记：${m.lessons}` : ""}{" "}
            <a
              href={
                m.caseId.startsWith("patient:")
                  ? `/?view=patients&patient=${encodeURIComponent(m.caseId.slice(8))}`
                  : "/?view=cases"
              }
              onClick={() => event("similar-opened")}
            >
              打开
            </a>
          </p>
        ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
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
export function LearningChanges() {
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
      {changes.map((c) => (
        <p key={c.id}>
          H{c.habit_id} ·{" "}
          {{
            activated: "学会了",
            stated: "记下了",
            "auto-paused": "自动暂停",
            disable: "已停用",
            restore: "已恢复",
            undo: "已撤销",
            delete: "已删除",
            superseded: "已由新习惯替代",
          }[c.decision] || c.decision}{" "}
          · {new Date(c.created_at).toLocaleDateString("zh-CN")}{" "}
          <button
            onClick={async () => {
              try {
                await api(
                  `/api/learning/habits/${c.habit_id}/decision`,
                  "POST",
                  {
                    historyId: c.id,
                    decision: ["activated", "stated", "restore"].includes(
                      c.decision,
                    )
                      ? "undo"
                      : "restore",
                  },
                );
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
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
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
  }, []);
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
    <details className="model-jev-section">
      <summary>用我的历史档案测一下这个模型</summary>
      <p>
        用最近最多 10
        份已确认档案的去标识化资料重新整理，比较改动率。使用已保存的模型配置，可能产生模型调用费用；结果不会写回患者档案或参与学习。
      </p>
      {state && !state.local && (
        <label>
          <input
            type="checkbox"
            checked={consent}
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
