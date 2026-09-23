export const CASE_DIMENSIONS = [
  {key:'disease',label:'疾病诊断',weight:35},
  {key:'stage',label:'疾病阶段',weight:25},
  {key:'treatment',label:'治疗经过',weight:20},
  {key:'medications',label:'用药情况',weight:15},
  {key:'demographics',label:'年龄与性别',weight:5},
];
export const RELATION_LABELS = {match:'相似',partial:'部分相似',different:'不同',unknown:'资料不足'};
// A transparent comparison index, not a validated clinical probability.
// Missing dimensions are excluded from the index and disclosed as coverage.
export function comparisonScore(comparison=[]) {
  const rows=CASE_DIMENSIONS.map(d=>({...d,...comparison.find(c=>c.dimension===d.key)}));
  const known=rows.filter(r=>['match','partial','different'].includes(r.relation) && r.currentQuote && r.candidateQuote);
  const coverage=known.reduce((sum,r)=>sum+r.weight,0);
  const disease=known.find(r=>r.key==='disease');
  const score=known.length>=2 && disease ? Math.round(known.reduce((sum,r)=>sum+r.weight*({match:1,partial:0.5,different:0}[r.relation]),0)/coverage*100):null;
  return {score,coverage,known:known.length,total:rows.length,clueOnly:disease?.relation==='different',rows};
}
