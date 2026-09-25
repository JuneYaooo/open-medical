import { useEffect, useState } from "react";
import { api } from "./agent-runtime";
import { Loader2, Plus, Search, Trash2, UserPlus, X } from "lucide-react";

// Case library view: browse/search local cases, run similar-case search,
// and snapshot patients into the library for future reference.
export function CasesView() {
  const [cases, setCases] = useState([]);
  const [patients, setPatients] = useState([]);
  const [query, setQuery] = useState("");
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
  });
  const [expanded, setExpanded] = useState({});

  const refresh = async () => {
    const [list, people] = await Promise.all([
      api("/api/cases"),
      api("/api/patients?summary=1"),
    ]);
    setCases(list.cases);
    setPatients(people.patients.filter((p) => !p.archived));
  };
  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, []);

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
      });
      setAdding(false);
      setNewCase({ patientId: "", summary: "", diagnosis: "" });
      setNotice("病例已收入本地病例库。");
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
            <h1>病例库</h1>
            <p className="module-phase">本地病例快照 · 相似病例检索 · 仅作参考</p>
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
            <div className="guideline-import-actions">
              <button onClick={addCase} disabled={busy || (!newCase.patientId && !newCase.diagnosis.trim())}>
                <UserPlus size={14} /> 收入病例库
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
                </div>
              )}
              <div className="literature-actions">
                <button className="icon-button danger" title="删除病例" onClick={() => removeCase(item.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </li>
          ))}
          {!cases.length && (
            <li className="memory-empty">
              病例库为空。可从患者档案快照收入病例，或在会话中用 similar_case_search 工具检索。
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
