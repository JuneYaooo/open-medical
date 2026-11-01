import { check, identifier, string } from "../../server/errors.mjs";
import { normalizeQuestionnaire } from "./core/surveys.mjs";

// Proposal types that predate the plugin boundary keep their exact strings and
// payload shapes. The host still owns pending_actions and the transaction; the
// plugin only supplies deterministic validate/apply for its own types.
const CARE_TYPES = [
  "care-message",
  "care-campaign",
  "care-settings",
  "care-bind",
  "care-group-message",
  "care-education-broadcast",
];

const followupService = (ctx) => ctx.plugins.followup.service;

const careHandler = (type) => ({
  validate({ patientId, payload }, ctx) {
    return followupService(ctx).care.normalizeProposal(type, {
      ...payload,
      ...(patientId ? { patientId } : {}),
    });
  },
  apply(payload, ctx, _tx, meta) {
    const action = meta?.action;
    return followupService(ctx).care.applyProposal({
      id: action?.id,
      type,
      patientId: action?.patientId ?? payload?.patientId ?? null,
      payload,
    });
  },
});

export function legacyFollowupProposals() {
  return {
    "followup-create": {
      revisionScoped: true,
      validate({ patientId, payload }, _ctx) {
        check(patientId, "INVALID_INPUT", "该提案需要患者编号");
        check(
          payload && typeof payload.name === "string" && payload.name.trim(),
          "INVALID_INPUT",
          "随访提案需要 name",
        );
        return payload;
      },
      apply(payload, ctx, _tx, meta) {
        const action = meta?.action;
        return followupService(ctx).followups.create(
          action?.patientId,
          payload,
        );
      },
    },
    ...Object.fromEntries(CARE_TYPES.map((type) => [type, careHandler(type)])),
  };
}

// Plan templates and plan enrollment. Validation runs at proposal time so the
// doctor never confirms something that cannot be applied.
export function followupPlanProposals() {
  return {
    "followup.plan.create": {
      validate(input) {
        check(input && typeof input === "object", "INVALID_INPUT", "模板参数无效");
        string(input.name, "模板名称", 100);
        check(Array.isArray(input.nodes) && input.nodes.length >= 1 && input.nodes.length <= 12, "INVALID_INPUT", "模板须包含 1–12 个随访节点");
        const nodes = input.nodes.map((node) => ({
          ...node,
          questionnaire: node?.questionnaire ? normalizeQuestionnaire(node.questionnaire) : null,
        }));
        return { ...input, nodes };
      },
      apply(input, ctx) {
        return followupService(ctx).followups.createPlan(input);
      },
    },
    "followup.plan.apply": {
      revisionScoped: true,
      validate(input, ctx) {
        check(input && typeof input === "object", "INVALID_INPUT", "参数无效");
        identifier(input.patientId);
        followupService(ctx).followups.planRow(input.planId);
        check(/^\d{4}-\d{2}-\d{2}$/.test(String(input.startDate || "")), "INVALID_INPUT", "开始日期须为 YYYY-MM-DD");
        return { patientId: input.patientId, planId: input.planId, startDate: input.startDate };
      },
      apply(input, ctx) {
        return followupService(ctx).followups.applyTemplate(input.patientId, {
          planId: input.planId,
          startDate: input.startDate,
        });
      },
    },
  };
}
