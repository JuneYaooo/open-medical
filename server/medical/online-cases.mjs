import { check, string } from '../errors.mjs';

// The model supplies medical concepts, never the patient's raw chart.
export function onlineCaseTools(literature) {
  return [{
    definition: { type: 'function', function: {
      name: 'online_case_search',
      description: '检索 PubMed 和 Europe PMC 网上病例报告。只传脱敏英文医学关键词（不要姓名、电话、病历号、精确日期）；保留来源、失败和缓存状态。返回的是待核验文献候选，不是已经确认的相似患者。',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: '英文疾病/综合征及鉴别特征关键词' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      }, required: ['query'], additionalProperties: false },
    } },
    capability: { backend: 'public-fetch' },
    execute: async ({ query, limit = 5 }) => {
      const q = string(query, '医学检索词', 300).trim();
      check(/[a-zA-Z]/.test(q) && !/[\p{Script=Han}@]/u.test(q) && !/\d{7,}|\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(q), 'INVALID_INPUT', '请使用脱敏英文医学关键词，不含姓名、联系方式、编号或精确日期');
      check(Number.isInteger(limit) && limit >= 1 && limit <= 10, 'INVALID_INPUT', '每个来源最多 10 条');
      const searches = [], candidates = [], seen = new Set();
      for (const source of ['pubmed', 'europepmc']) {
        const expression = source === 'pubmed' ? `(${q}) AND ("Case Reports"[Publication Type] OR "case report"[Title])` : `(${q}) AND (PUB_TYPE:"case report" OR TITLE:"case report")`;
        try {
          const result = await literature.search({ query: expression, source, limit });
          searches.push({ requestedSource: source, source: result.source, query: expression, status: 'ok', cached: !!result.cached, count: result.count, fallbackReason: result.fallbackReason });
          for (const article of result.articles) {
            const key = article.pmid || article.doi?.toLowerCase() || article.title?.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            candidates.push({ ...article, sourceType: 'online-publication', verification: 'unverified-publication-candidate', evidenceScope: 'bibliographic-metadata' });
          }
        } catch (error) { searches.push({ requestedSource: source, query: expression, status: 'failed', error: error.message }); }
      }
      return { searches, candidates, count: candidates.length, retrievedAt: new Date().toISOString(),
        note: '本次为 PubMed/Europe PMC 定向检索，未覆盖全部中文病例库。必须用 literature_fetch 或 web_fetch 核对摘要/原文与疾病主轴后才能称为相似病例；候选数不是独立患者数。失败不等于无病例，缓存不等于实时检索。' };
    },
  }];
}
