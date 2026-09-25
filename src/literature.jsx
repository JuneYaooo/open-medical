import { useEffect, useRef, useState } from "react";
import { api } from "./agent-runtime";
import { Search, Loader2, FilePlus, Copy, ExternalLink, Check } from "lucide-react";

// Literature search view: queries PubMed / Europe PMC through the local
// server. Only the query text leaves the machine; imports land as session
// materials with SHA-256 provenance.
export function LiteratureView({ onOpenTask }) {
  const [specialty, setSpecialty] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("pubmed");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState({});
  const importsInFlight = useRef(new Set());
  const importSessions = useRef(new Map());
  const [importing, setImporting] = useState({});
  const [abstractErrors, setAbstractErrors] = useState({});
  const [abstracts, setAbstracts] = useState({});
  const [imported, setImported] = useState({});
  const [copied, setCopied] = useState("");

  useEffect(() => {
    api("/api/doctor/profile")
      .then((profile) => setSpecialty(profile.fields?.specialty || ""))
      .catch(() => {});
  }, []);
  const runSearch = async (event, options = {}) => {
    event?.preventDefault();
    const searchQuery = options.query ?? query;
    if (!searchQuery.trim()) return;
    setBusy(true);
    setError("");
    setResults(null);
    try {
      if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}]/u.test(searchQuery)) {
        const session = await api("/api/sessions", "POST", { title: `文献检索 · ${searchQuery.slice(0, 40)}` });
        await onOpenTask(session.id, { draft: `请检索以下主题的论文：${searchQuery}。先提取核心医学概念并改写为 2–4 组英文检索式，分组检索、去重，核对摘要相关性后列出文献和出处。首选来源 ${options.source || source}。${yearFrom ? `起始年 ${yearFrom}。` : ""}${yearTo ? `结束年 ${yearTo}。` : ""}不要把未命中说成没有相关论文。` });
        return;
      }
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
      let session = importSessions.current.get(key);
      if (!session) {
        session = await api("/api/sessions", "POST", { title: `文献 · ${(article.title || "未命名").slice(0, 40)}` });
        importSessions.current.set(key, session);
      }
      await api("/api/literature/import", "POST", {
        sessionId: session.id,
        pmid: article.pmid || undefined,
        doi: article.pmid ? undefined : article.doi || undefined,
      });
      setImported((prev) => ({ ...prev, [article.pmid || article.doi]: true }));
      await onOpenTask?.(session.id);
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
      setError("浏览器拒绝了剪贴板访问");
    }
  };
  const pubmedLink = (article) =>
    article.pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`
      : `https://doi.org/${article.doi}`;

  return (
    <div className="module-view">
      <section className="module-card literature-view">
        <div className="module-head">
          <div>
            <h1>文献检索</h1>
            <p className="module-phase">PubMed · Europe PMC · 检索结果本地缓存 6 小时</p>
          </div>
        </div>
        {specialty && (
          <button
            className="secondary"
            style={{ marginBottom: 10 }}
            onClick={(event) =>
              runSearch(event, {
                query: specialty,
                source: "europepmc",
                sort: "date",
              })
            }
            disabled={busy}
          >
            查我领域最新文献：{specialty}
          </button>
        )}
        <form className="literature-form" onSubmit={runSearch}>
          <input
            className="literature-query"
            value={query}
            aria-label="文献检索主题" placeholder="英文关键词，或用中文描述论文主题"
            onChange={(e) => setQuery(e.target.value)}
          />
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
          <button type="submit" disabled={busy || !query.trim()}>
            {busy ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
            {/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}]/u.test(query) ? "让助手规划检索" : "检索"}
          </button>
        </form>
        {/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}]/u.test(query) && <p className="muted">将打开任务并填入主题；发送后由助手转为英文、分组检索。</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {results && (
          <p className="muted literature-meta">
            {results.cached ? "（本地缓存结果）" : ""}
            共 {results.count} 条 · 来源：{results.source === "pubmed" ? "PubMed" : "Europe PMC"}
            {results.fallback && <span role="status"> · {results.note}</span>}
          </p>
        )}
        <ul className="literature-results">
          {(results?.articles || []).map((article) => {
            const key = article.pmid || article.doi;
            return (
              <li className="literature-item" key={key}>
                <div className="literature-title-row">
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
                      <span className="hint-tag" key={hint}>
                        {hint}
                      </span>
                    ))}
                    {article.isOpenAccess && <span className="hint-tag oa">开放获取</span>}
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
            <li className="memory-empty">没有检索到结果，可尝试更换检索词或文献源。</li>
          )}
        </ul>
        <p className="module-note">
          证据类型标签由出版类型映射而来，仅为提示，不构成质量结论；全文导入仅限摘要与开放获取许可范围。
        </p>
      </section>
    </div>
  );
}
