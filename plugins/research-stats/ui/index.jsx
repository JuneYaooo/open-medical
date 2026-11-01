import { defineUiPlugin } from "../../../src/plugin-slots.jsx";

export default defineUiPlugin({
  id: "research-stats",
  slots: {
    legacyViews: {
      "data-analysis": () => import("./ResearchView.jsx").then((module) => ({ default: module.ResearchView })),
    },
    "chat.resultCards": {
      cohort_comparison: {
        label: "查看队列比较",
        component: () => import("./CohortComparison.jsx").then((module) => ({ default: module.CohortComparison })),
      },
    },
    "tools.directory": [
      {
        id: "data-analysis",
        label: "科研统计",
        order: 90,
        meta: {
          name: "科研统计",
          description: "用一句话提出研究问题，助手从本地患者库建队列并做统计；也可上传 CSV 自行分析。",
          category: "科研",
          keywords: "数据分析 统计学 CSV 队列 组间比较 科研",
          medical: true,
        },
        component: () => import("./ToolCard.jsx"),
      },
    ],
  },
});
