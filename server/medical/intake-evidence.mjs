import { createHash } from 'node:crypto';
import { auditIntakeLabs } from './intake-lab-evidence.mjs';

const normal = value => String(value ?? '').normalize('NFKC').replace(/[\s。:：]/gu, '').toLowerCase();
const datePattern = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/u;
const date = text => { const m = String(text || '').match(datePattern); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };
function issue(section, kind, row, claim, message) {
  return { id: `intake-${createHash('sha256').update(JSON.stringify([section, kind, row.sourceId, row.startLine, row.quote, claim])).digest('hex').slice(0, 24)}`, section, kind, message, ...row };
}

// Only explicit clinical record rows are counted; narrative dates and numbers
// are not converted into invented records. Original text stays authoritative.
export function auditIntakeEvidence({ payload, sources = [], notes = [] }) {
  const issues = auditIntakeLabs({ payload, sources, notes });
  // 没识别出文字的图片：逐条检验必然对不上行号，先给出根因和处理办法。
  for (const source of sources) {
    if (!source.unrecognized) continue;
    issues.unshift(issue('sources', 'source-unrecognized', { sourceId: source.id, sourceName: source.name, startLine: 0, endLine: 0, quote: '' }, source.unrecognized,
      `图片资料「${source.name}」没有识别成可回查的文字（${source.unrecognized}），其中的检验、用药等无法按原文行核对。请在资料详情点「重新识别」后重新整理；仍无法识别的，由医生对照原图逐项核对。`));
  }
  for (const source of sources) {
    let section = '';
    String(source.text || '').split('\n').forEach((quote, index) => {
      const text = quote.normalize('NFKC').trim();
      if (/^(?:#{1,6}\s*)?(?:用药|药物)(?:记录|史|清单)?[\s:：,，]/u.test(text)) { section = 'medications'; return; }
      if (/^(?:#{1,6}\s*)?就诊(?:记录|经历|史)?[\s:：,，]/u.test(text)) { section = 'visits'; return; }
      if (/^(?:#{1,6}\s*)?(?:检验|化验|诊断|过敏|病史|影像)/u.test(text)) { section = ''; return; }
      const row = { sourceId: source.id, sourceName: source.name, startLine: index + 1, endLine: index + 1, quote };
      if (section === 'medications' || /(?:药名|药物名称)\s*[:：]/u.test(text)) {
        const explicit = text.match(/(?:药名|药物名称)\s*[:：]\s*([^;；|]+)/u)?.[1];
        const name = explicit || (section === 'medications' && date(text) ? text.replace(datePattern, '').replace(/^\s*[:：]\s*/u, '').split(/[;；|]/u)[0] : '');
        if (!name || !/(?:状态|剂量|频次)\s*[:：]?/u.test(text)) return;
        const statusText = text.match(/(?:当前)?状态\s*[:：]?\s*([^;；|。]+)/u)?.[1] || '';
        const status = /停用|停止|stopped/iu.test(statusText) ? 'stopped' : /未知|待核对|unknown/iu.test(statusText) ? 'unknown' : /正在|在用|使用|active/iu.test(statusText) ? 'active' : '';
        const matches = (payload.medications || []).filter(item => normal(item.name) === normal(name));
        if (!matches.length) issues.push(issue('medications', 'omission', row, { name, status }, `原文用药未列入草稿：${name.trim()}`));
        else if (status && !matches.some(item => item.status === status)) issues.push(issue('medications', 'status-conflict', row, matches, `用药状态与原文不一致：${name.trim()}`));
      }
      if (section === 'visits' || /就诊(?:事由|原因)\s*[:：]?/u.test(text)) {
        const when = date(text), reason = text.match(/就诊(?:事由|原因)\s*[:：]?\s*([^;；|]+)/u)?.[1];
        if (!when || !reason) return;
        const matches = (payload.visits || []).filter(item => date(item.date) === when);
        if (!matches.length) issues.push(issue('visits', 'omission', row, { date: when, reason }, `原文就诊日期未列入草稿：${when}`));
        else if (!matches.some(item => normal(item.reason) === normal(reason))) issues.push(issue('visits', 'source-unverified', row, matches, `请核对 ${when} 就诊事由是否准确保留原文`));
      }
    });
  }
  const sourceDigest = createHash('sha256').update(JSON.stringify(sources.map(({ id, text }) => [id, text]))).digest('hex');
  return issues.map(item => ({ ...item, id: `${item.id}-${sourceDigest.slice(0, 16)}` }));
}

export function validEvidenceReview(review) {
  return Boolean(review && ['verified', 'exclude'].includes(review.decision) && typeof review.reason === 'string' && review.reason.trim().length >= 4 && review.reason.trim().length <= 500);
}
export function intakeAudit(payload, sources, reviews = {}) {
  const issues = auditIntakeEvidence({ payload, sources });
  return { sources: sources.map(({ id, name }) => ({ id, name })), issues, unresolved: issues.filter(item => !validEvidenceReview(reviews[item.id]) || reviews[item.id]?.decision !== (item.kind === 'omission' ? 'exclude' : 'verified')).map(item => item.id), scope: '自动核对仅覆盖可识别的结构化检验、用药状态和就诊记录；叙述、图像识别与其他事实仍需逐项对照原件。' };
}
