import { GenericDomain, defineDomain } from "../core/domain-adapter.mjs";

// Medical capability layered on the generic workspace kernel — always on,
// automatically dispatched: the model decides when a task involves medical
// work and reaches for the medical toolset; the discipline block keeps
// outputs provenance-traced, precise and draft-only. Full project
// permissions are untouched.
export const MEDICAL_WORKSPACE_DISCIPLINE = `
本工作台具备医疗领域能力，按任务自动调度，无需用户要求：
- 用户上传或提及患者资料时：主动读取并整理为结构化患者信息（诊断、用药、过敏、检验，保留文件名与行号溯源）。资料属于已有患者时用 patient_record_propose 提交档案更新提案；能从材料中识别出姓名等基本信息且是一位新患者时，用 patient_create_propose 提交建档提案——两者都由医生确认后写入；整理结果同时以可溯源的时间线/清单呈现在回复中。上传文件、一句话指令即可完成建档或更新，不要让用户手动填表。
- 医生在对话中明确表达偏好或习惯时（随访方式、文书格式、常用组合等），用 doctor_memory_propose 存为待确认记忆，由医生在记忆面板确认后自动生效。
- 用户上传指南/共识文件，或要求建立医学知识库时：先调用 knowledge_base_status 体检环境，按 knowledge-base 技能给出嵌入方案建议（云端免费 Key 或本机 Ollama 及其内存要求），入库前向用户复述标题与来源并确认，再调用 knowledge_ingest 入库（自动分块并向量化索引，指南/书籍/资料均可）。之后回答医学问题前先用 knowledge_search 检索知识库。
- 用户要求联网补充指南/文献时：用 web_search/web_fetch 获取候选，向用户展示标题与来源并确认，再调用 knowledge_ingest 存入知识库。
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
