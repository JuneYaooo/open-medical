import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { check, string } from "../errors.mjs";

// Local DRG grouping over a bundled simplified CHS-DRG 1.1 public scheme:
// principal diagnosis -> MDC -> ADRG (procedure-driven or medical) -> DRG
// by complication level (MCC/CC/none). Weights and the rate are
// configurable and every output carries the scheme version with a
// "reference only" disclaimer. Hospital-specific tables can be imported to
// override the bundled weights.
const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "drg-data");
const SETTINGS_KEY = "drg_settings";
const OVERRIDE_KEY = "drg_overrides";

export class DrgService {
  constructor(store, dataDir = DATA_DIR) {
    this.store = store;
    this.dataDir = dataDir;
  }
  async load() {
    if (this.scheme) return;
    const [mdcMap, drgGroups] = await Promise.all([
      readFile(resolve(this.dataDir, "mdc_map.json"), "utf8").then(JSON.parse),
      readFile(resolve(this.dataDir, "drg_groups.json"), "utf8").then(JSON.parse),
    ]);
    this.scheme = { mdcMap, drgGroups };
  }
  getSetting(key) {
    try {
      const row = this.store.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
      return row ? JSON.parse(row.value) : null;
    } catch {
      return null;
    }
  }
  setSetting(key, value) {
    this.store.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  settings() {
    const saved = this.getSetting(SETTINGS_KEY) || {};
    return {
      rate: Number.isFinite(saved.rate) ? saved.rate : 10000,
      hospital: saved.hospital || "示例统筹区（未配置）",
      schemeVersion: this.scheme?.drgGroups.version,
      overriddenCodes: Object.keys(this.getSetting(OVERRIDE_KEY) || {}).length,
    };
  }
  updateSettings({ rate, hospital } = {}) {
    const current = this.settings();
    const next = {
      rate:
        rate !== undefined
          ? (check(
              Number.isFinite(rate) && rate > 0 && rate <= 1000000,
              "INVALID_INPUT",
              "费率须为正数",
            ),
            rate)
          : current.rate,
      hospital:
        hospital !== undefined ? string(hospital, "统筹区名称", 80) : current.hospital,
    };
    this.setSetting(SETTINGS_KEY, next);
    return this.settings();
  }
  // Imported hospital-specific weights: {code: rw} merged over bundled data.
  importWeights(weights) {
    check(
      weights && typeof weights === "object" && !Array.isArray(weights),
      "INVALID_INPUT",
      "导入格式须为 {DRG码: 权重} 对象",
    );
    const entries = Object.entries(weights).filter(([code]) => code && code.length);
    check(entries.length >= 1 && entries.length <= 2000, "INVALID_INPUT", "导入条目须为 1–2000 条");
    for (const [code, rw] of entries)
      check(
        Number.isFinite(rw) && rw > 0 && rw <= 100,
        "INVALID_INPUT",
        `权重无效：${code}`,
      );
    const existing = this.getSetting(OVERRIDE_KEY) || {};
    this.setSetting(OVERRIDE_KEY, { ...existing, ...Object.fromEntries(entries) });
    return { imported: entries.length, ...this.settings() };
  }
  rwFor(code) {
    const overrides = this.getSetting(OVERRIDE_KEY) || {};
    if (overrides[code] !== undefined) return { rw: overrides[code], source: "imported" };
    const adrg = this.scheme?.drgGroups.adrgs.find((entry) =>
      Object.values(entry.drgs).some((variant) => variant.code === code),
    );
    const variant = adrg
      ? Object.values(adrg.drgs).find((v) => v.code === code)
      : null;
    if (variant) return { rw: variant.rw, source: "builtin" };
    return { rw: null, source: "unknown" };
  }
  mdcFor(principalDx) {
    const text = String(principalDx).toUpperCase().replace(/[^A-Z0-9.]/g, "");
    for (const rule of this.scheme.mdcMap.rules)
      if (rule.prefixes.some((prefix) => text.startsWith(prefix.toUpperCase())))
        return { mdc: rule.mdc, name: rule.name };
    return { mdc: null, name: "未覆盖" };
  }
  complicationLevel(secondaryDx) {
    const { mccPrefixes, ccPrefixes } = this.scheme.drgGroups;
    const hit = (prefixes) =>
      secondaryDx.find((dx) => {
        const text = String(dx).toUpperCase().replace(/[^A-Z0-9.]/g, "");
        return prefixes.some((prefix) => text.startsWith(prefix.toUpperCase()));
      });
    const mcc = hit(mccPrefixes);
    if (mcc) return { level: "mcc", matched: mcc };
    const cc = hit(ccPrefixes);
    if (cc) return { level: "cc", matched: cc };
    return { level: "none", matched: null };
  }
  async group({
    principalDx,
    secondaryDx = [],
    procedures = [],
    los,
    totalCost,
  } = {}) {
    await this.load();
    const diagnosis = string(principalDx, "主要诊断", 60);
    check(
      Array.isArray(secondaryDx) && secondaryDx.length <= 40,
      "INVALID_INPUT",
      "其他诊断最多 40 条",
    );
    check(
      Array.isArray(procedures) && procedures.length <= 40,
      "INVALID_INPUT",
      "手术操作最多 40 条",
    );
    const { mdc, name: mdcName } = this.mdcFor(diagnosis);
    if (!mdc)
      return {
        principalDx: diagnosis,
        drgCode: null,
        ungroupedReason: `主要诊断「${diagnosis}」在示例方案中无法路由到 MDC（${mdcName}）。请导入本地分组方案。`,
        schemeVersion: this.scheme.drgGroups.version,
      };
    const mdcAdrgs = this.scheme.drgGroups.adrgs.filter((entry) => entry.mdc === mdc);
    if (!mdcAdrgs.length)
      return {
        principalDx: diagnosis,
        mdc: `${mdc} ${mdcName}`,
        drgCode: null,
        ungroupedReason: `MDC ${mdc}（${mdcName}）在示例方案中暂无病组定义。请导入本地分组方案。`,
        schemeVersion: this.scheme.drgGroups.version,
      };
    // First matching surgical ADRG wins (list order); otherwise the medical
    // ADRG for this MDC.
    let adrg = null;
    for (const entry of mdcAdrgs) {
      if (entry.type !== "surgical" || !entry.procedures) continue;
      if (
        procedures.some((procedure) =>
          entry.procedures.some((prefix) =>
            String(procedure).replace(/\./g, "").startsWith(prefix.replace(/\./g, "")),
          ),
        )
      ) {
        adrg = entry;
        break;
      }
    }
    if (!adrg) adrg = mdcAdrgs.find((entry) => entry.type === "medical") || mdcAdrgs[0];
    const { level, matched } = this.complicationLevel(secondaryDx);
    const variant = adrg.drgs[level] || adrg.drgs.none;
    const { rw, source } = this.rwFor(variant.code);
    const rate = this.settings().rate;
    const result = {
      principalDx: diagnosis,
      mdc: `${mdc} ${mdcName}`,
      adrg: `${adrg.code} ${adrg.name}`,
      adrgType: adrg.type,
      drgCode: variant.code,
      complication: {
        level,
        label: this.scheme.drgGroups.ccLevels[level],
        matchedDiagnosis: matched,
      },
      rw,
      rwSource: source,
      estimatedCost: rw !== null ? Math.round(rw * rate) : null,
      los,
      ...(Number.isFinite(totalCost) && totalCost > 0 && rw
        ? {
            actualCost: totalCost,
            costDeviation: Math.round(totalCost - rw * rate),
          }
        : {}),
      schemeVersion: this.scheme.drgGroups.version,
      note: "DRG 结果为本地示例方案的测算草稿，仅供管理参考，不构成医疗或医保结论。",
    };
    return result;
  }
  parseBatchCsv(text) {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    check(lines.length >= 2, "INVALID_INPUT", "批量 CSV 需要表头和至少一行数据");
    const header = lines[0].split(",").map((h) => h.trim());
    check(
      ["principal_dx", "secondary_dx", "procedures", "total_cost"].every(
        (column) => column === "total_cost" || header.includes(column),
      ),
      "INVALID_INPUT",
      "批量 CSV 需要列：principal_dx, secondary_dx, procedures",
    );
    const splitList = (value) =>
      (value || "")
        .split(/[;；|]/)
        .map((item) => item.trim())
        .filter(Boolean);
    return lines.slice(1, 1001).map((line) => {
      const cells = line.split(",").map((cell) => cell.trim());
      const record = {};
      header.forEach((name, index) => (record[name] = cells[index] ?? ""));
      return {
        principal_dx: record.principal_dx,
        secondary_dx: splitList(record.secondary_dx),
        procedures: splitList(record.procedures),
        total_cost: Number(record.total_cost) || undefined,
      };
    });
  }
  async batchAnalyze({ csvText } = {}) {
    const text = string(csvText, "批量 CSV", 500000);
    const rows = this.parseBatchCsv(text);
    const results = [];
    for (const row of rows) {
      const grouped = await this.group({
        principalDx: row.principal_dx,
        secondaryDx: row.secondary_dx,
        procedures: row.procedures,
        totalCost: row.total_cost,
      });
      results.push(grouped);
    }
    const grouped = results.filter((result) => result.drgCode && result.rw !== null);
    const rwValues = grouped.map((result) => result.rw);
    const distribution = {};
    for (const result of grouped)
      distribution[result.drgCode] = (distribution[result.drgCode] || 0) + 1;
    return {
      rows: results.length,
      grouped: grouped.length,
      ungrouped: results.length - grouped.length,
      cmi: rwValues.length
        ? Math.round((rwValues.reduce((sum, rw) => sum + rw, 0) / rwValues.length) * 1000) / 1000
        : null,
      totalEstimated: grouped.reduce((sum, result) => sum + (result.estimatedCost || 0), 0),
      totalActual: results.reduce((sum, result) => sum + (result.actualCost || 0), 0),
      distribution,
      results,
      note: "CMI 与费用为示例方案下的测算草稿；未分组病例请检查诊断编码或导入本地方案。",
    };
  }
}

export function drgTools(drg) {
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
        "drg_group",
        "按本地 DRG 示例方案对单个病例分组：主诊断→MDC→ADRG→DRG，输出权重与预估费用。",
        {
          principalDx: textDef,
          secondaryDx: { type: "array", items: textDef },
          procedures: { type: "array", items: textDef },
          totalCost: numDef,
        },
        ["principalDx"],
      ),
      execute: async (args) => drg.group(args),
    },
    {
      definition: definition(
        "drg_batch_analyze",
        "对批量病例 CSV（列：principal_dx, secondary_dx, procedures, total_cost；多值用分号分隔）做 DRG 分组与 CMI 统计。",
        { csvText: textDef },
        ["csvText"],
      ),
      execute: async (args) => drg.batchAnalyze(args),
    },
  ];
}
