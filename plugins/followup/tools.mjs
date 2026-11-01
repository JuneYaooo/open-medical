import { check } from "../../server/errors.mjs";
import { careTools } from "./core/care/tools.mjs";
import { normalizeQuestionnaire, renderQuestionnaire } from "./core/surveys.mjs";

const text = { type: "string" };

// JSON schema for one questionnaire, shared by the preview, single follow-up
// and template tools. Validation itself lives in normalizeQuestionnaire.
const QUESTIONNAIRE_SCHEMA = {
  type: "object",
  description: "随访问卷：1–20 题。single/multi 题给 2–12 个选项（可带分值 score）；number 题可给 unit、min、max 和单题预警 alertIf {op: gt|lt, value}；scoring.alert {op: gte|lte, value, severity: warning|critical, message} 为总分预警。",
  properties: {
    title: text,
    replyWindowHours: { type: "integer", description: "回收窗口小时数，1–336，默认 72" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: text,
          text,
          type: { type: "string", enum: ["single", "multi", "number", "text"] },
          required: { type: "boolean" },
          options: { type: "array", items: { type: "object", properties: { label: text, score: { type: "number" } }, required: ["label"], additionalProperties: false } },
          unit: text,
          min: { type: "number" },
          max: { type: "number" },
          alertIf: { type: "object", properties: { op: { type: "string", enum: ["gt", "lt"] }, value: { type: "number" } }, required: ["op", "value"], additionalProperties: false },
        },
        required: ["text", "type"],
        additionalProperties: false,
      },
    },
    scoring: {
      type: "object",
      properties: {
        alert: { type: "object", properties: { op: { type: "string", enum: ["gte", "lte"] }, value: { type: "number" }, severity: { type: "string", enum: ["warning", "critical"] }, message: text }, required: ["op", "value"], additionalProperties: false },
      },
      additionalProperties: false,
    },
  },
  required: ["title", "questions"],
  additionalProperties: false,
};
const PLAN_NODE_SCHEMA = {
  type: "object",
  properties: {
    offsetDays: { type: "integer", description: "从开始日期起第几天，0 表示当天" },
    title: text,
    items: { type: "array", items: text, description: "提醒医生核对的随访内容，最多 10 条" },
    questionnaire: QUESTIONNAIRE_SCHEMA,
  },
  required: ["offsetDays", "title"],
  additionalProperties: false,
};

// Score range of a questionnaire, so the doctor can sanity-check thresholds.
function scoreRange(questionnaire) {
  let min = 0;
  let max = 0;
  for (const question of questionnaire.questions) {
    if (!question.options) continue;
    const scores = question.options.map((option) => option.score);
    if (question.type === "single") {
      min += Math.min(...scores);
      max += Math.max(...scores);
    } else {
      min += Math.min(0, ...scores.filter((score) => score < 0).concat(0));
      max += scores.filter((score) => score > 0).reduce((sum, score) => sum + score, 0);
    }
  }
  return { min, max };
}

const definition = (name, description, properties, required = []) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  },
});

// Followup-owned agent tools. Names and parameter schemas are unchanged from
// the fixed shell; proposal types also stay unchanged until T7.5.
// Patient-messaging tools (care_*, wecom_*) are only offered while a patient
// channel is connected; the doctor's own reminder tools are always present.
export function followupToolPlugins(ctx, { messaging = true } = {}) {
  const service = () => ctx.plugins.followup.service;
  const pending = ctx.services.pending;
  const care = () => service().care;
  return [
    {
      definition: definition(
        "followup_create_propose",
        "提议为患者创建本机随访提醒（单次或周期），到期提醒医生本人联系患者，不会给患者发消息。若要定时给患者发问题并自动收集回复，用 care_campaign_propose。只创建待确认提案；医生在对话中明确同意后用 proposal_confirm 生效。",
        {
          patientId: text,
          name: text,
          once: { type: "boolean" },
          intervalDays: { type: "integer" },
          firstDueAt: text,
          checklist: { type: "array", items: text },
          questionnaire: { ...QUESTIONNAIRE_SCHEMA, description: "可选：到期时一并生成的随访问卷（先用 questionnaire_preview 预览）。" },
          summary: text,
        },
        ["patientId", "name", "firstDueAt", "summary"],
      ),
      execute: (args) => {
        const { patientId, summary, ...payload } = args;
        if (payload.questionnaire) payload.questionnaire = normalizeQuestionnaire(payload.questionnaire);
        return pending.propose({
          type: "followup-create",
          patientId,
          payload,
          summary,
        });
      },
    },
    {
      definition: definition(
        "followups_overview",
        "只读全部患者的在管随访计划概览（按下次到期时间排序）：患者、计划名、频率、状态、到期时间。",
        { limit: { type: "integer", description: "返回条数，默认 50" } },
      ),
      execute: ({ limit } = {}) => {
        const value = limit === undefined ? 50 : limit;
        check(
          Number.isInteger(value) && value >= 1 && value <= 200,
          "INVALID_INPUT",
          "limit 须为 1–200",
        );
        return { followups: service().followups.overview({ limit: value }), readOnly: true };
      },
    },
    {
      definition: definition(
        "questionnaire_preview",
        "校验并预览一份随访问卷（只读，不保存）：返回规范化后的问卷、患者在企业微信/微信里收到的文字样式、总分范围和需要医生留意的问题。生成或修改问卷后先调用它，把预览给医生看，再保存。",
        { questionnaire: QUESTIONNAIRE_SCHEMA },
        ["questionnaire"],
      ),
      execute: ({ questionnaire }) => {
        const normalized = normalizeQuestionnaire(questionnaire);
        const range = scoreRange(normalized);
        const notes = [];
        const alert = normalized.scoring?.alert;
        if (alert && (alert.value > range.max || alert.value < range.min))
          notes.push(`总分预警阈值 ${alert.value} 超出可能得分范围 ${range.min}–${range.max}，永远不会触发。`);
        if (!alert && range.max > 0) notes.push("选项设置了分值但没有总分预警，得分只用于记录。");
        if (normalized.questions.length > 8) notes.push("题目超过 8 道，患者在手机上回复负担较重，建议精简。");
        if (!normalized.questions.some((question) => question.required)) notes.push("没有必答题，患者只回一部分也会被视为完成。");
        return {
          questionnaire: normalized,
          patientText: renderQuestionnaire(normalized),
          scoreRange: range,
          notes,
          readOnly: true,
        };
      },
    },
    {
      definition: definition(
        "followup_plans_list",
        "只读列出全部随访模板（内置、专病包和医生自建）：名称、适用病种、节点、各节点是否带问卷。",
        {},
      ),
      execute: () => ({
        plans: service().followups.listPlans().map((plan) => ({
          id: plan.id,
          name: plan.name,
          disease: plan.disease || "",
          builtin: Boolean(plan.builtin),
          source: plan.source || null,
          nodes: plan.nodes.map((node) => ({
            offsetDays: node.offsetDays,
            title: node.title,
            items: node.items,
            questionnaire: node.questionnaire ? node.questionnaire.title : null,
          })),
        })),
        readOnly: true,
      }),
    },
    {
      definition: definition(
        "followup_plan_propose",
        "提议保存一个随访模板（可复用到多位患者），每个节点可带一份问卷。只创建待确认提案，医生在「待确认」面板确认后才保存。",
        {
          name: text,
          disease: { type: "string", description: "适用病种，可选" },
          nodes: { type: "array", items: PLAN_NODE_SCHEMA, description: "1–12 个节点" },
          summary: text,
        },
        ["name", "nodes"],
      ),
      execute: ({ summary, ...input }) =>
        ctx.proposals.create({
          kind: "followup.plan.create",
          patientId: null,
          input,
          summary: summary || `保存随访模板「${input.name}」（${input.nodes?.length || 0} 个节点）`,
        }),
    },
    {
      definition: definition(
        "followup_plan_apply_propose",
        "提议把随访模板应用到一位患者：每个节点在开始日期 + offsetDays 天生成一次随访提醒，带问卷的节点到期时生成问卷。只创建待确认提案。",
        {
          patientId: text,
          planId: text,
          startDate: { type: "string", description: "YYYY-MM-DD，昨天到未来一年内" },
          summary: text,
        },
        ["patientId", "planId", "startDate"],
      ),
      execute: ({ patientId, planId, startDate, summary }) => {
        const plan = service().followups.planRow(planId);
        return ctx.proposals.create({
          kind: "followup.plan.apply",
          patientId,
          input: { patientId, planId, startDate },
          summary: summary || `为患者应用随访模板「${plan.name}」，从 ${startDate} 开始`,
        });
      },
    },
    ...(messaging ? careTools(care, pending) : []),
  ];
}

export function registerFollowupTools(ctx, { registry, messaging = true }) {
  for (const tool of followupToolPlugins(ctx, { messaging }))
    registry.register({
      permission: "tools.execute",
      capability: { backend: "local" },
      definition: tool.definition,
      execute: tool.execute,
    });
}
