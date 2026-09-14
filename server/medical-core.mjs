import { randomUUID, createHash } from "node:crypto";
import { check, string } from "./errors.mjs";
export { medicalPolicy } from "../shared/medical.mjs";

const fn = (name, description, properties, required = []) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  },
});
const text = { type: "string" },
  texts = { type: "array", items: text };
export const TOOL_DEFINITIONS = [
  fn("list_skills", "列出当前工作台可用的医疗技能。", {}, []),
  fn(
    "read_skill",
    "读取一个医疗技能的说明；技能文本是工作规则，不是工具权限。",
    { skillId: text },
    ["skillId"],
  ),
  fn(
    "extract_clinical_timeline",
    "按日期抽取当前会话的原文片段，附来源和行号，不推断诊断。",
    {},
    [],
  ),
  fn(
    "extract_observations",
    "提取原文数值和单位，不推断参考范围或异常结论。",
    {},
    [],
  ),
  fn(
    "search_materials",
    "在当前会话资料内检索，返回原文和来源行号。不是互联网检索。",
    { query: text },
    ["query"],
  ),
  fn(
    "read_source",
    "读取当前会话指定资料的行区间。",
    {
      sourceId: text,
      startLine: { type: "integer" },
      endLine: { type: "integer" },
    },
    ["sourceId", "startLine", "endLine"],
  ),
  fn(
    "build_evidence_question",
    "生成待审核的 PICO 和 PubMed 检索式，不声称已经检索文献。",
    { population: text, intervention: text, comparison: text, outcome: text },
    ["population", "intervention", "comparison", "outcome"],
  ),
  fn(
    "review_medication_safety",
    "按材料生成药品核对和缺失信息清单，不给剂量建议、不判断相互作用。",
    {},
    [],
  ),
  fn(
    "build_workflow",
    "生成医疗工作流程草稿。",
    { title: text, steps: texts },
    ["title", "steps"],
  ),
  fn(
    "make_review_checklist",
    "生成专业人员复核的条目草稿。",
    { title: text, items: texts },
    ["title", "items"],
  ),
  fn(
    "draft_treatment_review",
    "基于当前材料生成治疗方案参考意见草稿：现状摘要、需关注点、信息缺口、建议医生核对的问题。不给出剂量或处方建议，结果待复核。",
    {
      summary: text,
      concerns: texts,
      infoGaps: texts,
      questions: texts,
    },
    ["summary", "concerns", "infoGaps", "questions"],
  ),
];
export function sourcesFor(session, userMessage) {
  return [
    ...session.files.map((f) => ({
      id: f.id,
      name: f.name,
      text: f.text,
      hash: f.hash,
      extraction: f.extraction,
    })),
    {
      id: userMessage.id,
      name: "本轮输入",
      text: userMessage.content,
      hash: createHash("sha256").update(userMessage.content).digest("hex"),
    },
  ];
}
function sourceLines(sources) {
  return sources.flatMap((s) => {
    let page;
    return s.text.split(/\r?\n/).map((quote, i) => {
      const marker =
        s.extraction?.type === "pdf_text" &&
        quote.match(/^\[PDF 第 (\d+) 页\]$/);
      if (marker) page = Number(marker[1]);
      return {
        sourceId: s.id,
        sourceName: s.name,
        line: i + 1,
        quote,
        hash: s.hash,
        ...(page ? { page } : {}),
      };
    });
  });
}
function artifact(type, title, body) {
  return {
    id: randomUUID(),
    type,
    title,
    status: "draft",
    version: 1,
    createdAt: new Date().toISOString(),
    provenance: "local_rule",
    ...body,
  };
}
export function runTool(
  name,
  args = {},
  {
    sources = [],
    skills,
    definitions = TOOL_DEFINITIONS,
    plugins = new Map(),
  } = {},
) {
  const def = definitions.find((t) => t.function.name === name);
  check(def, "UNKNOWN_TOOL", `未授权的工具：${name}`);
  check(
    args && typeof args === "object" && !Array.isArray(args),
    "INVALID_TOOL_ARGS",
    "工具参数必须为对象",
  );
  const schema = def.function.parameters;
  for (const key of Object.keys(args))
    check(
      Object.hasOwn(schema.properties, key),
      "INVALID_TOOL_ARGS",
      `未声明的参数：${key}`,
    );
  for (const key of schema.required)
    check(
      Object.hasOwn(args, key),
      "INVALID_TOOL_ARGS",
      `缺少工具参数：${key}`,
    );
  for (const [key, value] of Object.entries(args)) {
    const type = schema.properties[key].type;
    if (type === "string") string(value, key, 6000);
    if (type === "integer")
      check(
        Number.isInteger(value) && value > 0,
        "INVALID_TOOL_ARGS",
        `${key} 必须是正整数`,
      );
    if (type === "array") {
      check(
        Array.isArray(value) && value.length <= 40,
        "INVALID_TOOL_ARGS",
        `${key} 需要最多 40 条条目`,
      );
      value.forEach((v) => string(v, key, 2000));
    }
  }
  if (name === "list_skills") {
    check(skills, "SKILL_NOT_CONFIGURED", "技能注册表未配置", 503);
    return { skills: skills.list(), readOnly: true };
  }
  if (name === "read_skill") {
    check(skills, "SKILL_NOT_CONFIGURED", "技能注册表未配置", 503);
    const skill = skills.get(args.skillId);
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      instructions: skill.body,
      readOnly: true,
    };
  }
  if (plugins.has(name)) {
    const result = plugins
      .get(name)
      .execute(args, {
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          hash: s.hash,
          text: s.text,
        })),
      });
    check(
      result && typeof result === "object" && !Array.isArray(result),
      "PLUGIN_RESULT",
      "医疗插件必须返回对象",
      502,
    );
    check(
      JSON.stringify(result).length <= 120000,
      "PLUGIN_RESULT",
      "医疗插件结果过大",
      502,
    );
    return { ...result, provenance: result.provenance || "plugin_draft" };
  }
  const lines = sourceLines(sources).filter((l) => l.quote.trim());
  if (name === "read_source") {
    const source = sources.find((s) => s.id === args.sourceId);
    check(source, "SOURCE_NOT_FOUND", "只能读取当前会话中的资料");
    check(
      args.endLine >= args.startLine && args.endLine - args.startLine < 100,
      "INVALID_TOOL_ARGS",
      "单次最多读取 100 行",
    );
    return {
      sourceId: source.id,
      name: source.name,
      lines: sourceLines([source]).filter(
        (l) => l.line >= args.startLine && l.line <= args.endLine,
      ),
      readOnly: true,
    };
  }
  if (name === "search_materials") {
    const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = lines
      .filter((l) => terms.some((term) => l.quote.toLowerCase().includes(term)))
      .slice(0, 30);
    return artifact("source_search", "材料检索结果", {
      query: args.query,
      matches,
      scope: "当前会话材料；未检索外部文献",
    });
  }
  if (name === "extract_observations") {
    const observations = [];
    const measurement =
      /(?<![A-Za-z])(Hb|血红蛋白|肌酐|血糖|血钾|血钠|ALT|AST|eGFR|CRP|血小板|白细胞)\s*[:：]?\s*([<>≤≥]?\s*[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*(g\/L|g\/dL|mg\/dL|mmol\/L|[μu]mol\/L|U\/L|mL\/min(?:\/1\.73m[²2])?|10[⁹9]\/L|×10\^9\/L)?/gi;
    for (const line of lines)
      for (const match of line.quote.matchAll(measurement))
        observations.push({
          name: match[1],
          value: match[2],
          unit: match[3] || "原文未提供",
          source: line,
          interpretation: "未评价",
        });
    return artifact("observations", "检验数值摘录", {
      observations,
      missing: observations.length ? [] : ["未识别到支持的检验项目与数值"],
      limitations: ["按原文保留数值和单位；没有单位换算、异常判断或诊断。"],
    });
  }
  if (name === "extract_clinical_timeline") {
    const events = [];
    const seen = new Set();
    for (const line of lines) {
      const date = line.quote.match(
        /(?<!\d)((?:19|20)\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/,
      );
      if (!date) continue;
      const [year, month, day] = date.slice(1).map(Number);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      const valid =
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day;
      const dateString = valid
        ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
        : date[0];
      const key = `${line.sourceId}:${line.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        date: dateString,
        event: line.quote,
        source: line,
        needs_review: true,
        dateValid: valid,
        ambiguousDates:
          [
            ...line.quote.matchAll(
              /(?:19|20)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g,
            ),
          ].length > 1,
      });
    }
    events.sort((a, b) => a.date.localeCompare(b.date));
    return artifact("clinical_timeline", "病历事件时间线", {
      events,
      missing: events.length
        ? []
        : ["未识别到完整年月日；请补充日期或使用模型辅助整理。"],
      limitations: [
        "一行作为一个原文事件，未推断诊断、相对日期或合并因果关系。",
      ],
    });
  }
  if (name === "build_evidence_question") {
    const term = (v) => '"' + v.replace(/["\\]/g, " ").trim() + '"';
    const query = [args.population, args.intervention]
      .filter((v) => v !== "未提供")
      .map(term)
      .join(" AND ");
    return artifact("evidence_plan", "PICO 与检索计划", {
      pico: args,
      query,
      searchUrl: query
        ? `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(query)}`
        : null,
      items: [
        "检查同义词与 MeSH 主题词",
        "记录检索数据库、日期和完整检索式",
        "预先定义纳入排除标准",
        "逐篇评价适用人群与证据局限",
      ],
      retrieved: false,
      provenance: "draft_query",
    });
  }
  if (name === "review_medication_safety") {
    const medicationLines = lines.filter((l) =>
      /药|片|胶囊|注射|mg|毫克|ml|毫升|用法|bid|qd/i.test(l.quote),
    );
    const fields = [
      ["年龄", /\d+\s*岁|年龄/],
      ["药品通用名及规格", /通用名|规格|\d+\s*(mg|毫克)/i],
      ["用法、频次和途径", /频次|口服|静脉|每日|bid|qd/i],
      ["过敏史", /过敏/],
      ["肾功能信息", /肌酐|eGFR|肾功能/i],
      ["肝功能信息", /ALT|AST|肝功能/i],
      ["合并用药", /合并用药|同时服用/],
    ];
    const information = fields.map(([name, regex]) => {
      const matches = lines.filter((l) => regex.test(l.quote));
      const unavailable =
        !matches.length ||
        matches.every((l) =>
          /未记录|未知|未提供|不详|待补|未查|未测/.test(l.quote),
        );
      return {
        name,
        status: unavailable ? "未明确" : "材料中有记载",
        sources: matches,
      };
    });
    return artifact("medication_review", "用药信息核对", {
      matches: medicationLines,
      information,
      missing: information
        .filter((f) => f.status === "未明确")
        .map((f) => f.name),
      checks: [
        "核对原始医嘱和实际用药是否一致",
        "由药师核查适应证、剂量、禁忌及相互作用",
        "记录复核人和待进一步确认的事项",
      ],
      limitations: ["仅检测信息是否出现，没有执行药物相互作用或剂量计算。"],
    });
  }
  if (name === "draft_treatment_review") {
    return artifact("treatment_review", "治疗方案参考意见（草稿）", {
      summary: args.summary,
      concerns: args.concerns,
      infoGaps: args.infoGaps,
      questions: args.questions,
      provenance: "model_draft",
      limitations: [
        "整理材料内信息与模型参考意见；没有药物知识库、剂量或相互作用判断，必须由医生复核确认。",
      ],
    });
  }
  return artifact(
    name === "build_workflow" ? "workflow" : "checklist",
    args.title,
    { items: args.steps || args.items, provenance: "model_draft" },
  );
}
export function localWork(policy, sources) {
  if (policy.intent === "record_structuring")
    return { tool: "extract_clinical_timeline", args: {} };
  if (policy.intent === "medication_safety")
    return { tool: "review_medication_safety", args: {} };
  if (policy.intent === "evidence_planning") {
    const content = sources.map((s) => s.text).join("\n");
    const extract = (label) =>
      content
        .match(
          new RegExp(
            "(?:^|[\\n；;])\\s*(?:" + label + ")\\s*[:：]\\s*([^\\n；;]+)",
            "i",
          ),
        )?.[1]
        ?.trim() || "未提供";
    return {
      tool: "build_evidence_question",
      args: {
        population: extract("P|人群|患者群体"),
        intervention: extract("I|干预"),
        comparison: extract("C|对照"),
        outcome: extract("O|结局"),
      },
    };
  }
  if (policy.intent === "observations")
    return { tool: "extract_observations", args: {} };
  return {
    tool: "build_workflow",
    args: {
      title: "医疗资料处理流程",
      steps: [
        "明确此次任务和材料范围",
        "核对资料来源与任务范围",
        "整理可追溯草稿，标出缺失信息",
        "由专业人员复核后导出",
      ],
    },
  };
}
