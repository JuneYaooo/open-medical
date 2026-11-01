import { definePlugin } from "../../server/plugin-host/define.mjs";
import { ResearchService, researchTools } from "./server/research.mjs";
import { dictionarySummary, exportCohortCsv } from "./server/cohort-export.mjs";

const REPLY = (send, status, value) => {
  send(status, value);
  return true;
};

function createResearchApi(ctx) {
  const service = () => ctx.plugins["research-stats"]?.service || ctx.services.researchStats;
  return async function researchApi(req, url, io) {
    const parts = url.pathname.split("/").filter(Boolean);
    // 统计页顶部：本地患者库数据概况（只有计数）。
    if (req.method === "GET" && parts[2] === "dictionary-summary" && parts.length === 3)
      return REPLY(io.send, 200, dictionarySummary(ctx.services.patients));
    if (req.method !== "POST") return false;
    // 按队列比较的口径导出脱敏 CSV（假名、组别、年龄、性别、结局值）。
    if (parts[2] === "cohort-export" && parts.length === 3) {
      const input = await io.body();
      return REPLY(io.send, 200, exportCohortCsv(ctx.services.patients.all(), input?.comparison));
    }
    if (parts[2] === "profile" || parts[2] === "test" || parts[2] === "sample-size" || parts[2] === "deidentify") {
      const input = await io.body();
      if (parts[2] === "sample-size")
        return REPLY(io.send, 200, service().sampleSize(input));
      const sources = ctx.services.researchHost?.sourcesOf(input.sessionId) || [];
      if (parts[2] === "profile")
        return REPLY(io.send, 200, service().profile({ ...input, sources }));
      if (parts[2] === "test")
        return REPLY(io.send, 200, service().test({ ...input, sources }));
      return REPLY(io.send, 200, service().deidentify({ ...input, sources }));
    }
    return false;
  };
}

export default definePlugin({
  id: "research-stats",
  version: "1.0.0",
  title: "科研统计与脱敏导出",
  enabledByDefault: true,
  provides: { service: "research-stats", apiVersion: 1 },
  prompt: "./prompt.md",
  legacyApiPaths: [
    { method: "POST", path: "/api/research/*" },
    { method: "GET", path: "/api/research/dictionary-summary" },
  ],
  // 统计页「想研究什么问题」提交的上下文：说明数据来自本地患者库，
  // 并按 RESEARCH_GUIDANCE 的步骤做（标签含“科研统计”，会开启科研工具组）。
  contexts: {
    "research-stats-question": {
      sticky: true,
      guidance: () =>
        "医生从科研统计页提出研究问题，数据来源是本机患者库（不是会话里的 CSV）。按科研流程：先明确人群、比较组、结局和时间范围（不清楚时先问医生），用 research_data_dictionary 确认本地写法和单位，用 cohort_query 展示各组人数，再用 cohort_compare 计算；说明各组 n、缺失、检验方法、p 值、效应量与 95% CI 和警示。结果是探索性草稿，不换口径追求显著。",
    },
  },
  setup() {
    return new ResearchService();
  },
  tools(ctx, { registry }) {
    const service = ctx.plugins["research-stats"]?.service || ctx.services.researchStats;
    for (const plugin of researchTools(service).filter(
      (item) => item.definition.function.name !== "cohort_profile",
    ))
      registry.register({
        permission: "tools.execute",
        capability: plugin.capability || { backend: "local" },
        definition: plugin.definition,
        execute: plugin.execute,
      });
  },
  api: (ctx, req, url, io) => createResearchApi(ctx)(req, url, io),
});
