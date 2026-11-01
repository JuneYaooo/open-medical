import { check } from "../errors.mjs";
import { mean, variance } from "./cohort-profile.mjs";

// 纯 JS 统计分布与检验（无外部统计运行时）。固定区的 cohort-stats 与
// research-stats 插件共用这一份实现；插件可以引用固定区，反之不行。

export function logGamma(x) {
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
export function gammaQ(s, x) {
  if (x < s + 1) return 1 - lowerGamma(s, x);
  return upperGammaCF(s, x);
}
export function lowerBeta(a, b, x) {
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
export function tTwoTailP(t, df) {
  const x = df / (df + t * t);
  return lowerBeta(df / 2, 0.5, x);
}
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
  // 小样本（总数 ≤ 60）用精确分布：在实际（含并列）秩上枚举所有分组方式。
  if (n <= EXACT_MW_MAX_N) {
    return { method: "mann-whitney", u, n1, n2, z, p: exactRankSumP(ranks.map((r) => Math.round(r * 2)), n1, Math.round(r1 * 2)), exact: true, note: null };
  }
  return {
    method: "mann-whitney",
    u,
    n1,
    n2,
    z,
    p: 2 * normalCdf(z < 0 ? z : -z),
    exact: false,
    note: null,
  };
}

const EXACT_MW_MAX_N = 60;
// 精确双侧 p：秩和偏离均值不小于观察值的分组占比。秩乘 2 化为整数以容纳并列平均秩。
// counts[k][s] = 从前若干个秩中选 k 个、和为 s 的方式数（用浮点数计数，比值精度远高于需要）。
function exactRankSumP(ranks2, n1, observed) {
  const total = ranks2.reduce((a, b) => a + b, 0);
  let counts = Array.from({ length: n1 + 1 }, () => new Float64Array(total + 1));
  counts[0][0] = 1;
  let reach = 0;
  for (const r of ranks2) {
    reach += r;
    for (let k = Math.min(n1, counts.length - 1); k >= 1; k--) {
      const prev = counts[k - 1], cur = counts[k];
      for (let sum = reach; sum >= r; sum--) if (prev[sum - r]) cur[sum] += prev[sum - r];
    }
  }
  const dist = counts[n1];
  const mean = (total * n1) / ranks2.length;
  const gap = Math.abs(observed - mean) - 1e-9;
  let all = 0, extreme = 0;
  for (let sum = 0; sum <= total; sum++) {
    if (!dist[sum]) continue;
    all += dist[sum];
    if (Math.abs(sum - mean) >= gap) extreme += dist[sum];
  }
  return Math.min(1, extreme / all);
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

// t 分布双侧分位数：求 t 使双侧 p = alpha（二分法，p 随 t 单调递减）。
export function tQuantile(df, alpha = 0.05) {
  check(Number.isFinite(df) && df > 0, "INVALID_INPUT", "自由度须为正数");
  let lo = 0,
    hi = 1e4;
  for (let i = 0; i < 200 && hi - lo > 1e-10; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoTailP(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// F 分布右尾概率 P(F > f)。
export function fUpperP(f, df1, df2) {
  if (!(f > 0)) return 1;
  return lowerBeta(df2 / 2, df1 / 2, df2 / (df2 + df1 * f));
}

// 经典单因素方差分析（假定方差齐）。
export function oneWayAnova(groups) {
  check(groups.length >= 2 && groups.every((g) => g.length >= 2), "INVALID_INPUT", "方差分析需要至少 2 组且每组至少 2 个数值");
  const all = groups.flat();
  const grand = mean(all);
  const ssb = groups.reduce((s, g) => s + g.length * (mean(g) - grand) ** 2, 0);
  const ssw = groups.reduce((s, g) => {
    const m = mean(g);
    return s + g.reduce((t, v) => t + (v - m) ** 2, 0);
  }, 0);
  const df1 = groups.length - 1,
    df2 = all.length - groups.length;
  const f = ssw > 0 ? ssb / df1 / (ssw / df2) : null;
  return { method: "anova", f, df1, df2, p: f === null ? null : fUpperP(f, df1, df2), etaSquared: ssb + ssw > 0 ? ssb / (ssb + ssw) : null };
}

// Kruskal–Wallis H（并列秩校正，卡方近似）。
export function kruskalWallis(groups) {
  check(groups.length >= 2 && groups.every((g) => g.length >= 1), "INVALID_INPUT", "Kruskal-Wallis 需要至少 2 组且每组非空");
  const all = groups.flatMap((g, gi) => g.map((v) => ({ v, gi }))).sort((a, b) => a.v - b.v);
  const n = all.length;
  const sums = groups.map(() => 0);
  let ties = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && all[j + 1].v === all[i].v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) sums[all[k].gi] += rank;
    const t = j - i + 1;
    if (t > 1) ties += t ** 3 - t;
    i = j + 1;
  }
  const raw = (12 / (n * (n + 1))) * groups.reduce((s, g, i) => s + sums[i] ** 2 / g.length, 0) - 3 * (n + 1);
  const correction = 1 - ties / (n ** 3 - n);
  const df = groups.length - 1;
  if (!(correction > 0)) return { method: "kruskal-wallis", h: null, df, p: null };
  const h = raw / correction;
  return { method: "kruskal-wallis", h, df, p: gammaQ(df / 2, Math.max(0, h) / 2) };
}

// Wilson 评分区间（比例）。
export function wilsonInterval(x, n, z = 1.959963984540054) {
  if (!n) return [null, null];
  const p = x / n;
  const denom = 1 + z ** 2 / n;
  const centre = (p + z ** 2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z ** 2 / (4 * n ** 2))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
