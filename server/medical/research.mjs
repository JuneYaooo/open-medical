import { check } from "../errors.mjs";

// Deterministic research statistics over session CSV materials. Pure-JS
// implementations (no external stats runtime required): Welch t-test,
// Mann-Whitney U, chi-square and Fisher exact for comparison; normal-approx
// sample-size formulas for two-group designs. All outputs are draft
// material pending review — nothing here "confirms" a scientific result.

function logGamma(x) {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function lowerGamma(s, x) {
  if (x < 0) return 0;
  let sum = 1 / s,
    term = sum;
  for (let n = 1; n < 200; n++) {
    term *= x / (s + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
  }
  return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
}
function upperGammaCF(a, x) {
  const tiny = 1e-30;
  let b = x + 1 - a,
    c = 1 / tiny,
    d = 1 / b,
    h = d;
  for (let i = 1; i < 200; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}
function gammaQ(s, x) {
  if (x < s + 1) return 1 - lowerGamma(s, x);
  return upperGammaCF(s, x);
}
function lowerBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lbeta);
  if (x < (a + 1) / (a + b + 2)) return (front * betacf(a, b, x)) / a;
  return 1 - (Math.exp(lbeta) * betacf(b, a, 1 - x)) / b;
}
function betacf(a, b, x) {
  const tiny = 1e-30;
  const qab = a + b,
    qap = a + 1,
    qam = a - 1;
  let c = 1,
    d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
}
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}
export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
// Acklam's inverse normal CDF rational approximation.
export function normalInv(p) {
  check(
    typeof p === "number" && p > 0 && p < 1,
    "INVALID_INPUT",
    "分位数须在 (0,1) 内",
  );
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - pLow) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  q = p - 0.5;
  r = q * q;
  return (
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}
function tTwoTailP(t, df) {
  const x = df / (df + t * t);
  return lowerBeta(df / 2, 0.5, x);
}
function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
function variance(values) {
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
}
const quantile = (sorted, q) => {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
};

export function parseCsv(text) {
  const rows = [];
  let row = [],
    field = "",
    inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field.trim());
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (field !== "" || row.length) {
        row.push(field.trim());
        rows.push(row);
        row = [];
        field = "";
      }
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  check(rows.length >= 2, "INVALID_INPUT", "CSV 需要表头和至少一行数据");
  const header = rows[0];
  const records = rows.slice(1).map((r) => {
    const record = {};
    header.forEach((name, i) => (record[name] = r[i] ?? ""));
    return record;
  });
  return { header, records };
}
const asNumber = (value) => {
  const parsed = Number(value);
  return value !== "" && Number.isFinite(parsed) ? parsed : null;
};

export function welchTTest(groups) {
  check(groups.length === 2, "INVALID_INPUT", "t 检验需要恰好 2 组");
  const [a, b] = groups;
  check(a.length >= 2 && b.length >= 2, "INVALID_INPUT", "每组至少需要 2 个数值");
  const n1 = a.length,
    n2 = b.length;
  const m1 = mean(a),
    m2 = mean(b);
  const v1 = variance(a),
    v2 = variance(b);
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  const t = (m1 - m2) / se;
  const df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  return {
    method: "welch-t",
    group1: { n: n1, mean: m1, sd: Math.sqrt(v1) },
    group2: { n: n2, mean: m2, sd: Math.sqrt(v2) },
    t,
    df,
    p: tTwoTailP(Math.abs(t), df),
  };
}
export function mannWhitney(groups) {
  check(groups.length === 2, "INVALID_INPUT", "Mann-Whitney 需要恰好 2 组");
  const [a, b] = groups;
  check(a.length >= 1 && b.length >= 1, "INVALID_INPUT", "两组都不能为空");
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort(
    (x, y) => x.v - y.v,
  );
  const ranks = new Array(all.length);
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  const r1 = ranks.filter((_, idx) => all[idx].g === 0).reduce((s, r) => s + r, 0);
  const n1 = a.length,
    n2 = b.length;
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);
  const muU = (n1 * n2) / 2;
  // Tie-corrected variance with normal approximation (adequate for n≥8).
  const counts = new Map();
  for (const { v } of all) counts.set(v, (counts.get(v) || 0) + 1);
  const tieTerm = [...counts.values()]
    .filter((c) => c > 1)
    .reduce((sum, c) => sum + c ** 3 - c, 0);
  const n = n1 + n2;
  const sigmaU = Math.sqrt(((n1 * n2) / (n * (n - 1))) * ((n ** 3 - n - tieTerm) / 12));
  const z = (u - muU) / sigmaU;
  return {
    method: "mann-whitney",
    u,
    n1,
    n2,
    z,
    p: 2 * normalCdf(z < 0 ? z : -z),
    note: n < 8 ? "样本量较小，正态近似误差可能较大。" : null,
  };
}
export function chiSquare(table) {
  check(
    Array.isArray(table) && table.length >= 2 && table.every((row) => row.length >= 2),
    "INVALID_INPUT",
    "卡方检验需要至少 2×2 列联表",
  );
  const rowSums = table.map((row) => row.reduce((s, v) => s + v, 0));
  const colSums = table[0].map((_, col) => table.reduce((s, row) => s + row[col], 0));
  const total = rowSums.reduce((s, v) => s + v, 0);
  check(total > 0, "INVALID_INPUT", "列联表合计为 0");
  let chi2 = 0;
  for (let r = 0; r < table.length; r++)
    for (let c = 0; c < table[r].length; c++) {
      const expected = (rowSums[r] * colSums[c]) / total;
      chi2 += (table[r][c] - expected) ** 2 / expected;
    }
  const df = (table.length - 1) * (table[0].length - 1);
  return { method: "chi-square", chi2, df, p: gammaQ(df / 2, chi2 / 2), total };
}
export function fisherExact2x2(table) {
  check(
    Array.isArray(table) && table.length === 2 && table.every((row) => row.length === 2),
    "INVALID_INPUT",
    "Fisher 精确检验需要 2×2 表",
  );
  const [a, b, c, d] = [table[0][0], table[0][1], table[1][0], table[1][1]];
  const n = a + b + c + d;
  check(
    n > 0 && [a, b, c, d].every((v) => Number.isInteger(v) && v >= 0),
    "INVALID_INPUT",
    "Fisher 检验需要非负整数计数",
  );
  const r1 = a + b;
  const c1 = a + c;
  // Two-sided Fisher: sum hypergeometric probabilities on the log scale that
  // are at most as likely as the observed table.
  const logHyper = (k) => {
    const b2 = r1 - k;
    const c2 = c1 - k;
    const d2 = n - r1 - c2;
    if (k < 0 || b2 < 0 || c2 < 0 || d2 < 0) return -Infinity;
    return (
      logGamma(r1 + 1) +
      logGamma(n - r1 + 1) +
      logGamma(c1 + 1) +
      logGamma(n - c1 + 1) -
      logGamma(n + 1) -
      logGamma(k + 1) -
      logGamma(b2 + 1) -
      logGamma(c2 + 1) -
      logGamma(d2 + 1)
    );
  };
  const target = logHyper(a);
  let pValue = 0;
  for (let k = Math.max(0, c1 - (n - r1)); k <= Math.min(r1, c1); k++) {
    const lp = logHyper(k);
    if (lp <= target + 1e-9) pValue += Math.exp(lp);
  }
  return {
    method: "fisher-exact",
    table: [[a, b], [c, d]],
    oddsRatio: b === 0 || c === 0 ? null : (a * d) / (b * c),
    p: Math.min(1, pValue),
  };
}

export class ResearchService {
  constructor() {}
  findSource(sources, sourceId) {
    check(sourceId && typeof sourceId === "string", "INVALID_INPUT", "请提供 sourceId");
    const source = sources.find((s) => s.id === sourceId);
    check(source, "NOT_FOUND", "找不到该资料", 404);
    return source;
  }
  numericColumn(records, column) {
    const values = records
      .map((record) => asNumber(record[column]))
      .filter((v) => v !== null);
    return values;
  }
  profile({ sources = [], sourceId, columns } = {}) {
    const source = this.findSource(sources, sourceId);
    const { header, records } = parseCsv(source.text);
    const fields = Array.isArray(columns) && columns.length ? columns : header;
    check(fields.length <= 30, "INVALID_INPUT", "最多分析 30 列");
    const summary = {};
    for (const field of fields) {
      check(header.includes(field), "INVALID_INPUT", `列不存在：${field}`);
      const numeric = this.numericColumn(records, field);
      if (numeric.length >= records.length * 0.6 && numeric.length >= 3) {
        const sorted = numeric.slice().sort((x, y) => x - y);
        summary[field] = {
          type: "numeric",
          n: numeric.length,
          missing: records.length - numeric.length,
          mean: mean(numeric),
          sd: numeric.length > 1 ? Math.sqrt(variance(numeric)) : null,
          min: sorted[0],
          p25: quantile(sorted, 0.25),
          median: quantile(sorted, 0.5),
          p75: quantile(sorted, 0.75),
          max: sorted.at(-1),
        };
      } else {
        const counts = new Map();
        for (const record of records) {
          const key = record[field] === "" ? "(缺失)" : record[field];
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        summary[field] = {
          type: "categorical",
          n: records.length,
          levels: [...counts.entries()]
            .sort((x, y) => y[1] - x[1])
            .slice(0, 12)
            .map(([level, count]) => ({ level, count })),
        };
      }
    }
    return {
      sourceId,
      sourceName: source.name,
      rows: records.length,
      columns: summary,
      note: "描述统计为待复核草稿结果，请在解读前核对原始数据。",
    };
  }
  test({ sources = [], sourceId, outcome, group, method = "auto" } = {}) {
    const source = this.findSource(sources, sourceId);
    check(outcome && typeof outcome === "string", "INVALID_INPUT", "请提供结局变量列名");
    check(group && typeof group === "string", "INVALID_INPUT", "请提供分组变量列名");
    const { header, records } = parseCsv(source.text);
    check(header.includes(outcome), "INVALID_INPUT", `结局列不存在：${outcome}`);
    check(header.includes(group), "INVALID_INPUT", `分组列不存在：${group}`);
    const levels = [...new Set(records.map((r) => r[group]).filter((v) => v !== ""))];
    check(levels.length === 2, "INVALID_INPUT", "分组变量必须恰好有 2 个水平");
    const outcomeIsBinary = [...new Set(records.map((r) => r[outcome]).filter((v) => v !== ""))].every(
      (v) => ["0", "1", "是", "否", "有", "无", "true", "false"].includes(String(v).toLowerCase()),
    );
    if (method === "auto") method = outcomeIsBinary ? "chi-square" : "welch-t";
    check(
      ["welch-t", "mann-whitney", "chi-square", "fisher"].includes(method),
      "INVALID_INPUT",
      "检验方法无效",
    );
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
        "每组至少需要 2 个有效数值",
      );
      result = method === "welch-t" ? welchTTest(groups) : mannWhitney(groups);
      result = {
        ...result,
        groups: levels.map((level, i) => ({
          level,
          ...result[i === 0 ? "group1" : "group2"] !== undefined
            ? { ...result[i === 0 ? "group1" : "group2"], level: undefined }
            : { n: groups[i].length },
        })),
      };
      if (method === "mann-whitney") delete result.groups;
    } else {
      const table = levels.map((level) => {
        const subset = records.filter((r) => r[group] === level);
        const positives = subset.filter((r) =>
          ["1", "是", "有", "true"].includes(String(r[outcome]).toLowerCase()),
        ).length;
        return [positives, subset.length - positives];
      });
      result = method === "fisher" ? fisherExact2x2(table) : chiSquare(table);
      result.levels = levels;
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
        Number.isFinite(delta) && Number.isFinite(sd) && sd > 0,
        "INVALID_INPUT",
        "means 设计需要 delta 与 sd>0",
      );
      n1 = ((zAlpha + zBeta) ** 2 * sd ** 2 * (1 + 1 / ratio)) / delta ** 2;
    } else {
      check(
        Number.isFinite(p1) && Number.isFinite(p2) && p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1,
        "INVALID_INPUT",
        "proportions 设计需要 0–1 之间的 p1 与 p2",
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
    const source = this.findSource(sources, sourceId);
    const { header, records } = parseCsv(source.text);
    check(
      Array.isArray(columns) && columns.length <= 20,
      "INVALID_INPUT",
      "脱敏列最多 20 个",
    );
    for (const column of columns)
      check(header.includes(column), "INVALID_INPUT", `列不存在：${column}`);
    const pseudonym = (value, column) => {
      const text = `${column}:${value}`;
      let hash = 0;
      for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
      return `${column.slice(0, 4).toUpperCase()}_${hash.toString(36)}`;
    };
    const out = [columns.length ? header.map((h) => (columns.includes(h) ? `${h}_deid` : h)).join(",") : header.join(",")];
    for (const [index, record] of records.entries()) {
      out.push(
        header
          .map((h) =>
            columns.includes(h)
              ? pseudonym(record[h], h, index)
              : String(record[h] ?? ""),
          )
          .join(","),
      );
    }
    return {
      sourceId,
      sourceName: source.name,
      rows: records.length,
      deidentifiedColumns: columns,
      csv: out.join("\n"),
      note: "确定性伪标识：同一原始值映射到同一编码；编码不可逆向还原，但小基数列仍可能被推断，请谨慎发布。",
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
        "cohort_profile",
        "对会话中的 CSV 资料做描述统计（数值列：均值/中位数/四分位；分类列：频数）。",
        { sourceId: textDef, columns: { type: "array", items: textDef } },
        ["sourceId"],
      ),
      execute: (args, context) => research.profile({ ...args, sources: context.sources }),
    },
    {
      definition: definition(
        "stats_test",
        "对会话中 CSV 资料的两组做统计比较（welch-t / mann-whitney / chi-square / fisher；auto 按结局类型选择）。",
        {
          sourceId: textDef,
          outcome: textDef,
          group: textDef,
          method: textDef,
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
        "对会话中 CSV 资料的指定列做确定性伪标识脱敏，返回脱敏后的 CSV 文本。",
        { sourceId: textDef, columns: { type: "array", items: textDef } },
        ["sourceId", "columns"],
      ),
      execute: (args, context) => research.deidentify({ ...args, sources: context.sources }),
    },
  ];
}
