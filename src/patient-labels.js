import { matchesNameInitials } from "./pinyin-initials.js";

export function patientAgeLabel(patient, currentYear = new Date().getFullYear()) {
  const value = patient.birthYear;
  if (value === undefined || value === null || value === "") return "";
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1900 || year > currentYear) return "";
  return `约${currentYear - year}岁 · ${year}年生`;
}

export function patientIdentityLabel(patient) {
  // 无病历号时显示「未编号」而不是内部 ID 片段——哈希前缀对医生是乱码。
  return [patient.patientNumber || "未编号", patientAgeLabel(patient),
    patient.phone ? `尾号 ${patient.phone.slice(-4)}` : null].filter(Boolean).join(" · ");
}
export function patientOptionLabel(patient, patients = []) {
  return patients.some((other) => other.id !== patient.id && other.name === patient.name)
    ? `${patient.name} · ${patientIdentityLabel(patient)}` : patient.name;
}

// 电话比对只看数字：「138-0000-0000」与「13800000000」视为同一号码。
export const phoneDigits = (value) => String(value || "").replace(/\D/g, "");

// 按年龄估算出生年；年龄须为 0–120 的整数，否则返回空串。
export function birthYearFromAge(age, currentYear = new Date().getFullYear()) {
  const text = String(age ?? "").trim();
  if (!/^\d{1,3}$/.test(text) || Number(text) > 120) return "";
  return currentYear - Number(text);
}

// 最近打开的患者（仅存 ID，最多 5 位）：命令面板空查询时展示。
// 本机存储可能不可用（隐私模式、被清理），读写失败时静默跳过。
const RECENT_KEY = "om.recentPatients";
export function recentPatientIds() {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string").slice(0, 5) : [];
  } catch { return []; }
}
export function rememberRecentPatient(id) {
  if (!id) return;
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentPatientIds().filter((other) => other !== id)].slice(0, 5)));
  } catch { /* 本机存储不可用时不记录 */ }
}

// 快速找人：姓名、编号、拼音首字母（「zs」→张三）、电话后四位（或 5 位以上连续数字）。
// q 需已 trim + 小写。
export function patientQuickMatch(patient, q) {
  if (!q) return false;
  const name = String(patient.name || "");
  if (name.toLowerCase().includes(q) || String(patient.patientNumber || "").toLowerCase().includes(q) || matchesNameInitials(name, q)) return true;
  const digits = phoneDigits(patient.phone);
  return /^\d{4,}$/.test(q) && Boolean(digits) && (q.length === 4 ? digits.endsWith(q) : digits.includes(q));
}
