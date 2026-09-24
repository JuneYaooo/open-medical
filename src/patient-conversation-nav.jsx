import { patientQuestions } from "../shared/patient-conversations.mjs";
export function PatientConversationNav({ session, runId, busy, onSelect }) {
  const questions = patientQuestions(session);
  const current = session.runs.find(run => run.id === runId);
  const canContinue = current?.status === "completed" && current?.mode !== "local";
  return <section className="patient-question-nav" aria-label="患者问答">
    <div className="patient-question-actions">
      <div><strong>{runId ? "当前问答" : "问一个新问题"}</strong><p>{busy ? "正在处理当前问题，可在下方补充要求。" : runId ? (canContinue ? "下方输入将继续这段问答。" : "已保存这次记录；再次发送会独立开始。") : "使用患者档案和所选资料，独立回答本次问题。"}</p></div>
      <button className="secondary" disabled={busy || !runId} onClick={() => onSelect(null)}>＋ 问新问题</button>
    </div>
    {!!questions.length && <details className="patient-question-history">
      <summary>以前的问答 · {questions.length}</summary>
      <p>选择一段查看；已完成的回答可以继续追问。</p>
      <div>{questions.map(question => <button key={question.id} disabled={busy} aria-current={runId === question.id ? "true" : undefined} onClick={e => { onSelect(question.id); e.currentTarget.closest("details").open = false; }}>
        <span>{question.title}</span><small>{question.status === "completed" ? (question.mode === "local" ? "查看记录" : "查看 / 追问") : "查看未完成问答"}</small>
      </button>)}</div>
    </details>}
  </section>;
}
