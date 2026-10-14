import { useEffect, useState } from 'react';
import { api } from './agent-runtime';
import { assessOcrQuality, OCR_QUALITY_LABELS } from '../shared/ocr-quality.mjs';
import { splitOcrPages, cleanText } from '../shared/ocr-pages.mjs';

function MaterialImage({ sessionId, artifactId, name, onZoom }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    let alive = true, objectUrl;
    api(`/api/workspaces/${sessionId}/artifacts/${artifactId}`, { raw: true })
      .then((r) => r.blob()).then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (alive) setUrl(objectUrl); else URL.revokeObjectURL(objectUrl);
      }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [sessionId, artifactId]);
  return <figure style={{ margin: '8px 0' }}>{url ? <>
    <img src={url} alt={name} loading="lazy" className="ocr-image" title="点击放大" onClick={() => onZoom?.({ url, name })} />
    <small className="ocr-image-tools"><a href={url} download={name}>下载原图</a></small>
  </> : <small>{error || '读取图片…'}</small>}</figure>;
}

const METHOD_LABELS = { 'local-ocr': '本地识别', vision: '视觉模型', 'pdf-text': 'PDF 文字层' };

// 质量等级：优先读服务端在识别时算好的分，旧材料没有分时按同一算法现算兜底。
export function materialQualityLevel(file) {
  const stored = file?.extraction?.ocr?.quality?.level;
  if (stored) return stored;
  if (file?.extraction?.ocr?.status === 'ready') return assessOcrQuality(file.text || '').level;
  return null;
}

export function MaterialDetails({ file, sessionId, visionSupported = null, onChanged, onError }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('compare');
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(null);
  const [zoomScale, setZoomScale] = useState(1);
  const e = file.extraction;
  // 纯文本材料（txt/md/csv/json）没有 extraction：保留原来的「查看文字内容」折叠块。
  if (!e) return <details><summary>查看文字内容</summary><pre>{file.text || '暂无可读取文字'}</pre></details>;
  const images = e.type === 'image' ? [{ artifactId: e.artifactId }] : e.pageImages || [];
  const label = e.type === 'image' ? '图片 · 已保存原图 · 可本地 OCR / 视觉读取'
    : e.type === 'docx_text' ? 'Word 抽取文本 · 未保存原件'
    : e.type === 'xlsx_text' ? 'Excel 抽取文本 · 保留工作表与单元格 · 未保存原件'
    : `PDF · ${e.pageCount} 页 · ${images.length ? `${images.length} 页扫描图可读取` : '抽取文本'} · 未保存 PDF 原件`;
  const level = materialQualityLevel(file);
  const method = METHOD_LABELS[e.ocr?.method] || '';
  const previous = e.ocrPrevious?.method ? `上次：${METHOD_LABELS[e.ocrPrevious.method] || e.ocrPrevious.method}` : '';
  const edited = e.edited?.at ? `已由医生修正 · ${new Date(e.edited.at).toLocaleString('zh-CN')}` : '';
  const canReprepare = images.length > 0;

  const reprepare = async () => {
    setBusy(true);
    try {
      const outcome = await api(`/api/sessions/${sessionId}/files/${file.id}/prepare`, 'POST', { force: true, preferVision: true, refreshRecord: true });
      if (outcome.refreshError) onError?.(`重新识别完成，但发起病历重新整理失败：${outcome.refreshError}`);
      else if (outcome.refresh) onChanged?.(`已用识别模型重新识别「${file.name}」，正在按新文本重新整理病历，完成后可在工作区查看提案。`);
      else onChanged?.();
    } catch (error) { onError?.(error.message); }
    finally { setBusy(false); }
  };
  const saveText = async () => {
    setBusy(true);
    try {
      await api(`/api/sessions/${sessionId}/files/${file.id}/text`, 'PUT', { text: draftText });
      setEditing(false);
      onChanged?.();
    } catch (error) { onError?.(error.message); }
    finally { setBusy(false); }
  };
  const textPane = editing
    ? <div className="ocr-text-edit">
      <textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} rows={14} aria-label={`修正 ${file.name} 的识别文本`} />
      <small>直接修改识别文字后保存；行号可能变化，已保存档案中的来源引用不会自动更新。</small>
      <div><button className="primary" disabled={busy || !draftText.trim()} onClick={saveText}>保存修正</button>
        <button className="secondary" disabled={busy} onClick={() => { setEditing(false); setDraftText(''); }}>取消</button></div>
    </div>
    : null;

  // 逐页对照：把识别文本拆回页单元，图按页号挂载；解析不出页结构时退回「全部图 + 全文」。
  const { pages, fallback } = splitOcrPages(file.text);
  const imagesByPage = new Map(images.map((image) => [image.page ?? 'solo', image.artifactId]));
  const pageRows = pages.map((page, index) => {
    const artifactId = imagesByPage.get(page.page ?? 'solo')
      ?? (fallback && index === 0 ? imagesByPage.get('solo') : null)
      ?? (!fallback && pages.length === 1 ? imagesByPage.get('solo') : null);
    return { ...page, artifactId, key: page.page ?? `p${index}` };
  });
  for (const [key, artifactId] of imagesByPage) {
    if (key === 'solo' || pageRows.some((row) => String(row.page) === String(key))) continue;
    pageRows.push({ page: key, method: null, text: '', artifactId, key: `img${key}` });
  }
  pageRows.sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
  const singlePage = pageRows.length === 1;

  const compareBody = fallback || !pageRows.length
    ? <div className="ocr-compare">
      {images.map((image) => <MaterialImage key={image.artifactId} sessionId={sessionId} artifactId={image.artifactId} name={image.page ? `${file.name}-第${image.page}页.jpg` : file.name} onZoom={setZoom} />)}
      {!editing && <pre>{cleanText(file.text) || '暂无可读取文字'}</pre>}
    </div>
    : <div className="ocr-pages">
      {pageRows.map((row) => <section className="ocr-page" key={row.key}>
        <header className="ocr-page-head">
          <b>{singlePage ? '原图与识别文字' : `第 ${row.page} 页`}</b>
          {row.method && <span className="ocr-badge plain">{METHOD_LABELS[row.method] || row.method}</span>}
        </header>
        <div className={row.artifactId ? 'ocr-page-body' : 'ocr-page-body text-only'}>
          {row.artifactId
            ? <MaterialImage sessionId={sessionId} artifactId={row.artifactId} name={singlePage ? file.name : `${file.name}-第${row.page}页.jpg`} onZoom={setZoom} />
            : null}
          {row.text
            ? <pre>{row.text}</pre>
            : <pre className="ocr-page-empty">本页没有识别文字；{row.artifactId ? '请点开上方原图核对。' : '该页未保存扫描图。'}</pre>}
        </div>
      </section>)}
    </div>;

  return <><small>{label}</small>
    {(level || method || previous || edited) && <p className="ocr-meta">
      {level && <span className={`ocr-badge ${level}`}>{OCR_QUALITY_LABELS[level]}</span>}
      {method && <span className="ocr-badge plain">{method}</span>}
      {previous && <span className="ocr-badge plain">{previous}</span>}
      {edited && <span className="ocr-badge plain">{edited}</span>}
    </p>}
    {images.length > 0 && <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>查看{e.type === 'image' ? '原图' : '扫描页'}与识别文字对照</summary>
      {open && <>
        <div className="ocr-seg" role="tablist" aria-label="对照方式">
          <button className={mode === 'compare' ? 'active' : ''} onClick={() => setMode('compare')}>图文对照</button>
          <button className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>仅文字</button>
        </div>
        {editing ? textPane : <>
          {mode === 'compare' && compareBody}
          {mode === 'text' && <pre className="ocr-text-only">{cleanText(file.text) || '暂无可读取文字'}</pre>}
        </>}
      </>}
    </details>}
    {canReprepare && visionSupported !== null && <div className="ocr-actions">
      {visionSupported
        ? <button className="secondary" disabled={busy} onClick={reprepare}>用识别模型重新识别并整理</button>
        : <small className="muted">暂无可用的图片识别模型；可在模型设置中勾选「此模型支持图片」，或在「文字识别（OCR）」中配置专用识别模型后重新识别。</small>}
      {!editing && <button className="text-button" disabled={busy} onClick={() => { setDraftText(file.text || ''); setEditing(true); setOpen(true); }}>修正文字</button>}
    </div>}
    {zoom && <div className="ocr-lightbox" role="dialog" aria-label={`查看 ${zoom.name} 原图`} onClick={() => { setZoom(null); setZoomScale(1); }}
      onWheel={(event) => setZoomScale((s) => Math.min(5, Math.max(0.5, s * (event.deltaY < 0 ? 1.15 : 0.87))))}>
      <img src={zoom.url} alt={zoom.name} style={{ transform: `scale(${zoomScale})` }} />
      <small>点击任意位置关闭 · 滚轮缩放（{Math.round(zoomScale * 100)}%）</small>
    </div>}
  </>;
}
