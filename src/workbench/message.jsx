import { useRef, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Copy, Check, FileText } from "lucide-react";
import "highlight.js/styles/github-dark.css";

function CodeBlock({ children }) {
  const ref = useRef(null),
    [copied, setCopied] = useState(false);
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
export function RichMessage({ text, onOpenFile }) {
  return (
    <div className="wb-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        urlTransform={(url) =>
          /^[^:/?#]+\.[a-z0-9]+:\d+(?::\d+)?$/i.test(url)
            ? url
            : defaultUrlTransform(url)
        }
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => {
            if (
              href &&
              !/^(https?:|mailto:|#)/i.test(href) &&
              !href.startsWith("//")
            )
              return (
                <button
                  className="wb-file-link"
                  onClick={() => onOpenFile?.(href)}
                >
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
        }}
      >
        {String(text || "")}
      </Markdown>
    </div>
  );
}
