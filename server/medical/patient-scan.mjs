import { check } from "../errors.mjs";

// 确定性患者花名册扫描：把医生的分组意图（如「术后三个月内」「血糖未达
// 标」）转成结构化条件后由本地代码一次遍历完成，不逐患者调用模型。
// 每个命中都带可读依据行，供模型起草分组提案、医生在待确认面板核对。
const LAB_OPS = {
  ">": (a, b) => a > b,
  "<": (a, b) => a < b,
  ">=": (a, b) => a >= b,
  "<=": (a, b) => a <= b,
};
const OP_LABEL = { ">": ">", "<": "<", ">=": "≥", "<=": "≤" };

const days = (limit, name) => {
  check(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 3650,
    "INVALID_INPUT",
    `${name}须为 1–3650 天`,
  );
  return limit;
};
const keyword = (value, name) => {
  check(
    typeof value === "string" && value.trim().length >= 1 && value.length <= 60,
    "INVALID_INPUT",
    `${name}须为 1–60 字符的文本`,
  );
  return value.trim();
};
// 档案日期为 "YYYY-MM-DD"（clinicalDate 校验）；按当日零点比较，避免时区
// 把「90 天内」算成 89 天。无法解析的日期视为不在窗口内。
const withinDays = (date, limit, now) => {
  const time = Date.parse(`${date}T00:00:00`);
  return Number.isFinite(time) && time <= now && now - time <= limit * 86400000;
};

export function scanPatients(patients, criteria = {}, now = Date.now()) {
  check(
    criteria && typeof criteria === "object" && !Array.isArray(criteria),
    "INVALID_INPUT",
    "扫描条件无效",
  );
  const diagnosisContains =
    criteria.diagnosisContains === undefined ? null : keyword(criteria.diagnosisContains, "诊断关键词");
  const diagnosisWithinDays =
    criteria.diagnosisWithinDays === undefined ? null : days(criteria.diagnosisWithinDays, "诊断时间窗口");
  const visitReasonContains =
    criteria.visitReasonContains === undefined ? null : keyword(criteria.visitReasonContains, "就诊事由关键词");
  const visitWithinDays =
    criteria.visitWithinDays === undefined ? null : days(criteria.visitWithinDays, "就诊时间窗口");
  let lab = null;
  if (criteria.lab !== undefined) {
    check(
      criteria.lab && typeof criteria.lab === "object" && !Array.isArray(criteria.lab),
      "INVALID_INPUT",
      "检验条件无效",
    );
    const op = criteria.lab.op;
    check(
      typeof op === "string" && LAB_OPS[op],
      "INVALID_INPUT",
      "检验比较符须为 >、<、>=、<=",
    );
    check(
      typeof criteria.lab.value === "number" && Number.isFinite(criteria.lab.value),
      "INVALID_INPUT",
      "检验阈值必须为数字",
    );
    lab = {
      item: keyword(criteria.lab.item, "检验项目"),
      op,
      value: criteria.lab.value,
      withinDays:
        criteria.lab.withinDays === undefined ? null : days(criteria.lab.withinDays, "检验时间窗口"),
    };
  }
  const gender = criteria.gender;
  check(gender === undefined || ["male", "female", "unknown"].includes(gender), "INVALID_INPUT", "性别条件无效");
  const ageMin = criteria.ageMin === undefined ? null : ageBound(criteria.ageMin, "最小年龄");
  const ageMax = criteria.ageMax === undefined ? null : ageBound(criteria.ageMax, "最大年龄");
  const tag = criteria.tag === undefined ? null : keyword(criteria.tag, "标签");
  const group = criteria.group === undefined ? null : keyword(criteria.group, "分组");
  check(
    Boolean(
      diagnosisContains ||
        diagnosisWithinDays ||
        visitReasonContains ||
        visitWithinDays ||
        lab ||
        gender !== undefined ||
        ageMin !== null ||
        ageMax !== null ||
        tag ||
        group,
    ),
    "INVALID_INPUT",
    "至少提供一个扫描条件",
  );

  const year = new Date(now).getFullYear();
  const ageOf = (patient) =>
    patient.birthYear ? year - patient.birthYear : null;
  const matchesItem = (entry, contains, text) =>
    !contains || String(text || "").includes(contains);

  const matched = [];
  for (const patient of patients.all()) {
    if (patient.archived) continue;
    if (gender !== undefined && (patient.gender || "unknown") !== gender) continue;
    const age = ageOf(patient);
    if (ageMin !== null && (age === null || age < ageMin)) continue;
    if (ageMax !== null && (age === null || age > ageMax)) continue;
    if (tag && !(patient.tags || []).includes(tag)) continue;
    if (group && !(patient.groups || []).includes(group)) continue;
    const evidence = [];
    if (diagnosisContains || diagnosisWithinDays) {
      const hit = (patient.diagnoses || []).find(
        (d) =>
          matchesItem(d, diagnosisContains, d.name) &&
          (!diagnosisWithinDays || withinDays(d.date, diagnosisWithinDays, now)),
      );
      if (!hit) continue;
      evidence.push(
        `诊断「${hit.name}」${hit.date || "日期未记录"}${diagnosisWithinDays ? `（${diagnosisWithinDays} 天内）` : ""}`,
      );
    }
    if (visitReasonContains || visitWithinDays) {
      const hit = (patient.visits || []).find(
        (v) =>
          matchesItem(v, visitReasonContains, v.reason) &&
          (!visitWithinDays || withinDays(v.date, visitWithinDays, now)),
      );
      if (!hit) continue;
      evidence.push(
        `就诊「${hit.reason}」${hit.date || "日期未记录"}${visitWithinDays ? `（${visitWithinDays} 天内）` : ""}`,
      );
    }
    if (lab) {
      const hit = (patient.labs || []).find(
        (l) =>
          String(l.item || "").toLowerCase().includes(lab.item.toLowerCase()) &&
          LAB_OPS[lab.op](l.value, lab.value) &&
          (!lab.withinDays || withinDays(l.date, lab.withinDays, now)),
      );
      if (!hit) continue;
      evidence.push(
        `检验 ${hit.item} ${hit.value}${hit.unit ? hit.unit : ""}（${hit.date || "日期未记录"}）${OP_LABEL[lab.op]} ${lab.value}`,
      );
    }
    matched.push({
      id: patient.id,
      name: patient.name,
      patientNumber: patient.patientNumber || "",
      gender: patient.gender || "unknown",
      ...(age !== null ? { age } : {}),
      groups: patient.groups || [],
      tags: patient.tags || [],
      evidence,
    });
  }
  matched.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN") || a.id.localeCompare(b.id));
  return {
    total: matched.length,
    matched: matched.slice(0, 100),
    truncated: matched.length > 100,
    readOnly: true,
  };
}

function ageBound(value, name) {
  check(Number.isSafeInteger(value) && value >= 0 && value <= 150, "INVALID_INPUT", `${name}须为 0–150`);
  return value;
}
