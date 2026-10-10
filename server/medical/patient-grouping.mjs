import { check, identifier, string } from "../errors.mjs";

// Deterministic, explainable disease-group suggestions derived from the
// structured problem list (ICD-10 codes / diagnosis names) with a small
// medication fallback. Output is a draft for the doctor's tray — nothing is
// written until the proposal is confirmed.
const ICD_RULES = [
  { prefixes: ["I10"], keywords: ["高血压"], tag: "高血压" },
  { prefixes: ["E10", "E11", "E12", "E13", "E14"], keywords: ["糖尿病"], tag: "糖尿病" },
  { prefixes: ["C22"], keywords: ["肝癌", "肝细胞癌", "胆管细胞癌"], tag: "肝癌" },
  { prefixes: ["I48"], keywords: ["心房颤动", "房颤"], tag: "房颤" },
  { prefixes: ["I50"], keywords: ["心力衰竭", "心衰"], tag: "心力衰竭" },
  { prefixes: ["I20", "I21", "I22", "I23", "I24", "I25"], keywords: ["冠心病", "心肌梗死", "心绞痛"], tag: "冠心病" },
  { prefixes: ["I60", "I61", "I63", "I64"], keywords: ["脑梗死", "脑出血", "卒中"], tag: "脑卒中" },
  { prefixes: ["J44"], keywords: ["慢阻肺", "慢性阻塞性肺"], tag: "慢阻肺" },
  { prefixes: ["J45"], keywords: ["哮喘"], tag: "哮喘" },
  { prefixes: ["N18"], keywords: ["慢性肾脏病", "慢性肾衰竭"], tag: "慢性肾病" },
  { prefixes: ["K70", "K71", "K72", "K73", "K74"], keywords: ["肝硬化"], tag: "肝硬化" },
  { prefixes: ["B18"], keywords: ["乙型肝炎", "丙型肝炎", "乙肝", "丙肝"], tag: "病毒性肝炎" },
  { prefixes: ["K80"], keywords: ["胆囊结石", "胆管结石", "胆结石"], tag: "胆石症" },
  { prefixes: ["C16"], keywords: ["胃癌"], tag: "胃癌" },
  { prefixes: ["C18", "C19", "C20"], keywords: ["结直肠癌", "结肠癌", "直肠癌"], tag: "结直肠癌" },
  { prefixes: ["C25"], keywords: ["胰腺癌"], tag: "胰腺癌" },
  { prefixes: ["C34"], keywords: ["肺癌"], tag: "肺癌" },
  { prefixes: ["C61"], keywords: ["前列腺癌"], tag: "前列腺癌" },
  { prefixes: ["C67"], keywords: ["膀胱癌"], tag: "膀胱癌" },
  { prefixes: ["M81"], keywords: ["骨质疏松"], tag: "骨质疏松" },
];
// Only used when no diagnosis matched anything:常见慢病用药给出待核对分组。
const MED_HINTS = [
  { keywords: ["二甲双胍", "格列", "达格列净", "恩格列净", "胰岛素"], tag: "糖尿病待核对" },
  { keywords: ["氨氯地平", "硝苯地平", "缬沙坦", "氯沙坦", "厄贝沙坦", "培哚普利", "美托洛尔"], tag: "高血压待核对" },
  { keywords: ["索拉非尼", "仑伐替尼", "瑞戈非尼"], tag: "肝癌靶向治疗待核对" },
  { keywords: ["华法林", "利伐沙班", "达比加群"], tag: "抗凝治疗" },
  { keywords: ["阿司匹林", "氯吡格雷", "替格瑞洛"], tag: "抗血小板治疗" },
];

const normalize = (value) => String(value || "").toLowerCase();

function matchDiagnosis(diagnosis) {
  const code = String(diagnosis?.code || "").toUpperCase().replace(/\s/g, "");
  const name = typeof diagnosis === "string" ? diagnosis : String(diagnosis?.name || "");
  for (const rule of ICD_RULES) {
    if (
      (code && rule.prefixes.some((prefix) => code.startsWith(prefix))) ||
      rule.keywords.some((keyword) => name.toLowerCase().includes(keyword))
    )
      return { tag: rule.tag, code, name };
  }
  return null;
}

export function suggestGroups(patient) {
  const existing = new Set([...(patient.groups || []), ...(patient.tags || [])]);
  const matched = [];
  const tags = new Set();
  for (const diagnosis of patient.diagnoses || []) {
    const hit = matchDiagnosis(diagnosis);
    if (!hit || tags.has(hit.tag)) continue;
    tags.add(hit.tag);
    matched.push({ tag: hit.tag, code: hit.code, name: hit.name || "" });
  }
  if (!tags.size) {
    for (const medication of patient.medications || []) {
      if (medication.status === "stopped") continue;
      const name = normalize(medication?.name);
      if (!name) continue;
      for (const hint of MED_HINTS) {
        if (hint.keywords.some((keyword) => name.includes(keyword))) {
          tags.add(hint.tag);
          matched.push({ tag: hint.tag, code: "", name: medication.name });
          break;
        }
      }
    }
  }
  const addTags = [...tags].filter((tag) => !existing.has(tag));
  return { addTags, matched };
}

// Scan all live patients once; only patients with at least one new tag come
// back. baseRevision is captured so the tray confirm applies per-patient
// optimistic updates and reports conflicts instead of overwriting.
export function scanGroupSuggestions(patients) {
  const suggestions = [];
  for (const patient of patients.list()) {
    if (patient.archived) continue;
    const { addTags, matched } = suggestGroups(patient);
    if (!addTags.length) continue;
    suggestions.push({
      patientId: patient.id,
      name: patient.name,
      currentGroups: patient.groups || [],
      addTags,
      matched,
      baseRevision: patient.revision,
    });
  }
  return suggestions;
}

// Shared by the HTTP propose route and agent tools: validate a batch of
// tray assignments and pin each patient's revision at propose time.
export function normalizeGroupProposal(patients, payload = {}) {
  check(
    Array.isArray(payload.assignments) &&
      payload.assignments.length >= 1 &&
      payload.assignments.length <= 200,
    "INVALID_INPUT",
    "请选择 1–200 位患者",
  );
  const seen = new Set();
  return {
    assignments: payload.assignments.map((assignment) => {
      const patient = patients.row(identifier(assignment?.patientId));
      check(!seen.has(patient.id), "INVALID_INPUT", "患者列表有重复");
      seen.add(patient.id);
      const addTags = (Array.isArray(assignment.addTags) ? assignment.addTags : [])
        .map((tag) => string(tag, "分组", 40).trim())
        .filter(Boolean);
      check(
        addTags.length >= 1 && addTags.length <= 5,
        "INVALID_INPUT",
        `患者「${patient.name}」的分组建议须为 1–5 个`,
      );
      return { patientId: patient.id, name: patient.name, addTags, baseRevision: patient.revision };
    }),
  };
}
