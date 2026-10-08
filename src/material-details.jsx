import { useEffect, useState } from 'react';
import { api } from './agent-runtime';
import { assessOcrQuality, OCR_QUALITY_LABELS } from '../shared/ocr-quality.mjs';

function MaterialImage({ sessionId, artifactId, name }) {
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
  return <figure style={{ margin: '8px 0' }}>{url ? <><a href={url} download={name}>下载图片</a><img src={url} alt={name} style={{ display: 'block', maxWidth: '100%', height: 'auto' }} /></> : <small>{error || '读取图片…'}</small>}</figure>;
}

// 质量等级：优先读服务端在识别时算好的分，旧材料没有分时按同一算法现算兜底。
export function materialQualityLevel(file) {
  const stored = file?.extraction?.ocr?.quality?.level;
  if (stored) return stored;
  if (file?.extraction?.ocr?.status === 'ready') return assessOcrQuality(file.text || '').level;
  return null;
}

const METHOD_LABELS = { 'local-ocr': '本地识别', vision: '视觉模型' };

export function MaterialDetails({ file, sessionId, visionSupported = null, onChanged, onError }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('compare');
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [busy, setBusy] = useState(false);
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
      else if (outcome.refresh) onChanged?.(`已用视觉模型重新识别「${file.name}」，正在按新文本重新整理病历，完成后可在工作区查看提案。`);
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
    : <pre>{file.text || '暂无可读取文字'}</pre>;

  return <><small>{label}</small>
    {(level || method || previous || edited) && <p className="ocr-meta">
      {level && <span className={`ocr-badge ${level}`}>{OCR_QUALITY_LABELS[level]}</span>}
      {method && <span className="ocr-badge plain">{method}</span>}
      {previous && <span className="ocr-badge plain">{previous}</span>}
      {edited && <span className="ocr-badge plain">{edited}</span>}
    </p>}
    {images.length > 0 && <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>查看{e.type === 'image' ? '原图' : '扫描页'}与识别文字对照</summary>
      {open && <>
        <div className="ocr-seg" role="tablist" aria-label="对照方式">
          <button className={mode === 'compare' ? 'active' : ''} onClick={() => setMode('compare')}>图文对照</button>
          <button className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>仅文字</button>
        </div>
        <div className={mode === 'compare' ? 'ocr-compare' : ''}>
          {mode === 'compare' && images.map((image) => <MaterialImage key={image.artifactId} sessionId={sessionId} artifactId={image.artifactId} name={image.page ? `${file.name}-第${image.page}页.jpg` : file.name} />)}
          {textPane}
        </div>
      </>}
    </details>}
    {canReprepare && visionSupported !== null && <div className="ocr-actions">
      {visionSupported
        ? <button className="secondary" disabled={busy} onClick={reprepare}>视觉模型重新识别并整理</button>
        : <small className="muted">当前模型不支持图片识别；要在模型设置中更换多模态模型后重新识别。</small>}
      {!editing && <button className="text-button" disabled={busy} onClick={() => { setDraftText(file.text || ''); setEditing(true); }}>修正文字</button>}
    </div>}
  </>;
}
