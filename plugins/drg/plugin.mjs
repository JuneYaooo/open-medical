import { definePlugin } from "../../server/plugin-host/define.mjs";
import { DrgService, drgTools } from "./server/drg.mjs";

const REPLY = (send, status, value) => {
  send(status, value);
  return true;
};

function createDrgApi(ctx) {
  const service = () => ctx.plugins.drg?.service;
  return async function drgApi(req, url, io) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "drg") return false;
    const drg = service();
    await drg.load();
    if (parts.length === 3 && parts[2] === "group" && req.method === "POST")
      return REPLY(io.send, 200, await drg.group(await io.body()));
    if (parts.length === 3 && parts[2] === "batch" && req.method === "POST")
      return REPLY(io.send, 200, await drg.batchAnalyze(await io.body()));
    if (parts.length === 3 && parts[2] === "settings") {
      if (req.method === "GET") return REPLY(io.send, 200, drg.settings());
      if (req.method === "POST")
        return REPLY(io.send, 200, drg.updateSettings(await io.body()));
    }
    if (parts.length === 3 && parts[2] === "import" && req.method === "POST")
      return REPLY(
        io.send,
        200,
        drg.importWeights((await io.body()).weights),
      );
    return false;
  };
}

export default definePlugin({
  id: "drg",
  version: "1.0.0",
  title: "DRG 示例测算",
  // 私域与诊所患者管理的非核心场景：新安装默认关闭，可在设置中开启；
  // 升级用户保持原有开启状态。
  enabledByDefault: false,
  keepEnabledOnUpgrade: true,
  provides: { service: "drg", apiVersion: 1 },
  legacyApiPaths: [{ method: "*", path: "/api/drg/*" }],
  setup(ctx) {
    const service = new DrgService(ctx.store);
    service.load().catch(() => {});
    return service;
  },
  tools(ctx, { registry }) {
    const service = ctx.plugins.drg?.service;
    for (const plugin of drgTools(service))
      registry.register({
        permission: "tools.execute",
        capability: plugin.capability || { backend: "local" },
        definition: plugin.definition,
        execute: plugin.execute,
      });
  },
  api: (ctx, req, url, io) => createDrgApi(ctx)(req, url, io),
});
