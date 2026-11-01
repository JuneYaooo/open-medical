import { defineUiPlugin } from "../../../src/plugin-slots.jsx";

export default defineUiPlugin({
  id: "trials",
  slots: {
    legacyViews: {
      research: () =>
        import("./TrialScreeningView.jsx").then((module) => ({
          default: module.TrialScreeningView,
        })),
    },
    "patient.tabs": [
      {
        id: "trials",
        label: "可能适合的试验",
        order: 90,
        area: "record",
        component: () => import("./PatientTrialsTab.jsx"),
      },
    ],
    "proposal.renderers": {
      "trial-screening-conditions": () => import("./TrialProposal.jsx"),
      "trial-protocol": () => import("./TrialProposal.jsx"),
    },
    "tools.directory": [
      {
        id: "research",
        label: "临床试验",
        order: 60,
        meta: {
          name: "临床试验",
          description: "管理试验方案，按入排标准开展患者初筛。",
          category: "科研",
          keywords: "试验 入组 入排",
          medical: true,
        },
        component: () => import("./ToolCard.jsx"),
      },
    ],
  },
});
