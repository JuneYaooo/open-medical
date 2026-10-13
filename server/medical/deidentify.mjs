import { createHash } from "node:crypto";
import { REDACT_MARK } from "../../shared/share-report.mjs";

// 脱敏分享引擎：结构化身份字段移除/分桶（科研导出同规则），再加自由文本
// PHI 扫描——手机号、身份证号、座机、住院号/病历号等长编号一律打码，紧凑
// 书写的 8 位年月日数字串除外（日期是临床要素，且月日组合不构成身份）。
// 返回「导出内容 + 打码清单」，医生在预览里能看到到底抹掉了什么再决定分享。
// 展示模板（renderShareHtml/buildShareSections）在 shared/share-report.mjs。
const ID_CARD = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const LANDLINE = /(?<!\d)0\d{2,4}-?\d{7,8}(?!\d)/g;
// 6 位以上数字串视为编号；纯 8 位且像 19xx/20xx 年月日的跳过。
const LONG_NUMBER = /(?<!\d)(?!(?:19|20)\d{6}(?!\d))\d{6,}(?!\d)/g;

export function shareIdentities(patient) {
  return [patient.name, patient.phone, patient.patientNumber, patient.id]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim())
    .sort((a, b) => b.length - a.length);
}

export function scrubFreeText(text, identities, counts) {
  let out = String(text);
  for (const identity of identities) {
    if (identity && out.includes(identity)) {
      counts.identity += out.split(identity).length - 1;
      out = out.split(identity).join(REDACT_MARK);
    }
  }
  for (const [key, pattern] of [["idNumber", ID_CARD], ["phone", MOBILE], ["landline", LANDLINE], ["longNumber", LONG_NUMBER]]) {
    out = out.replace(pattern, () => {
      counts[key] += 1;
      return REDACT_MARK;
    });
  }
  return out;
}

export function buildShareRecord(patient, { sections } = {}) {
  const chosen = new Set(
    Array.isArray(sections) && sections.length
      ? sections
      : ["diagnoses", "medications", "allergies", "labs", "visits"],
  );
  const age = patient.birthYear ? new Date().getFullYear() - patient.birthYear : null;
  const counts = { identity: 0, idNumber: 0, phone: 0, landline: 0, longNumber: 0 };
  const identities = shareIdentities(patient);
  const scrub = (value) => {
    if (typeof value === "string") return scrubFreeText(value, identities, counts);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, scrub(item)]),
      );
    return value;
  };
  const record = scrub({
    pseudoId: `P-${createHash("sha256").update(patient.id).digest("hex").slice(0, 8)}`,
    gender: patient.gender || "unknown",
    ageBand:
      age !== null
        ? `${Math.floor(age / 10) * 10}–${Math.floor(age / 10) * 10 + 9}`
        : null,
    ...(chosen.has("diagnoses")
      ? {
          diagnoses: (patient.diagnoses || []).map(({ name, code, date, status, note }) => ({
            name,
            ...(code ? { code } : {}),
            ...(date ? { date } : {}),
            ...(status ? { status } : {}),
            ...(note ? { note } : {}),
          })),
        }
      : {}),
    ...(chosen.has("medications")
      ? {
          medications: (patient.medications || []).map((m) => ({
            name: m.name,
            ...(m.dose ? { dose: m.dose } : {}),
            ...(m.frequency ? { frequency: m.frequency } : {}),
            status: m.status || "unknown",
          })),
        }
      : {}),
    ...(chosen.has("allergies")
      ? {
          allergies: patient.allergies || [],
          allergyStatus:
            patient.allergyStatus ||
            ((patient.allergies || []).length ? "recorded" : "unknown"),
        }
      : {}),
    ...(chosen.has("labs")
      ? {
          labs: (patient.labs || []).map(({ item, value, unit, date }) => ({
            item,
            value,
            ...(unit ? { unit } : {}),
            ...(date ? { date } : {}),
          })),
        }
      : {}),
    ...(chosen.has("visits")
      ? {
          visits: (patient.visits || []).map((v) => ({
            date: v.date,
            reason: v.reason,
          })),
        }
      : {}),
  });
  const findings = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([category, count]) => ({ category, count }));
  return {
    record: {
      ...record,
      exportedAt: new Date().toISOString(),
      note: "去隐私化分享：姓名、电话、病历号等身份字段已移除，出生年改为年龄段；自由文本里的证件号/手机号/长编号已打码。分享前请浏览预览确认没有遗漏。",
    },
    findings,
  };
}
