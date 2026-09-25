import { useEffect, useState } from "react";
import { api } from "./agent-runtime";
import { Loader2, Search, Calculator, FlaskConical, FileCode2, ShieldAlert } from "lucide-react";

// Clinical quick-reference: scale calculators, lab item interpretations,
// ICD-9-CM-3 procedure lookup, and adverse-reaction screening. All results
// are deterministic local outputs for clinician review.
export function ClinicalRefView() {
  const [tab, setTab] = useState("scales");
  const [initialScale, setInitialScale] = useState("");
  return (
    <div className="module-view">
      <section className="module-card clinical-ref-view">
        <div className="module-head">
          <div>
            <h1>临床速查</h1>
            <p className="module-phase">量表计算 · 检验解读 · 手术编码 · 不良反应筛查</p>
          </div>
        </div>
        <nav className="doctor-tabs" aria-label="速查分类">
          {[
            ["scales", "量表计算", Calculator],
            ["labs", "检验速查", FlaskConical],
            ["codes", "手术编码", FileCode2],
            ["adr", "不良反应筛查", ShieldAlert],
          ].map(([id, label, Icon]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </nav>
        {tab === "scales" && <ScalesTab initialScale={initialScale} />}
        {tab === "labs" && <LabsTab />}
        {tab === "codes" && <CodesTab />}
        {tab === "adr" && <AdrTab onGoScales={() => { setInitialScale("naranjo"); setTab("scales"); }} />}
      </section>
    </div>
  );
}

function ScalesTab({ initialScale = "" }) {
  const [scales, setScales] = useState([]);
  const [scaleId, setScaleId] = useState(initialScale);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api("/api/scales")
      .then((value) => setScales(value.scales))
      .catch((err) => setError(err.message));
  }, []);
  useEffect(() => { setResult(null); }, [answers]);
  const scale = scales.find((s) => s.id === scaleId);
  const run = async (event) => {
    event?.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const value = await api(`/api/scales/${scaleId}/calculate`, "POST", { answers });
      setResult(value);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="followups-section">
      <h3>量表与计算器</h3>
      <div className="followup-apply">
        <select disabled={busy} aria-label="选择量表" value={scaleId} onChange={(e) => { setScaleId(e.target.value); setAnswers({}); setResult(null); }}>
          <option value="">选择量表…</option>
          {scales.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}（{s.category}）
            </option>
          ))}
        </select>
      </div>
      {scale && (
        <form onSubmit={run}>
          <p className="muted">{scale.desc}</p>
          <div className="scale-form">
            {scale.items.map((item) => (
              <label key={item.key} className="scale-item">
                <span>{item.label}</span>
                {item.type === "select" ? (
                  <select
                    disabled={busy}
                    value={answers[item.key] || ""}
                    onChange={(e) => setAnswers({ ...answers, [item.key]: e.target.value })}
                  >
                    <option value="">请选择…</option>
                    {item.choices.map((c) => (
                      <option key={c.label} value={c.label}>
                        {c.label}
                        {c.points ? `（${c.points > 0 ? "+" : ""}${c.points}）` : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="number"
                    step="any"
                    min={item.min}
                    max={item.max}
                    disabled={busy}
                    value={answers[item.key] ?? ""}
                    onChange={(e) =>
                      setAnswers({ ...answers, [item.key]: e.target.value === "" ? "" : Number(e.target.value) })
                    }
                  />
                )}
              </label>
            ))}
          </div>
          <button onClick={run} disabled={busy || !scaleId}>
            {busy ? <Loader2 className="spin" size={14} /> : <Calculator size={14} />}
            计算
          </button>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="drg-result">
          <div className="drg-code">
            <b>{result.score}</b>
            <span>{result.scaleName}</span>
          </div>
          <p>{result.interpretation}</p>
          {result.note && <p className="module-note">{result.note}</p>}
        </div>
      )}
    </section>
  );
}

function LabsTab() {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (event) => {
    event?.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError("");
    try {
      const value = await api(`/api/lab-knowledge?q=${encodeURIComponent(query)}`);
      setEntries(value.entries);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="followups-section">
      <h3>检验指标速查</h3>
      <form className="literature-form" onSubmit={run}>
        <input
          className="literature-query"
          value={query}
          placeholder="指标名/缩写，如 血钾、WBC、肌钙蛋白"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={busy || !query.trim()}>
          {busy ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
          查询
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      <ul className="literature-results">
        {(entries || []).map((item) => (
          <li className="literature-item" key={item.name}>
            <div className="literature-title-row">
              <b>{item.name}</b>
              <span className="literature-journal">
                {item.category} · 参考范围 {item.ref} {item.unit}
              </span>
            </div>
            <p className="literature-authors">
              <b>升高：</b>
              {item.high}
            </p>
            <p className="literature-authors">
              <b>降低：</b>
              {item.low}
            </p>
          </li>
        ))}
        {entries && !entries.length && <li className="memory-empty">内置条目中没有该指标。</li>}
        {!entries && (
          <li className="memory-empty">内置常见指标解读条目（血常规/肝肾功能/电解质/血脂/凝血/心肌/甲状腺/炎症）。参考范围以报告单为准。</li>
        )}
      </ul>
    </section>
  );
}

function CodesTab() {
  const [query, setQuery] = useState("");
  const [codes, setCodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (event) => {
    event?.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try {
      const value = await api(`/api/icd9?q=${encodeURIComponent(query)}`);
      setCodes(value.codes);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const [error, setError] = useState("");
  return (
    <section className="followups-section">
      <h3>手术操作编码（ICD-9-CM-3 常用速查）</h3>
      <form className="literature-form" onSubmit={run}>
        <input
          className="literature-query"
          value={query}
          placeholder="术式名或编码，如 胆囊、51.23"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={busy || !query.trim()}>
          {busy ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
          查询
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      <ul className="literature-results">
        {(codes || []).map((item) => (
          <li className="literature-item" key={item.code}>
            <div className="literature-title-row">
              <b>{item.name}</b>
              <span className="literature-journal">{item.code}</span>
            </div>
          </li>
        ))}
        {codes && !codes.length && <li className="memory-empty">常用编码表中没有匹配，请以本院编码库为准。</li>}
      </ul>
    </section>
  );
}

function AdrTab({ onGoScales }) {
  const [meds, setMeds] = useState("");
  const [findings, setFindings] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (event) => {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const value = await api("/api/adr-assess", "POST", {
        medications: meds.split(/[\n,，;；]/).map((s) => s.trim()).filter(Boolean),
        findings,
      });
      setResult(value);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="followups-section">
      <h3>不良反应筛查</h3>
      <p className="muted">
        输入当前用药与可疑临床表现，按内置药物不良反应知识表匹配。提示性筛查，不构成因果判定。
      </p>
      <div className="drg-form">
        <textarea
          className="case-summary"
          rows={2}
          value={meds}
          placeholder={"当前用药（每行一个或逗号分隔）：\n依那普利, 美托洛尔"}
          onChange={(e) => setMeds(e.target.value)}
        />
        <textarea
          className="case-summary"
          rows={2}
          value={findings}
          placeholder="可疑临床表现：如 干咳、血钾升高、肌痛"
          onChange={(e) => setFindings(e.target.value)}
        />
        <button onClick={run} disabled={busy || !meds.trim() || !findings.trim()}>
          {busy ? <Loader2 className="spin" size={14} /> : <ShieldAlert size={14} />}
          筛查
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {result && (
        <>
          {result.suspected.length > 0 ? (
            <ul className="literature-results">
              {result.suspected.map((s, index) => (
                <li className="literature-item" key={index}>
                  <b>{s.medication}</b>（{s.drugClass}）
                  <p className="literature-authors">{s.message}</p>
                  {s.monitoring && (
                    <p className="literature-authors">
                      <b>建议核查：</b>
                      {s.monitoring.join("、")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="memory-empty">内置知识表中没有匹配到与该表现相关的不良反应。</p>
          )}
          {result.drugProfiles.length > 0 && (
            <p className="literature-authors">
              <b>用药组已知不良反应：</b>
              {result.drugProfiles
                .map((p) => `${p.drugClass}（${p.knownReactions.join("、")}）`)
                .join("；")}
            </p>
          )}
          <p className="module-note">
            {result.note}
            <button className="text-button" onClick={onGoScales}>
              打开 Naranjo 因果评估量表 →
            </button>
          </p>
        </>
      )}
    </section>
  );
}
