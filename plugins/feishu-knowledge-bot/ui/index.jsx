import { defineUiPlugin } from "../../../src/plugin-slots.jsx";

export default defineUiPlugin({
  id: "feishu-knowledge-bot",
  slots: {
    "settings.panels": [
      {
        id: "knowledge-bot",
        label: "飞书分身",
        order: 20,
        legacyTab: "knowledge-bot",
        component: () => import("./FeishuKnowledgeBotSettings.jsx"),
      },
    ],
  },
});
