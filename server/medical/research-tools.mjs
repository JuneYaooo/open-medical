import { createHash } from "node:crypto";
import { AppError, check, string } from "../errors.mjs";
import { randomUUID } from "node:crypto";
import { PID_PATTERN, buildResearchDataset, researchDataDictionary } from "./research-dataset.mjs";
import { cohortSpecSchema, runCohortQuery } from "./cohort-query.mjs";
import { cohortCompareSchema, compareCohorts } from "./cohort-stats.mjs";

// 科研工具面：数据字典 + 沙箱分析。agent 自己决定研究什么、怎么分析；
// 框架保证三件事：
// 1. 数据只以脱敏长表进入沙箱，模型只看到代码赋给 result 的汇总；
// 2. 结果里出现大量逐人假名编号视为泄露逐行数据，直接拒绝；
// 3. 每次分析带数据快照哈希、代码哈希、包版本和本会话分析序号，
//    便于复现与如实披露多重比较。

export const RESEARCH_GUIDANCE = `- 科研问题（某类患者的组间比较、共性、危险因素、生存分析、从文献找方向再用本地数据验证）按以下顺序：
  1. 先把问题拆成 人群、比较组（暴露/对照）、结局、时间范围，口径不清时先问医生，必要时让医生确认分析计划；
  2. 用 research_data_dictionary 看本地数据能否支持，确认诊断/用药/检验的本地写法和单位；
  3. 用 cohort_query 展示各组人群（符合/待核对人数），让医生核对口径；
  4. 两到四组比较一个检验数值或一个是/否结局，用 cohort_compare 在本机确定性计算（无需 Python）；对照组要写明排除暴露，保证各组互斥；
  5. 超出 cohort_compare 的分析（回归、多因素校正、生存分析等）在科研计算环境已安装时才用 research_analyze 写 Python，先 read_skill（危险因素与共性挖掘用 cohort-factor-analysis，文献选题用 research-direction-scouting）。不要用 patient_scan 逐人拼数据。
- 汇报时写明各组 n、缺失人数及原因、待核对/重叠排除人数、所用检验、p 值、效应量及 95% CI，以及本次任务共做了几项分析（多重比较）。所有发现都是探索性、相关性结论，提示混杂，作为待复核草稿。
- 定好口径后不要反复更换人群、结局或时间窗去追求显著结果；确需调整时说明原因并如实报告所有做过的比较。`;

const MAX_PIDS_IN_OUTPUT = 20;
const TABLES = ["patients", "diagnoses", "medications", "labs", "visits"];
const ledgers = new Map(); // `${workspaceId}:${runId}` -> 本次运行已做分析数（进程内）

export function configureResearchTools(registry, workspace, run, { patients, research, artifacts } = {}) {
  if (!patients) return;
  const runKey = `${workspace.id}:${run?.id || "none"}`;
  const register = (name, description, properties, required, execute, permission = "tools.execute") =>
    registry.register({
      permission,
      capability: { backend: "local" },
      definition: {
        type: "function",
        function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
      },
      execute,
    });

  register(
    "research_data_dictionary",
    "只读：科研数据字典。返回本地患者库脱敏后有哪些表和字段、每类数据覆盖多少患者、常见诊断/用药/检验项目（含单位、取值范围、年份）及数据快照哈希。用于判断某个研究问题在本地数据上是否可行、确定变量口径（同一指标可能有多种写法），再交给 research_analyze。不含逐人数据。",
    {
      includeArchived: { type: "boolean", description: "是否包含已归档患者，默认否" },
    },
    [],
    async (args) => ({
      ...researchDataDictionary(buildResearchDataset(patients(), { includeArchived: args.includeArchived === true })),
      readOnly: true,
    }),
  );

  // 按条件找患者：模型只负责把医生的话翻译成条件，逐人判断由本地代码完成。
  // 返回给模型的只有计数、各条件命中情况和前 30 位患者的精简判断（无姓名）；
  // 完整名单由界面卡片用同一组条件在本机查询。
  register(
    "cohort_query",
    `按条件在本地患者库里找患者（自然语言筛选）。把医生的描述或试验入排标准翻译成结构化条件后调用：
- 每条条件写 label（医生能看懂的原文）、kind（include 必须满足 / exclude 满足则排除）和 field（age/sex/diagnosis/medication/lab/group/tag）。
- 诊断、用药、检验要给出常见写法（中文名、英文名、缩写、通用名），检验写明比较值和单位；有时间要求用 withinDays。
- 不确定口径时先用 research_data_dictionary 看本地常见诊断、用药和检验项目的写法与单位。
结果：每位患者判为 符合 / 待核对 / 不符合，并给出每条条件的依据。缺资料是“待核对”，不是“不符合”。结果是待医生复核的草稿，不能直接作为入组或诊疗决定。`,
    cohortSpecSchema.properties,
    cohortSpecSchema.required,
    async (args) => {
      const result = runCohortQuery(patients().all(), args, { limit: 30 });
      return {
        id: randomUUID(),
        type: "patient_cohort",
        status: "draft",
        title: `按条件找患者：${result.spec.title}`,
        spec: result.spec,
        counts: result.counts,
        perCondition: result.perCondition,
        rows: result.rows.map((row) => ({
          patientId: row.patientId,
          status: row.status,
          // 只列不符合或待核对的条件，符合的不重复。
          open: row.results.filter((r) => r.verdict !== "met").map((r) => `第${r.index + 1}条${r.verdictLabel}：${r.evidence}`),
        })),
        truncated: result.truncated,
        evaluatedAt: result.evaluatedAt,
        note: `共 ${result.counts.total} 位患者：符合 ${result.counts.match}，待核对 ${result.counts.unclear}，不符合 ${result.counts.mismatch}。这里最多列 30 位，完整名单在结果卡片中由医生查看。向医生说明条件口径和待核对原因，不要编造患者信息。`,
      };
    },
  );

  // 队列比较：模型只负责把研究问题翻译成分组条件与结局，分组、取值与检验由
  // 本地确定性代码完成；返回汇总统计，不含逐人数据。与 research_analyze 共用
  // 本次运行的分析序号，便于如实披露多重比较。
  register(
    "cohort_compare",
    `在本地患者库中比较 2–4 组患者的一个结局（本机确定性统计，不需要 Python）。
- groups：每组 label + spec（与 cohort_query 相同的条件格式）。各组须互斥：对照组写明排除暴露（如“未使用二甲双胍”= 同样的入组条件 + exclude 二甲双胍；没有任何用药记录的患者会判为待核对而不入组）。同时符合多组的患者会被排除并报告。
- outcome：type=lab 为数值检验（items 写全常见写法，unit 必填且不换算，use=latest/first/change，可加 withinDays）；type=condition 为是/否结局（一条 cohort 条件）。
- 只有判为“符合”的患者入组；待核对、结局缺失（无记录、单位不同、时间窗外等）都不计入，并按原因计数。
- 检验自动选择：数值 2 组 Welch t + Mann-Whitney，3–4 组方差分析 + Kruskal-Wallis；是/否结局 2 组卡方或 Fisher（期望频数 < 5），3–4 组卡方。给出均值/中位数、均差或率差/OR 及 95% CI。
结果是探索性、相关性的待复核草稿；向医生报告 n、缺失、检验、p 值、效应量与 CI、全部警示，不要换口径追求显著。`,
    cohortCompareSchema.properties,
    cohortCompareSchema.required,
    async (args) => {
      const index = (ledgers.get(runKey) || 0) + 1;
      const result = compareCohorts(patients().all(), args, { analysisNumber: index });
      ledgers.delete(runKey);
      ledgers.set(runKey, index);
      if (ledgers.size > 500) ledgers.delete(ledgers.keys().next().value);
      return {
        id: randomUUID(),
        type: "cohort_comparison",
        status: "draft",
        ...result,
        title: `队列比较：${result.title}`,
        note: `本次任务第 ${index} 项分析。向医生说明各组口径、可分析人数与缺失原因、检验方法、p 值、效应量及 95% CI 和全部警示；这是探索性、相关性草稿，不是因果或疗效结论。`,
      };
    },
  );

  if (!research) return;
  register(
    "research_analyze",
    `在隔离的科研计算沙箱中用 Python 分析本地患者库（已脱敏）。沙箱内可用变量：tables（dict，键 ${TABLES.join("/")}，值为 pandas DataFrame，字段见 research_data_dictionary.schema）、pd、np、plt；可 import scipy、statsmodels、lifelines、sklearn。禁网、禁写盘、禁子进程，最长 120 秒。
把 JSON 兼容的汇总结果（统计表、效应量、置信区间、p 值、样本量、缺失情况）赋给 result；print 的内容作为 log 返回（截取末尾 8KB）。用 plt 画的图会自动保存为本会话成果。
不要返回逐人明细：结果中出现超过 ${MAX_PIDS_IN_OUTPUT} 个患者假名编号会被拒绝。每次调用写明 purpose；结果是探索性草稿。`,
    {
      purpose: { type: "string", description: "本次分析要回答的问题，一句话" },
      code: { type: "string", description: "Python 代码；把汇总结果赋给 result" },
      includeArchived: { type: "boolean", description: "是否包含已归档患者，默认否" },
    },
    ["purpose", "code"],
    async (args, context = {}) => {
      const purpose = string(args.purpose, "分析目的", 300).trim();
      check(purpose, "INVALID_INPUT", "请写明本次分析目的");
      const code = string(args.code, "分析代码", 40000);
      const dataset = buildResearchDataset(patients(), { includeArchived: args.includeArchived === true });
      check(dataset.tables.patients.length, "RESEARCH_EMPTY", "患者库为空，无法分析");
      const output = await research().run({ code, tables: dataset.tables, signal: context.signal });
      const leaked = new Set(`${JSON.stringify(output.result)}\n${output.log}`.match(PID_PATTERN) || []);
      if (leaked.size > MAX_PIDS_IN_OUTPUT)
        throw new AppError(
          "RESEARCH_ROW_LEVEL",
          `结果包含 ${leaked.size} 个患者的逐人编号。请在沙箱内完成汇总，只返回统计量（计数、均值、效应量、p 值等）。`,
          422,
        );
      const index = (ledgers.get(runKey) || 0) + 1;
      ledgers.delete(runKey);
      ledgers.set(runKey, index);
      if (ledgers.size > 500) ledgers.delete(ledgers.keys().next().value);
      const figures = [];
      for (const figure of output.figures) {
        if (!artifacts || !run?.id) break;
        try {
          const saved = artifacts.save(workspace.id, `analysis-${index}-${figure.name}`, figure.data, run.id);
          figures.push({ name: saved.name, artifactId: saved.id });
        } catch (error) {
          figures.push({ name: figure.name, error: error.message });
        }
      }
      return {
        purpose,
        result: output.result,
        ...(output.log ? { log: output.log } : {}),
        ...(figures.length ? { figures } : {}),
        provenance: {
          analysisNumber: index,
          dataSnapshot: dataset.snapshot,
          codeHash: createHash("sha256").update(code).digest("hex").slice(0, 16),
          environment: output.environment,
        },
        status: "draft",
        note: `本次会话第 ${index} 项分析。探索性结果，待医生复核；报告时说明共做了几项分析（多重比较）、样本量与缺失。`,
      };
    },
    "sandbox.execute",
  );
}
