import { useEffect, useRef } from "react";

export function FileEditor({ content, onChange, line = 1, onQuote }) {
  const editor = useRef(null),
    gutter = useRef(null);
  useEffect(() => {
    const el = editor.current;
    const offset = content
      .split("\n")
      .slice(0, Math.max(0, line - 1))
      .reduce((n, s) => n + s.length + 1, 0);
    el.setSelectionRange(offset, offset);
    el.scrollTop = Math.max(0, (line - 3) * 20);
    gutter.current.scrollTop = el.scrollTop;
    // Only relocate when the caller opens a different line.
  }, [line]);
  return (
    <>
      <div className="wb-editor">
        <pre ref={gutter} aria-hidden="true">
          {content
            .split("\n")
            .map((_, i) => i + 1)
            .join("\n")}
        </pre>
        <textarea
          ref={editor}
          aria-label="文件内容"
          className="workspace-editor"
          value={content}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          wrap="off"
          onScroll={(e) => {
            gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>
      <button
        onClick={() => {
          const el = editor.current;
          onQuote(content.slice(el.selectionStart, el.selectionEnd));
        }}
      >
        将选中内容加入对话
      </button>
    </>
  );
}
