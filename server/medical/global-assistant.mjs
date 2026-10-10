import { check, string } from "../errors.mjs";
import { scanPatients } from "./patient-scan.mjs";

// 全局聊天 Agent 的领域层：一个不关联单一患者的常驻会话，医生用一句话
// 跨模块操作工作台（查患者、自动分组、安排随访、检索知识库）。读取跨
// 患者放开，写入一律走待确认提案——与全产品「AI 不直写」底线一致。
export const GLOBAL_ASSISTANT_DISCIPLINE = `
你是医生工作台的全局助手：跨模块的常驻对话入口，没有关联单一患者，工具可以跨患者只读。医生用一句话查询患者、整理分组、安排随访、检索知识库。

工作方式：
- 查患者先用 list_patients 按姓名/编号/标签定位；同名患者要列出编号、性别、年龄让医生选择，不要猜。需要临床细节再 read_patient_chart。
- 「找出一批患者」的请求（如术后三个月内、血糖未达标、60 岁以上）先用 patient_scan 把意图转成结构化条件做确定性扫描，不要逐个患者核对；对扫描结果有疑问的患者再用 read_patient_chart 抽查。扫描没有覆盖的条件（如具体术式、并发症）如实说明，让医生补充。
- 一切写入只能通过 *_propose 工具生成待确认提案，由医生在「待确认」面板核对后生效。提案后如实告知已生成提案、等待确认，不得声称已完成。
- 分组提案（patient_grouping_propose）每位患者必须写明分组依据（来自扫描证据或档案事实）；没有依据的患者不列入，宁可少列也不凑数。分组名称用医生的原话，简洁明确。
- 知识库检索先 knowledge_collections 选适用库，再 knowledge_search 指定 collection；2–3 组短术语，英文原文用英文关键词。只有已读正文能支撑结论，证据不足直接说明缺口。
- 随访安排用 followup_create_propose（只提醒医生本人联系，不会给患者发消息）。
- 回答简短直接，先给结果再说过程；不确定就问。所有临床内容均为供医生复核的参考，不替代医生判断；不得编造患者数据、诊断或文献。`;

export const GLOBAL_ASSISTANT_GUIDANCE = `本轮是全局助手对话：先判断医生意图——查询类用只读工具直接回答；批量筛选或分组用 patient_scan 转结构化条件 → 逐人核对依据 → patient_grouping_propose 生成提案；随访安排用 followup_create_propose。写入操作只生成待确认提案并明确告知医生到「待确认」面板确认。普通问答直接回答，不额外创建草稿或提案。`;

// 花名册摘要注入系统提示，让助手不用首轮工具调用就知道患者规模和在用
// 分组，避免对空花名册或分组名做无意义检索。
export function rosterDigest(patients) {
  const summaries = patients.summaries();
  const active = summaries.filter((p) => !p.archived);
  const groups = new Map();
  for (const patient of active)
    for (const group of patient.groups || []) groups.set(group, (groups.get(group) || 0) + 1);
  const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([name, count]) => `${name}(${count})`).join("、");
  let due = 0;
  for (const counts of patients.allCounts().values()) due += counts.dueFollowups;
  return `花名册：${active.length} 位在管患者${summaries.length !== active.length ? `（另有 ${summaries.length - active.length} 位已归档）` : ""}${top ? `；在用分组：${top}` : "；尚无分组"}；到期随访 ${due} 个。`;
}

const JSON_SCHEMA_DECL = { type: "object", additionalProperties: false };

export function configureGlobalAssistantTools(
  registry,
  workspace,
  run,
  {
    patients,
    pending,
    brief,
    followups,
    sessionPlugins = [],
    dispatch = null,
  },
) {
  const register = (name, description, parameters, execute, { readOnly = false } = {}) =>
    registry.register({
      permission: "tools.execute",
      capability: { backend: "local" },
      definition: {
        type: "function",
        function: { name, description, parameters: { ...JSON_SCHEMA_DECL, properties: parameters.properties || {}, required: parameters.required || [] } },
      },
      execute: async (args) => {
        const result = await execute(args);
        return readOnly ? { ...result, readOnly: true } : result;
      },
    });

  register(
    "list_patients",
    "按姓名、编号、电话或标签搜索患者列表，返回身份摘要（含分组、标签、在管事项计数）。用于把医生提到的患者名解析为患者编号；同名患者返回多条供医生选择。",
    {
      properties: {
        query: { type: "string", description: "姓名/编号/电话/标签关键词" },
        group: { type: "string", description: "按分组过滤" },
      },
    },
    async (args) => {
      const list = patients.list({
        ...(args.query ? { query: args.query } : {}),
        ...(args.group ? { group: args.group } : {}),
        summary: true,
        includeArchived: true,
      });
      return {
        total: list.length,
        patients: list.slice(0, 50).map((p) => ({
          id: p.id,
          name: p.name,
          patientNumber: p.patientNumber || "",
          gender: p.gender || "unknown",
          ...(p.birthYear ? { birthYear: p.birthYear } : {}),
          groups: p.groups || [],
          tags: p.tags || [],
          archived: Boolean(p.archived),
          counts: p.counts,
        })),
        truncated: list.length > 50,
      };
    },
    { readOnly: true },
  );

  register(
    "read_patient_chart",
    "只读任意患者的档案速览：诊断、用药、过敏、近期检验、随访与联系记录、信息缺口。与患者工作区的简报同一来源；不能写入。",
    { properties: { patientId: { type: "string" } }, required: ["patientId"] },
    async (args) => ({ ...brief(string(args.patientId, "患者编号", 100)), sourceType: "patient-chart" }),
    { readOnly: true },
  );

  register(
    "patient_scan",
    "按结构化条件确定性扫描全部在管患者，返回命中名单与逐人依据（诊断/检验/就诊原文事实）。用于「找出一批患者」：如术后 N 天内（diagnosisContains=术后 + diagnosisWithinDays）、检验不达标（lab 阈值）、年龄段、性别、标签。不调用模型、不修改数据。",
    {
      properties: {
        diagnosisContains: { type: "string", description: "诊断名称包含的关键词" },
        diagnosisWithinDays: { type: "integer", description: "诊断日期在最近 N 天内" },
        visitReasonContains: { type: "string", description: "就诊事由包含的关键词" },
        visitWithinDays: { type: "integer", description: "就诊日期在最近 N 天内" },
        lab: {
          type: "object",
          properties: {
            item: { type: "string", description: "检验项目关键词，如 HbA1c" },
            op: { type: "string", enum: [">", "<", ">=", "<="] },
            value: { type: "number" },
            withinDays: { type: "integer" },
          },
          required: ["item", "op", "value"],
          additionalProperties: false,
        },
        tag: { type: "string" },
        group: { type: "string" },
        gender: { type: "string", enum: ["male", "female", "unknown"] },
        ageMin: { type: "integer" },
        ageMax: { type: "integer" },
      },
    },
    async (args) => scanPatients(patients, args),
    { readOnly: true },
  );

  register(
    "followups_overview",
    "只读全部患者的在管随访计划概览（按下次到期时间排序）：患者、计划名、频率、状态、到期时间。",
    { properties: { limit: { type: "integer", description: "返回条数，默认 50" } } },
    async (args) => {
      const limit = args.limit === undefined ? 50 : args.limit;
      check(Number.isInteger(limit) && limit >= 1 && limit <= 200, "INVALID_INPUT", "limit 须为 1–200");
      return { followups: followups.overview({ limit }) };
    },
    { readOnly: true },
  );

  register(
    "patient_grouping_propose",
    "提议把一批患者加入某个分组（每位患者附分组依据）。只创建待确认提案，医生在「待确认」面板核对确认后才会写入患者分组；依据必须来自 patient_scan 证据或已读取的档案事实。",
    {
      properties: {
        groupName: { type: "string", description: "分组名称，用医生原话，简洁明确" },
        patients: {
          type: "array",
          description: "患者列表，每项含 patientId 与分组依据",
          items: {
            type: "object",
            properties: {
              patientId: { type: "string" },
              reason: { type: "string", description: "该患者加入分组的依据（扫描证据或档案事实）" },
            },
            required: ["patientId", "reason"],
            additionalProperties: false,
          },
        },
        note: { type: "string", description: "给医生的补充说明" },
      },
      required: ["groupName", "patients"],
    },
    async (args) => {
      const result = pending.propose({
        type: "patient-grouping",
        payload: {
          groupName: args.groupName,
          patients: args.patients,
          ...(args.note ? { note: args.note } : {}),
          sourceSessionId: workspace.id,
        },
        summary: `建议分组「${args.groupName}」：${args.patients.length} 位患者`,
      });
      return result;
    },
  );

  // 复用会话插件里的知识库与随访提案工具（同一定义与执行契约）。
  if (dispatch) {
    for (const plugin of sessionPlugins) {
      const name = plugin.definition.function.name;
      if (!["knowledge_collections", "knowledge_search", "followup_create_propose"].includes(name)) continue;
      registry.register({
        permission: "tools.execute",
        capability: plugin.capability,
        definition: plugin.definition,
        execute: (args) => dispatch(name, args),
      });
    }
  }
}
