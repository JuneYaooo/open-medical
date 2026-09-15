import { useEffect, useRef, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Copy, Check, FileText } from "lucide-react";
import "highlight.js/styles/github-dark.css";

// Decision-flow blocks from the clinical-decision-flow skill render as SVG.
// mermaid is lazy-loaded only when a flowchart actually appears.
function MermaidBlock({ chart }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
        });
        const rendered = await mermaid.render(
          "mmd-" + Math.random().toString(36).slice(2),
          chart,
        );
        if (live) setSvg(rendered.svg);
      } catch (err) {
        if (live) setError(err.message || String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [chart]);
  if (error)
    return (
      <div className="wb-code">
        <pre>{chart}</pre>
        <p className="muted">流程图渲染失败（保留源码）：{error}</p>
      </div>
    );
  if (!svg)
    return (
      <div className="wb-code">
        <pre>{chart}</pre>
        <p className="muted">流程图渲染中…</p>
      </div>
    );
  return <div className="wb-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function CodeBlock({ children }) {
  const codeChild = Array.isArray(children) ? children[0] : children;
  const className = String(codeChild?.props?.className || "");
  const isMermaid = className.includes("language-mermaid");
  const raw = codeChild?.props?.children;
  const mermaidChart = isMermaid
    ? String(Array.isArray(raw) ? raw.join("") : raw || "").replace(/\n$/, "")
    : "";
  const ref = useRef(null),
    [copied, setCopied] = useState(false);
  if (isMermaid) return <MermaidBlock chart={mermaidChart} />;
  return (
    <div className="wb-code">
      <button
        aria-label="复制代码"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(ref.current.textContent);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? "已复制" : "复制"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

// Models that narrate their process (e.g. DeepSeek) prefix replies with short
// English working notes before the actual answer. Collapse that prefix into an
// expandable block. Answer content in this product is Chinese, so a CJK
// character inside a narration paragraph marks where the real answer starts;
// a reply that never produces answer content stays fully visible.
const NARRATION_OPENER =
  /^(i'?(?:'|\u2019)?(ll|ve|m| |,)|let'|now|first|next|then|checking|reading|writing|looking|based on|the |this |ok|alright|done)/i;
function splitThinking(text) {
  const raw = String(text || "");
  if (!NARRATION_OPENER.test(raw.trim())) return null;
  const segments = raw.split(/\n\n+/);
  const thinkingParts = [];
  for (const segment of segments) {
    const t = segment.trim();
    if (!NARRATION_OPENER.test(t)) break;
    const cjk = t.search(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/);
    if (cjk > 0) {
      // Narration and answer merged in one paragraph: split at the CJK start,
      // regardless of paragraph length.
      thinkingParts.push(t.slice(0, cjk).trim());
      return {
        thinking: thinkingParts.join("\n\n"),
        answer: [t.slice(cjk), ...segments.slice(segments.indexOf(segment) + 1)]
          .join("\n\n")
          .trim(),
      };
    }
    if (cjk === 0) break; // paragraph starts as answer content
    if (t.length > 500) break; // long pure-English content is likely the answer
    thinkingParts.push(t);
  }
  if (!thinkingParts.length) {
    // Fallback: long mixed-narration replies usually end with a structured
    // Chinese report — collapse everything before its first CJK heading.
    const headingIdx = segments.findIndex(
      (segment) =>
        /^#{1,3}\s/.test(segment.trim()) && /[\u4e00-\u9fff]/.test(segment),
    );
    if (headingIdx > 0) {
      const prefix = segments.slice(0, headingIdx).join("\n\n").trim();
      const ascii =
        (prefix.match(/[\x20-\x7e]/g) || []).length / Math.max(1, prefix.length);
      if (prefix.length > 40 && ascii > 0.6)
        return {
          thinking: prefix,
          answer: segments.slice(headingIdx).join("\n\n").trim(),
        };
    }
    return null;
  }
  const consumed = thinkingParts.length;
  const answer = segments.slice(consumed).join("\n\n").trim();
  if (!answer) return null; // narration IS the whole reply: keep it visible
  return { thinking: thinkingParts.join("\n\n"), answer };
}
const markdownComponents = (onOpenFile) => ({
  pre: CodeBlock,
  a: ({ href, children }) => {
    if (
      href &&
      !/^(https?:|mailto:|#)/i.test(href) &&
      !href.startsWith("//")
    )
      return (
        <button className="wb-file-link" onClick={() => onOpenFile?.(href)}>
          <FileText size={13} />
          {children}
        </button>
      );
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => (
    <a href={src} target="_blank" rel="noreferrer noopener">
      图片：{alt || "查看图片"}
    </a>
  ),
});
export function RichMessage({ text, onOpenFile }) {
  const split = splitThinking(text);
  return (
    <div className="wb-markdown">
      {split && (
        <details className="wb-thinking">
          <summary>思考过程</summary>
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { detect: false }]]}
            urlTransform={(url) =>
              /^[^:/?#]+\.[a-z0-9]+:\d+(?::\d+)?$/i.test(url)
                ? url
                : defaultUrlTransform(url)
            }
            components={markdownComponents(onOpenFile)}
          >
            {split.thinking}
          </Markdown>
        </details>
      )}
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        urlTransform={(url) =>
          /^[^:/?#]+\.[a-z0-9]+:\d+(?::\d+)?$/i.test(url)
            ? url
            : defaultUrlTransform(url)
        }
        components={markdownComponents(onOpenFile)}
      >
        {String(split ? split.answer : text || "")}
      </Markdown>
    </div>
  );
}
