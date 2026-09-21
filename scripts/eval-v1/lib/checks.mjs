// N2 检查级状态与可信汇总(复核报告 R2):
// 检查项是显式结构 {id, required, status, reason, evidence},状态至少区分
// pass/fail/blocked;timeout 与执行异常单独记录。必需检查全部 pass 才能
// pass;任一必需 fail 则 fail;无确定失败但有必需 blocked/timeout/error
// 则相应降级,绝不把 blocked 计入成功分子。required/optional 由数据版本
// 事先确定(验证器静态声明),不根据候选输出临时改动。
export const CHECK_STATUSES = ["pass", "fail", "blocked", "timeout", "error"];

// 聚合优先级(单一判定源,所有出口共用):
// 1) 任一必需检查 fail(或外部违规) → fail
// 2) 任一必需检查 timeout → timeout(实际超预算)
// 3) 任一必需检查 error(验收器执行异常) → error
// 4) 任一必需检查 blocked → blocked(基础设施缺口)
// 5) 其余(全部必需 pass) → pass;optional 任何状态不影响任务级状态。
export const AGGREGATION_PRIORITY = ["fail", "timeout", "error", "blocked"];

export class CheckList {
  constructor() {
    this.items = [];
  }
  add(id, status, detail = "", { required = true, evidence = null } = {}) {
    if (!CHECK_STATUSES.includes(status))
      throw new Error(`未知检查状态:${status}`);
    this.items.push({ id, required, status, reason: detail, evidence });
    return this;
  }
  pass(id, detail, opts) {
    return this.add(id, "pass", detail, opts);
  }
  fail(id, detail, opts) {
    return this.add(id, "fail", detail, opts);
  }
  blocked(id, detail, opts) {
    return this.add(id, "blocked", detail, opts);
  }
  timeout(id, detail, opts) {
    return this.add(id, "timeout", detail, opts);
  }
  error(id, detail, opts) {
    return this.add(id, "error", detail, opts);
  }
  /** optional 项:提示不阻断任务,但必须先在数据版本中声明为可选。 */
  optional(id, status, detail, evidence = null) {
    return this.add(id, status, detail, { required: false, evidence });
  }
  merge(other) {
    this.items.push(...other.items);
    return this;
  }
}

/**
 * 确定性聚合。violations 是控制器运行期违规(越界提案、副作用违规等),
 * 视为必需 fail。返回统一形状:{status, pass, reason, checks, blocked}。
 */
export function aggregateChecks(checks, { violations = [] } = {}) {
  const items = checks.items || checks; // 兼容数组
  const required = items.filter((c) => c.required);
  const reasonOf = (c) => `${c.id}:${c.reason || c.status}`;
  let status = "pass";
  let reason = null;
  if (violations.length) {
    status = "fail";
    reason = violations.join(";");
  } else {
    for (const bad of AGGREGATION_PRIORITY) {
      const hit = required.find((c) => c.status === bad);
      if (hit) {
        status = bad;
        reason = reasonOf(hit);
        break;
      }
    }
  }
  return {
    status,
    pass: status === "pass",
    reason,
    checks: items,
    // 兼容旧行字段:blocked[] 单列,方便报告呈现基础设施缺口。
    blocked: items.filter((c) => c.status === "blocked").map((c) => reasonOf(c)),
  };
}

/**
 * 报告汇总(与聚合同一判定源):pass 计入分子;分母是全部结果
 * (fail/blocked/timeout/error 都留在分母里,不允许丢掉 blocked 提高成功率)。
 */
export function summarizeResults(rows) {
  const counts = { pass: 0, fail: 0, blocked: 0, timeout: 0, error: 0 };
  for (const r of rows) {
    const s = r.status;
    counts[s] = (counts[s] || 0) + 1;
  }
  const total = rows.length;
  return {
    total,
    counts,
    success: counts.pass,
    // 分母恒为 total;blocked/timeout 不移出分母,成功率不可能虚报 100%。
    success_rate: total ? counts.pass / total : 0,
  };
}
