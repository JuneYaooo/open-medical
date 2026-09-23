import {useState} from 'react';
import {medicalExcerpt} from '../shared/medical-excerpt.mjs';
import './task-result.css';
export function TaskResult({run}) {
 const results=run?.displayResults||[],diagnostic=results.find(r=>r.kind==='diagnostic');
 const assessment=run?.artifacts?.find(a=>a.type==='treatment_review');
 const calculations=results.filter(r=>r.kind==='calculator');
 const literature=results.filter(r=>r.kind==='literature');
 const [query,setQuery]=useState('');
 if(diagnostic||assessment)return <section className="task-result" aria-label="辅助诊断与方案评估"><h3>{diagnostic?'辅助诊断参考':'治疗方案评估'}</h3><p>{(diagnostic||assessment).summary}</p>{diagnostic?diagnostic.candidates.map((c,i)=><article key={i}><h4>{c.name}</h4><dl><dt>支持的依据</dt><dd>{c.support}</dd><dt>不支持或需要注意的地方</dt><dd>{c.against}</dd><dt>还需补充</dt><dd>{c.missing}</dd></dl><details><summary>查看患者资料依据</summary><p>{medicalExcerpt(c.quote)}</p></details></article>):<>{[['需要注意',assessment.concerns],['还需补充',assessment.infoGaps],['建议进一步核对',assessment.questions]].map(([label,items])=>items?.length>0&&<article key={label}><h4>{label}</h4><ul>{items.map((x,i)=><li key={i}>{x}</li>)}</ul></article>)}<details><summary>查看依据</summary>{assessment.matches?.map((m,i)=><blockquote key={i}>{m.sourceName} {m.line?`第 ${m.line} 行`:''}<p>{medicalExcerpt(m.quote)}</p></blockquote>)}</details></>}<small>供医生核对，不自动写入诊断或调整治疗。</small></section>;
 if(calculations.length)return <section className="task-result" aria-label="医学计算结果">{calculations.map((r,i)=><article key={i}><h3>{r.scaleName}</h3><div className="calculation-value">{r.score}<span>{r.level}</span></div><p>{r.interpretation}</p><h4>本次使用的数值</h4><dl>{r.inputs?.map((v,j)=><div key={j}><dt>{v.label}</dt><dd>{v.value===undefined?'未提供':String(v.value)}</dd></div>)}</dl><details><summary>计算方法与说明</summary><p>{r.formula}</p>{r.detail?.map((v,j)=><p key={j}>{v.item}：{v.answer} {v.points!==undefined?`（${v.points}）`:''}</p>)}<p>{r.note}</p></details></article>)}</section>;
 if(literature.length){
  const articles=[...new Map(literature.flatMap(r=>r.articles|| (r.title?[r]:[])).map(a=>[a.pmid||a.doi||a.title,a])).values()];
  const visible=articles.filter(a=>`${a.title} ${a.journal} ${a.abstract||''}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="task-result" aria-label="文献检索结果"><h3>文献检索结果 · {articles.length} 篇</h3><input aria-label="筛选文献" placeholder="搜索标题、期刊或摘要" value={query} onChange={e=>setQuery(e.target.value)}/>{visible.map((a,i)=><article key={a.pmid||a.doi||i}><h4>{a.title}</h4><p>{a.journal} {a.year}</p><details><summary>{a.abstract?'阅读摘要':'仅有题录，尚未读取摘要'}</summary><p>{medicalExcerpt(a.abstract)||'尚未取得摘要。'}</p></details>{a.pmid&&/^\d+$/.test(String(a.pmid))&&<a href={`https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/`} target="_blank" rel="noreferrer">查看原文网页</a>}</article>)}{!visible.length&&<p>{articles.length?'没有符合筛选条件的文献。':'本次没有取得文献，请查看检索记录。'}</p>}<details><summary>检索记录</summary>{literature.filter(r=>r.tool==='literature_search').map((r,i)=><div key={i}><p>{r.query} {r.source} {r.note}</p>{r.searches?.map((s,j)=><p key={j}>{s.query} · {s.source} · {s.status}{s.error?`：${s.error}`:''}</p>)}</div>)}</details></section>;
 }
 return null;
}
export const hasTaskResult=run=>Boolean(run?.displayResults?.some(r=>['diagnostic','calculator','literature'].includes(r.kind))||run?.artifacts?.some(a=>a.type==='treatment_review'));
