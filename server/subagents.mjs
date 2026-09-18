import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { AppError, check, string } from "./errors.mjs";
import { TOOL_DEFINITIONS, runTool } from "./medical-core.mjs";

export const MEDICAL_AGENTS = {
  timeline: {
    name: "病历时间线助理",
    tool: "extract_clinical_timeline",
    instruction: "按原始日期摘录就诊事件，保留原文行号，不推断缺失日期。",
  },
  observations: {
    name: "检验资料助理",
    tool: "extract_observations",
    instruction: "摘录检验数值、正负号、单位和出处，不进行异常判断或单位转换。",
  },
  medication: {
    name: "用药资料助理",
    tool: "review_medication_safety",
    instruction:
      "整理用药资料的缺失字段和待复核事项，不做剂量、相互作用或安全结论。",
  },
};

export const ORCHESTRATION_TOOLS = [
  {
    type: "function",
    function: {
      name: "delegate_medical_task",
      description:
        "委派独立上下文的医疗资料子代理，最多 3 次，子代理不可递归。返回待复核结果。",
      parameters: {
        type: "object",
        properties: {
          profile: { type: "string", enum: Object.keys(MEDICAL_AGENTS) },
          task: { type: "string" },
          sourceIds: { type: "array", items: { type: "string" } },
        },
        required: ["profile", "task", "sourceIds"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sandbox_python",
      description:
        "在本机 OS 沙箱中运行 Python 标准库计算。只提供当前资料 sources；禁止联网、文件写入、子进程。将 JSON 兼容结果赋给 result，不要 print。结果需人工复核。",
      parameters: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
        additionalProperties: false,
      },
    },
  },
];

export class MedicalSubagents {
  constructor({
    provider,
    skills,
    system,
    maxActive = 2,
    maxRounds = Infinity,
    maxContextChars = 40000,
  }) {
    Object.assign(this, {
      provider,
      skills,
      system,
      maxActive,
      maxRounds,
      maxContextChars,
    });
    this.active = 0;
  }
  async run({
    profile,
    task,
    sources,
    mode,
    model,
    signal,
    onEvent = () => {},
  }) {
    check(
      Object.hasOwn(MEDICAL_AGENTS, profile),
      "AGENT_PROFILE",
      "未知医疗子代理",
    );
    string(task, "子代理任务", 4000);
    const agent = MEDICAL_AGENTS[profile];
    const child = {
      id: randomUUID(),
      profile,
      name: agent.name,
      task: task,
      mode,
      status: "queued",
      startedAt: new Date().toISOString(),
      sourceIds: sources.map((s) => s.id),
      artifacts: [],
      usage: { total_tokens: 0, rounds: 0 },
    };
    const emit = (type, details = {}) =>
      onEvent(type, { child: structuredClone(child), ...details });
    emit("subagent.queued");
    let acquired = false;
    try {
      while (this.active >= this.maxActive) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      signal.throwIfAborted();
      this.active++;
      acquired = true;
      child.status = "running";
      emit("subagent.started");
      if (mode === "local") {
        await setImmediate(undefined, { signal });
        const result = runTool(
          agent.tool,
          {},
          { sources, skills: this.skills },
        );
        result.subagentId = child.id;
        child.artifacts.push(result);
        child.text = `${agent.name}已完成资料摘录；结果待人工复核。`;
        emit("subagent.tool", { tool: agent.tool });
      } else {
        // Separate messages: no parent/sibling conversation or unselected sources.
        const messages = [
          {
            role: "system",
            content: `${this.system}\n你是${agent.name}。${agent.instruction}\n只完成子任务，不创建其他代理或调度。资料索引：${JSON.stringify(sources.map((s) => ({ id: s.id, name: s.name, hash: s.hash, preview: s.text.slice(0, 1000) })))}`,
          },
          { role: "user", content: child.task },
        ];
        const allowed = TOOL_DEFINITIONS.filter((t) =>
          [
            agent.tool,
            "read_source",
            "search_materials",
            "list_skills",
            "read_skill",
          ].includes(t.function.name),
        );
        let completed = false;
        for (let round = 0; round < this.maxRounds; round++) {
          signal.throwIfAborted();
          check(
            JSON.stringify(messages).length < this.maxContextChars,
            "CONTEXT_LIMIT",
            "子代理上下文达到预算",
            413,
          );
          const result = await this.provider.complete(messages, allowed, {
            signal,
            model,
          });
          child.usage.rounds++;
          if (Number.isFinite(result.usage?.total_tokens))
            child.usage.total_tokens += result.usage.total_tokens;
          messages.push(result.message);
          const calls = result.message.tool_calls || [];
          check(
            calls.length <= 6,
            "TOOL_BUDGET",
            "子代理工具调用超过预算",
            422,
          );
          if (!calls.length) {
            child.text = result.message.content || "";
            completed = true;
            break;
          }
          for (const call of calls) {
            signal.throwIfAborted();
            check(
              allowed.some((t) => t.function.name === call.function.name),
              "AGENT_TOOL_DENIED",
              "子代理不能使用此工具或递归委派",
              403,
            );
            const output = runTool(
              call.function.name,
              JSON.parse(call.function.arguments),
              { sources, skills: this.skills },
            );
            if (output.id) {
              output.subagentId = child.id;
              child.artifacts.push(output);
            }
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(output),
            });
            emit("subagent.tool", { tool: call.function.name });
          }
        }
        check(completed, "TOOL_BUDGET", "子代理达到轮数上限，结果不完整", 422);
      }
      signal.throwIfAborted();
      child.status = "completed";
      child.endedAt = new Date().toISOString();
      emit("subagent.completed");
      return child;
    } catch (error) {
      child.status = signal.aborted ? "cancelled" : "failed";
      child.error =
        error instanceof AppError
          ? error.message
          : signal.aborted
            ? "父任务停止，子代理已取消"
            : "子代理执行失败";
      child.endedAt = new Date().toISOString();
      emit(`subagent.${child.status}`);
      return child;
    } finally {
      if (acquired) this.active--;
    }
  }
}
