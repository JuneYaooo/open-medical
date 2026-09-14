// Complete interrupted protocol batches without executing historic tool calls.
// A durable intent cannot establish whether an external effect actually happened.
export function sealInterruptedContext(messages = [], pendingToolCall) {
  const result = [];
  for (let index = 0; index < messages.length; index++) {
    const message = structuredClone(messages[index]);
    result.push(message);
    if (!message.tool_calls?.length) continue;
    const outputs = new Map();
    while (messages[index + 1]?.role === "tool") {
      const output = structuredClone(messages[++index]);
      outputs.set(output.tool_call_id, output);
    }
    for (const call of message.tool_calls) {
      result.push(outputs.get(call.id) || {
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({
          code: call.id === pendingToolCall ? "TOOL_OUTCOME_UNKNOWN" : "TOOL_NOT_EXECUTED",
          error: call.id === pendingToolCall
            ? "进程在此工具执行期间中断，副作用可能已经发生。先查询实际状态；不能盲目重试。无法确认的外部写入须由用户核实。"
            : "进程中断，此调用尚未执行。请根据当前状态重新规划。",
          interrupted: true,
        }),
      });
    }
  }
  return result;
}
