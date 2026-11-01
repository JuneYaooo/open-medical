import { createHash } from "node:crypto";
import { AppError, check } from "../errors.mjs";
import { serviceCandidate, serviceInsecure } from "../core/ocr-settings.mjs";
import { serviceUrl } from "../core/paddle-ocr.mjs";
import { scrubFreeText } from "./deidentify.mjs";

// 患者资料去隐私：资料导入时就做脱敏，发给模型的只有脱敏文本。
//
// - 服务脱敏：调用 medagent-gpu-worker 的 /v1/deidentify（规则 + 私有
//   Qwen，返回前复检，必须 verified=true），同时用 /v1/identity 抽取身份，
//   身份只留在本机，用于建档时回填真实姓名。
// - 规则兜底：服务不可用或没配置时，本地打码证件号、电话、病历号、带标签
//   的姓名/地址/联系人，以及花名册里已知患者的姓名和电话。会漏掉自由文本里
//   未登记的人名和地址，资料会标成「仅规则脱敏」，服务恢复后可重新处理。
// - 严格模式：不做兜底，脱敏完成前资料不发给模型。
// - 开启后原图不发给视觉模型：图片只走 OCR，识别出的文字再脱敏。
//
// 服务地址可用 HTTP；非本机 HTTP 会标记 insecure，设置页提示送去脱敏的
// 原文与 API Key 是明文传输。

const KEY = "platform:privacy-settings:v1";
// 内置脱敏服务（medagent-gpu-worker 公共部署）。地址可公开；API Key 不写进
// 代码，从 model.env 的 MEDICAL_PRIVACY_SERVICE_KEY 读取或在设置页填写。
export const BUILTIN_PRIVACY_SERVICE_URL = "http://36.139.121.215:18090";

// 由环境变量决定内置服务：MEDICAL_PRIVACY_SERVICE_URL 可改地址，设为 off 或空
// 则不使用内置服务。
export function builtinPrivacyService(env = process.env) {
  const raw = env.MEDICAL_PRIVACY_SERVICE_URL;
  const baseUrl = raw === undefined ? BUILTIN_PRIVACY_SERVICE_URL : String(raw).trim();
  if (!baseUrl || baseUrl.toLowerCase() === "off") return null;
  return { baseUrl: baseUrl.replace(/\/+$/, "").replace(/\/v1$/, ""), apiKey: String(env.MEDICAL_PRIVACY_SERVICE_KEY || "").trim() };
}
export const PRIVACY_MODES = Object.freeze({
  fallback: "规则兜底（推荐）：服务不可用时用本地规则先脱敏，服务恢复后可重新处理",
  strict: "严格：脱敏服务完成前，资料不发给模型",
});
export const POLICY_PREFIX = "cn-medical-pii";
const CHUNK_CHARS = 1500;
const CONCURRENCY = 4;

const hashText = (text) => createHash("sha256").update(String(text)).digest("hex");

export class PrivacySettings {
  constructor(vault, ocrSettings = null, { builtin = null } = {}) {
    this.vault = vault;
    this.ocrSettings = ocrSettings;
    this.builtin = builtin;
  }
  saved() {
    return this.vault.get(KEY) || {};
  }
  // 默认开启；只有医生明确关闭才关闭。
  enabled() {
    return this.saved().enabled !== false;
  }
  mode() {
    return PRIVACY_MODES[this.saved().mode] ? this.saved().mode : "fallback";
  }
  // 自有配置优先；其次沿用 OCR 设置里的 worker（同一台 worker 同时提供
  // OCR 与去隐私）；最后用内置服务。内置服务需要鉴权，没有 Key 时不使用，
  // 避免每份资料都发一次必然 401 的请求（含原文）。
  service() {
    const saved = this.saved();
    if (saved.service?.baseUrl) return { ...saved.service, source: "privacy" };
    if (saved.useOcrService !== false) {
      const ocr = this.ocrSettings?.service?.();
      if (ocr?.baseUrl) return { ...ocr, source: "ocr" };
    }
    const builtin = this.builtinService();
    if (builtin) return builtin;
    return null;
  }
  // 内置服务默认开启，可在设置页关闭。Key 优先用设置页填写的，其次 model.env。
  builtinKey() {
    return this.saved().builtinApiKey || this.builtin?.apiKey || "";
  }
  builtinEnabled() {
    return Boolean(this.builtin?.baseUrl) && this.saved().useBuiltin !== false;
  }
  builtinService() {
    const apiKey = this.builtinKey();
    return this.builtinEnabled() && apiKey ? { baseUrl: this.builtin.baseUrl, apiKey, source: "builtin" } : null;
  }
  candidateService(body) {
    try {
      return serviceCandidate(null, body);
    } catch (error) {
      throw new AppError("PRIVACY_SETTINGS", error.message.replace(/OCR 服务/g, "脱敏服务"), 400);
    }
  }
  save(body = {}) {
    check(body && typeof body === "object" && !Array.isArray(body), "PRIVACY_SETTINGS", "需要配置对象");
    const next = { ...this.saved() };
    if (body.enabled !== undefined) {
      check(typeof body.enabled === "boolean", "PRIVACY_SETTINGS", "enabled 须为布尔值");
      next.enabled = body.enabled;
    }
    if (body.mode !== undefined) {
      check(PRIVACY_MODES[body.mode], "PRIVACY_SETTINGS", "脱敏模式无效");
      next.mode = body.mode;
    }
    if (body.useOcrService !== undefined) {
      check(typeof body.useOcrService === "boolean", "PRIVACY_SETTINGS", "useOcrService 须为布尔值");
      next.useOcrService = body.useOcrService;
    }
    if (body.useBuiltin !== undefined) {
      check(typeof body.useBuiltin === "boolean", "PRIVACY_SETTINGS", "useBuiltin 须为布尔值");
      next.useBuiltin = body.useBuiltin;
    }
    if (body.builtinApiKey !== undefined) {
      check(typeof body.builtinApiKey === "string" && body.builtinApiKey.length <= 500, "PRIVACY_SETTINGS", "API Key 格式无效");
      next.builtinApiKey = body.builtinApiKey.trim() || null;
    }
    if (body.clearService === true) next.service = null;
    else if (body.service) {
      const previous = this.saved().service || null;
      try {
        next.service = serviceCandidate(previous, body.service);
      } catch (error) {
        throw new AppError("PRIVACY_SETTINGS", error.message.replace(/OCR 服务/g, "脱敏服务"), 400);
      }
    }
    this.vault.set(KEY, next);
    return this.public();
  }
  public(extra = {}) {
    const saved = this.saved();
    const service = this.service();
    return {
      enabled: this.enabled(),
      mode: this.mode(),
      modes: PRIVACY_MODES,
      useOcrService: saved.useOcrService !== false,
      service: service ? { baseUrl: service.baseUrl, hasKey: Boolean(service.apiKey), source: service.source, insecure: serviceInsecure(service.baseUrl) } : null,
      ownService: saved.service?.baseUrl ? { baseUrl: saved.service.baseUrl, hasKey: Boolean(saved.service.apiKey) } : null,
      builtin: this.builtin?.baseUrl
        ? {
            baseUrl: this.builtin.baseUrl,
            enabled: this.builtinEnabled(),
            hasKey: Boolean(this.builtinKey()),
            keySource: saved.builtinApiKey ? "settings" : this.builtin.apiKey ? "env" : null,
            active: service?.source === "builtin",
            insecure: serviceInsecure(this.builtin.baseUrl),
          }
        : null,
      ...extra,
    };
  }
}

// ---------- worker 客户端 ----------

async function postForm(service, path, fields, signal) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const timeoutMs = Math.max(Number(service.timeoutMs) || 0, 120000);
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(serviceUrl(service.baseUrl, path), {
      method: "POST",
      headers: service.apiKey ? { authorization: `Bearer ${service.apiKey}` } : {},
      body: form,
      signal: bounded,
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw new AppError("PRIVACY_SERVICE", `无法连接脱敏服务：${error.cause?.code || error.message}`, 502);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {}
  if (!response.ok) {
    const detail = typeof body?.detail === "string" ? body.detail.slice(0, 200) : "";
    throw new AppError(
      response.status === 401 ? "PRIVACY_SERVICE_AUTH" : "PRIVACY_SERVICE",
      response.status === 401 ? "脱敏服务鉴权失败：请核对 API Key（worker 的 WORKER_API_KEY）" : `脱敏服务返回 ${response.status}${detail ? `：${detail}` : ""}`,
      502,
    );
  }
  return body || {};
}

// 按行切块，避免长病历超出 worker 模型的实体输出上限。
export function chunkText(text, limit = CHUNK_CHARS) {
  const chunks = [];
  let current = "";
  for (const line of String(text).split(/(?<=\n)/)) {
    if (current && current.length + line.length > limit) {
      chunks.push(current);
      current = "";
    }
    if (line.length > limit) {
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
    } else current += line;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

export async function deidentifyViaService(service, text, { signal } = {}) {
  if (!String(text).trim()) return { text, policy: null };
  let policy = null;
  const parts = await mapLimit(chunkText(text), CONCURRENCY, async (chunk) => {
    if (!chunk.trim()) return chunk;
    const body = await postForm(service, "/v1/deidentify", { text: chunk }, signal);
    check(
      body.verified === true && typeof body.text === "string" && String(body.policy_version || "").startsWith(POLICY_PREFIX),
      "PRIVACY_SERVICE",
      "脱敏服务没有返回已复检的结果（verified/policy_version 缺失），不使用该结果",
      502,
    );
    policy = body.policy_version;
    return body.text;
  });
  return { text: parts.join(""), policy };
}

export async function identityViaService(service, text, { signal } = {}) {
  const body = await postForm(service, "/v1/identity", { text: String(text).slice(0, 20000), language: "zh" }, signal);
  const raw = body.identity && typeof body.identity === "object" ? body.identity : {};
  const pick = (key) => (typeof raw[key] === "string" && raw[key].trim() ? raw[key].trim().slice(0, 80) : null);
  return { name: pick("name"), gender: pick("gender"), birthDate: pick("birth_date"), age: pick("age") };
}

// ---------- 本地规则 ----------

const LABELED = [
  [/((?:患者)?姓\s*名|病人姓名)(\s*[:：]\s*)([^\s，。；,;:：\n]{2,20})/g, "[患者姓名]"],
  [/((?:现?住|家庭)?(?:住址|地址))(\s*[:：]\s*)([^\n；;]{2,80})/g, "[地址]"],
  [/((?:紧急)?联系人(?:姓名)?|家属(?:姓名)?)(\s*[:：]\s*)([^\s，。；,;:：\n（(]{2,20})/g, "[联系人]"],
  [/(出生(?:日期|年月)|生日)(\s*[:：]?\s*)((?:19|20)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/g, "[出生日期]"],
  [/(住院号|病案号|门诊号|病历号|ID号|就诊卡号|医保卡号)(\s*[:：]?\s*)([A-Za-z0-9-]{3,30})/g, "[医疗编号]"],
  [/(身份证号?(?:码)?|证件号(?:码)?)(\s*[:：]?\s*)([0-9Xx*＊]{8,20})/g, "[身份证号]"],
];

// identities：已知身份字符串（花名册姓名、电话、病历号）。
export function rulesDeidentify(text, identities = []) {
  let out = String(text);
  // 先从带标签的字段里取出姓名和联系人，正文中其他位置出现时一并打码。
  const labeledNames = [...out.matchAll(/(?:(?:患者)?姓\s*名|病人姓名|(?:紧急)?联系人(?:姓名)?|家属(?:姓名)?)\s*[:：]\s*([^\s，。；,;:：\n（([]{2,20})/g)].map((m) => m[1]);
  for (const [pattern, label] of LABELED) out = out.replace(pattern, (_, key, sep) => `${key}${sep}${label}`);
  const counts = { identity: 0, idNumber: 0, phone: 0, landline: 0, longNumber: 0 };
  const known = [...new Set([...identities, ...labeledNames].filter((value) => typeof value === "string" && value.trim().length >= 2).map((v) => v.trim()))].sort(
    (a, b) => b.length - a.length,
  );
  for (const identity of known) if (out.includes(identity)) out = out.split(identity).join("[患者姓名]");
  return scrubFreeText(out, [], counts);
}

// 规则兜底时从带标签的字段里抽身份（只留本机，用于建档回填）。
export function rulesIdentity(text) {
  const value = String(text);
  const name = value.match(/(?:患者)?姓\s*名\s*[:：]\s*([^\s，。；,;:：\n[]{2,20})/)?.[1] || null;
  const gender = value.match(/性\s*别\s*[:：]?\s*([男女])/)?.[1] || null;
  const birthDate = value.match(/出生(?:日期|年月)\s*[:：]?\s*((?:19|20)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})/)?.[1] || null;
  const age = value.match(/年\s*龄\s*[:：]?\s*(\d{1,3})\s*岁/)?.[1] || null;
  return name || gender || birthDate || age ? { name, gender, birthDate, age } : null;
}

// ---------- 统一入口 ----------

export class MaterialPrivacy {
  constructor({ settings, roster = () => [] } = {}) {
    this.settings = settings;
    this.roster = roster; // () => 已知身份字符串
  }
  enabled() {
    return Boolean(this.settings?.enabled());
  }
  strict() {
    return this.settings?.mode() === "strict";
  }
  rawImagesBlocked() {
    return this.enabled();
  }
  // 助手浏览器的网页截图不是导入的患者资料；默认可以交给视觉模型，
  // 严格模式下仍然禁止（网页上可能有医院系统里的患者信息）。
  screenshotsBlocked() {
    return this.enabled() && this.strict();
  }
  hasService() {
    return Boolean(this.settings?.service());
  }
  knownIdentities(extra = []) {
    try {
      return [...this.roster(), ...extra];
    } catch {
      return extra;
    }
  }
  // 服务脱敏 + 身份抽取；失败抛错由调用方决定兜底或等待。
  async protect(text, { signal } = {}) {
    const service = this.settings?.service();
    check(service, "PRIVACY_SERVICE_MISSING", "未配置脱敏服务", 503);
    const [result, identity] = await Promise.all([
      deidentifyViaService(service, text, { signal }),
      identityViaService(service, text, { signal }).catch(() => null),
    ]);
    return { text: result.text, policy: result.policy, identity, method: "service", textHash: hashText(text) };
  }
  rules(text, extra = []) {
    return { text: rulesDeidentify(text, this.knownIdentities(extra)), method: "rules", textHash: hashText(text) };
  }
  // 一次性文本（如 inspect_image 的 OCR 结果）：服务优先，按模式兜底。
  async protectText(text, { signal } = {}) {
    if (!this.enabled()) return { text, method: "off" };
    try {
      return await this.protect(text, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      check(!this.strict(), "PRIVACY_PENDING", `脱敏服务不可用（${error.message}），严格模式下不把这段文字交给模型`, 503);
      return this.rules(text);
    }
  }
}

export const materialTextHash = hashText;

// ---------- 建档回填身份 ----------
// 模型只看到脱敏文本，建档时会写 [患者姓名] 之类的占位符。这里在本机用
// 资料的身份抽取结果把真实身份填回提案；工具结果回给模型前再遮掉。
const PLACEHOLDER = /\[(?:患者姓名|电话|手机号|身份证号|医疗编号|地址|联系人|出生日期)\]|［已脱敏］/;
const GENERIC_NAME = /^(?:患者|某患者|病人|未知|不详)$/;
const GENDER = { 男: "male", 女: "female", male: "male", female: "female" };

export function sourceIdentities(sources = []) {
  return (sources || []).map((source) => source?.privacy?.identity).filter(Boolean);
}

const unanimous = (values) => {
  const set = [...new Set(values.filter(Boolean))];
  return set.length === 1 ? set[0] : null;
};

function deepReplace(value, from, to) {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((item) => deepReplace(item, from, to));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepReplace(v, from, to)]));
  return value;
}

export function reidentifyProposal(tool, args, sources, { findPatients = () => [] } = {}) {
  const identities = sourceIdentities(sources);
  let next = structuredClone(args || {});
  const notes = [];
  const isPlaceholder = (value) => typeof value === "string" && (PLACEHOLDER.test(value) || GENERIC_NAME.test(value.trim()));
  for (const field of ["phone", "patientNumber"]) if (isPlaceholder(next[field])) delete next[field];
  const names = [...new Set(identities.map((i) => i.name).filter(Boolean))];
  if (tool === "patient_record_propose") {
    if (isPlaceholder(next.name)) delete next.name;
    return { args: next, filled: [] };
  }
  const filled = [];
  if (!next.name || isPlaceholder(next.name)) {
    if (names.length === 1) {
      next.name = names[0];
      filled.push("name");
    } else if (names.length > 1) notes.push(`资料中出现多个姓名（${names.join("、")}），请核对是否为同一患者`);
  }
  if (names.length === 1) next = deepReplace(next, "[患者姓名]", names[0]);
  if (!next.gender) {
    const gender = unanimous(identities.map((i) => GENDER[i.gender]));
    if (gender) {
      next.gender = gender;
      filled.push("gender");
    }
  }
  if (!next.birthYear) {
    const year = unanimous(identities.map((i) => Number(String(i.birthDate || "").slice(0, 4)) || null));
    if (year && year > 1900 && year <= new Date().getFullYear()) {
      next.birthYear = year;
      filled.push("birthYear");
    }
  }
  if (next.name && !isPlaceholder(next.name)) {
    const same = (findPatients(next.name) || []).filter((p) => p.name === next.name);
    if (same.length) notes.push(`已有同名患者：${same.map((p) => `${p.name}（${p.patientNumber || p.id}）`).join("、")}，请确认不是重复建档`);
  }
  if (notes.length) next.note = [next.note, ...notes].filter(Boolean).join("；");
  return { args: next, filled };
}

// 工具结果回给模型前，把本机回填的身份换回占位符。
export function maskIdentities(value, identities = []) {
  const secrets = [
    ...new Set(identities.flatMap((i) => [i.name, i.birthDate]).filter((v) => typeof v === "string" && v.trim().length >= 2)),
  ].sort((a, b) => b.length - a.length);
  let out = value;
  for (const secret of secrets) out = deepReplace(out, secret, secret === identities.find((i) => i.birthDate === secret)?.birthDate ? "[出生日期]" : "[患者姓名]");
  return out;
}
