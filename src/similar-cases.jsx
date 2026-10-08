import {medicalExcerpt} from '../shared/medical-excerpt.mjs';
import {caseForDisplay} from '../shared/case-profile.mjs';
import {useState,useRef,useLayoutEffect} from 'react';
import {ArrowLeft, ArrowUpRight, ChevronRight, Search} from 'lucide-react';
import {CASE_DIMENSIONS, RELATION_LABELS, comparisonScore} from '../shared/case-comparison.mjs';
import './similar-cases.css';

const sourceOf=item=>item.sourceKind || (item.evidence?.type==='local-record'?'local':'online');
function caseTitle(item,index) {
  const disease=item.comparison?.find(d=>d.dimension==='disease');
  return disease?.candidateQuote?disease.candidate:/[\u4e00-\u9fff]/.test(item.title)?item.title:`${sourceOf(item)==='local'?'本地':'网上'}病例${index===undefined?'':` ${index+1}`}`;
}
function caseEyebrow(item,result) {
  return `${sourceOf(item)==='local'?'本地患者':'网上病例'} · ${result.clueOnly?'疾病不同 · 文献线索':item.evidence?.type==='metadata'?'仅题录':item.evidence?.type==='abstract'?'摘要已取得':'本地记录'}`;
}
function Score({result}) {
  if(result.clueOnly)return <div className="case-score"><strong>—</strong><span>疾病不同 · 文献线索</span><small>不作为相似患者评分</small></div>;
  return <div className="case-score"><strong>{result.score===null?'—':result.score}<small>{result.score===null?'': '/ 100'}</small></strong><span>{result.score===null?'尚未完成对照，暂不评分':'相似度（参考）'}</span><small>对照覆盖 {result.coverage}% · {result.known}/5 项</small></div>;
}
function Limitations({artifact}) {
  return <details className="case-method"><summary>哪些资料还不全？</summary><p>{artifact.localSearched?(artifact.localFailed?'本地检索失败':`本地检索返回 ${artifact.localCount||0} 条候选`):'本次未检索本地'}</p><p>网上检索中，有 {artifact.searches?.filter(s=>s.status==='failed').length||0} 次未能取得资料</p><ul>{artifact.limitations?.map((v,i)=><li key={i}>{v}</li>)}</ul></details>;
}
const bySimilarity=(a,b)=>a.result.clueOnly!==b.result.clueOnly?Number(a.result.clueOnly)-Number(b.result.clueOnly):(b.result.score??-1)-(a.result.score??-1);
export function SimilarCases({artifact,onRefresh,onOpen,variant}) {
  const [source,setSource]=useState('all'),[query,setQuery]=useState(''),[sort,setSort]=useState('similarity'),[selected,setSelected]=useState(null);
  const panelRef=useRef(null), initial=useRef(true);
  useLayoutEffect(()=>{if(initial.current){initial.current=false;return;}panelRef.current?.scrollIntoView({block:'start'});},[selected]);
  const cases=(artifact.cases || []).map(caseForDisplay);
  if(variant==='teaser'){
    const ranked=cases.map(item=>({item,result:comparisonScore(item.comparison)})).sort(bySimilarity);
    return <section className="similar-cases case-teaser" aria-label="相似患者对照">
      <header className="case-list-head"><div><span className="case-eyebrow">患者对照 · 检索结果</span><h3>相似病例 <small>{cases.length}</small></h3></div><span className="case-draft-label">供医生参考</span></header>
      {artifact.summary&&<p className="case-summary case-teaser-summary">{artifact.summary}</p>}
      {cases.length>0?<div className="case-list">{ranked.map(({item,result},index)=><div className="case-row" key={item.reference}><div className="case-rank">{String(index+1).padStart(2,'0')}</div><div className="case-row-body"><span className="case-eyebrow">{caseEyebrow(item,result)}</span><h4>{caseTitle(item,index)}</h4><p><b>相同的地方：</b>{item.reason}</p></div><Score result={result}/></div>)}</div>
      :<div className="case-empty"><h4>本次未选出候选病例</h4><p>{artifact.localFailed?'本地检索失败，不能据此判断没有相似患者。':'可展开查看哪些资料还不全。'}</p></div>}
      {onOpen&&<button className="case-open-cta" onClick={onOpen}>展开阅读 · 逐项对照与原文依据<ChevronRight size={16}/></button>}
      {onRefresh&&<button className="case-refresh" onClick={onRefresh}>重新检索并对照</button>}
      <Limitations artifact={artifact}/>
    </section>;
  }
  const filtered=cases.filter(c=>(source==='all'||sourceOf(c)===source) && `${c.title} ${c.reason} ${(c.comparison||[]).map(d=>d.candidate).join(' ')}`.toLowerCase().includes(query.toLowerCase())).map(item=>({item,result:comparisonScore(item.comparison)})).sort((a,b)=>sort==='coverage'?b.result.coverage-a.result.coverage:bySimilarity(a,b));
  const item=cases.find(c=>c.reference===selected), result=item?comparisonScore(item.comparison):null;
  return <section ref={panelRef} className="similar-cases" aria-label="相似患者对照">
    {item ? <>
      <button className="case-back" onClick={()=>setSelected(null)}><ArrowLeft size={15}/>返回相似病例列表</button>
      <header className="case-detail-head"><div><span className="case-eyebrow">{sourceOf(item)==='local'?'本地患者记录':'网上病例报告'} · 供医生参考</span><h3>{caseTitle(item)}</h3><p>{item.scope}</p></div><Score result={result}/></header>
      <section className="case-profile" aria-label="病例概况">{CASE_DIMENSIONS.filter(d=>item.comparison?.find(c=>c.dimension===d.key)?.candidateQuote).map(d=>{const row=item.comparison?.find(c=>c.dimension===d.key);return <div key={d.key}><span>{d.label}</span><strong>{row?.candidateQuote?row.candidate:'尚未整理'}</strong></div>;})}{item.outcome?.quote && <div><span>治疗结果与随访</span><strong>{item.outcome.text}</strong></div>}</section>
      <p className="case-pending-fields">{[...CASE_DIMENSIONS.filter(d=>!item.comparison?.find(c=>c.dimension===d.key)?.candidateQuote).map(d=>d.label),...(!item.outcome?.quote?["治疗结果"]:[])].length>0 && `尚待整理：${[...CASE_DIMENSIONS.filter(d=>!item.comparison?.find(c=>c.dimension===d.key)?.candidateQuote).map(d=>d.label),...(!item.outcome?.quote?["治疗结果"]:[])].join("、")}。`}</p>
      {item.comparisonWarnings?.length>0 && <p className="case-pending-fields">部分对照未能核实原文，已保留可读取资料；未核实的项目不计入分数。</p>}
      <div className="case-findings"><section><h4>相同的地方</h4><p>{item.reason}</p></section><section><h4>需要注意的不同</h4><p>{item.differences}</p></section></div>
      {result.known>0 ? <details className="case-comparison-disclosure"><summary>逐项比较与原文依据</summary>
      <div className="case-comparison" role="table" aria-label="患者逐项对照">
        <div className="case-compare-head" role="row"><span role="columnheader">比较项目</span><span role="columnheader">当前患者</span><span role="columnheader">这个病例</span></div>
        {result.rows.map(d=><div className="case-dimension" key={d.key} role="rowgroup"><div role="row"><div role="cell"><b>{d.label}</b><span className={`case-relation ${d.relation||'unknown'}`}>{d.relation==='unknown'?'待对照':RELATION_LABELS[d.relation]||'待对照'}</span></div><p role="cell">{d.current||'尚未整理'}</p><p role="cell">{d.candidate||'尚未整理'}</p></div><details><summary>{d.reason || '未保存逐项对照，需重新检索后生成。'} · 查看依据</summary><div className="case-quotes"><blockquote><b>当前患者原文</b><p>{medicalExcerpt(d.currentQuote)||'暂无原文'}</p></blockquote><blockquote><b>候选病例原文</b><p>{medicalExcerpt(d.candidateQuote)||'暂无原文'}</p></blockquote></div></details></div>)}
      </div>
      </details> : <p className="case-pending-fields">双方资料尚未完成逐项对照，暂不显示比较表。</p>}
      <details className="case-method"><summary>相似度怎么算？</summary><p>疾病 35%、阶段 25%、治疗 20%、用药 15%、年龄与性别 5%。双方原文齐全的维度，按相似 1、部分相似 0.5、不同 0 加权，再除以可对照维度的权重。至少包含疾病及另一项才显示分值；未知项不当作不相似，单独展示覆盖率。</p><p>维度关系由模型根据原文整理，尚需人工核对。此分值用于资料比较，不是临床相似概率，也不代表治疗适用性。疾病不同的结果仅作为文献线索。</p></details>
      <details className="case-evidence"><summary>查看原文</summary><h4>{item.title}</h4><p>{medicalExcerpt(item.evidence?.text)||'仅取得题录，未保存摘要。'}</p>{/^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/$/.test(item.url||'')&&<a href={item.url} target="_blank" rel="noreferrer">打开原文网页（PubMed） <ArrowUpRight size={14}/></a>}</details>
    </> : <>
      <header className="case-list-head"><div><span className="case-eyebrow">患者对照 · 检索结果</span><h3>相似病例 <small>{cases.length}</small></h3></div><span className="case-draft-label">供医生参考</span></header>
      <p className="case-summary">{artifact.summary}</p>
      {cases.length>0 && cases.some(c=>c.profilePending) && <div className="case-upgrade-note">部分信息尚未整理成表格，不代表原文没有说明；能从已保存原文确认的信息已补入。{onRefresh&&<button onClick={onRefresh}>重新检索并对照</button>}</div>}
      <div className="case-toolbar"><div className="case-filters" aria-label="病例来源">{[['all','全部'],['local','本地'],['online','网上']].map(([value,label])=><button key={value} aria-pressed={source===value} onClick={()=>setSource(value)}>{label} {cases.filter(c=>value==='all'||sourceOf(c)===value).length}</button>)}</div><label className="case-search"><Search size={14}/><input aria-label="筛选相似病例" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索疾病、用药或病例"/></label><select aria-label="病例排序" value={sort} onChange={e=>setSort(e.target.value)}><option value="similarity">相似度优先</option><option value="coverage">资料完整度优先</option></select></div>
      <div className="case-list">{filtered.map(({item,result},index)=><button className="case-row" key={item.reference} onClick={()=>setSelected(item.reference)} aria-label={`查看病例：${item.title}`}><div className="case-rank">{String(index+1).padStart(2,'0')}</div><div className="case-row-body"><span className="case-eyebrow">{caseEyebrow(item,result)}</span><h4>{caseTitle(item,index)}</h4><div className="case-tags">{['demographics','disease','stage','treatment','medications'].map(key=>{const d=item.comparison?.find(c=>c.dimension===key);return <span key={key}>{CASE_DIMENSIONS.find(c=>c.key===key).label}：{d?.candidateQuote?d.candidate:'尚未整理'}</span>;})}</div><p><b>相同的地方：</b>{item.reason}</p><p className="case-outcome"><b>治疗结果：</b>{item.outcome?.quote?item.outcome.text:"尚未核对"}</p></div><Score result={result}/><ChevronRight size={16}/></button>)}</div>
      {!filtered.length&&<div className="case-empty"><h4>{cases.length?'没有符合筛选条件的病例':'本次未选出候选病例'}</h4><p>{cases.length?'调整关键词或切换来源查看。':artifact.localFailed?'本地检索失败，不能据此判断没有相似患者。':'请查看下方哪些资料还不全？。'}</p></div>}
      <p className="case-footnote">请先看病情和治疗经过，再比较相同与不同。分数仅供参考，不能据此照搬治疗方案。</p>
      <Limitations artifact={artifact}/>
    </>}
  </section>;
}
