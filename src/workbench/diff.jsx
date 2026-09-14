import { useMemo, useState } from "react";
import { structuredPatch } from "diff";
export function DiffView({ before, after, path = "file" }) {
  const [full, setFull] = useState(false);
  const patch = useMemo(
    () =>
      structuredPatch(path, path, before || "", after || "", "", "", {
        context: full ? 10000 : 3,
      }),
    [before, after, path, full],
  );
  const additions = patch.hunks.reduce(
    (n, h) => n + h.lines.filter((l) => l.startsWith("+")).length,
    0,
  );
  const removals = patch.hunks.reduce(
    (n, h) => n + h.lines.filter((l) => l.startsWith("-")).length,
    0,
  );
  return (
    <div className="wb-diff">
      <header>
        <span className="wb-added">+{additions}</span>
        <span className="wb-removed">−{removals}</span>
        <button onClick={() => setFull(!full)}>
          {full ? "只看变更" : "显示完整文件"}
        </button>
      </header>
      {!patch.hunks.length && <p className="wb-muted">文件内容没有变化。</p>}
      <div className="wb-diff-scroll">
        {patch.hunks.map((h, index) => {
          let old = h.oldStart,
            next = h.newStart;
          return (
            <div key={index}>
              <div className="wb-hunk">
                @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
              </div>
              {h.lines.map((line, i) => {
                const type = line[0],
                  oldNo = type === "+" || type === "\\" ? "" : old++,
                  newNo = type === "-" || type === "\\" ? "" : next++;
                return (
                  <div
                    className={`wb-diff-line ${type === "+" ? "added" : type === "-" ? "removed" : ""}`}
                    key={i}
                  >
                    <span>{oldNo}</span>
                    <span>{newNo}</span>
                    <code>{line}</code>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
