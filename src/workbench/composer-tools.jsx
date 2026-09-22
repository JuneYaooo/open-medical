import { useEffect, useRef, useState } from "react";
import { Paperclip, AtSign, X, FileText } from "lucide-react";
import { api } from "../agent-runtime";
import { importMaterial } from "../import-material";
// 与医疗任务 composer 同一套工具栏风格：材料/引用/技能常驻底部，
// 附件以卡片展示，可拖拽或粘贴文件。
export function ComposerTools({
  attachments,
  setAttachments,
  onMention,
  disabled,
  error,
  setError,
  current,
  onSkill,
}) {
  const file = useRef(null),
    [loading, setLoading] = useState(false);
  const alive = useRef(true),
    importing = useRef(false);
  const [skills, setSkills] = useState(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function loadSkills() {
    try {
      const value = await api(`/api/workspaces/${current.id}/tools`, "POST", {
        tool: "list_skills",
        arguments: {},
      });
      if (alive.current) setSkills(value);
    } catch (e) {
      if (alive.current) setError(e.message);
    }
  }
  async function attach(files) {
    if (disabled || importing.current || !files.length) return;
    importing.current = true;
    setLoading(true);
    try {
      if (attachments.length + files.length > 5)
        throw new Error("每次最多添加 5 份材料");
      const result = [];
      for (const f of files) {
        if (/\.(png|jpe?g|webp)$/i.test(f.name) || /^image\/(png|jpeg|webp)$/.test(f.type)) {
          if (f.size > 4000000)
            throw new Error("上传图片限 4MB；更大的图片可放在项目目录中引用");
          const bytes = new Uint8Array(await f.arrayBuffer());
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          const item = await api(
            `/api/workspaces/${current.id}/images`,
            "POST",
            { name: f.name || "clipboard.png", data: btoa(binary) },
          );
          result.push({
            name: item.name,
            text: `用户上传图片 artifactId: ${item.id}。如果当前模型支持视觉，请使用 inspect_image 分析；不支持时明确告知。`,
          });
          continue;
        }
        if (
          !/\.(txt|md|csv|json|log|ya?ml|pdf|docx|xlsx|tsv|markdown|js|ts|jsx|tsx|py|html|css)$/i.test(
            f.name,
          )
        )
          throw new Error("支持 PNG、JPEG、WebP、Word、Excel、文本、代码和有文字层的 PDF");
        const material = await importMaterial(f);
        if (material.pageImages?.length) {
          for (const page of material.pageImages) {
            const image = await api(`/api/workspaces/${current.id}/images`, "POST", { name: `PDF-page-${page.page}.jpg`, data: page.data });
            material.text += `\n[PDF 第 ${page.page} 页扫描图] artifactId: ${image.id}，请使用 inspect_image 读取。`;
          }
          delete material.pageImages;
        }
        if (material.text.includes("\0"))
          throw new Error("不能将二进制文件作为文本导入");
        result.push(material);
      }
      const next = [...attachments, ...result];
      if (next.reduce((n, a) => n + a.text.length, 0) > 10000)
        throw new Error("本次附件文本总量超过 10000 字符，请拆分材料");
      if (alive.current) {
        setAttachments(next);
        setError("");
      }
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      importing.current = false;
      if (alive.current) setLoading(false);
    }
  }
  useEffect(() => {
    const paste = (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (
        files.length &&
        document.activeElement?.closest(".desk-composer, .composer")
      ) {
        e.preventDefault();
        attach(files);
      }
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  });
  return (
    <div
      className="wb-composer-tools"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (!disabled && !loading) attach([...e.dataTransfer.files]);
      }}
    >
      <input
        hidden
        type="file"
        ref={file}
        multiple
        accept=".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.json,.pdf,.docx,.xlsx,.tsv,.markdown,.log,.yaml,.yml,.js,.ts,.jsx,.tsx,.py,.html,.css"
        onChange={(e) => {
          attach([...e.target.files]);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        className="attach-button"
        title="添加材料：文本/代码/PDF/图片（也可直接拖拽或粘贴文件）"
        disabled={disabled || loading}
        onClick={() => file.current.click()}
      >
        <Paperclip size={16} />
        {loading ? "读取中…" : "材料"}
      </button>
      <button
        type="button"
        className="attach-button"
        title="引用工作区文件（在文件面板中选择）"
        disabled={disabled}
        onClick={onMention}
      >
        <AtSign size={15} />
        引用
      </button>
      <button
        type="button"
        className="attach-button"
        title="选择项目技能"
        disabled={
          disabled || current.runs.some((r) => r.status === "running")
        }
        onClick={loadSkills}
      >
        技能
      </button>
      {skills && (
        <select
          aria-label="选择项目技能"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) {
              onSkill(e.target.value);
              setSkills(null);
            }
          }}
        >
          <option value="">
            {skills.length ? "选择要使用的技能" : "项目 skills 目录暂无技能"}
          </option>
          {skills.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      {attachments.map((a, i) => (
        <div className="wb-attachment" key={`${a.name}-${i}`}>
          <FileText size={13} />
          <span>{a.name}</span>
          <button
            aria-label={`移除 ${a.name}`}
            onClick={() =>
              setAttachments(attachments.filter((_, n) => n !== i))
            }
          >
            <X size={12} />
          </button>
        </div>
      ))}
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
