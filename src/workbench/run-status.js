// W7 运行状态与交付呈现的共享判定（纯函数，组件与测试复用）。
// 状态词汇与服务端 core/run-status.mjs 的 §12 目标集一致：服务端已下发
// run.derivedStatus/waitingReason 时直接消费；通用工作区接口暂未下发时，
// 按同一持久事实（该工作区的待审批提案数）在展示层归一，不引入第二套
// 状态语义——等待审批以外的情况保持 run.status 原值。

export const WAITING_STATES = [
  "queued",
  "waiting_approval",
  "waiting_input",
  "blocked",
];

export const RUN_STATUS_TEXT = {
  queued: "排队中",
  running: "执行中",
  waiting_approval: "等待批准",
  waiting_input: "等待补充说明",
  blocked: "受阻",
  cancelled: "已停止",
  failed: "失败",
  interrupted: "已中断",
  completed: "已完成",
};

// 展示层状态归一：优先服务端派生字段；无派生字段（通用工作区接口）时，
// 仅用「running + 存在待审批提案」这一持久事实补齐 waiting_approval。
export function runDerivedStatus(run, pendingCount = 0) {
  if (run?.derivedStatus) return run.derivedStatus;
  if (run?.status === "running" && pendingCount > 0)
    return "waiting_approval";
  return run?.status || "";
}

// 顶栏/任务条状态芯片文案；非等待的运行态返回 null（调用方用默认文案）。
export function runChipLabel(run, pendingCount = 0) {
  const status = runDerivedStatus(run, pendingCount);
  if (status === "waiting_input" && run?.outcome === "approval_resolved")
    return "修改已处理";
  return (
    {
      waiting_approval: "等待你批准",
      waiting_input: "等待你的补充",
      blocked: "受阻",
      queued: "排队中",
    }[status] || null
  );
}

export function blockedText(reason) {
  if (!reason || reason === "blocked") return "任务无法继续推进";
  return String(reason);
}

// 等待/受阻状态的「在等什么、能做什么」文案（16.1：是否等待自己、是否受阻）。
// 返回 null 表示该状态不需要提示。
export function waitingNotice({ status, reason = "", pendingCount = 0 }) {
  switch (status) {
    case "waiting_approval":
      return {
        title:
          pendingCount > 0
            ? `等待你批准 ${pendingCount} 项文件修改`
            : "等待批准",
        detail:
          pendingCount > 0
            ? "助手提交的修改提案在批准前不会写入文件；批准或拒绝后，本次任务继续收尾。"
            : "任务在等待一项操作批准，批准后才会继续。",
        action: "查看并批准",
      };
    case "waiting_input":
      return {
        title: "等待你的补充说明",
        detail: "助手需要更多信息才能继续，直接在下方输入并发送即可。",
        action: null,
      };
    case "blocked":
      return {
        title: "任务受阻",
        detail: `${blockedText(reason)}。可停止本次执行后重试，或查看执行记录定位问题。`,
        action: null,
      };
    case "queued":
      return {
        title: "排队中",
        detail: "任务已提交，会自动开始执行。",
        action: null,
      };
    default:
      return null;
  }
}

// 交付证据/缺口条目 → 一行可读文本（文件名/来源 + 哈希前 8 位）。
export function evidenceLine(e) {
  if (!e) return "";
  if (e.kind === "file")
    return `${e.path}${e.bytes != null ? ` · ${e.bytes} B` : ""}${
      e.hash ? ` · SHA-256 ${String(e.hash).slice(0, 8)}` : ""
    }`;
  if (e.source === "artifact")
    return `${e.title || e.type || "结构化产物"}${
      e.hash ? ` · SHA-256 ${String(e.hash).slice(0, 8)}` : ""
    }`;
  if (e.source === "sandbox") return `沙箱执行回执${e.backend ? ` · ${e.backend}` : ""}`;
  if (e.source === "subagent")
    return `子任务回执${e.childId ? ` · ${e.childId.slice(0, 8)}` : ""}`;
  return e.source || e.kind || "执行回执";
}

export function gapLine(g) {
  if (!g) return "";
  if (typeof g === "string") return g;
  return g.detail || g.reason || "未说明的缺口";
}
// Consultation lookup failures limit evidence; they do not imply a missing file.
export function consultationLookupIssue(run) {
  const gaps = run?.delivery?.gaps || [];
  const reads = new Set(['literature_search', 'literature_fetch', 'knowledge_search', 'knowledge_base_status', 'lab_knowledge_search']);
  return run?.policy?.intent === 'consultation' && !run.delivery?.evidence?.length &&
    gaps.some((g) => g.reason === 'tool_failed' && reads.has(g.tool)) &&
    gaps.every((g) => g.reason === 'no_current_run_evidence' || (g.reason === 'tool_failed' && reads.has(g.tool)));
}
