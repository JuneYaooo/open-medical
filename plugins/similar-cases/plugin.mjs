import { definePlugin } from "../../server/plugin-host/define.mjs";
import {
  configureSimilarCaseTools,
  SIMILAR_CASE_GUIDANCE,
  similarCaseAnswer,
  similarCaseQuestion,
  similarCaseSearchScope,
} from "./server/similar-case-workflow.mjs";
import { patientIdentityTerms } from "../../server/medical/outbound-query.mjs";

// The local-only constraint used to be a second fixed line in runSystemExtras.
// Keeping it beside the workflow guidance preserves the exact prompt order.
const LOCAL_SEARCH_GUIDANCE =
  "本轮医生限定仅本地检索：只使用本机患者档案和本地病例库，不进行网上检索。online_case_search、literature_fetch、web_search 和 web_fetch 不可用。完成一次 similar_case_search 后直接核对候选并提交 finish_similar_case_search；无候选也提交真实的本地检索结果。";

export default definePlugin({
  id: "similar-cases",
  version: "1.0.0",
  title: "相似病例",
  enabledByDefault: true,
  prompt: "./prompt.md",
  workflows: {
    "similar-case-search": {
      artifactType: "similar_cases",
      detect: (message) => similarCaseQuestion(message),
      applyPolicy(policy, message) {
        policy.workflow = "similar-case-search";
        policy.intent = "similar_cases";
        policy.searchScope = similarCaseSearchScope(message);
      },
      guidance(run) {
        return run.policy?.searchScope === "local"
          ? `${SIMILAR_CASE_GUIDANCE}\n${LOCAL_SEARCH_GUIDANCE}`
          : SIMILAR_CASE_GUIDANCE;
      },
      configure(ctx, { registry, workspace, run }) {
        let patient = null;
        try {
          patient = workspace.patientId ? ctx.services.patients?.row(workspace.patientId) : null;
        } catch {}
        configureSimilarCaseTools(registry, workspace, run, {
          identities: patientIdentityTerms(patient),
        });
      },
      prepared(workspace, runId) {
        const run = workspace?.runs?.find((item) => item.id === runId);
        if (run?.policy?.workflow !== "similar-case-search") return undefined;
        const artifact = run.artifacts?.find(
          (item) => item.type === "similar_cases",
        );
        if (
          !artifact ||
          run.inputs?.some(
            (input) =>
              input.createdAt >= new Date(artifact.createdAt).getTime(),
          )
        )
          return undefined;
        return {
          message: {
            role: "assistant",
            content: similarCaseAnswer(workspace, runId, { text: "" }).text,
          },
        };
      },
      answer(workspace, runId, result) {
        return similarCaseAnswer(workspace, runId, result);
      },
    },
  },
});
