import { createHash } from "node:crypto";
import { check } from "../errors.mjs";

// Playback is a read-only projection. Recorded commands and model text are data;
// this module deliberately has no provider, tool registry, or process runner.
export function replayTrajectory(store, workspaceId, runId) {
  const workspace = store.get(workspaceId);
  const run = workspace.runs.find((r) => r.id === runId) || JSON.parse(
    store.db.prepare("SELECT data FROM agent_run_history WHERE workspace_id=? AND run_id=?").get(workspaceId, runId)?.data || "null");
  check(run, "NOT_FOUND", "运行记录不存在", 404);
  const steps = [], actors = new Map(), anomalies = [], hash = createHash("sha256");
  let truncated = false;
  for (const row of store.db.prepare("SELECT id,time,data FROM agent_trace WHERE workspace_id=? AND run_id=? ORDER BY id LIMIT 10001").iterate(workspaceId, runId)) {
    if (steps.length >= 10000) { truncated = true; break; }
    hash.update(String(row.id)).update(row.time).update(row.data);
    const data = JSON.parse(row.data), actorId = data.agentId || "parent";
    if (!actors.has(actorId)) actors.set(actorId, { modelPending: false, tools: new Map() });
    const actor = actors.get(actorId);
    const step = { id: row.id, time: row.time, actorId, type: data.type, durationMs: data.durationMs,
      ...(data.phase ? { phase: data.phase, fragment: data.fragment, archiveId: data.archiveId } : {}) };
    if (data.type === "model.request") {
      if (actor.modelPending) anomalies.push({ id: row.id, reason: "前一次模型请求没有完整响应记录" });
      if (actor.tools.size) anomalies.push({ id: row.id, reason: "模型请求之前存在未记录结果的工具" });
      actor.modelPending = true;
      step.messageCount = data.messages.length;
      step.contextChars = JSON.stringify(data.messages).length;
      step.tools = data.tools.map((t) => t.function.name);
    } else if (data.type === "model.error") {
      actor.modelPending = false;
      step.error = data.error;
    } else if (data.type === "model.response") {
      if (!actor.modelPending) anomalies.push({ id: row.id, reason: "模型响应缺少对应请求" });
      actor.modelPending = false;
      step.text = typeof data.message.content === "string" ? data.message.content.slice(0, 4000) : "";
      step.textTruncated = typeof data.message.content === "string" && data.message.content.length > 4000;
      step.usage = data.usage;
      step.calls = (data.message.tool_calls || []).map((call) => {
        if (actor.tools.has(call.id)) anomalies.push({ id: row.id, reason: "同一批次调用标识重复" });
        actor.tools.set(call.id, call.function.name);
        return { id: call.id, tool: call.function.name };
      });
    } else if (data.type === "tool.result") {
      if (actor.tools.get(data.call.id) !== data.call.function.name) anomalies.push({ id: row.id, reason: "工具结果缺少匹配的模型调用" });
      actor.tools.delete(data.call.id);
      step.tool = data.call.function.name;
      step.callId = data.call.id;
      step.error = data.output?.error;
      const output = JSON.stringify(data.output ?? null);
      step.outputPreview = output.slice(0, 4000);
      step.outputTruncated = output.length > 4000;
    }
    steps.push(step);
  }
  const unfinished = [...actors].filter(([_id, actor]) => actor.modelPending || actor.tools.size)
    .map(([actorId, actor]) => ({ actorId, modelPending: actor.modelPending, toolCalls: [...actor.tools.keys()] }));
  return { workspaceId, runId, status: run.status, readOnly: true, executesTools: false,
    traceHash: hash.digest("hex"), truncated, steps,
    summary: { steps: steps.length, actors: actors.size, anomalies, unfinished,
      protocolComplete: steps.length > 0 && !truncated && !anomalies.length && !unfinished.length } };
}
