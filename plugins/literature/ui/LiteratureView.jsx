import { useEffect, useRef, useState } from "react";
import { api } from "../../../src/agent-runtime";
import { requestSettingsTab } from "../../../src/extension-center";
import "../../../src/tools-clarity.css";
import "./literature.css";
import { Search, Loader2, FilePlus, Copy, ExternalLink, Check, Sparkles } from "lucide-react";
import { patientOptionLabel } from "../../../src/patient-labels.js";

// 文献页主入口是一句自然语言问题：由助手检索、阅读、比较并作答（需要模型）。
// 手动 PubMed 检索保留在折叠区，只发送检索词；导入为会话材料并保留来源。
const NON_LATIN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}]/u;
const TASK_PREFIX = "文献研究 · ";
const EXAMPLES = [
  "老年 2 型糖尿病患者使用 SGLT2 抑制剂的心肾获益与风险，最新指南怎么推荐？",
  "早期非小细胞肺癌术后辅助免疫治疗的证据与适用人群",
  "比较国内外指南对高血压合并慢性肾病的降压目标",
  "幽门螺杆菌根除的一线方案：中国共识与国际指南有何差异？",
];
export function LiteratureView({ onOpenTask, config, onSettings }) {
  const modelConfigured = Boolean(config?.modelConfigured);
  const openModelSettings = () => { requestSettingsTab("general"); onSettings?.(); };
  const [specialty, setSpecialty] = useState("");
  const [question, setQuestion] = useState("");
  const [patients, setPatients] = useState([]);
  const [patientId, setPatientId] = useState("");
  const [recent, setRecent] = useState([]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("pubmed");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState({});
  const importsInFlight = useRef(new Set());
  const searchInFlight = useRef(false);
  // 手动导入的文献都放进同一个任务：选了患者就进该患者会话，否则进本次
  // 打开页面后新建的一个“文献收集”任务（首次导入时创建，并发导入共用）。
  const collectSession = useRef(null);
  const [collected, setCollected] = useState(null);
  const [importing, setImporting] = useState({});
  const [abstractErrors, setAbstractErrors] = useState({});
  const [abstracts, setAbstracts] = useState({});
  const [imported, setImported] = useState({});
  const [copied, setCopied] = useState("");

  useEffect(() => {
    api("/api/doctor/profile")
      .then((profile) => setSpecialty(profile.fields?.specialty || ""))
      .catch(() => {});
    api("/api/patients")
      .then((value) => setPatients((value.patients || []).filter((patient) => !patient.archived && patient.sessionId)))
      .catch(() => {});
    api("/api/sessions")
      .then((value) => setRecent((value.sessions || []).filter((session) => session.title?.startsWith(TASK_PREFIX)).slice(0, 5)))
      .catch(() => {});
  }, []);
  // 一个问题 = 一次文献研究任务：选了患者就进入该患者会话，否则新建会话。
  const startResearch = async (event, text = question) => {
    event?.preventDefault();
    const draft = text.trim();
    if (!draft || starting) return;
    if (!modelConfigured) {
      setStartError("需先连接模型：文献研究由助手检索、阅读和综合，未连接模型时不能发送。问题已保留。");
      return;
    }
    setStarting(true);
    setStartError("");
    try {
      const patient = patients.find((item) => item.id === patientId);
      const sessionId = patient ? patient.sessionId : (await api("/api/sessions", "POST", { title: `${TASK_PREFIX}${draft.slice(0, 40)}` })).id;
      await onOpenTask(sessionId, {
        submit: true,
        draft,
        workflow: "literature-research",
        context: { kind: "literature-search", label: patient ? "文献研究 · 结合当前患者" : "文献研究", scope: { mode: "research" } },
      });
    } catch (err) {
      setStartError(err.message);
    } finally {
      setStarting(false);
    }
  };
  const runSearch = async (event, options = {}) => {
    event?.preventDefault();
    const searchQuery = options.query ?? query;
    if (searchInFlight.current || !searchQuery.trim()) return;
    if (NON_LATIN.test(searchQuery)) {
      setError("手动检索只接受英文关键词、标题或 PMID。中文问题请在上方提问，由助手检索中英文文献。");
      return;
    }
    searchInFlight.current = true;
    setBusy(true);
    setError("");
    setResults(null);
    try {
      const params = new URLSearchParams({
        query: searchQuery,
        source: options.source || source,
        limit: "15",
      });
      if (options.sort) params.set("sort", options.sort);
      if (options.source) setSource(options.source);
      if (yearFrom) params.set("yearFrom", yearFrom);
      if (yearTo) params.set("yearTo", yearTo);
      const value = await api(`/api/literature/search?${params}`);
      setResults(value);
      setAbstracts({});
      setExpanded({});
      if (options.query !== undefined) setQuery(searchQuery);
    } catch (err) {
      setError(err.message);
    } finally {
      searchInFlight.current = false;
      setBusy(false);
    }
  };
  const loadAbstract = async (article) => {
    const key = article.pmid || article.doi;
    if (abstracts[key]) return abstracts[key];
    const params = new URLSearchParams();
    if (article.pmid) params.set("pmid", article.pmid);
    else params.set("doi", article.doi);
    setAbstractErrors(prev => ({ ...prev, [key]: "" }));
    try {
      const full = await api(`/api/literature/article?${params}`);
      setAbstracts((prev) => ({ ...prev, [key]: full }));
      return full;
    } catch (err) {
      setAbstractErrors(prev => ({ ...prev, [key]: err.message }));
    }
  };
  const toggleExpand = async (article) => {
    const key = article.pmid || article.doi;
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
    if (!expanded[key]) loadAbstract(article).catch(() => {});
  };
  const importAsMaterial = async (article) => {
    const key = article.pmid || article.doi;
    if (importsInFlight.current.has(key)) return;
    importsInFlight.current.add(key);
    setImporting(prev => ({ ...prev, [key]: true }));
    setError("");
    try {
      const patient = patients.find((item) => item.id === patientId);
      let target;
      if (patient) target = { id: patient.sessionId, title: `${patient.name || "患者"}的会话` };
      else {
        collectSession.current ||= api("/api/sessions", "POST", { title: `文献收集 · ${new Date().toLocaleDateString("zh-CN")}` })
          .then((session) => ({ id: session.id, title: "文献收集" }))
          .catch((err) => { collectSession.current = null; throw err; });
        target = await collectSession.current;
      }
      await api("/api/literature/import", "POST", {
        sessionId: target.id,
        pmid: article.pmid || undefined,
        doi: article.pmid ? undefined : article.doi || undefined,
      });
      setCollected((prev) => ({ ...target, count: prev?.id === target.id ? prev.count + 1 : 1 }));
      setImported((prev) => ({ ...prev, [article.pmid || article.doi]: true }));
    } catch (err) {
      setError(err.message);
    } finally {
      importsInFlight.current.delete(key);
      setImporting(prev => ({ ...prev, [key]: false }));
    }
  };
  const citation = (article) => {
    const authors = article.authors || [];
    const authorText =
      authors.length > 3 ? `${authors.slice(0, 3).join(", ")} 等` : authors.join(", ");
    return `${authorText}. ${article.title}. ${article.journal}${article.year ? `, ${article.year}` : ""}.${article.doi ? ` doi:${article.doi}.` : ""}${article.pmid ? ` PMID:${article.pmid}.` : ""}`;
  };
  const copyCitation = async (article) => {
    try {
      await navigator.clipboard.writeText(citation(article));
      setCopied(article.pmid || article.doi);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setError("无法写入剪贴板，请重试或手动复制");
    }
  };
  const pubmedLink = (article) =>
    article.pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`
      : `https://doi.org/${article.doi}`;

  return (
    <div className="module-view tool-page">
      <section className="module-card literature-view">
        <div className="module-head">
          <div>
            <h1>文献研究</h1>
            <p className="module-phase">围绕问题查找、阅读和比较证据，形成有来源的总结。</p>
          </div>
        </div>
        <section className="tool-section literature-ask" aria-label="文献研究提问">
          <form className="literature-form" onSubmit={startResearch}>
            <label className="literature-ask-label" htmlFor="literature-question">想研究什么问题？</label>
            <textarea
              id="literature-question"
              rows={3}
              className="literature-query"
              value={question}
              placeholder="用一句话描述临床问题，例如：某治疗方案的证据、适用人群和局限；国内外指南有何差异"
              onChange={(e) => setQuestion(e.target.value)}
            />
            {patients.length > 0 && (
              <label className="literature-patient">
                <span>结合患者（可选）</span>
                <select aria-label="结合患者" value={patientId} onChange={(e) => setPatientId(e.target.value)} disabled={starting}>
                  <option value="">不结合患者</option>
                  {patients.map((patient) => <option key={patient.id} value={patient.id}>{patientOptionLabel(patient, patients)}</option>)}
                </select>
              </label>
            )}
            <button className="primary" type="submit" disabled={starting || !question.trim() || !modelConfigured} title={!modelConfigured ? "需先连接模型" : undefined}>
              {starting ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}
              开始研究
            </button>
          </form>
          <p className="om-meta literature-mode-hint">助手会检索 PubMed 英文文献，并检索中文指南、共识与期刊（中华医学期刊网、中华医学会、知网/万方等），阅读摘要或原文后比较证据，回答附来源链接，供你复核。{patientId ? "结合患者时会读取该患者档案，只把脱敏医学关键词发往网上。" : "联网只发送医学关键词。"}</p>
          {!modelConfigured && <p className="notice" role="status">需先连接模型：文献研究由助手执行，未连接模型时不能发送。<button type="button" className="text-button" onClick={openModelSettings}>连接模型</button></p>}
          {startError && <p className="form-error" role="alert">{startError}</p>}
          <div className="literature-examples" aria-label="示例问题">
            <span className="om-meta">示例：</span>
            {EXAMPLES.map((example) => <button type="button" className="om-chip" key={example} onClick={() => setQuestion(example)}>{example}</button>)}
            {specialty && <button type="button" className="om-chip" onClick={() => setQuestion(`${specialty}领域近两年有哪些重要的新研究和指南更新？`)}>我关注的领域：{specialty}</button>}
          </div>
          {recent.length > 0 && (
            <div className="literature-recent">
              <h2>最近的文献研究</h2>
              <ul>{recent.map((task) => <li key={task.id}><button type="button" className="text-button" onClick={() => onOpenTask?.(task.id)}>{task.title.slice(TASK_PREFIX.length)}</button>{task.running && <span className="om-meta"> · 进行中</span>}</li>)}</ul>
            </div>
          )}
        </section>

        <details className="literature-manual om-disclosure">
        <summary>手动检索 PubMed（高级）</summary>
        <section className="tool-section literature-search">
          {specialty && !NON_LATIN.test(specialty) && (
            <div className="tool-section-head">
              <button className="om-link" onClick={(event) => runSearch(event, { query: specialty, source: "europepmc", sort: "date" })} disabled={busy}>
                查找最新论文：{specialty} →
              </button>
            </div>
          )}
          <p className="om-meta literature-mode-hint">按标题、PMID 或英文关键词直接检索 PubMed / Europe PMC，不经过助手，只发送检索词。</p>
          <form className="literature-form" onSubmit={runSearch}>
            <input
              className="literature-manual-query"
              value={query}
              aria-label="PubMed 检索词" placeholder="英文关键词、标题或 PMID"
              onChange={(e) => setQuery(e.target.value)}
            />
            <details className="literature-options om-disclosure"><summary>检索范围：{source === "pubmed" ? "PubMed" : "Europe PMC"}{yearFrom || yearTo ? ` · ${yearFrom || "不限"}–${yearTo || "至今"}` : " · 不限年份"}</summary><div>
            <select aria-label="文献来源" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="pubmed">PubMed</option>
              <option value="europepmc">Europe PMC</option>
            </select>
            <input
              className="literature-year"
              value={yearFrom}
              aria-label="检索起始年" placeholder="起始年"
              inputMode="numeric"
              onChange={(e) => setYearFrom(e.target.value.replace(/\D/g, ""))}
            />
            <input
              className="literature-year"
              value={yearTo}
              aria-label="检索结束年" placeholder="结束年"
              inputMode="numeric"
              onChange={(e) => setYearTo(e.target.value.replace(/\D/g, ""))}
            />
            </div></details>
            <button className="secondary" type="submit" disabled={busy || !query.trim()}>
              {busy ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
              检索
            </button>
          </form>
        </section>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {results && (
          <p className="om-meta literature-meta">
            {results.cached ? "（本地缓存结果）" : ""}
            共 {results.count} 条 · 来源：{results.source === "pubmed" ? "PubMed" : "Europe PMC"}
            {results.fallback && <span role="status"> · {results.note}</span>}
          </p>
        )}
        {results && <ul className="literature-results tool-section tool-list">
          {(results?.articles || []).map((article) => {
            const key = article.pmid || article.doi;
            return (
              <li className="literature-item" key={key}>
                <div className="literature-title-row tool-list-title">
                  <button aria-expanded={Boolean(expanded[key])} className="literature-title" onClick={() => toggleExpand(article)}>
                    {article.title}
                  </button>
                  <span className="literature-journal">
                    {article.journal}
                    {article.year ? ` · ${article.year}` : ""}
                  </span>
                </div>
                <p className="literature-authors">
                  {(article.authors || []).slice(0, 4).join(", ")}
                  {article.authorCount > 4 ? " 等" : ""}
                </p>
                {(article.hints || []).length > 0 && (
                  <div className="literature-hints">
                    {article.hints.map((hint) => (
                      <span className="om-chip" key={hint}>
                        {hint}
                      </span>
                    ))}
                    {article.isOpenAccess && <span className="om-chip is-info">开放获取</span>}
                  </div>
                )}
                {expanded[key] && (
                  <div className="literature-abstract">
                    {abstractErrors[key] ? <div role="alert"><p>摘要读取失败：{abstractErrors[key]}</p><button className="secondary" onClick={() => loadAbstract(article)}>重试摘要</button></div> : abstracts[key] ? (
                      abstracts[key].abstract ? (
                        <p>{abstracts[key].abstract.replace(/<[^>]+>/g, "")}</p>
                      ) : (
                        <p className="muted">该文献未提供结构化摘要。</p>
                      )
                    ) : (
                      <p className="muted">正在加载摘要…</p>
                    )}
                  </div>
                )}
                <div className="literature-actions">
                  <button
                    className="secondary"
                    onClick={() => importAsMaterial(article)}
                    disabled={imported[key] || importing[key]}
                  >
                    {imported[key] ? <Check size={14} /> : <FilePlus size={14} />}
                    {importing[key] ? "正在导入…" : imported[key] ? "已导入" : "导入为材料"}
                  </button>
                  <button className="secondary" onClick={() => copyCitation(article)}>
                    {copied === key ? <Check size={14} /> : <Copy size={14} />}
                    复制引用
                  </button>
                  <a
                    className="icon-link"
                    href={pubmedLink(article)}
                    target="_blank"
                    rel="noreferrer"
                    title={article.pmid ? "在 PubMed 打开" : "打开 DOI 来源"}
                  >
                    <ExternalLink size={14} />
                  </a>
                </div>
              </li>
            );
          })}
          {results && !results.count && (
            <li className="tool-list-empty">没有检索到结果，可尝试更换检索词或文献源。</li>
          )}
        </ul>}
        {collected && (
          <p className="literature-collected" role="status">
            已导入 {collected.count} 篇到「{collected.title}」。
            <button type="button" className="text-button" onClick={() => onOpenTask?.(collected.id)}>打开该任务</button>
          </p>
        )}
        <p className="tool-footnote">
          {patientId ? "导入的文献放进所选患者的会话；" : "导入的文献都放进同一个“文献收集”任务；"}证据类型标签由出版类型映射而来，仅为提示，不构成质量结论；「导入为材料」只导入题录与摘要（含 MeSH 主题词），不下载全文。
        </p>
        </details>
      </section>
    </div>
  );
}
