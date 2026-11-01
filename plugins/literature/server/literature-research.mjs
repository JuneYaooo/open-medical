import { check } from '../../../server/errors.mjs';
import { normalizeWebUrl } from '../../../shared/web-source.mjs';

export const LITERATURE_RESEARCH_GUIDANCE = `
当前任务是文献研究：完成检索、阅读、比较、综合回答，不能以搜索结果列表或检索计划作为最终交付。
1. 先明确医生真正要回答的问题；有当前患者时读取最新档案与相关原文。只提取与问题有关的临床条件，不推断缺失事实。若范围足够明确，直接研究，不要求医生填写 PICO 表。
2. 英文文献（PubMed/Europe PMC）用 literature_search 的 queries 设计 2–4 组互补英文检索式。按问题选择指南、系统综述、原始研究。中国指南、专家共识和中文文献用 web_search 中文关键词检索，用 domains 限定 yiigle.com（中华医学期刊网）、cma.org.cn（中华医学会）、cnki.net、wanfangdata.com.cn、nhc.gov.cn 等；需要时也可限定 mp.weixin.qq.com、dxy.cn。联网只发脱敏医学关键词，不含患者姓名、电话、病历号、证件号或具体日期（系统会拒绝这类检索词）。
3. 对相关候选调用 literature_fetch 阅读摘要；网页来源用 web_fetch 读取正文，能取得合法全文时进一步阅读原文。先读最相关的 3–6 篇，再根据证据矛盾或关键缺口补充检索；不足数量时如实说明，不能凑数。题录、摘要、全文、网页正文分别标注；网页搜索摘要不能作为指南条文。每个来源标明类型：期刊论文、指南/共识原文、学会或机构网页、公众号文章或论坛帖子；公众号与论坛内容未经同行评审，证据等级较低，须明确标注并尽量追溯原始出处。
4. 比较研究设计、人群、干预/对照、主要结局、效应及不确定性。数值与结论仅取自已读来源。区分证据一致之处、分歧及适用边界；有患者时解释与该患者的相关性和未知条件。
5. 最终回答先直接回答问题，再提供关键证据对照表、综合解读与局限、可打开的来源链接。每项实质结论就近引用已读来源，保留 PMID/DOI、年份及资料范围；引用的网页链接必须是本次 web_fetch 实际读取过的网址，只见过搜索摘要的网页不作为引用链接。简述实际检索式与范围，不声称完成了穷尽检索或正式系统综述。未联网成功必须说明，不能把失败说成零文献。
研究完成后保留结果并结束；医生可以继续追问。除非明确要求，不自动把论文入库、不生成文书、不修改患者档案。`;

// Read receipts from the run trace so model-context compaction cannot erase them.
export function literatureRunEvidence(db, { workspaceId, runId } = {}) {
  if (!workspaceId || !runId) return {};
  const workspace = db.prepare('SELECT data FROM agent_workspaces WHERE id=?').get(workspaceId);
  const run = workspace && JSON.parse(workspace.data).runs?.find(item => item.id === runId);
  if (run?.policy?.workflow !== 'literature-research') return {};
  const rows = db.prepare(`SELECT data FROM agent_trace WHERE workspace_id=? AND run_id=?
    AND json_extract(data,'$.type')='tool.result'
    AND json_extract(data,'$.call.function.name') IN ('literature_search','literature_fetch','web_search','web_fetch')`).all(workspaceId, runId);
  const evidence = { research: true, searched: false, candidates: false, fetched: false, pmids: [], dois: [], urls: [] };
  for (const row of rows) {
    const { call, output } = JSON.parse(row.data);
    if (call.function.name === 'literature_search') {
      evidence.searched = true;
      if (!output?.error && output?.articles?.length) evidence.candidates = true;
    } else if (call.function.name === 'web_search') {
      evidence.searched = true;
      if (!output?.error && output?.results?.length) evidence.candidates = true;
    } else if (call.function.name === 'web_fetch') {
      // 网页回执：只有成功读取到正文的网址可作为引用链接。
      evidence.fetched = true;
      if (!output?.error && typeof output?.text === 'string') {
        let requested = '';
        try { requested = JSON.parse(call.function.arguments || '{}').url || ''; } catch {}
        for (const url of [output.url, requested]) if (url) evidence.urls.push(normalizeWebUrl(url));
      }
    } else {
      evidence.fetched = true;
      if (!output?.error && output?.abstract?.trim()) {
        if (output.pmid) evidence.pmids.push(String(output.pmid));
        if (output.doi) evidence.dois.push(String(output.doi).toLowerCase());
      }
    }
  }
  return evidence;
}

export function verifyLiteratureResearch({ messages = [], text = '', evidence = {} }) {
  if (!evidence.research) return;
  const final = messages.at(-1);
  if (final?.role === 'assistant' && !final.tool_calls?.length) text = final.content || '';
  const unknownPmid = [...text.matchAll(/https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/g)].some(match => !evidence.pmids.includes(match[1]));
  // Stop at CJK punctuation and strip trailing sentence punctuation, as for URLs below.
  const unknownDoi = [...text.matchAll(/https?:\/\/doi\.org\/([^\s)\]>"'<，。；、）】]+)/g)].some(match => !evidence.dois.includes(match[1].replace(/[.,;:!?]+$/, '').toLowerCase()));
  // 其他网页链接须在本次 web_fetch 成功读取过；文献库链接由上面的 PMID/DOI 核验。
  const fetchedUrls = new Set((evidence.urls || []).map(normalizeWebUrl));
  const unknownUrl = [...text.matchAll(/https?:\/\/[^\s)\]>"'<，。；、）】]+/g)].map(match => match[0].replace(/[.,;:!?]+$/, ''))
    .filter(url => !/^https?:\/\/(?:[\w-]+\.)*(?:pubmed\.ncbi\.nlm\.nih\.gov|doi\.org|ncbi\.nlm\.nih\.gov|europepmc\.org)(?:[/:?#]|$)/i.test(url))
    .some(url => !fetchedUrls.has(normalizeWebUrl(url)));
  if (evidence.searched && (!evidence.candidates || evidence.fetched) && !unknownPmid && !unknownDoi && !unknownUrl) return;
  const retries = messages.filter(message => message.name === 'runtime_control' && message.content?.includes('文献研究核验：')).length;
  check(false, retries < 2 ? 'COMPLETE_RETRY' : 'RESEARCH_EVIDENCE', '文献研究核验：先实际检索，并阅读相关论文摘要后综合回答。PubMed/DOI 引用必须来自本次成功取得摘要的文献，网页链接必须是本次 web_fetch 成功读取过的网址（只见过搜索摘要的网页不要给出链接）。检索或阅读失败时明确说明可用范围，不补造结论，也不要把尚未阅读的候选列表当作研究结果。');
}

export function researchAnswer(workspace, runId, result) {
  if (workspace.runs?.find(run => run.id === runId)?.policy?.workflow !== 'literature-research') return result;
  const last = result.messages?.at(-1);
  return last?.role === 'assistant' && !last.tool_calls?.length && typeof last.content === 'string' ? { ...result, text: last.content } : result;
}
