import { useEffect, useState } from "react";
import { FileText, Download, X } from "lucide-react";
import { api } from "../agent-runtime";
import { RichMessage } from "./message";
export function Artifacts({ current, onDownload, onOpenFile, refresh }) {
  const [preview, setPreview] = useState(null),
    [url, setUrl] = useState(null),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [rendering, setRendering] = useState(false);
  async function renderOffice() {
    setRendering(true);
    setError("");
    try {
      const base = `/api/workspaces/${current.id}/tools`;
      let result = await api(base, "POST", {
        tool: "document_render",
        arguments: { artifactId: preview.id },
      });
      while (["running", "finalizing"].includes(result.status))
        result = await api(base, "POST", {
          tool: "terminal_wait",
          arguments: { id: result.id, timeoutMs: 30000 },
        });
      if (result.exitCode !== 0)
        throw new Error(
          result.output || "渲染失败，请检查完整工具镜像与终端授权",
        );
      await refresh?.();
      const pdf = result.result?.artifacts?.find(
        (a) => a.mime === "application/pdf",
      );
      if (pdf) setPreview(pdf);
    } catch (e) {
      setError(e.message);
    } finally {
      setRendering(false);
    }
  }
  useEffect(() => {
    if (!preview) return;
    let alive = true,
      objectUrl;
    setUrl(null);
    setText("");
    setError("");
    api(`/api/workspaces/${current.id}/artifacts/${preview.id}`, { raw: true })
      .then((r) => r.blob())
      .then(async (blob) => {
        if (!alive) return;
        if (
          /^(image\/(png|jpeg|webp|gif)|application\/pdf|audio\/[\w.+-]+|video\/[\w.+-]+)$/.test(
            preview.mime,
          )
        ) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        } else if (
          /^(text\/|application\/json)/.test(preview.mime) ||
          /\.(md|txt|json|csv)$/.test(preview.name)
        ) {
          const value = await blob.text();
          if (alive) setText(value.slice(0, 100000));
        } else setText("此格式可下载后用本机应用打开。");
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [preview, current.id]);
  if (!current.artifacts?.length) return null;
  return (
    <section className="wb-artifacts" aria-label="生成的成果">
      {current.artifacts.map((a) => (
        <div key={a.id}>
          <button onClick={() => setPreview(a)}>
            <FileText size={17} />
            <span>
              {a.name}
              <small>{Math.ceil(a.size / 1024)} KB</small>
            </span>
          </button>
          <button aria-label={`下载 ${a.name}`} onClick={() => onDownload(a)}>
            <Download size={14} />
          </button>
        </div>
      ))}
      {preview && (
        <div className="wb-preview" role="region" aria-label="成果预览">
          <header>
            <b>{preview.name}</b>
            <button onClick={() => setPreview(null)} aria-label="关闭成果预览">
              <X size={15} />
            </button>
          </header>
          {error && <p role="alert">{error}</p>}
          {/\.(docx|xlsx|pptx)$/i.test(preview.name) && (
            <button disabled={rendering} onClick={renderOffice}>
              {rendering ? "正在生成预览…" : "生成 PDF 与逐页预览"}
            </button>
          )}
          {url &&
            (preview.mime.startsWith("audio/") ? (
              <audio controls src={url} aria-label={preview.name} />
            ) : preview.mime.startsWith("video/") ? (
              <video
                controls
                src={url}
                aria-label={preview.name}
                style={{ maxWidth: "100%" }}
              />
            ) : preview.mime.startsWith("image/") ? (
              <img src={url} alt={preview.name} />
            ) : (
              <iframe sandbox="" title={preview.name} src={url} />
            ))}
          {text && <RichMessage text={text} onOpenFile={onOpenFile} />}
        </div>
      )}
    </section>
  );
}
