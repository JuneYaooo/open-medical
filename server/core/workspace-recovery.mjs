import { PermissionEngine } from "./permissions.mjs";
import { hashText } from "./workspace-files.mjs";

// Restart authorization is attached to one run, with its original identity and
// budget. It never authorizes changed workspaces, providers, or approval effects.
export class WorkspaceRecovery {
  constructor(service) {
    this.service = service;
    this.pending = new Set();
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
  async drain() {
    await Promise.allSettled([...this.pending]);
  }
  tick() {
    const service = this.service;
    for (const workspace of service.store.recoveryCandidates()) {
      if (service.active.size >= service.maxActive) break;
      if (service.active.has(workspace.id) || service.mutating.has(workspace.id)) continue;
      const run = workspace.runs.at(-1);
      if (!run?.resumeOnRestart || run.status !== "interrupted" || run.recoveryBlocked) continue;
      let reason;
      if (run.authority !== hashText(JSON.stringify(workspace.permissions)) ||
          run.contextIdentity !== service.contextIdentity(workspace.id)) reason = "模型、领域或授权已变化";
      else if (!run.contextMessages?.length) reason = "没有持久化的执行检查点";
      else if ((run.recoveryAttempts || 0) >= 3) reason = "已达到 3 次自动恢复上限";
      else if ((run.activeMs || 0) >= run.limits.timeoutMs) reason = "原任务执行时间预算已用尽";
      else if ((run.roundsUsed || 0) >= run.limits.maxRounds) reason = "原任务模型轮数预算已用尽";
      else if (workspace.approvals.some((a) => a.status === "interrupted") ||
        workspace.extensions?.actions?.some((a) => a.status === "interrupted")) reason = "存在结果未知的审批操作，需要核查实际状态";
      if (reason) {
        service.store.update(workspace.id, (w) => {
          w.runs.find((r) => r.id === run.id).recoveryBlocked = reason;
        });
        service.store.event(workspace.id, run.id, "recovery.blocked", { reason });
        service.notify(workspace.id, run.id, "interrupted");
        continue;
      }
      const handle = {
        id: workspace.id, run, recovering: true,
        message: workspace.messages.find((m) => m.runId === run.id && m.role === "user")?.content || "继续原任务",
        permissions: new PermissionEngine(workspace.permissions),
        controller: new AbortController(),
      };
      run.recoveryAttempts = (run.recoveryAttempts || 0) + 1;
      run.status = "running";
      service.store.update(workspace.id, (w) => {
        Object.assign(w.runs.find((r) => r.id === run.id), {
          status: "running", recoveryAttempts: run.recoveryAttempts, resumedAt: Date.now(),
        });
      });
      service.active.set(workspace.id, handle);
      service.store.event(workspace.id, run.id, "recovery.started", { attempt: run.recoveryAttempts });
      const promise = service.execute(handle);
      this.pending.add(promise);
      promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    }
  }
}
