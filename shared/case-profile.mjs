import {CASE_DIMENSIONS} from './case-comparison.mjs';

// Recover explicit demographic statements from saved evidence, never from the
// model's similarity narrative. Ambiguous multi-patient reports stay unresolved.
export function savedDemographics(evidence='') {
  const text=evidence.replace(/<[^>]*>/g,' ');
  const matches=[...text.matchAll(/\b(?:a|an)\s+(\d{1,3})[ -]year[ -]old\s+(man|woman|male|female|boy|girl)\b/gi),
    ...text.matchAll(/(\d{1,3})\s*岁\s*(男性|女性|男|女)(?:患者)?/g)];
  const facts=matches.map(m=>({age:Number(m[1]),sex:/^(?:man|male|boy|男性|男)$/i.test(m[2])?'男':'女',quote:m[0]})).filter(f=>f.age>0&&f.age<=120);
  if (!facts.length || new Set(facts.map(f=>`${f.age}:${f.sex}`)).size!==1) return null;
  const fact=facts[0];
  // Keep the exact saved quote for the evidence disclosure.
  if(!evidence.includes(fact.quote))return null;
  return {text:`${fact.age}岁，${fact.sex}`,quote:fact.quote};
}
export function caseForDisplay(item) {
  const demographics=savedDemographics(item.evidence?.text || '');
  const comparison=CASE_DIMENSIONS.map(d=>{
    const stored=item.comparison?.find(c=>c.dimension===d.key);
    const row={...stored,dimension:d.key};
    if (!row.currentQuote) row.current='尚未整理';
    if (!row.candidateQuote) row.candidate='尚未整理';
    if (d.key==='demographics' && !row.candidateQuote && demographics) {
      row.candidate=demographics.text;row.candidateQuote=demographics.quote;
      row.candidateRecovered=true;
    }
    // A recovered candidate fact does not establish a clinical match.
    if (!stored?.currentQuote || !stored?.candidateQuote) row.relation='unknown';
    if (!stored?.currentQuote || !stored?.candidateQuote) row.reason='双方资料尚未完成对照，暂不计入相似度。';
    return row;
  });
  return {...item,comparison,profilePending:!item.comparison?.some(r=>r.candidateQuote)};
}
