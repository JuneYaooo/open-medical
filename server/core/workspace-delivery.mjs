import { check } from "../errors.mjs";
import { WorkspaceFiles, hashText } from "./workspace-files.mjs";
import { normalizeDelivery, receiptEvidence, artifactEvidence } from "./delivery.mjs";

// Requirements are supplied by the caller, never inferred from model prose.
export function completionRequirements(input, root) {
  if (input === undefined) return { kind: "auto", files: [], requireExecution: false };
  check(input && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).every((key) => ["kind", "files", "requireExecution"].includes(key)),
  "COMPLETION_REQUIREMENTS", "完成要求格式无效");
  const { kind = "execution", files = [], requireExecution = false } = input;
  check(["answer", "execution", "auto"].includes(kind) && Array.isArray(files) && files.length <= 100 &&
    typeof requireExecution === "boolean", "COMPLETION_REQUIREMENTS", "完成要求格式无效");
  check(kind !== "answer" || (!files.length && !requireExecution), "COMPLETION_REQUIREMENTS", "问答要求不能包含执行条件");
  const workspaceFiles = new WorkspaceFiles(root);
  for (const file of files) {
    check(file && typeof file === "object" && !Array.isArray(file) &&
      Object.keys(file).every((key) => ["path", "hash", "contains"].includes(key)) &&
      typeof file.path === "string" && file.path.length > 0 &&
      (file.hash === undefined || (typeof file.hash === "string" && /^[a-f0-9]{64}$/.test(file.hash))) &&
      (file.contains === undefined || (typeof file.contains === "string" && file.contains.length <= 20000)),
    "COMPLETION_REQUIREMENTS", "文件完成条件无效");
    workspaceFiles.path(file.path, { create: true, parents: true });
  }
  return structuredClone({ kind, files, requireExecution });
}

// Only service-owned records from this run are candidates. Read through the
// existing workspace guard; a path/hash claimed in model text is never evidence.
export function collectWorkspaceDelivery(service, id, runId, signal) {
  signal?.throwIfAborted();
  const w = service.store.get(id), run = w.runs.find((r) => r.id === runId);
  const requirements = run.completion || { kind: "auto", files: [], requireExecution: false };
  const baseline = run.evidenceBaseline || {};
  const priorApprovals = new Set(baseline.approvals || []);
  const priorArtifacts = new Set(baseline.artifacts || []);
  const priorExecutions = new Set(baseline.executions || []);
  const evidence = [], gaps = [], warnings = [], currentFiles = new Map();
  for (const [tool, failure] of Object.entries(run.toolFailures || {}))
    (failure.affectsDelivery === false ? warnings : gaps).push({
      reason: "tool_failed", tool, callId: failure.callId,
      detail: failure.affectsDelivery === false ? "探索时有只读工具调用失败；该失败不作为交付证据。" : "本次工具调用仍有未解决的失败。",
    });
  const files = new WorkspaceFiles(w.root);
  for (const child of run.children || [])
    if (["failed", "cancelled", "interrupted"].includes(child.status))
      gaps.push({ reason: "child_not_completed", agentId: child.id, status: child.status, detail: "协作任务尚未成功结束。" });
  const owners = new Set([runId, ...(run.children || []).map((child) => child.id)]);
  const approvals = w.approvals.filter((a) => owners.has(a.runId) && !priorApprovals.has(a.id));
  const latest = new Map(approvals.map((a) => [a.path, a]));
  for (const approval of latest.values()) {
    signal?.throwIfAborted();
    if (approval.status !== "applied") {
      gaps.push({ reason: `approval_${approval.status}`, path: approval.path,
        detail: "本次文件提案尚未实际应用。" });
      continue;
    }
    if (approval.kind === "file.delete") {
      try {
        files.path(approval.path);
        gaps.push({ reason: "deletion_unverified", path: approval.path, detail: "删除后目标仍然存在。" });
      } catch (error) {
        if (error.code === "ENOENT") evidence.push(receiptEvidence("applied_deletion", {
          runId: approval.runId, approvalId: approval.id, path: approval.path, status: "completed", deleted: true,
        }));
        else gaps.push({ reason: "deletion_unverified", path: approval.path, detail: "无法在授权边界内核对删除结果。" });
      }
      continue;
    }
    if (approval.before !== null && approval.before !== undefined && hashText(approval.before) === approval.result?.hash) {
      gaps.push({ reason: "no_file_change", path: approval.path, detail: "文件与运行前相同，没有本次实际修改。" });
      continue;
    }
    try {
      check(w.permissions.grants["filesystem.read"], "PERMISSION_DENIED", "文件读取未授权");
      const read = files.read(approval.path);
      if (read.hash !== approval.result?.hash) {
        gaps.push({ reason: "file_changed", path: approval.path, detail: "当前文件与本次应用记录不一致。" });
        continue;
      }
      currentFiles.set(approval.path, read);
      evidence.push({ kind: "file", path: approval.path, hash: read.hash, readable: true,
        bytes: Buffer.byteLength(read.text), runId, approvalId: approval.id });
    } catch (error) {
      gaps.push({ reason: "file_unverified", path: approval.path, code: error.code || "READ_FAILED",
        detail: "无法通过工作区权限边界读取并核对文件。" });
    }
  }
  for (const item of (w.artifacts || []).filter((a) => owners.has(a.runId) && !priorArtifacts.has(a.id))) {
    try {
      const { data } = service.artifacts.read(id, item.id);
      evidence.push(receiptEvidence("workspace_artifact", { artifactId: item.id, runId,
        hash: hashText(data), bytes: data.length, status: "completed" }));
    } catch {
      gaps.push({ reason: "artifact_unverified", artifactId: item.id, detail: "当前产物不可读取或内容已改变。" });
    }
  }
  for (const item of (run.artifacts || []).filter((a) => !priorArtifacts.has(a.id))) evidence.push(artifactEvidence({ ...item, runId }));
  const sessions = [...new Map([
    ...(w.verifications || []).filter((s) => owners.has(s.runId)),
    ...[...service.extensions.runner.sessions.values()].filter((s) => s.owner === id && owners.has(s.runId)),
  ].filter((s) => !priorExecutions.has(s.id)).map((s) => [s.id, s])).values()];
  let executed = false;
  for (const session of sessions) {
    if (session.status !== "completed" || session.exitCode !== 0) {
      gaps.push({ reason: "execution_not_passed", sessionId: session.id, exitCode: session.exitCode,
        status: session.status, detail: "本次执行没有成功退出，不能作为验证通过的证据。" });
    } else {
      executed = true;
      evidence.push(receiptEvidence("process_runner", { sessionId: session.id, runId,
        status: session.status, exitCode: session.exitCode }));
    }
  }
  for (const requirement of requirements.files) {
    const read = currentFiles.get(requirement.path);
    if (!read) gaps.push({ reason: "required_file_not_written", path: requirement.path, detail: "缺少本次运行实际应用并核对的文件。" });
    else if ((requirement.hash && requirement.hash !== read.hash) ||
      (requirement.contains !== undefined && !read.text.includes(requirement.contains)))
      gaps.push({ reason: "file_requirement_failed", path: requirement.path, detail: "文件存在，但未满足调用方指定的内容条件。" });
  }
  if (requirements.requireExecution && !executed)
    gaps.push({ reason: "execution_required", detail: "缺少本次运行成功退出的真实执行回执。" });
  if (!evidence.length) gaps.push({ reason: "no_current_run_evidence",
    detail: requirements.kind === "answer" ? "本次为文字问答，无需文件交付。" : "仅有文字回答；尚无本次运行可核对的产物或执行回执。" });
  signal?.throwIfAborted();
  return normalizeDelivery({ delivered: requirements.kind !== "answer" && evidence.length > 0 && !gaps.length,
    evidence, gaps, warnings, method: requirements.kind === "auto" ? "current-run-facts-only" : "explicit-requirements" });
}
