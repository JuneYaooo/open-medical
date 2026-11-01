import { fileURLToPath } from "node:url";
import { definePlugin } from "../../server/plugin-host/define.mjs";
import { check, identifier } from "../../server/errors.mjs";
import { sqliteTransaction } from "../../server/sqlite-transaction.mjs";
import { createCarePackService, loadPacks } from "./server/service.mjs";

const PACK_DIR = fileURLToPath(new URL("./packs", import.meta.url));
const serviceOf = (ctx) => ctx.plugins["care-packs"].service;
const text = { type: "string" };
const tool = (name, description, properties, required, execute) => ({
  permission: "tools.execute",
  capability: { backend: "local" },
  definition: {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
  },
  execute,
});
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

function proposeApply(ctx, { patientId, packId, startDate, summary }) {
  const pack = serviceOf(ctx).get(packId);
  return ctx.proposals.create({
    kind: "care-packs.apply",
    patientId,
    input: { patientId, packId, startDate },
    summary: summary || `为患者应用「${pack.name}」：${pack.plan.nodes.length} 个随访节点、${(pack.labMonitors || []).length} 项检验监测，从 ${startDate} 开始`,
  });
}

// 专病管理包：一个病种的随访计划 + 问卷 + 检验监测阈值 + 患教素材，装上即可管理
// 一类患者。内容是 packs/*.json，新增病种不需要改代码。
export default definePlugin({
  id: "care-packs",
  version: "1.0.0",
  title: "专病管理包",
  enabledByDefault: true,
  requires: { plugins: { followup: "*" } },
  provides: { service: "care-packs", apiVersion: 1 },
  prompt: "./prompt.md",
  skills: "./skills",
  setup(ctx) {
    return createCarePackService({
      packs: loadPacks(PACK_DIR),
      followups: () => ctx.plugins.followup.service.followups,
      // risk-rules is optional and may set up after this plugin, so resolve
      // it on use instead of reading the setup-time snapshot.
      riskRules: () => {
        try { return ctx.service("risk-rules"); } catch { return null; }
      },
      guidelines: ctx.services.guidelines || null,
    });
  },
  tools(ctx, { registry }) {
    registry.register(tool(
      "care_pack_list",
      "只读列出专病管理包（如高血压、2 型糖尿病）：适用病种、随访节点与问卷、检验监测阈值、患教素材，以及是否已安装。",
      {},
      [],
      () => ({ packs: serviceOf(ctx).list(), readOnly: true }),
    ));
    registry.register(tool(
      "care_pack_apply_propose",
      "提议把一个专病管理包应用到患者：按包里的节点生成一年随访（带问卷的节点到期生成问卷），并加上包里的检验监测阈值（已有同项目同方向的监测不重复）。只创建待确认提案，医生确认后生效。",
      { patientId: text, packId: text, startDate: { type: "string", description: "YYYY-MM-DD，一般为本次就诊或开始治疗日期" }, summary: text },
      ["patientId", "packId", "startDate"],
      (args) => proposeApply(ctx, args),
    ));
  },
  proposals: {
    "care-packs.apply": {
      revisionScoped: true,
      validate(input, ctx) {
        check(input && typeof input === "object", "INVALID_INPUT", "参数无效");
        identifier(input.patientId);
        serviceOf(ctx).get(input.packId);
        check(isDate(input.startDate), "INVALID_INPUT", "开始日期须为 YYYY-MM-DD");
        return { patientId: input.patientId, packId: input.packId, startDate: input.startDate };
      },
      apply(input, ctx) {
        return serviceOf(ctx).apply(input.patientId, input.packId, input.startDate);
      },
    },
  },
  async api(ctx, req, url, io) {
    const parts = url.pathname.split("/").filter(Boolean); // api p care-packs packs [id] [action]
    if (parts[0] !== "api" || parts[1] !== "p" || parts[2] !== "care-packs" || parts[3] !== "packs") return false;
    const service = serviceOf(ctx);
    if (parts.length === 4 && req.method === "GET") {
      io.send(200, { packs: service.list() });
      return true;
    }
    if (parts.length === 6 && parts[5] === "install" && req.method === "POST") {
      io.send(200, await service.install(parts[4]));
      return true;
    }
    if (parts.length === 6 && parts[5] === "monitors" && req.method === "POST") {
      const input = await io.body();
      io.send(200, sqliteTransaction(ctx.db, () => service.addMonitors(input?.patientId, parts[4])));
      return true;
    }
    if (parts.length === 6 && parts[5] === "apply" && req.method === "POST") {
      const input = await io.body();
      check(isDate(input?.startDate), "INVALID_INPUT", "开始日期须为 YYYY-MM-DD");
      io.send(201, { proposal: proposeApply(ctx, { patientId: input.patientId, packId: parts[4], startDate: input.startDate }) });
      return true;
    }
    return false;
  },
});
