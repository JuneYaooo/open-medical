import { GenericDomain, defineDomain } from "../core/domain-adapter.mjs";

// Medical capability layered on the generic workspace kernel. The domain
// keeps the generic identity and full project permissions; when a workspace
// enables the medical mode flag it gains the medical toolset and a
// provenance/precision discipline block in the system prompt.
export const MEDICAL_WORKSPACE_DISCIPLINE = `
本工作区已开启医疗能力。涉及患者材料或医学问题时适用以下纪律：
- 医学结论性输出一律为待专业医生复核的草稿；不得输出替代医生判断的最终诊疗结论。
- 引用指南、文献、病历或检验内容必须标注来源（文档名、页码或行号）；工具没返回的事实不得编造。
- 数值保留原始精度与单位；保留"疑似""考虑""待确认"等限定词，不把描述升级为确定结论。
- 优先用医疗工具取事实：literature_search（文献）、guideline_search（指南）、medical_scale_calculate（量表）、lab_knowledge_search（检验意义）、assess_adverse_reaction（不良反应筛查）、medication_safety_check（用药核查）、similar_case_search（相似病例）。工具查不到就如实说明。
- 用药与检验数据涉及具体患者时，建议用 patient_record_propose 提交档案变更提案，由医生确认后写入。`;

export function createMedicalWorkspaceDomain({ plugins }) {
  return defineDomain({
    // Keeps the generic kernel identity: same execution limits, same
    // context management, full project permissions.
    id: "generic",
    system: GenericDomain.system,
    limits: GenericDomain.limits,
    contextManagement: true,
    allowAutoFileWrites: true,
    systemFor: (workspace) =>
      workspace?.modeFlags?.medical
        ? `${GenericDomain.system}\n${MEDICAL_WORKSPACE_DISCIPLINE}`
        : GenericDomain.system,
    registerTools: ({ registry, workspace }) => {
      if (!workspace?.modeFlags?.medical) return;
      for (const plugin of plugins)
        registry.register({
          permission: "tools.execute",
          definition: plugin.definition,
          execute: plugin.execute,
        });
    },
  });
}
