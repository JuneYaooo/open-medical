import { sortDiagnoses } from "./diagnoses.mjs";

const excerpt = (value, length = 180) => typeof value === "string" && value.length > length ? `${value.slice(0, length)}…[节选，请查看原记录]` : value;
const bounded = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "string" ? excerpt(value, key === "source" ? 100 : 180) : value]));

// 医生在输入框里看到并可修改的请求。
export function briefRequest(purpose = "previsit") {
  return purpose === "postvisit"
    ? "请准备诊后文书包：①病历补充摘要；②面向患者、用词清楚的本次沟通说明；③待医生确认的随访事项清单。仅复述已有记录中的计划；未记录的处理决定明确留待医生填写。"
    : "请准备本次接诊：①用简短条目概括已知病史与最近变化；②列出本次需优先核对的信息缺口；③给出可向患者询问的问题。如附有诊前问卷回复，先单独概括患者自述的本次诉求与变化，并标明为患者自述、待核实。";
}

// 档案快照作为任务上下文随问题发送（规则在服务端 patient-brief 上下文里），
// 不再拼进输入框。
export function briefContext(brief, purpose = "previsit") {
  // Identity stays in the already associated patient workspace; the body only
  // carries bounded chart facts and explicit source references.
  const facts = {
    chartRevision: brief.revision, fingerprint: brief.fingerprint, capturedAt: brief.generatedAt,
    demographics: { birthYear: brief.identity?.birthYear || null, gender: brief.identity?.gender || "unknown" },
    diagnoses: sortDiagnoses(brief.diagnoses).slice(0, 6).map(bounded), medications: brief.medications.slice(0, 8).map(bounded),
    allergyStatus: brief.allergyStatus, allergies: brief.allergies,
    latestLabs: brief.labs.slice(0, 6).map((lab) => ({ ...bounded(lab), observations: lab.observations.slice(0, 3).map(bounded), previous: lab.previous ? bounded(lab.previous) : null })),
    recentVisits: brief.visits.slice(0, 3).map(bounded), recentFollowups: brief.outcomes.slice(0, 3).map((o) => ({ id: o.id, title: excerpt(o.title), status: o.status, contactMethod: o.contactMethod, clinical: Object.fromEntries(Object.entries(o.clinical || {}).map(([key, value]) => [key, excerpt(value, 500)])), note: excerpt(o.note, 500), contactedAt: o.contactedAt, recordedAt: o.recordedAt, source: o.source, addendumCount: o.addendumCount || 0, addenda: (o.addenda || []).slice(-3).map((a) => ({ id: a.id, recordedAt: a.recordedAt, note: excerpt(a.note, 400) })) })),
    careTasks: (brief.careTasks || []).slice(0, 3).map(bounded),
    unprocessedMessages: brief.messages.slice(0, 3).map((m) => ({ ...bounded(m), text: excerpt(m.text, 500) })), informationGaps: brief.gaps.map((g) => g.label), totals: brief.counts,
    // Patient-reported answers, kept apart from chart facts.
    previsitSurvey: brief.previsitSurvey?.status === "collected" ? { visitDate: brief.previsitSurvey.visitDate, collectedAt: brief.previsitSurvey.collectedAt, alert: excerpt(brief.previsitSurvey.alert, 300), source: brief.previsitSurvey.source, answers: (brief.previsitSurvey.answers || []).slice(0, 13).map((a) => ({ question: excerpt(a.question, 120), answer: excerpt(a.answer, 400) })) } : null,
  };
  const collections = ["latestLabs", "medications", "diagnoses", "recentFollowups", "unprocessedMessages", "recentVisits", "careTasks"];
  while (JSON.stringify(facts).length > 17500) {
    const largest = collections.filter((key) => facts[key].length).sort((a, b) => JSON.stringify(facts[b]).length - JSON.stringify(facts[a]).length)[0];
    if (!largest) break;
    facts[largest].pop();
    facts.additionalOmissionsForLength = true;
  }
  return {
    kind: "patient-brief",
    label: `档案快照 · ${String(brief.generatedAt || "").slice(0, 10) || "当前"}`,
    scope: { purpose },
    data: facts,
  };
}
