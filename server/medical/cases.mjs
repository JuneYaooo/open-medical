import { randomUUID } from "node:crypto";
import { check, string } from "../errors.mjs";
import { sortDiagnoses } from "../../shared/diagnoses.mjs";

// Local case library with similar-case search. Cases are structured
// snapshots (diagnosis, demographics, key labs, treatments, outcome) plus a
// free-text summary. Similarity is deterministic: diagnosis affinity first,
// then term-overlap scoring over the case text, with human-readable match
// reasons. Strictly advisory — retrieval support, not decision making.
export class CaseLibrary {
  constructor(store) {
    this.store = store;
  }
  row(id) {
    check(typeof id === "string" && id, "INVALID_INPUT", "病例编号无效");
    const row = this.store.db
      .prepare("SELECT data FROM case_library WHERE id=?")
      .get(id);
    check(row, "NOT_FOUND", "病例不存在", 404);
    return JSON.parse(row.data);
  }
  list({ query, diagnosis, limit = 30 } = {}) {
    check(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      "INVALID_INPUT",
      "返回数量须为 1–100",
    );
    let cases = this.store.db
      .prepare("SELECT data FROM case_library")
      .all()
      .map((row) => JSON.parse(row.data));
    if (diagnosis)
      cases = cases.filter((item) =>
        (item.diagnosis || "").toLowerCase().includes(String(diagnosis).toLowerCase()),
      );
    if (query) {
      const text = string(query, "检索词", 200);
      const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
      cases = cases
        .map((item) => {
          const lower = item.text.toLowerCase();
          const score = terms.reduce(
            (sum, term) => sum + (lower.split(term).length - 1),
            0,
          );
          return { ...item, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);
    } else {
      cases = cases.sort((a, b) => b.createdAt - a.createdAt);
    }
    return { count: cases.length, cases: cases.slice(0, limit) };
  }
  get(id) {
    return this.row(id);
  }
  addCase(input = {}) {
    const diagnosis = string(input.diagnosis, "主要诊断", 200);
    const summary = input.summary ? string(input.summary, "病例摘要", 5000) : "";
    const caseRecord = {
      id: randomUUID(),
      patientId: input.patientId ? string(input.patientId, "患者编号", 100) : null,
      patientName: input.patientName ? string(input.patientName, "患者标识", 80) : null,
      sessionId: input.sessionId || null,
      diagnosis,
      icd10: input.icd10 ? string(input.icd10, "ICD 编码", 20) : "",
      age: optionalAge(input.age),
      gender: input.gender || null,
      keyLabs: structuredKeyLabs(input.keyLabs),
      treatments: stringsList(input.treatments, "治疗", 20, 200),
      outcome: input.outcome ? string(input.outcome, "结局", 500) : "",
      summary,
      createdAt: Date.now(),
      revision: 0,
    };
    caseRecord.text = composeText(caseRecord);
    this.store.db
      .prepare("INSERT INTO case_library(id,data) VALUES (?,?)")
      .run(caseRecord.id, JSON.stringify(caseRecord));
    return caseRecord;
  }
  // Build a case from the patient's structured record. The snapshot keeps a
  // point-in-time copy; identity stays limited to a display name.
  fromPatient(patient, { summary, outcome } = {}) {
    // The case library keys similarity on the primary diagnosis, so an
    // incidental imaging finding must not outrank the confirmed disease.
    const primary = sortDiagnoses(patient.diagnoses || [])[0];
    return this.addCase({
      patientId: patient.id,
      patientName: patient.name,
      diagnosis: primary ? primary.name : "未标注诊断",
      icd10: primary?.code || "",
      age: patient.birthYear ? new Date().getFullYear() - patient.birthYear : null,
      gender: patient.gender || null,
      keyLabs: (patient.labs || []).slice(-10).map((lab) => ({
        item: lab.item,
        value: lab.value,
        ...(lab.unit ? { unit: lab.unit } : {}),
        date: lab.date,
      })),
      treatments: (patient.medications || []).map(
        (med) => [med.name, med.dose, med.frequency].filter(Boolean).join(" "),
      ),
      outcome: outcome || "",
      summary,
    });
  }
  removeCase(id) {
    this.row(id);
    this.store.db.prepare("DELETE FROM case_library WHERE id=?").run(id);
    return { ok: true };
  }
  // Similar-case search: optional structured narrowing plus deterministic
  // term-overlap scoring with explicit match reasons.
  similar({ caseText, diagnosis, age, gender, limit = 5, excludePatientId } = {}) {
    const text = string(caseText, "病例描述", 4000);
    check(
      Number.isInteger(limit) && limit >= 1 && limit <= 20,
      "INVALID_INPUT",
      "返回数量须为 1–20",
    );
    const terms = text
      .toLowerCase()
      .split(/[\s,，、;；.。]+/)
      .filter((term) => term.length >= 2);
    const diagnosisNeedle = diagnosis
      ? String(diagnosis).toLowerCase().trim()
      : null;
    const library = this.store.db.prepare("SELECT data FROM case_library").all().map((row) => ({ ...JSON.parse(row.data), sourceType: "local-case-library" }));
    const charts = this.store.db.prepare("SELECT data FROM patients").all().map((row) => JSON.parse(row.data))
      .filter((p) => !p.archived && p.id !== excludePatientId && p.diagnoses?.length)
      .map((p) => {
        const item = { id: `patient:${p.id}`, patientId: p.id, sourceType: "local-patient-chart",
          diagnosis: p.diagnoses.map((d) => d.name).join("；"), icd10: p.diagnoses[0]?.code || "",
          age: p.birthYear ? new Date().getFullYear() - p.birthYear : null, gender: p.gender,
          keyLabs: (p.labs || []).slice(-10), treatments: (p.medications || []).map((m) => `${m.name}（${m.status || "unknown"}）`),
          summary: "", outcome: "", createdAt: new Date(p.updatedAt).getTime() };
        item.text = composeText(item);
        return item;
      });
    const chartIds = new Set(charts.map((p) => p.patientId));
    const scored = [...charts, ...library.filter((item) => (!excludePatientId || item.patientId !== excludePatientId) && !chartIds.has(item.patientId))]
      .map((item) => {
        const reasons = [];
        let score = 0;
        const lower = item.text.toLowerCase();
        const hitTerms = [];
        for (const term of terms) {
          const occurrences = lower.split(term).length - 1;
          if (occurrences > 0) {
            score += occurrences;
            if (!hitTerms.includes(term)) hitTerms.push(term);
          }
        }
        const diagnosisHit =
          diagnosisNeedle &&
          (item.diagnosis || "").toLowerCase().includes(diagnosisNeedle);
        if (diagnosisHit) {
          score += 5;
          reasons.push(`诊断匹配：${item.diagnosis}`);
        }
        // Demographic affinity only ranks candidates that already share a
        // clinical signal (text or diagnosis) — never admits on its own.
        if (score > 0) {
          if (Number.isFinite(item.age) && Number.isFinite(age)) {
            if (Math.abs(item.age - age) <= 10) {
              score += 2;
              reasons.push(`年龄接近（${item.age} vs ${age}）`);
            }
          }
          if (gender && item.gender && item.gender === gender) {
            score += 1;
            reasons.push("性别相同");
          }
        }
        if (hitTerms.length)
          reasons.push(`术语命中：${hitTerms.slice(0, 5).join("、")}`);
        return { case: item, score, reasons };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return {
      count: scored.length,
      matches: scored.map(({ case: item, score, reasons }) => ({
        caseId: item.id,
        sourceType: item.sourceType,
        verification: "candidate-needs-clinical-review",
        diagnosis: item.diagnosis,
        icd10: item.icd10,
        age: item.age,
        gender: item.gender,
        keyLabs: item.keyLabs,
        treatments: item.treatments,
        outcome: item.outcome,
        summary: item.summary,
        createdAt: item.createdAt,
        score,
        reasons,
      })),
      note: "相似病例为本地确定性检索（诊断加权 + 术语重合）。主轴核验优先：先确认候选与患者为同一主要疾病/综合征，症状或检验的相似不能弥补主轴不符；文本缺失视为未知而非不匹配。仅用于提出假设，不构成诊疗建议。",
    };
  }
  counts() {
    return {
      cases: this.store.db.prepare("SELECT COUNT(*) n FROM case_library").get()?.n || 0,
    };
  }
}

function composeText(caseRecord) {
  return [
    caseRecord.diagnosis,
    caseRecord.icd10,
    caseRecord.summary,
    ...(caseRecord.treatments || []),
    ...(caseRecord.keyLabs || []).map((lab) => `${lab.item} ${lab.value ?? ""}`),
    caseRecord.outcome,
  ]
    .filter(Boolean)
    .join("\n");
}
function optionalAge(value) {
  if (value === undefined || value === null || value === "") return null;
  check(
    Number.isInteger(value) && value >= 0 && value <= 120,
    "INVALID_INPUT",
    "年龄须为 0–120 整数",
  );
  return value;
}
function stringsList(value, label, maxCount, maxLen) {
  if (value === undefined || value === null) return [];
  check(Array.isArray(value) && value.length <= maxCount, "INVALID_INPUT", `${label}最多 ${maxCount} 条`);
  return value.map((item) => string(item, label, maxLen)).filter(Boolean);
}
function structuredKeyLabs(value) {
  if (value === undefined || value === null) return [];
  check(Array.isArray(value) && value.length <= 20, "INVALID_INPUT", "关键检验最多 20 条");
  return value.map((lab) => {
    check(
      lab && typeof lab === "object" && !Array.isArray(lab) && typeof lab.value === "number",
      "INVALID_INPUT",
      "关键检验格式无效",
    );
    return {
      item: string(lab.item, "检验项目", 60),
      value: lab.value,
      ...(lab.unit ? { unit: string(lab.unit, "单位", 30) } : {}),
      ...(lab.date ? { date: string(lab.date, "日期", 10) } : {}),
    };
  });
}

export function caseTools(cases) {
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
  const intDef = { type: "integer" };
  return [
    {
      definition: definition(
        "similar_case_search",
        "在本地病例库中搜索相似病例（诊断加权 + 术语重合的确定性检索），返回带匹配理由的参考病例。",
        {
          caseText: textDef,
          diagnosis: textDef,
          age: intDef,
          gender: textDef,
          limit: intDef,
        },
        ["caseText"],
      ),
      execute: (args, context = {}) => cases.similar({ ...args, excludePatientId: context.patientId }),
    },
  ];
}
