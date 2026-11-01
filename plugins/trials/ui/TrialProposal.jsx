// 待确认面板里的试验提案预览：筛选条件逐条列出口径与试算人数；导入方案列出入排条目。
export function TrialProposal({ action }) {
  const p = action.payload || {};
  if (action.type === "trial-screening-conditions") return <div className="care-hint">
    <p>「{p.trialTitle}」· 确认后候选患者按以下条件逐条预筛（缺资料记为待核对）：</p>
    <ol>{(p.conditions || []).map((c, i) => <li key={i}>{c.label}<small className="muted"> · {c.description}</small></li>)}</ol>
    {p.manualCriteria?.length > 0 && <p>需人工或 AI 逐人核对（不参与预筛）：{p.manualCriteria.join("；")}</p>}
    {p.preview && <p className="muted">按当前患者库试算：共 {p.preview.total} 位，符合 {p.preview.match}、待核对 {p.preview.unclear}、不符合 {p.preview.mismatch}。</p>}
  </div>;
  if (action.type === "trial-protocol") {
    const include = (p.criteria || []).filter((c) => c.kind === "include"), exclude = (p.criteria || []).filter((c) => c.kind === "exclude");
    return <div className="care-hint">
      <p>导入方案「{p.title}」{p.registration ? ` · ${p.registration}` : ""} · {p.version}{p.recruitment ? ` · ${p.recruitment}` : ""}</p>
      {p.duplicateOf && <p className="warn">本地已有同注册号方案「{p.duplicateOf.title}」（{p.duplicateOf.version}），确认后另存为新版本。</p>}
      <details><summary>入选 {include.length} 条 · 排除 {exclude.length} 条</summary>
        <p><b>入选</b></p><ol>{include.map((c, i) => <li key={i}>{c.text}</li>)}</ol>
        <p><b>排除</b></p><ol>{exclude.map((c, i) => <li key={i}>{c.text}</li>)}</ol>
      </details>
      {p.sourceUrl && <p><a href={p.sourceUrl} target="_blank" rel="noreferrer">核对来源</a></p>}
    </div>;
  }
  return null;
}
export default TrialProposal;
