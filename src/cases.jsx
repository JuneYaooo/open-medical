import { useEffect, useState } from "react";
import { api } from "./agent-runtime";
import { Loader2, Plus, Search, Star, Trash2, UserPlus, X } from "lucide-react";

// Case library view: browse/search local cases, run similar-case search,
// and snapshot patients into the library for future reference. Curated
// cases (starred + lessons) are the doctor's own experience layer.
export function CasesView() {
  const [cases, setCases] = useState([]);
  const [patients, setPatients] = useState([]);
  const [query, setQuery] = useState("");
  const [starredOnly, setStarredOnly] = useState(false);
  const [editing, setEditing] = useState(null);
  const [similarText, setSimilarText] = useState("");
  const [similarDiagnosis, setSimilarDiagnosis] = useState("");
  const [similarMatches, setSimilarMatches] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);
  const [newCase, setNewCase] = useState({
    patientId: "",
    summary: "",
    diagnosis: "",
    lessons: "",
    tags: "",
  });
  const [expanded, setExpanded] = useState({});

  const refresh = async () => {
    const [list, people] = await Promise.all([
      api(`/api/cases${starredOnly ? "?starred=1" : ""}`),
      api("/api/patients?summary=1"),
    ]);
    setCases(list.cases);
    setPatients(people.patients.filter((p) => !p.archived));
  };
  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, [starredOnly]);

  const runSearch = async (event) => {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const value = await api(
        `/api/cases${query ? `?query=${encodeURIComponent(query)}` : ""}`,
      );
      setCases(value.cases);
      setSimilarMatches(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const runSimilar = async (event) => {
    event?.preventDefault();
    if (!similarText.trim()) return;
    setBusy(true);
    setError("");
    try {
      const value = await api("/api/cases/similar", "POST", {
        caseText: similarText,
        diagnosis: similarDiagnosis || undefined,
        limit: 6,
      });
      setSimilarMatches(value.matches);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const addCase = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/cases", "POST", {
        ...(newCase.patientId ? { patientId: newCase.patientId } : {}),
        ...(newCase.patientId
          ? { summary: newCase.summary || undefined }
          : { diagnosis: newCase.diagnosis, summary: newCase.summary || undefined }),
        lessons: newCase.lessons || undefined,
        tags: newCase.tags.split(/[,，、\s]+/).filter(Boolean),
        starred: true,
      });
      setAdding(false);
      setNewCase({ patientId: "", summary: "", diagnosis: "", lessons: "", tags: "" });
      setNotice("病例已收入案例库（精选）。下次遇到相似患者，检索会优先翻出它。");
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const toggleStar = async (item) => {
    setError("");
    try {
      await api(`/api/cases/${item.id}`, "PATCH", { starred: !item.starred });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };
  const saveCuration = async () => {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/cases/${editing.id}`, "PATCH", {
        lessons: editing.lessons,
        tags: editing.tags.split(/[,，、\s]+/).filter(Boolean),
      });
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const removeCase = async (id) => {
    setError("");
    try {
      await api(`/api/cases/${id}`, "DELETE");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="module-view">
      <section className="module-card cases-view">
        <div className="module-head">
          <div>
            <h1>案例库</h1>
            <p className="module-phase">本地病例快照 · 精选经验 · 相似检索 · 仅作参考</p>
          </div>
          <button className="secondary" onClick={() => setAdding((v) => !v)}>
            {adding ? <X size={14} /> : <Plus size={14} />}
            {adding ? "取消" : "收入病例"}
          </button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="form-notice">{notice}</p>}

        {adding && (
          <div className="guideline-import">
            <h3>收入新病例</h3>
            <div className="followup-apply">
              <select
                value={newCase.patientId}
                onChange={(e) =>
                  setNewCase({ ...newCase, patientId: e.target.value })
                }
              >
                <option value="">手动填写（不选患者）</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    从患者快照：{p.name}
                  </option>
                ))}
              </select>
              {!newCase.patientId && (
                <input
                  value={newCase.diagnosis}
                  placeholder="主要诊断（手动填写时必填）"
                  onChange={(e) =>
                    setNewCase({ ...newCase, diagnosis: e.target.value })
                  }
                />
              )}
            </div>
            <textarea
              className="case-summary"
              rows={3}
              value={newCase.summary}
              placeholder="病例摘要：病史要点、处理经过与转归（可选）"
              onChange={(e) => setNewCase({ ...newCase, summary: e.target.value })}
            />
            <textarea
              className="case-summary"
              rows={2}
              value={newCase.lessons}
              placeholder="经验教训：这次最有价值的点、下次遇到类似患者怎么用（可选）"
              onChange={(e) => setNewCase({ ...newCase, lessons: e.target.value })}
            />
            <input
              value={newCase.tags}
              placeholder="标签（如：糖尿病、胰岛素方案），逗号分隔（可选）"
              onChange={(e) => setNewCase({ ...newCase, tags: e.target.value })}
            />
            <div className="guideline-import-actions">
              <button onClick={addCase} disabled={busy || (!newCase.patientId && !newCase.diagnosis.trim())}>
                <UserPlus size={14} /> 收入案例库
              </button>
            </div>
          </div>
        )}

        <form className="literature-form" onSubmit={runSearch}>
          <input
            className="literature-query"
            value={query}
            aria-label="检索病例" placeholder="检索病例（诊断、治疗、摘要关键词）"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" disabled={busy}>
            <Search size={15} /> 检索
          </button>
        </form>

        <form className="literature-form" onSubmit={runSimilar}>
          <input
            className="literature-query"
            value={similarText}
            aria-label="相似病例描述" placeholder="相似病例搜索：粘贴当前病例描述（诊断、表现、检验）"
            onChange={(e) => setSimilarText(e.target.value)}
          />
          <input
            className="literature-year"
            style={{ width: 140 }}
            value={similarDiagnosis}
            aria-label="诊断加权（可选）" placeholder="诊断加权（可选）"
            onChange={(e) => setSimilarDiagnosis(e.target.value)}
          />
          <button type="submit" disabled={busy || !similarText.trim()}>
            {busy ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
            相似搜索
          </button>
        </form>

        {similarMatches && (
          <>
            <h3 className="guidelines-list-title">相似病例（按匹配度）</h3>
            <ul className="literature-results">
              {similarMatches.map((match) => (
                <li className="literature-item" key={match.caseId}>
                  <b>{match.diagnosis}</b>
                  <p className="literature-authors">
                    {[
                      match.age !== null && match.age !== undefined ? `${match.age} 岁` : "",
                      match.gender === "male" ? "男" : match.gender === "female" ? "女" : "",
                      match.outcome,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {match.summary && <p className="literature-authors">{match.summary}</p>}
                  <div className="literature-hints">
                    {match.reasons.map((reason) => (
                      <span className="hint-tag" key={reason}>
                        {reason}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
              {!similarMatches.length && (
                <li className="memory-empty">没有找到相似病例。</li>
              )}
            </ul>
          </>
        )}

        <h3 className="guidelines-list-title">
          病例列表 <span className="muted">{cases.length} 份</span>
          <button
            className="text-button"
            aria-pressed={starredOnly}
            style={{ marginLeft: 12 }}
            onClick={() => setStarredOnly((v) => !v)}
          >
            {starredOnly ? "⭐ 只看精选（点击看全部）" : "只看我的精选"}
          </button>
        </h3>
        <ul className="literature-results">
          {cases.map((item) => (
            <li className="literature-item" key={item.id}>
              <div className="literature-title-row">
                <button
                  className="literature-title"
                  onClick={() =>
                    setExpanded((prev) => ({ ...prev, [item.id]: !prev[item.id] }))
                  }
                >
                  {item.diagnosis}
                  {item.starred ? " ⭐" : ""}
                </button>
                <span className="literature-journal">
                  {[
                    item.age !== null && item.age !== undefined ? `${item.age} 岁` : "",
                    item.gender === "male" ? "男" : item.gender === "female" ? "女" : "",
                    item.icd10,
                    item.patientName || "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              {expanded[item.id] && (
                <div className="literature-abstract">
                  {item.summary && <p>{item.summary}</p>}
                  {item.treatments?.length > 0 && (
                    <p>
                      <b>治疗：</b>
                      {item.treatments.join("；")}
                    </p>
                  )}
                  {item.keyLabs?.length > 0 && (
                    <p>
                      <b>关键检验：</b>
                      {item.keyLabs
                        .map((lab) => `${lab.item} ${lab.value}${lab.unit || ""}`)
                        .join("；")}
                    </p>
                  )}
                  {item.outcome && (
                    <p>
                      <b>结局：</b>
                      {item.outcome}
                    </p>
                  )}
                  {item.lessons && (
                    <p>
                      <b>⭐ 经验教训：</b>
                      {item.lessons}
                    </p>
                  )}
                  {item.tags?.length > 0 && (
                    <p>
                      <b>标签：</b>
                      {item.tags.join("、")}
                    </p>
                  )}
                  {editing?.id === item.id ? (
                    <div>
                      <textarea
                        rows={2}
                        aria-label="经验教训"
                        placeholder="这次最有价值的点、下次遇到类似患者怎么用"
                        value={editing.lessons}
                        onChange={(e) =>
                          setEditing({ ...editing, lessons: e.target.value })
                        }
                      />
                      <input
                        aria-label="标签"
                        placeholder="标签，逗号分隔"
                        value={editing.tags}
                        onChange={(e) =>
                          setEditing({ ...editing, tags: e.target.value })
                        }
                      />
                      <div className="guideline-import-actions">
                        <button onClick={saveCuration} disabled={busy}>
                          保存
                        </button>
                        <button className="secondary" onClick={() => setEditing(null)}>
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="text-button"
                      onClick={() =>
                        setEditing({
                          id: item.id,
                          lessons: item.lessons || "",
                          tags: (item.tags || []).join("、"),
                        })
                      }
                    >
                      补经验教训 / 标签
                    </button>
                  )}
                </div>
              )}
              <div className="literature-actions">
                <button
                  className="icon-button"
                  title={item.starred ? "取消精选" : "标记为精选案例"}
                  aria-pressed={item.starred}
                  onClick={() => toggleStar(item)}
                >
                  <Star size={13} fill={item.starred ? "currentColor" : "none"} />
                </button>
                <button className="icon-button danger" title="删除病例" onClick={() => removeCase(item.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </li>
          ))}
          {!cases.length && (
            <li className="memory-empty">
              {starredOnly ? "还没有精选案例。展开一份病例，补上经验教训并点星标，它就会在相似患者出现时优先被翻出来。" : "案例库为空。可在患者档案点「收进案例库」，把有价值的病例连同经验一起留下。"}
            </li>
          )}
        </ul>
        <p className="module-note">
          相似病例检索为本地确定性匹配（诊断加权 + 术语重合），结果仅作临床参考，不构成诊疗建议。
        </p>
      </section>
    </div>
  );
}
