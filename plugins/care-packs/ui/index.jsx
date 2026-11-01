import { defineUiPlugin } from "../../../src/plugin-slots.jsx";

export default defineUiPlugin({
  id: "care-packs",
  slots: {
    "settings.panels": [
      {
        id: "care-packs",
        label: "专病管理包",
        order: 45,
        legacyTab: "care-packs",
        component: () => import("./CarePacksSettings.jsx"),
      },
    ],
  },
});
