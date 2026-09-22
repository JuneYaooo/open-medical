import { useEffect, useState } from 'react';
import { api } from './agent-runtime';

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
export function MaterialDetails({ file, sessionId }) {
  const [open, setOpen] = useState(false);
  const e = file.extraction;
  if (!e) return null;
  const images = e.type === 'image' ? [{ artifactId: e.artifactId }] : e.pageImages || [];
  const label = e.type === 'image' ? '图片 · 已保存原图 · 可本地 OCR / 视觉读取'
    : e.type === 'docx_text' ? 'Word 抽取文本 · 未保存原件'
    : e.type === 'xlsx_text' ? 'Excel 抽取文本 · 保留工作表与单元格 · 未保存原件'
    : `PDF · ${e.pageCount} 页 · ${images.length ? `${images.length} 页扫描图可读取` : '抽取文本'} · 未保存 PDF 原件`;
  return <><small>{label}</small>{images.length > 0 && <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>查看{e.type === 'image' ? '原图' : '扫描页'}</summary>{open && images.map((image) => <MaterialImage key={image.artifactId} sessionId={sessionId} artifactId={image.artifactId} name={image.page ? `${file.name}-第${image.page}页.jpg` : file.name} />)}</details>}</>;
}
