import { useState } from "react";
import {
  Check,
  ChevronDown,
  Loader,
  AlertCircle,
  FileCheck2,
} from "lucide-react";
const names = {
  read_file: "读取文件",
  list_directory: "浏览目录",
  search_files: "搜索文件",
  propose_file_write: "准备文件修改",
  edit_file: "编辑文件",
  terminal_run: "运行命令",
  terminal_start: "启动终端",
  spawn_agent: "分配子任务",
  web_search: "搜索网页",
  web_fetch: "读取网页",
  document_create: "生成文档",
  git_diff: "检查差异",
};
export function Activity({ events, current, running, onReview, onHistory }) {
  const [expanded, setExpanded] = useState(false),
    run = current.runs.at(-1);
  const steps = new Map();
  for (const e of events.filter(
    (e) => (!e.runId && !e.run_id) || (e.runId || e.run_id) === run?.id,
  )) {
    if (e.type?.startsWith("tool.")) {
      const p = e.payload || {};
      steps.set(p.call_id || `${p.tool}-${e.id}`, { ...p, type: e.type });
    }
  }
  const tools = [...steps.values()],
    pending = current.approvals.filter((a) => a.status === "pending");
  if (!run && !pending.length) return null;
  return (
    <section className="wb-activity" aria-label="任务执行进度">
      <button
        className="wb-activity-toggle"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {running ? (
          <Loader size={14} className="wb-spin" />
        ) : run?.status === "failed" ? (
          <AlertCircle size={14} />
        ) : (
          <Check size={14} />
        )}
        <span>
          {running
            ? tools.at(-1)?.type === "tool.start"
              ? names[tools.at(-1).tool] || tools.at(-1).tool
              : "正在处理任务"
            : run?.status === "completed"
              ? "执行完成"
              : "任务记录"}
          {tools.length > 0 && ` · ${tools.length} 项操作`}
        </span>
        <ChevronDown size={13} />
      </button>
      {expanded && (
        <div className="wb-activity-details">
          {tools.slice(-30).map((t, i) => (
            <div key={i}>
              {t.type === "tool.start" && running ? (
                <Loader size={12} />
              ) : t.type === "tool.failed" ? (
                <AlertCircle size={12} />
              ) : (
                <Check size={12} />
              )}
              <span>{names[t.tool] || t.tool}</span>
              {t.error && <small>{t.error}</small>}
            </div>
          ))}
          {current.plan?.steps?.map((step, i) => (
            <div key={`plan-${i}`}>
              {step.status === "completed" ? "✓" : "○"}{" "}
              {step.step || step.text || step.title}
            </div>
          ))}
          <button onClick={onHistory}>查看完整运行记录</button>
        </div>
      )}
      {pending.length > 0 && (
        <button className="wb-review-prompt" onClick={onReview}>
          <FileCheck2 size={15} />
          {pending.length} 个文件等待复核<span>查看变更 →</span>
        </button>
      )}
    </section>
  );
}
