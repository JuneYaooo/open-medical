import { GenericDomain, defineDomain } from "../core/domain-adapter.mjs";
import { TOOL_DEFINITIONS, runTool } from "../medical-core.mjs";

// Medical capability layered on the generic workspace kernel — on demand,
// never by default for ordinary projects:
// - session-kind workspaces (home/patient sessions of the medical app) are
//   medical by construction and keep the full discipline;
// - project workspaces carry the medical layer only after an explicit,
//   explainable opt-in (creation with domain:"medical" or the runtime
//   domain switch), persisted as modeFlags.medical on the workspace record.
// With the layer on, the model auto-dispatches medical work (patient
// materials -> provenance-traced proposals; guideline files -> RAG knowledge
// base). Full project permissions are untouched either way.
export const MEDICAL_WORKSPACE_DISCIPLINE = `
本工作台具备医疗领域能力，按任务自动调度，无需用户要求：
- 用户上传或提及患者资料时：主动读取并整理为结构化患者信息（诊断、用药、过敏、检验，保留文件名与行号溯源）。资料属于已有患者时用 patient_record_propose 提交档案更新提案；能从材料中识别出姓名等基本信息且是一位新患者时，用 patient_create_propose 提交建档提案——两者都由医生确认后写入；整理结果同时以可溯源的时间线/清单呈现在回复中。上传文件、一句话指令即可完成建档或更新，不要让用户手动填表。
- 医生在对话中明确表达偏好或习惯时（随访方式、文书格式、常用组合等），用 doctor_memory_propose 存为待确认记忆，由医生在记忆面板确认后自动生效。
- 用户上传指南/共识文件，或要求建立医学知识库时：先调用 knowledge_base_status 体检环境，按 knowledge-base 技能给出嵌入方案建议（云端免费 Key 或本机 Ollama 及其内存要求），入库前向用户复述标题与来源并确认，再调用 knowledge_ingest 入库（自动分块并向量化索引，指南/书籍/资料均可）。之后回答医学问题前先用 knowledge_search 检索知识库。
- 用户要求联网补充指南/文献时：用 web_search/web_fetch 获取候选，向用户展示标题与来源并确认，再调用 knowledge_ingest 存入知识库。
- 医学问题先查知识库与文献工具取事实；所有医学结论性输出为待专业医生复核的草稿，引用必须带来源（文档名、页码或行号），不编造。

本会话是医疗工作会话：先判断这轮输入是「问答咨询」还是「资料整理/文书生成」。问答咨询（如"血糖有点高怎么办"）直接回答，用工具补充依据并在结尾提醒具体诊疗请咨询医生；资料整理先 list_skills/read_skill 选择技能模板，再调用时间线（extract_clinical_timeline）、检验摘录（extract_observations）、用药核对（review_medication_safety）、循证规划（build_evidence_question）等工具产出可追溯草稿。消息中以 @技能名 固定技能时先 read_skill 再按其执行。只使用用户提供的材料和工具返回的来源；不得编造文献、指南或病历内容。`;

// 单一判定点：会话型工作区（医疗应用首页/患者会话）始终医疗；普通项目
// 只有显式打开 modeFlags.medical 后才叠加医疗层。systemFor 与
// registerTools 共用同一谓词，系统指令和工具面不可能出现半开状态。
// modeFlags 经 WorkspaceService.setModeFlag 写入：执行期间禁止切换并留
// 有审计事件；contextIdentity 包含 systemFor 输出，切换即失效旧运行
// 检查点的复用（不跨纪律混用上下文）。
export function medicalWorkspaceEnabled(workspace) {
  return (
    workspace?.kind === "session" || workspace?.modeFlags?.medical === true
  );
}

export function createMedicalWorkspaceDomain({
  plugins = [],
  sessionPlugins = [],
  skills = null,
  doctor = null,
} = {}) {
  // 会话叠层的插件经 runTool 统一分发：材料 sources、schema 校验与
  // readOnly 约定和医疗会话路径共用同一执行契约。
  const sessionPluginMap = new Map(
    sessionPlugins.map((plugin) => [plugin.definition.function.name, plugin]),
  );
  return defineDomain({
    // Keeps the generic kernel identity: same execution limits, same
    // context management, full project permissions.
    id: "generic",
    system: `${GenericDomain.system}\n${MEDICAL_WORKSPACE_DISCIPLINE}`,
    // 按需分层：未启用医疗的工作区（普通项目）只带通用内核指令，
    // 不注入医疗纪律文本。
    systemFor(workspace) {
      return medicalWorkspaceEnabled(workspace)
        ? `${GenericDomain.system}\n${MEDICAL_WORKSPACE_DISCIPLINE}`
        : GenericDomain.system;
    },
    limits: GenericDomain.limits,
    contextManagement: true,
    allowAutoFileWrites: true,
    // 会话型工作区：注入医生偏好摘要、策略、固定技能与材料索引。
    runSystemExtras(workspace, run, handle) {
      if (workspace.kind !== "session") return [];
      const sources = handle?.sources || [];
      const manifest = sources.map((s) => ({
        id: s.id,
        name: s.name,
        lines: s.text.split("\n").length,
        hash: s.hash,
        ...(sources.length <= 8 ? { preview: s.text.slice(0, 1000) } : {}),
      }));
      return [
        doctor?.digest(),
        `可用技能：${JSON.stringify(skills?.list() || [])}`,
        run.pinnedSkills?.length
          ? `用户通过 @ 明确固定了技能：${JSON.stringify(run.pinnedSkills)}。先 read_skill 阅读这些技能并按其执行，无需再自行选择模板。`
          : "",
        run.policy ? `策略：${JSON.stringify(run.policy)}` : "",
        sources.length
          ? `本次材料索引（可用工具读取全文）：${JSON.stringify(manifest)}\n选中材料已建立可检索索引：语义检索用 semantic_material_search，关键词检索用 search_materials，按行读原文用 read_source。检索工具未返回不代表材料中没有相关内容。`
          : "",
      ].filter(Boolean);
    },
    registerTools: ({ registry, workspace }) => {
      // 会话叠层：医疗核心工具 + 全部医疗插件走 runTool 分发；项目
      // 工作区在显式启用医疗后直注插件（知识库/提案工具），普通项目
      // 保持纯通用工具面。
      if (workspace.kind === "session") {
        // runTool 按 definitions 校验参数并分发插件：必须同时包含核心与插件。
        const sessionDefinitions = [
          ...TOOL_DEFINITIONS,
          ...sessionPlugins.map((plugin) => plugin.definition),
        ];
        const execute = (name, args, context) =>
          runTool(name, args, {
            sources: context.sources || [],
            skills,
            definitions: sessionDefinitions,
            plugins: sessionPluginMap,
          });
        for (const definition of TOOL_DEFINITIONS)
          registry.register({
            permission: "tools.execute",
            definition,
            execute: (args, context) =>
              execute(definition.function.name, args, context),
          });
        // 插件定义必须注册进 registry，模型才能发现并调用；
        // 执行仍经 runTool（材料 sources、schema 校验、provenance）。
        for (const plugin of sessionPlugins)
          registry.register({
            permission: "tools.execute",
            definition: plugin.definition,
            execute: (args, context) =>
              execute(plugin.definition.function.name, args, context),
          });
        return;
      }
      if (!medicalWorkspaceEnabled(workspace)) return;
      for (const plugin of plugins)
        registry.register({
          permission: "tools.execute",
          definition: plugin.definition,
          execute: plugin.execute,
        });
    },
  });
}
