import { AppError, check } from "../errors.mjs";

// 运行状态的单一事实判定（路线文档 §10.2/§12）：状态词汇、合法转移与
// 从持久事实推导的目标状态只有这一处实现。引擎写入 run.status 必须经
// assertRunTransition 守卫；UI/桥接只能读 deriveRunStatus 的结果，不能
// 各自推导。持久字段 run.status 的既有取值与语义保持不变（向后兼容），
// 新增派生字段（derivedStatus/waitingReason）只增不改。
//
// 状态集 = §12 最小集 { queued, running, waiting_approval, waiting_input,
// blocked, cancelled, failed, completed } + 既有扩展 interrupted
// （服务重启/关停中断；可被恢复或取消，是准终态）。
export const RUN_STATES = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "blocked",
  "cancelled",
  "failed",
  "interrupted",
  "completed",
];
export const TERMINAL_RUN_STATES = ["cancelled", "failed", "completed"];
// 等待用户或环境、尚未失败的中间状态：等待期间任务可继续推进或被取消。
export const WAITING_RUN_STATES = [
  "waiting_approval",
  "waiting_input",
  "blocked",
  "queued",
];
// 引擎写入 run.status 的合法转移图。初始写入（无 from）只允许
// queued/running。interrupted 只能经恢复（running）或放弃（cancelled）离开。
export const RUN_TRANSITIONS = {
  queued: ["running", "cancelled"],
  running: [
    "waiting_approval",
    "waiting_input",
    "blocked",
    "cancelled",
    "failed",
    "interrupted",
    "completed",
  ],
  waiting_approval: [
    "running",
    "blocked",
    "cancelled",
    "failed",
    "interrupted",
    "completed",
  ],
  waiting_input: [
    "running",
    "blocked",
    "cancelled",
    "failed",
    "interrupted",
    "completed",
  ],
  blocked: ["running", "cancelled", "failed", "interrupted", "completed"],
  cancelled: [],
  failed: [],
  completed: [],
  interrupted: ["running", "cancelled"],
};

export function assertRunTransition(from, to) {
  check(RUN_STATES.includes(to), "RUN_STATE", `未知运行状态：${to}`, 422);
  if (from === undefined || from === null) {
    check(
      ["queued", "running"].includes(to),
      "RUN_STATE",
      `运行只能从 queued 或 running 开始，不能是 ${to}`,
      409,
    );
    return to;
  }
  check(
    RUN_STATES.includes(from),
    "RUN_STATE",
    `未知运行状态：${from}`,
    422,
  );
  if (from === to) return to; // 幂等重写（如恢复流程重复确认）
  if (!(RUN_TRANSITIONS[from] || []).includes(to))
    throw new AppError(
      "RUN_STATE",
      `非法状态转移：${from} → ${to}`,
      409,
    );
  return to;
}

// 从持久事实推导 §12 目标状态。facts 是可选项，缺省时只做基础归一：
// - pendingApprovals：该 run 关联、状态仍为 pending 的审批数（统一内核
//   w.approvals；旧医疗引擎无审批流，恒为 0）。
// - awaitingInput：持久事实 run.awaitingInput === true（当前无写入方，
//   保留给未来的“暂停等用户输入”入口；不在这里用模型输出猜测）。
// - active：执行服务当前是否持有该 run（用于识别“看起来 running 但
//   没有执行体”的孤儿状态；缺省视为不确定、不影响推导）。
export function deriveRunStatus(run, facts = {}) {
  const status = run?.status;
  if (status === "running") {
    if (run.awaitingInput === true || facts.awaitingInput === true)
      return "waiting_input";
    if ((facts.pendingApprovals || 0) > 0) return "waiting_approval";
    if (facts.active === false) return "blocked";
    return "running";
  }
  if (status === "interrupted") {
    if (run.recoveryBlocked || facts.recoveryBlocked) return "blocked";
    return "interrupted";
  }
  return status;
}

// 等待/受阻原因（与 deriveRunStatus 同一事实来源，供展示层使用）。
export function waitingReasonFor(run, facts = {}) {
  const derived = deriveRunStatus(run, facts);
  if (derived === "waiting_approval") return "approval";
  if (derived === "waiting_input") return "input";
  if (derived === "blocked")
    return (
      run?.recoveryBlocked ||
      facts.recoveryBlocked ||
      (run?.status === "running" && facts.active === false
        ? "运行记录没有活跃执行体"
        : "blocked")
    );
  return null;
}
