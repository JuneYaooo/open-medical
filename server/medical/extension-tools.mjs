// Chat tools that let the workbench grow: the agent writes the doctor's
// own skills and automation rules, previews them against real data and
// files a proposal; nothing takes effect before the doctor confirms.
// Disabling and rolling back are reversible, so they run directly.
const definition = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});
const text = { type: "string" };
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const boundedText = (maxLength) => ({ type: "string", minLength: 1, maxLength });
const SPEC = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: boundedText(60),
    description: boundedText(600),
    body: boundedText(20000),
    template: { type: "string", maxLength: 20000 },
    appliesTo: {
      description: "适用文书名称数组，例如 [\"出院小结草稿\"]；兼容单个名称字符串。",
      anyOf: [{ type: "array", items: boundedText(40), maxItems: 10 }, boundedText(40)],
    },
    quickTask: object({ title: boundedText(30), desc: { type: "string", maxLength: 80 }, prompt: boundedText(2000) }, ["prompt"]),
    trigger: object({
      type: { type: "string", enum: ["daily", "weekly", "lab", "appointment"] },
      time: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
      weekday: { type: "integer", minimum: 1, maximum: 7 },
      item: boundedText(40), daysBefore: { type: "integer", minimum: 0, maximum: 14 },
    }, ["type"]),
    condition: object({
      diagnosis: boundedText(60), tag: boundedText(60), group: boundedText(60),
      gender: { type: "string", enum: ["male", "female"] },
      ageMin: { type: "integer", minimum: 0, maximum: 130 },
      ageMax: { type: "integer", minimum: 0, maximum: 130 },
      lab: object({ item: boundedText(40), op: { type: "string", enum: ["gt", "gte", "lt", "lte", "eq"] }, value: { type: "number" } }, ["item", "op", "value"]),
    }),
    action: object({
      type: { type: "string", enum: ["agenda", "draft_message", "report"] },
      title: boundedText(60), detail: { type: "string", maxLength: 200 }, text: boundedText(1000),
    }, ["type"]),
  },
  description: [
    "skill 必填 name、description、body：{name, description（何时使用）, body（步骤、结构、措辞要求，Markdown）, template?（医院/科室模板原文）, appliesTo?（适用文书名称数组，如 [\"出院小结草稿\"]）, quickTask?{title, desc, prompt}（出现在首页快捷任务）}。",
    "automation：{name, trigger, condition, action}。",
    "trigger：{type:'daily', time:'08:00'} | {type:'weekly', weekday:1–7, time} | {type:'lab', item?} 新检验结果 | {type:'appointment', daysBefore:0–14}。",
    "condition（可省略=所有患者）：{diagnosis?, tag?, group?, gender?:'male'|'female', ageMin?, ageMax?, lab?:{item, op:'gt'|'gte'|'lt'|'lte'|'eq', value}}。",
    "action：{type:'agenda', title, detail?} 今日待办 | {type:'draft_message', text} 起草给患者的消息（仍需医生发送）| {type:'report', title} 每天/每周汇总。",
    "文字中可用占位符 {姓名} {检验} {数值} {日期} {复诊日期} {复诊事项}。",
  ].join(""),
};

export function extensionTools(getExtensions, pending) {
  const ext = () => {
    const service = getExtensions();
    if (!service) throw new Error("扩展中心未启用");
    return service;
  };
  return [
    {
      definition: definition("extension_list", "列出医生的工作台扩展：自建技能、自动化规则（含触发次数、完成/忽略统计），以及系统根据使用情况提出的进化建议和已自动做的调整。医生想定制、问「我设置过哪些规则」时先调用。"),
      execute: () => {
        const o = ext().overview();
        return { extensions: o.extensions.map((e) => ({ id: e.id, kind: e.kind, status: e.status, name: e.name, summary: e.summary, version: e.version, stats: e.stats })),
          suggestions: o.suggestions.map((s) => ({ id: s.id, title: s.title, evidence: s.evidence, prompt: s.prompt })), autoChanges: o.changes.slice(0, 5) };
      },
    },
    {
      definition: definition("extension_get", "读取一个扩展的当前内容和全部历史版本。修改前先读。", { id: text }, ["id"]),
      execute: ({ id }) => ext().detail(id),
    },
    {
      definition: definition("extension_preview", "试算一个技能或自动化规则：规则会用当前患者数据算出现在会产生哪些待办/消息（不真正执行），技能返回生成的说明文件。提交前先试算，并把结果告诉医生。", {
        kind: { type: "string", enum: ["skill", "automation"] }, spec: SPEC,
      }, ["kind", "spec"]),
      execute: ({ kind, spec }) => ext().preview(kind, spec),
    },
    {
      definition: definition("extension_propose", "提议新建或修改一个扩展（传 id 表示修改，会生成新版本）。医生的个性化要求——医院文书格式、写作习惯、质控必写项、定时提醒、检验阈值提醒、复诊前起草消息、定期汇总——都用它固化下来。只生成待确认提案，附试算结果；确认后才生效，可随时停用或回退。不能用它削弱红旗提醒、外发确认、知情同意等安全规则。", {
        id: text, kind: { type: "string", enum: ["skill", "automation"] }, spec: SPEC, reason: { type: "string", description: "医生的原话或进化建议的依据" }, suggestionId: { type: "string", description: "响应进化建议时填写" }, summary: text,
      }, ["kind", "spec"]),
      execute: ({ summary, ...payload }) => {
        const value = ext().normalizeProposal("ext-change", payload);
        return {
          ...pending.propose({ type: "ext-change", payload, summary: summary || `${value.id ? "修改" : "新建"}${value.kind === "skill" ? "技能" : "规则"}：${value.summary.slice(0, 60)}` }),
          preview: value.preview,
          note: "已生成待确认提案，附试算结果。请提醒医生在右下角「待确认」面板核对后确认；确认前不会生效。",
        };
      },
    },
    {
      definition: definition("extension_toggle", "停用或重新启用一个扩展（可随时恢复）。医生说「先别提醒了」「这个规则不要了」时调用。", { id: text, enabled: { type: "boolean" } }, ["id", "enabled"]),
      execute: ({ id, enabled }) => ext().setStatus(id, enabled ? "active" : "disabled"),
    },
    {
      definition: definition("extension_rollback", "把扩展恢复到某个历史版本（会生成一个新版本，原记录保留）。", { id: text, version: { type: "integer" } }, ["id", "version"]),
      execute: ({ id, version }) => ext().rollback(id, version),
    },
  ];
}
