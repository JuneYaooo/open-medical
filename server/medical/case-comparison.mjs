import {CASE_DIMENSIONS} from '../../shared/case-comparison.mjs';
const text={type:'string',maxLength:600};
export const comparisonSchema={type:'array',maxItems:5,items:{type:'object',properties:{dimension:{type:'string',enum:CASE_DIMENSIONS.map(d=>d.key)},current:text,currentQuote:text,candidate:text,candidateQuote:text,relation:{type:'string',enum:['match','partial','different','unknown']},reason:text},required:['dimension','current','currentQuote','candidate','candidateQuote','relation','reason'],additionalProperties:false}};
export function verifyComparison(input=[],currentEvidence='',candidateEvidence='') {
  return CASE_DIMENSIONS.map(d=>{
    const proposed=input.find(r=>r.dimension===d.key);
    const currentValid=Boolean(proposed?.currentQuote?.trim() && currentEvidence.includes(proposed.currentQuote));
    const candidateValid=Boolean(proposed?.candidateQuote?.trim() && candidateEvidence.includes(proposed.candidateQuote));
    return {dimension:d.key,current:currentValid?proposed.current:'未取得可核对信息',candidate:candidateValid?proposed.candidate:'来源未提供可核对信息',currentQuote:currentValid?proposed.currentQuote:'',candidateQuote:candidateValid?proposed.candidateQuote:'',relation:currentValid && candidateValid ? proposed.relation:'unknown',reason:currentValid && candidateValid ? proposed.reason:'缺少双方原文，暂不参与相似度计算。'};
  });
}
