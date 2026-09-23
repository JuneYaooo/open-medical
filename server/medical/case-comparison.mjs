import {CASE_DIMENSIONS} from '../../shared/case-comparison.mjs';
import {medicalExcerpt} from '../../shared/medical-excerpt.mjs';
const normalized=value=>medicalExcerpt(value).replace(/\s+/gu,' ').trim();
export function evidenceText(value) {
  const parts=[JSON.stringify(value)];
  const visit=item=>{if(typeof item==='string')parts.push(item);else if(item&&typeof item==='object')Object.values(item).forEach(visit);};
  visit(value);return parts.join('\n');
}
export const quoteInEvidence=(quote,evidence)=>Boolean(quote?.trim() && normalized(evidence).includes(normalized(quote)));
export function comparisonIssues(input=[],currentEvidence='',candidateEvidence='') {
  const issues=[];
  for(const d of CASE_DIMENSIONS){
    const rows=input.filter(r=>r.dimension===d.key),r=rows[0];
    if(rows.length!==1){issues.push(`${d.key}：必须提供且只能提供一项，未知项留空引文并标 unknown`);continue;}
    if(r.currentQuote?.trim()&&!quoteInEvidence(r.currentQuote,currentEvidence))issues.push(`${d.key}.currentQuote：不在已读取的当前患者原文中`);
    if(r.candidateQuote?.trim()&&!quoteInEvidence(r.candidateQuote,candidateEvidence))issues.push(`${d.key}.candidateQuote：不在候选原文中`);
    if(r.relation!=='unknown'&&(!r.currentQuote?.trim()||!r.candidateQuote?.trim()))issues.push(`${d.key}：缺少双方引文时 relation 必须为 unknown`);
  }
  return issues;
}
const text={type:'string',maxLength:600};
export const comparisonSchema={type:'array',maxItems:5,items:{type:'object',properties:{dimension:{type:'string',enum:CASE_DIMENSIONS.map(d=>d.key)},current:text,currentQuote:text,candidate:text,candidateQuote:text,relation:{type:'string',enum:['match','partial','different','unknown']},reason:text},required:['dimension','current','currentQuote','candidate','candidateQuote','relation','reason'],additionalProperties:false}};
export function verifyComparison(input=[],currentEvidence='',candidateEvidence='') {
  return CASE_DIMENSIONS.map(d=>{
    const matches=input.filter(r=>r.dimension===d.key);
    const proposed=matches.length===1?matches[0]:undefined;
    const currentValid=quoteInEvidence(proposed?.currentQuote,currentEvidence);
    const candidateValid=quoteInEvidence(proposed?.candidateQuote,candidateEvidence);
    const values=[proposed?.current,proposed?.candidate,proposed?.currentQuote,proposed?.candidateQuote].filter(Boolean).join('\n');
    // A model may label an explicitly unresolved stage/regimen as comparable.
    // Preserve the facts for reading, but exclude that uncertainty from scores.
    const unresolved=d.key==='stage' && /未知|不详|未确定|未确诊|未提供|未记录|无确切分期|缺少.*分期|疑似|待定|not (?:determined|confirmed|reported)|unknown/i.test(values) ||
      d.key==='medications' && /当前.{0,12}(?:未知|未记录|未确认|待核对)|是否.{0,8}(?:未知|不详|未确认)|服用状态.{0,8}(?:不详|未知|未记录|未确认)|未记录.{0,8}(?:当前|服用状态)|current.{0,20}(?:unknown|unconfirmed)/i.test(values) ||
      d.key==='treatment' && [proposed?.current,proposed?.candidate].some(value=>value && /未记录.{0,8}治疗|仅.{0,10}(?:建议|核对).{0,12}(?:检查|影像|病理)/.test(value) && !/已行|接受|切除|手术|消融|放疗/.test(value));
    return {dimension:d.key,current:currentValid?proposed.current:'未取得可核对信息',candidate:candidateValid?proposed.candidate:'来源未提供可核对信息',currentQuote:currentValid?proposed.currentQuote:'',candidateQuote:candidateValid?proposed.candidateQuote:'',relation:currentValid && candidateValid && !unresolved ? proposed.relation:'unknown',reason:unresolved?'资料明确存在尚未确认的信息，本项暂不计入相似度。':currentValid && candidateValid ? proposed.reason:'缺少双方原文，暂不参与相似度计算。',...(unresolved?{uncertainty:true}:{})};
  });
}

// Do not invent a second clinical narrative on top of the sourced comparison.
// The two sides remain explicitly attributed, including differences/unknowns.
export function groundedCaseFindings(rows) {
  const comparable=rows.filter(r=>r.currentQuote&&r.candidateQuote&&r.relation!=='unknown');
  const line=r=>`${CASE_DIMENSIONS.find(d=>d.key===r.dimension).label}：当前患者“${r.current}”；候选病例“${r.candidate}”。`;
  const matching=comparable.filter(r=>['match','partial'].includes(r.relation));
  const different=comparable.filter(r=>r.relation==='different');
  const missing=rows.filter(r=>r.relation==='unknown').map(r=>CASE_DIMENSIONS.find(d=>d.key===r.dimension).label);
  return {reason:matching.map(line).join('\n')||'尚无足够的双方资料确认相似点，请先查看原文。',differences:[...different.map(line),missing.length?`${missing.join('、')}尚未完成双方对照，不能据此判断相同或不同。`:'逐项关系由模型整理，需结合原文判断适用性。'].join('\n')};
}
