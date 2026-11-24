// Pre-visit questionnaire: sent the day before a booked revisit so the doctor
// starts the visit from what the patient reports. It rides on the ordinary
// follow-up machinery (a one-off job with a questionnaire, source.kind
// "previsit"); the doctor still sends it and the answers are the patient's own
// words, never a clinical conclusion.
import { localCalendarDate } from "../../../shared/calendar-date.mjs";

export const PREVISIT_KIND = "previsit";

export const PREVISIT_BASE_QUESTIONS = [
  { id: "goal", text: "这次复诊最想解决的问题是什么？", type: "text", required: true },
  { id: "change", text: "上次看病以来，身体有没有新的不舒服或明显变化？", type: "single", required: true, options: [{ label: "有明显变化", score: 2 }, { label: "有一点", score: 1 }, { label: "没有", score: 0 }] },
  { id: "change_detail", text: "如果有，请简单说说是什么、从什么时候开始的（没有可不填）", type: "text", required: false },
  { id: "meds", text: "现在吃的药和上次医生开的一样吗？", type: "single", required: true, options: [{ label: "一样，按时吃", score: 0 }, { label: "一样，但经常漏吃", score: 1 }, { label: "自己改过或停过", score: 1 }, { label: "别处新开了药", score: 1 }] },
  { id: "reports", text: "这段时间有没有在别处做过检查？", type: "single", required: false, options: [{ label: "有，复诊时带上或拍照发来", score: 0 }, { label: "没有", score: 0 }] },
];

const MAX_EXTRA = 8;

// Disease-specific questions (from care packs) follow the common ones. Their
// ids are namespaced by the caller so they cannot collide with the base set.
export function previsitQuestionnaire(extraQuestions = []) {
  const extra = Array.isArray(extraQuestions) ? extraQuestions.slice(0, MAX_EXTRA) : [];
  return { title: "诊前问卷", replyWindowHours: 48, questions: [...PREVISIT_BASE_QUESTIONS, ...extra] };
}

// 09:00 local time the day before the visit; if that has already passed
// (booked for today or tomorrow morning) it fires a minute from now.
export function previsitDueAt(visitDate, now) {
  const due = new Date(`${visitDate}T09:00:00`);
  due.setDate(due.getDate() - 1);
  return Math.max(due.getTime(), now + 60000);
}

const answerText = (question, answer) => {
  if (!answer) return "";
  const value = Array.isArray(answer.value) ? answer.value.join("、") : `${answer.value}`;
  return question?.unit ? `${value} ${question.unit}` : value;
};

// Brief contribution: the pre-visit questionnaire for the patient's next (or
// just-past) visit, with answers once collected. Read-only.
export function previsitBrief(db, patientId, now) {
  const since = localCalendarDate(new Date(now - 86400000));
  for (const row of db.prepare("SELECT data FROM followup_surveys WHERE patient_id=? ORDER BY rowid DESC LIMIT 30").all(patientId)) {
    const survey = JSON.parse(row.data);
    if (survey.source?.kind !== PREVISIT_KIND || survey.source.visitDate < since || survey.status === "cancelled") continue;
    const expired = survey.status === "sent" && survey.expiresAt && Date.parse(survey.expiresAt) < now;
    return {
      surveyId: survey.id,
      visitDate: survey.source.visitDate,
      status: expired ? "expired" : survey.status,
      sentAt: survey.sentAt,
      collectedAt: survey.collectedAt,
      alert: survey.alert ? survey.alert.message : null,
      answers: survey.status === "collected"
        ? survey.questionnaire.questions
          .map((question) => ({ question: question.text, answer: answerText(question, (survey.answers || []).find((a) => a.questionId === question.id)) }))
          .filter((item) => item.answer)
        : [],
      source: `诊前问卷 ${survey.id}（患者自述）`,
    };
  }
  const job = db.prepare("SELECT data FROM follow_ups WHERE patient_id=? AND status IN ('active','running') AND json_extract(data,'$.source.kind')=? AND json_extract(data,'$.source.visitDate')>=? ORDER BY next_due LIMIT 1").get(patientId, PREVISIT_KIND, since);
  if (!job) return null;
  const data = JSON.parse(job.data);
  return { visitDate: data.source.visitDate, status: "scheduled", dueAt: new Date(data.nextDue).toISOString(), answers: [] };
}
