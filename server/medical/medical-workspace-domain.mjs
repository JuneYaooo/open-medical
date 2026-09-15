import { GenericDomain, defineDomain } from "../core/domain-adapter.mjs";

// Medical capability layered on the generic workspace kernel — always on,
// automatically dispatched: the model decides when a task involves medical
// work and reaches for the medical toolset; the discipline block keeps
// outputs provenance-traced, precise and draft-only. Full project
// permissions are untouched.
export const MEDICAL_WORKSPACE_DISCIPLINE = `
本工作台具备医疗领域能力，按任务自动调度，无需用户要求：
- 用户上传或提及患者资料时：主动读取并整理为结构化患者信息（诊断、用药、过敏、检验，保留文件名与行号溯源），用 patient_record_propose 提交档案存储提案，由医生确认后写入患者档案；整理结果同时以可溯源的时间线/清单呈现在回复中。
- 用户上传指南/共识文件，或要求建立医学知识库时：先调用 knowledge_base_status 体检环境，按 knowledge-base 技能给出嵌入方案建议（云端免费 Key 或本机 Ollama 及其内存要求），入库前向用户复述标题与来源并确认，再调用 guideline_ingest 入库（自动分块并向量化索引）。之后回答医学问题前先用 guideline_search 检索知识库。
- 用户要求联网补充指南/文献时：用 web_search/web_fetch 获取候选，向用户展示标题与来源并确认，再调用 guideline_ingest 存入知识库。
- 医学问题先查知识库与文献工具取事实；所有医学结论性输出为待专业医生复核的草稿，引用必须带来源（文档名、页码或行号），不编造。`;

export function createMedicalWorkspaceDomain({ plugins }) {
  return defineDomain({
    // Keeps the generic kernel identity: same execution limits, same
    // context management, full project permissions.
    id: "generic",
    system: `${GenericDomain.system}\n${MEDICAL_WORKSPACE_DISCIPLINE}`,
    limits: GenericDomain.limits,
    contextManagement: true,
    allowAutoFileWrites: true,
    registerTools: ({ registry }) => {
      for (const plugin of plugins)
        registry.register({
          permission: "tools.execute",
          definition: plugin.definition,
          execute: plugin.execute,
        });
    },
  });
}
