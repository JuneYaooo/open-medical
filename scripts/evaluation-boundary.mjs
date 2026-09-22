import { collectApprovalReadiness } from "../server/core/workspace-delivery.mjs";

// Acceptance fixtures explicitly ask for proposals and approve only their
// allowlisted paths. A verified pause is the correct intermediate state; it
// must not be confused with a completed write or accepted without evidence.
export function verifyEvaluationBoundary(service, id, run, execution, { automatic = false } = {}) {
  if (execution.status === "completed") return { executionStatus: execution.status };
  if (execution.status !== "waiting_approval" || automatic)
    throw new Error(`Agent did not reach the expected boundary: ${execution.status || "unknown"}${execution.error ? ` (${execution.error})` : ""}`);
  const readiness = collectApprovalReadiness(service, id, run.id, run.approvalSubmission);
  if (!readiness || readiness.phase !== "verification_complete") throw new Error("Missing verified proposal handoff");
  return { executionStatus: "waiting_approval", approvalBoundaryVerified: true,
    proposalCount: readiness.approvalIds.length, verificationCount: readiness.verificationIds.length };
}
