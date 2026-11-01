import { check } from "../errors.mjs";

// 外发检索词的确定性隐私闸门：患者会话里发往网上的检索词不得带出当前患者
// 身份或可识别的编号/日期。中文医学关键词本身允许。
const DATE = /(?:19|20)\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\b\d{1,2}[-/]\d{1,2}[-/](?:19|20)\d{2}\b/u;
const LONG_NUMBER = /\d{7,}/;
const ID_CARD = /\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])\d{2}\d{3}[\dXx]|\d{15,17}[Xx]/;
const PHONE = /(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}|0\d{2,3}[\s-]\d{7,8}|\b\d{3,4}[\s-]\d{3,4}[\s-]\d{4}\b/;

// 姓名按常见分隔拆开（如“示例·张三”也拦截“张三”）；编号/电话按原文与纯数字比较。
export function patientIdentityTerms(patient) {
  if (!patient) return [];
  const terms = new Set();
  const name = String(patient.name || "").trim();
  if (name.length >= 2) {
    terms.add(name);
    for (const part of name.split(/[\s·•.．・()（）]+/u)) if (part.length >= 2) terms.add(part);
  }
  for (const value of [patient.patientNumber, patient.phone]) {
    const text = String(value || "").trim();
    if (text.length >= 3) terms.add(text);
    const digits = text.replace(/\D/g, "");
    if (digits.length >= 5) terms.add(digits);
  }
  return [...terms];
}

export function outboundQueryIssue(text, identities = [], { numbers = true } = {}) {
  const value = String(text ?? "").normalize("NFKC");
  const lower = value.toLowerCase(), digits = value.replace(/\D/g, "");
  for (const term of identities) {
    const t = String(term).toLowerCase();
    // Latin-script name pieces match whole words only: "Li Na" must not block
    // "clinical" or "analysis". CJK names have no word breaks, so substring.
    const hit = /^[a-z][a-z\s'-]*$/.test(t)
      ? new RegExp(`(^|[^a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(lower)
      : lower.includes(t);
    if (hit || (/^\d{5,}$/.test(t) && digits.includes(t))) return "当前患者的姓名、电话或病历号";
  }
  if (!numbers) return null;
  if (ID_CARD.test(value)) return "证件号样式的编号";
  if (PHONE.test(value)) return "电话号码";
  if (LONG_NUMBER.test(value)) return "7 位以上的数字编号";
  if (DATE.test(value)) return "精确日期";
  return null;
}

export function checkOutboundQuery(text, identities = [], options = {}) {
  const issue = outboundQueryIssue(text, identities, options);
  check(!issue, "OUTBOUND_PRIVACY", `检索词未发送：含有${issue}。网上检索只能使用脱敏医学关键词（疾病、症状、检查、治疗等），请删除身份信息、编号和具体日期后重新检索。`);
}

// 收集一次工具调用里会外发的文本：检索词逐条检查；网址只查患者身份（网址
// 常含长数字编号与日期路径）。
export function outboundTexts(name, args = {}) {
  if (name === "web_search" || name === "online_case_search") return [[args.query, {}]];
  if (name === "literature_search") return [args.query, ...(Array.isArray(args.queries) ? args.queries : [])].filter((q) => typeof q === "string").map((q) => [q, {}]);
  // A DOI/PMID is public, but the field must not carry identity text either.
  if (name === "literature_fetch") return [args.doi, args.pmid].filter((v) => typeof v === "string" && v).map((v) => [v, { numbers: false }]);
  if (name === "web_fetch") {
    let url = String(args.url || "");
    try { url = decodeURIComponent(url); } catch {}
    return [[url, { numbers: false }]];
  }
  return [];
}
export const OUTBOUND_TOOLS = ["web_search", "web_fetch", "online_case_search", "literature_search", "literature_fetch"];

export function checkOutboundTool(name, args, identities = []) {
  for (const [text, options] of outboundTexts(name, args)) checkOutboundQuery(text, identities, options);
}

// 包装注册表中的外发工具：患者会话统一在执行前检查。
export function guardOutboundTools(registry, identities = []) {
  for (const name of OUTBOUND_TOOLS) {
    const tool = registry.get?.(name) || registry.tools?.get(name);
    if (!tool || tool.outboundGuarded) continue;
    const execute = tool.execute;
    tool.execute = async (args, ...rest) => {
      checkOutboundTool(name, args || {}, identities);
      return execute(args, ...rest);
    };
    tool.outboundGuarded = true;
  }
}
