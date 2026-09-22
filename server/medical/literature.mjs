import { AppError, check, string } from "../errors.mjs";

// Medical literature search over free public APIs: PubMed E-utilities and
// Europe PMC. Only the query terms leave the machine — never patient
// material. Results are cached locally; imports go through the regular
// session file path so provenance (SHA-256) is preserved.
const PUBMED = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const EUROPEPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PUBMED_MIN_GAP_MS = 400; // NCBI allows 3 req/s; stay below it.

// Publication-type → evidence hint. Advisory only, never a quality verdict.
const EVIDENCE_HINTS = [
  ["meta-analysis", "Meta 分析"],
  ["systematic review", "系统评价"],
  ["randomized controlled trial", "RCT"],
  ["controlled clinical trial", "对照临床试验"],
  ["cohort", "队列研究"],
  ["practice guideline", "临床指南"],
  ["review", "综述"],
  ["case reports", "病例报告"],
];
const evidenceHints = (pubTypes = []) => {
  const joined = pubTypes.join(" ").toLowerCase();
  return EVIDENCE_HINTS.filter(([key]) => joined.includes(key)).map(
    ([, label]) => label,
  );
};

export class LiteratureService {
  constructor(store, { fetchImpl = fetch, timeoutMs = 8000, retryDelayMs = 400 } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.lastPubMedCall = 0;
  }
  cacheGet(key) {
    const row = this.store.db
      .prepare("SELECT payload, created_at FROM literature_cache WHERE key=?")
      .get(key);
    if (!row) return null;
    if (Date.now() - row.created_at > CACHE_TTL_MS) {
      this.store.db.prepare("DELETE FROM literature_cache WHERE key=?").run(key);
      return null;
    }
    return JSON.parse(row.payload);
  }
  cacheSet(key, payload) {
    this.store.db
      .prepare(
        "INSERT INTO literature_cache(key,payload,created_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at",
      )
      .run(key, JSON.stringify(payload), Date.now());
  }
  async request(url, { throttle = false } = {}) {
    const source = url.startsWith(PUBMED) ? "PubMed" : "Europe PMC";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      if (throttle) {
        const wait = this.lastPubMedCall + PUBMED_MIN_GAP_MS - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        this.lastPubMedCall = Date.now();
      }
      let retryable = true;
      try {
        const response = await this.fetchImpl(url, {
          headers: { "User-Agent": "open-medical-workbench/0.9 (local)" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          await response.body?.cancel();
          throw new AppError("LITERATURE_SOURCE", `${source} 返回 HTTP ${response.status}`, 502);
        }
        // Consume the body within the same timeout and retry boundary.
        return await response.json();
      } catch (cause) {
        const error = cause instanceof AppError ? cause : new AppError(
          "LITERATURE_NETWORK",
          `${source} ${cause.name === "TimeoutError" || cause.name === "AbortError" ? "请求超时" : cause instanceof SyntaxError ? "返回数据无法解析" : "网络连接失败"}`,
          502,
        );
        error.retryable = retryable;
        if (!retryable || attempt === 1) {
          error.message += retryable ? "（已重试 1 次）" : "";
          throw error;
        }
      }
    }
  }

  normalizeQuery(query) {
    const text = string(query, "检索词", 400);
    check(text.trim().length >= 2, "INVALID_INPUT", "检索词至少 2 个字符");
    return text.trim();
  }
  async search({
    query,
    source = "pubmed",
    yearFrom,
    yearTo,
    limit = 10,
    sort = "relevance",
  } = {}) {
    const text = this.normalizeQuery(query);
    check(
      ["relevance", "date"].includes(sort),
      "INVALID_INPUT",
      "排序仅支持 relevance 或 date",
    );
    check(
      ["pubmed", "europepmc"].includes(source),
      "INVALID_INPUT",
      "文献源仅支持 pubmed 或 europepmc",
    );
    check(
      Number.isInteger(limit) && limit >= 1 && limit <= 30,
      "INVALID_INPUT",
      "返回数量须为 1–30",
    );
    const year = (value, min = 1800) => {
      if (value === undefined || value === null || value === "") return null;
      check(
        Number.isInteger(value) && value >= min && value <= new Date().getFullYear(),
        "INVALID_INPUT",
        `年份须为 ${min}–${new Date().getFullYear()}`,
      );
      return value;
    };
    const from = year(yearFrom);
    const to = year(yearTo);
    check(!from || !to || from <= to, "INVALID_INPUT", "年份区间无效");
    const cacheKey = JSON.stringify(["search", source, text, from, to, limit, sort]);
    const cached = this.cacheGet(cacheKey);
    if (cached) return { ...cached, cached: true };
    let actualSource = source, fallbackReason;
    const searchSource = (selected) => selected === "pubmed"
      ? this.searchPubMed(text, from, to, limit, sort)
      : this.searchEurope(text, from, to, limit, sort);
    let articles;
    try {
      articles = await searchSource(source);
    } catch (error) {
      if (!error.retryable) throw error;
      actualSource = source === "pubmed" ? "europepmc" : "pubmed";
      fallbackReason = error.message;
      try { articles = await searchSource(actualSource); }
      catch (fallbackError) {
        throw new AppError("LITERATURE_UNAVAILABLE",
          `文献检索暂不可用：${fallbackReason}；${fallbackError.message}。请稍后重试。`, 502);
      }
    }
    const result = {
      source: actualSource,
      requestedSource: source,
      ...(fallbackReason ? { fallback: true, fallbackReason } : {}),
      query: text,
      count: articles.length,
      articles,
      note: `${fallbackReason ? `首选来源暂不可用，已切换至 ${actualSource === "pubmed" ? "PubMed" : "Europe PMC"}；检索范围可能不同。` : ""}检索只发送了检索词；证据类型标签仅为提示，不构成质量结论。`,
    };
    // Do not cache a fallback under the requested source: allow primary recovery.
    if (!fallbackReason) this.cacheSet(cacheKey, result);
    return result;
  }
  async searchGroups({ queries, ...options }) {
    check(Array.isArray(queries) && queries.length >= 2 && queries.length <= 4,
      "INVALID_INPUT", "请提供 2–4 组英文检索式：核心概念、同义词扩展、必要时较宽泛检索");
    const normalized = [...new Set(queries.map((q) => this.normalizeQuery(q)))];
    check(normalized.length >= 2 && normalized.every((q) => /[a-zA-Z]/.test(q) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}]/u.test(q)),
      "INVALID_INPUT", "queries 需为至少两组不同的英文检索式；先提取医学概念和同义词，不发送患者身份信息");
    // Sequential groups respect public API quotas; each retains its own outcome.
    const searches = [], articles = [], byId = new Map();
    for (const query of normalized) {
      try {
        const result = await this.search({ ...options, query });
        searches.push({ query, source: result.source, count: result.count, status: "ok",
          ...(result.fallback ? { fallback: true, fallbackReason: result.fallbackReason } : {}) });
        for (const article of result.articles) {
          const keys = [article.pmid && `pmid:${article.pmid}`, article.doi && `doi:${article.doi.toLowerCase()}`,
            !article.pmid && !article.doi && `title:${article.title.toLowerCase()}:${article.year}`].filter(Boolean);
          let saved = keys.map((key) => byId.get(key)).find(Boolean);
          if (!saved) { saved = { ...article, matchedQueries: [], sources: [] }; articles.push(saved); }
          if (!saved.matchedQueries.includes(query)) saved.matchedQueries.push(query);
          if (!saved.sources.includes(result.source)) saved.sources.push(result.source);
          for (const key of keys) byId.set(key, saved);
        }
      } catch (error) {
        if (error.code === "INVALID_INPUT") throw error;
        searches.push({ query, status: "failed", error: error.message });
      }
    }
    if (searches.every((s) => s.status === "failed"))
      throw new AppError("LITERATURE_UNAVAILABLE", `所有检索组均失败，不能判定为零文献：${searches.map((s) => s.error).join("；")}`, 502);
    return { searches, articles, count: articles.length,
      partial: searches.some((s) => s.status === "failed"),
      note: "结果已按 PMID / DOI 去重。各组计数为本次取回数量，非数据库总量；逐项核对摘要与问题相关性。零结果仅说明这些检索式未命中，不代表没有相关文献。" };
  }
  async searchPubMed(text, from, to, limit, sort = "relevance") {
    const terms = [text];
    if (from || to)
      terms.push(
        `(${from || 1800}:${to || new Date().getFullYear()}[dp])`,
      );
    const searchUrl = `${PUBMED}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(terms.join(" AND "))}&retmax=${limit}&retmode=json&sort=${sort === "date" ? "pub_date" : "relevance"}`;
    const searchResult = await this.request(searchUrl, { throttle: true });
    check(Array.isArray(searchResult?.esearchresult?.idlist), "LITERATURE_SOURCE", "PubMed 返回数据格式异常", 502);
    const ids = searchResult.esearchresult.idlist;
    if (!ids.length) return [];
    const summaryUrl = `${PUBMED}/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`;
    const summary = await this.request(summaryUrl, { throttle: true });
    return ids
      .map((pmid) => {
        const item = summary?.result?.[pmid];
        if (!item) return null;
        const authors = (item.authors || [])
          .map((a) => a.name)
          .filter(Boolean);
        return {
          pmid,
          doi: (item.articleids || []).find((a) => a.idtype === "doi")?.value || null,
          title: String(item.title || "").replace(/\.$/, ""),
          journal: item.fulljournalname || item.source || "",
          year: Number(item.pubdate?.match(/\d{4}/)?.[0] || 0) || null,
          pubDate: item.pubdate || "",
          authors: authors.slice(0, 6),
          authorCount: authors.length,
          pubTypes: (item.pubtype || []).map(String),
          hints: evidenceHints((item.pubtype || []).map(String)),
        };
      })
      .filter(Boolean);
  }
  async searchEurope(text, from, to, limit, sort = "relevance") {
    const terms = [text];
    if (from || to)
      terms.push(
        `FIRST_PDATE:[${from || 1800} TO ${to || new Date().getFullYear()}]`,
      );
    const sortParam = sort === "date" ? "&sort=P_PDATE_D%20desc" : "";
    const url = `${EUROPEPMC}/search?query=${encodeURIComponent(terms.join(" AND "))}&format=json&pageSize=${limit}&resultType=lite${sortParam}`;
    const result = await this.request(url);
    return (result?.resultList?.result || []).map((item) => ({
      pmid: item.pmid || null,
      pmcid: item.pmcid || null,
      doi: item.doi || null,
      title: String(item.title || "").replace(/\.$/, ""),
      journal: item.journalTitle || item.journalInfo?.journal?.title || "",
      year: Number(item.pubYear || 0) || null,
      pubDate: item.firstPublicationDate || "",
      authors: String(item.authorString || "")
        .split(/,\s*/)
        .filter(Boolean)
        .slice(0, 6),
      authorCount: (item.authorString || "").split(",").length,
      pubTypes: item.pubTypeList?.pubType || [],
      hints: evidenceHints(item.pubTypeList?.pubType || []),
      isOpenAccess: item.isOpenAccess === "Y",
    }));
  }
  async fetchArticle({ pmid, doi } = {}) {
    check(
      (pmid && !doi) || (!pmid && doi),
      "INVALID_INPUT",
      "请提供 pmid 或 doi 之一",
    );
    if (pmid) check(/^\d{1,9}$/.test(String(pmid)), "INVALID_INPUT", "PMID 格式无效");
    if (doi) check(String(doi).length <= 200, "INVALID_INPUT", "DOI 过长");
    const key = JSON.stringify(["article", pmid || doi]);
    const cached = this.cacheGet(key);
    if (cached) return { ...cached, cached: true };
    const query = pmid ? `EXT_ID:${pmid} AND SRC:MED` : `DOI:"${doi}"`;
    const url = `${EUROPEPMC}/search?query=${encodeURIComponent(query)}&format=json&pageSize=1&resultType=core`;
    const result = await this.request(url);
    const item = result?.resultList?.result?.[0];
    check(item, "NOT_FOUND", "未找到该文献", 404);
    const article = {
      pmid: item.pmid || null,
      pmcid: item.pmcid || null,
      doi: item.doi || null,
      title: String(item.title || "").replace(/\.$/, ""),
      journal: item.journalInfo?.journal?.title || item.journalTitle || "",
      year: Number(item.pubYear || 0) || null,
      authors: String(item.authorString || "").split(/,\s*/).filter(Boolean),
      abstract: item.abstractText || "",
      meshTerms: (item.meshHeadingList?.meshHeading || [])
        .map((m) => m.majorTopic_major || m.majorTopic || m)
        .map((m) => (typeof m === "string" ? m : String(m)))
        .slice(0, 20),
      pubTypes: item.pubTypeList?.pubType || [],
      hints: evidenceHints(item.pubTypeList?.pubType || []),
      isOpenAccess: item.isOpenAccess === "Y",
      license: item.license || null,
      note: "摘要与主题词来自 Europe PMC；全文获取仅限开放获取许可范围。",
    };
    this.cacheSet(key, article);
    return article;
  }
  // Build a markdown material from an article; the caller decides where the
  // file goes (UI import → session addFile).
  materialText(article) {
    const authors = article.authors || [];
    const authorText =
      authors.length > 6 ? `${authors.slice(0, 6).join(", ")} 等` : authors.join(", ");
    const lines = [
      `# ${article.title}`,
      "",
      `${authorText}. ${article.journal}${article.year ? ` ${article.year}` : ""}.`,
      article.doi ? `doi: ${article.doi}` : "",
      article.pmid ? `PMID: ${article.pmid}` : "",
      article.hints?.length ? `证据类型提示: ${article.hints.join("、")}（提示非结论）` : "",
      "",
      "## 摘要",
      article.abstract || "（该文献未提供结构化摘要）",
      "",
      article.meshTerms?.length ? `## MeSH 主题词\n${article.meshTerms.join("；")}` : "",
      "",
      `来源: Europe PMC REST API；导入时间 ${new Date().toISOString()}`,
    ];
    return lines.filter((line) => line !== "").join("\n");
  }
}

const textDef = { type: "string" };
// Agent tools. Registration goes through MedicalRuntime toolPlugins, so the
// model can search literature during evidence work; search sends only the
// query string to the configured public source.
export function literatureTools(literature) {
  const definition = (name, description, properties, required = []) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  });
  return [
    {
      definition: definition(
        "literature_search",
        "检索 PubMed / Europe PMC。主题问题先提取核心概念，将非英文问题改写为英文医学检索词，提供 queries（2–4 组）：核心概念 AND 症状、同义词 OR 扩展、较宽泛检索。保持原意，歧义分组，不虚构已核实的 MeSH。只发送脱敏关键词。返回分组检索记录、去重文献与命中来源；取摘要核实相关性再引用。query 单组仅用于精确查找或补充检索。",
        {
          query: textDef,
          queries: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
          source: textDef,
          yearFrom: { type: "integer" },
          yearTo: { type: "integer" },
          limit: { type: "integer" },
        },
        [],
      ),
      // 参数类错误返回给模型自适应重试，而不是作为 rejection 逃逸。
      execute: async (args) => {
        try {
          if (args.queries !== undefined) return await literature.searchGroups(args);
          if (typeof args.query === "string" && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}]/u.test(args.query))
            return { code: "LITERATURE_REWRITE_REQUIRED", error: "尚未执行检索。请把用户主题提取为英文医学概念，生成 2–4 组不同 queries（核心概念、同义词、宽泛检索）后重新调用。不要把本提示当作零结果，也不要要求用户自行翻译。" };
          return await literature.search(args);
        } catch (error) {
          if (error instanceof Error && error.code === "INVALID_INPUT")
            return { error: error.message, code: error.code };
          throw error;
        }
      },
    },
    {
      definition: definition(
        "literature_fetch",
        "按 PMID 或 DOI 获取单篇文献的完整摘要与主题词（Europe PMC）。",
        { pmid: textDef, doi: textDef },
        [],
      ),
      execute: async (args) => {
        try {
          return await literature.fetchArticle(args);
        } catch (error) {
          if (error instanceof Error && error.code === "INVALID_INPUT")
            return { error: error.message, code: error.code };
          throw error;
        }
      },
    },
  ];
}
