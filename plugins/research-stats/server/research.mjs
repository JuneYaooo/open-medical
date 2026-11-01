import { createHmac, randomBytes } from "node:crypto";
import { check } from "../../../server/errors.mjs";
import {
  asNumber,
  findSource,
  parseCsv,
  profileSources,
} from "../../../server/medical/cohort-profile.mjs";
import {
  chiSquare,
  fisherExact2x2,
  mannWhitney,
  normalInv,
  welchTTest,
} from "../../../server/medical/stats-math.mjs";

// 统计分布与检验的实现在固定区 server/medical/stats-math.mjs，供本插件与
// 患者库队列比较（cohort-stats）共用；这里保留原有导出名。
export {
  chiSquare,
  erf,
  fisherExact2x2,
  mannWhitney,
  normalCdf,
  normalInv,
  welchTTest,
} from "../../../server/medical/stats-math.mjs";

// Deterministic research statistics over session CSV materials. Pure-JS
// implementations (no external stats runtime required): Welch t-test,
// Mann-Whitney U, chi-square and Fisher exact for comparison; normal-approx
// sample-size formulas for two-group designs. All outputs are draft
// material pending review — nothing here "confirms" a scientific result.

const POSITIVE_VALUES = new Set(["1", "是", "有", "true", "yes", "y", "阳性", "positive", "pos", "+"]);
const NEGATIVE_VALUES = new Set(["0", "否", "无", "false", "no", "n", "阴性", "negative", "neg", "-"]);
// The positive level of a two-valued outcome, or null when the outcome is not
// binary or its positive level cannot be told apart. An explicit level wins.
export function binaryPositive(values, positive) {
  if (positive !== undefined && positive !== null && positive !== "") {
    check(typeof positive === "string", "INVALID_INPUT", "阳性取值须为文本");
    return values.length === 2 && values.includes(positive) ? positive : null;
  }
  if (!values.length || values.length > 2) return null;
  const norm = (value) => String(value).trim().toLowerCase();
  if (!values.every((value) => POSITIVE_VALUES.has(norm(value)) || NEGATIVE_VALUES.has(norm(value)))) return null;
  const positives = values.filter((value) => POSITIVE_VALUES.has(norm(value)));
  return positives.length === 1 ? positives[0] : null;
}
// Cells that a spreadsheet would run as a formula get a leading quote; plain
// numbers such as -3.5 stay numbers.
const neutralize = (value) =>
  /^[=+\-@\t\r]/.test(value) && !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value) ? `'${value}` : value;
const csvField = (raw) => {
  const value = neutralize(raw);
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
};

export class ResearchService {
  constructor() {}
  profile({ sources = [], sourceId, columns } = {}) {
    return profileSources({ sources, sourceId, columns });
  }
  test({ sources = [], sourceId, outcome, group, method = "auto", positive } = {}) {
    const source = findSource(sources, sourceId);
    check(outcome && typeof outcome === "string", "INVALID_INPUT", "请提供结局变量列名");
    check(group && typeof group === "string", "INVALID_INPUT", "请提供分组变量列名");
    const { header, records } = parseCsv(source.text);
    check(header.includes(outcome), "INVALID_INPUT", `结局列不存在：${outcome}`);
    check(header.includes(group), "INVALID_INPUT", `分组列不存在：${group}`);
    const levels = [...new Set(records.map((r) => r[group]).filter((v) => v !== ""))];
    check(levels.length === 2, "INVALID_INPUT", "分组变量必须恰好有 2 个水平");
    const outcomeValues = [...new Set(records.map((r) => r[outcome]).filter((v) => v !== ""))];
    const positiveLevel = binaryPositive(outcomeValues, positive);
    if (method === "auto") method = positiveLevel !== null ? "chi-square" : "welch-t";
    check(
      ["welch-t", "mann-whitney", "chi-square", "fisher"].includes(method),
      "INVALID_INPUT",
      "检验方法无效",
    );
    if (method === "chi-square" || method === "fisher") {
      check(
        outcomeValues.length === 2,
        "INVALID_INPUT",
        `卡方与 Fisher 检验需要结局变量恰好有 2 个取值（当前 ${outcomeValues.length} 个）；数值结局请选择 t 检验或 Mann-Whitney U`,
      );
      check(
        positiveLevel !== null,
        "INVALID_INPUT",
        positive
          ? `阳性取值「${positive}」不在结局列中（现有取值：${outcomeValues.join(" / ")}）`
          : `无法判断哪一个取值为阳性（${outcomeValues.join(" / ")}），请指定阳性取值`,
      );
    }
    let result;
    if (method === "welch-t" || method === "mann-whitney") {
      const groups = levels.map((level) =>
        records
          .filter((r) => r[group] === level)
          .map((r) => asNumber(r[outcome]))
          .filter((v) => v !== null),
      );
      check(
        groups.every((values) => values.length >= 2),
        "INVALID_INPUT",
        groups.every((values) => !values.length) && outcomeValues.length === 2
          ? `结局变量不是数值（${outcomeValues.join(" / ")}）：二分类结局请指定阳性取值，并选择卡方或 Fisher 检验`
          : "每组至少需要 2 个有效数值",
      );
      result = method === "welch-t" ? welchTTest(groups) : mannWhitney(groups);
      // Each group keeps its level name so readers can tell which arm is which.
      result = {
        ...result,
        levels,
        groups: levels.map((level, i) => ({
          level,
          ...(result[i === 0 ? "group1" : "group2"] ?? { n: groups[i].length }),
        })),
      };
      if (method === "mann-whitney") delete result.groups;
    } else {
      const table = levels.map((level) => {
        const subset = records.filter((r) => r[group] === level);
        const answered = subset.filter((r) => r[outcome] !== "");
        const positives = answered.filter((r) => r[outcome] === positiveLevel).length;
        return [positives, answered.length - positives];
      });
      result = method === "fisher" ? fisherExact2x2(table) : chiSquare(table);
      result.levels = levels;
      result.positive = positiveLevel;
    }
    return {
      ...result,
      outcome,
      group,
      note: "检验结果为待复核草稿：请核对分组定义、数据质量与方法学假设后再作解读。",
    };
  }
  sampleSize({ design, alpha = 0.05, power = 0.8, delta, sd, p1, p2, ratio = 1 } = {}) {
    check(
      ["means", "proportions"].includes(design),
      "INVALID_INPUT",
      "设计类型须为 means 或 proportions",
    );
    const zAlpha = normalInv(1 - alpha / 2);
    const zBeta = normalInv(power);
    let n1;
    if (design === "means") {
      check(
        Number.isFinite(delta) && delta !== 0 && Number.isFinite(sd) && sd > 0,
        "INVALID_INPUT",
        "means 设计需要非零的 delta 与 sd>0",
      );
      n1 = ((zAlpha + zBeta) ** 2 * sd ** 2 * (1 + 1 / ratio)) / delta ** 2;
    } else {
      check(
        Number.isFinite(p1) && Number.isFinite(p2) && p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1 && p1 !== p2,
        "INVALID_INPUT",
        "proportions 设计需要 0–1 之间且不相等的 p1 与 p2",
      );
      const pBar = (p1 + ratio * p2) / (1 + ratio);
      n1 =
        ((zAlpha * Math.sqrt((1 + 1 / ratio) * pBar * (1 - pBar)) +
          zBeta * Math.sqrt(p1 * (1 - p1) + (p2 * (1 - p2)) / ratio)) **
          2) /
        (p1 - p2) ** 2;
    }
    return {
      design,
      alpha,
      power,
      n1: Math.ceil(n1),
      n2: Math.ceil(n1 * ratio),
      total: Math.ceil(n1) + Math.ceil(n1 * ratio),
      note: "样本量按两独立组正态近似估计，未考虑失访与依从性折减；请按研究设计上浮。",
    };
  }
  deidentify({ sources = [], sourceId, columns = [] } = {}) {
    const source = findSource(sources, sourceId);
    const { header, records } = parseCsv(source.text);
    check(
      Array.isArray(columns) && columns.length <= 20,
      "INVALID_INPUT",
      "脱敏列最多 20 个",
    );
    for (const column of columns)
      check(header.includes(column), "INVALID_INPUT", `列不存在：${column}`);
    // A fresh random key per export: codes stay consistent within this file,
    // and the key is discarded, so codes cannot be recomputed from guesses.
    const key = randomBytes(32);
    const pseudonym = (value, column) =>
      value === ""
        ? ""
        : `${column.slice(0, 4).toUpperCase()}_${createHmac("sha256", key).update(`${column}\u0000${value}`).digest("hex").slice(0, 16)}`;
    const out = [
      header.map((h) => csvField(columns.includes(h) ? `${h}_deid` : h)).join(","),
    ];
    for (const record of records)
      out.push(
        header
          .map((h) => csvField(columns.includes(h) ? pseudonym(String(record[h] ?? ""), h) : String(record[h] ?? "")))
          .join(","),
      );
    return {
      sourceId,
      sourceName: source.name,
      rows: records.length,
      deidentifiedColumns: columns,
      csv: out.join("\n"),
      note: "伪标识由本次导出的随机密钥生成，密钥不保存：同一次导出内同一原始值对应同一编码，编码无法还原，不同导出之间编码不同。其余列仍可能间接识别个人，请谨慎发布。",
    };
  }
}

export function researchTools(research) {
  const definition = (name, description, properties, required = []) => ({
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
  const textDef = { type: "string" };
  const numDef = { type: "number" };
  return [
    {
      definition: definition(
        "stats_test",
        "对会话中 CSV 资料的两组做统计比较（welch-t / mann-whitney / chi-square / fisher；auto 按结局类型选择）。二分类结局可用 positive 指定阳性取值。",
        {
          sourceId: textDef,
          outcome: textDef,
          group: textDef,
          method: textDef,
          positive: textDef,
        },
        ["sourceId", "outcome", "group"],
      ),
      execute: (args, context) => research.test({ ...args, sources: context.sources }),
    },
    {
      definition: definition(
        "sample_size",
        "计算两独立组研究的样本量（design=means 需要 delta 与 sd；design=proportions 需要 p1 与 p2）。",
        {
          design: textDef,
          alpha: numDef,
          power: numDef,
          delta: numDef,
          sd: numDef,
          p1: numDef,
          p2: numDef,
          ratio: numDef,
        },
        ["design"],
      ),
      execute: (args) => research.sampleSize(args),
    },
    {
      definition: definition(
        "deidentify_csv",
        "对会话中 CSV 资料的指定列做伪标识脱敏（每次导出随机密钥，同次导出内编码一致），返回脱敏后的 CSV 文本。",
        { sourceId: textDef, columns: { type: "array", items: textDef } },
        ["sourceId", "columns"],
      ),
      execute: (args, context) => research.deidentify({ ...args, sources: context.sources }),
    },
  ];
}
