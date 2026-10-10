import { useEffect, useState } from "react";
import { api } from "./agent-runtime";

// Per-patient follow-up survey queue: send the questionnaire through a
// verified channel (or copy it manually), collect replies (auto-collected
// ones land here too), fill answers on behalf of phone follow-ups, and
// confirm model-parsed drafts before they count.
const STATUS_LABELS = {
  pending_send: "待下发",
  sent: "已发送待回收",
  expired: "已过期",
  collected: "已回收",
  cancelled: "已取消",
};
const CHANNEL_LABELS = { manual: "手动复制发送", wechat: "微信（已验证发送）", aibot: "企微机器人推送" };
const fmtTime = (value) => (value ? new Date(value).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" }) : "");

function answerOf(survey, questionId) {
  return (survey.answers || []).find((a) => a.questionId === questionId);
}

function CollectForm({ survey, busy, onSubmit, onCancel }) {
  const [values, setValues] = useState(() => {
    const initial = {};
    for (const question of survey.questionnaire.questions) {
      const existing = answerOf(survey, question.id);
      initial[question.id] =
        question.type === "single" || question.type === "multi"
          ? existing?.value || (question.type === "multi" ? [] : "")
          : existing?.value ?? "";
    }
    return initial;
  });
  const set = (questionId, value) => setValues((old) => ({ ...old, [questionId]: value }));
  const submit = (event) => {
    event.preventDefault();
    const answers = survey.questionnaire.questions
      .filter((question) => {
        const value = values[question.id];
        if (question.type === "multi") return Array.isArray(value) && value.length;
        return value !== "" && value !== null && value !== undefined;
      })
      .map((question) => ({
        questionId: question.id,
        value: values[question.id],
        confidence: "manual",
      }));
    onSubmit(answers);
  };
  return (
    <form className="survey-collect" onSubmit={submit}>
      {survey.questionnaire.questions.map((question, index) => (
        <fieldset key={question.id}>
          <legend>{index + 1}. {question.text}{question.required ? " *" : ""}</legend>
          {question.type === "single" && (
            <select value={values[question.id]} onChange={(e) => set(question.id, e.target.value)}>
              <option value="">未作答</option>
              {question.options.map((option) => <option key={option.label} value={option.label}>{option.label}{option.score ? `（${option.score} 分）` : ""}</option>)}
            </select>
          )}
          {question.type === "multi" && (
            <div className="survey-multi">
              {question.options.map((option) => (
                <label key={option.label} className="consent">
                  <input type="checkbox" checked={values[question.id]?.includes(option.label)} onChange={(e) => set(question.id, e.target.checked ? [...(values[question.id] || []), option.label] : (values[question.id] || []).filter((v) => v !== option.label))} />
                  {option.label}{option.score ? `（${option.score} 分）` : ""}
                </label>
              ))}
            </div>
          )}
          {question.type === "number" && (
            <span className="survey-number">
              <input type="number" step="any" value={values[question.id]} onChange={(e) => set(question.id, e.target.value === "" ? "" : Number(e.target.value))} />
              {question.unit && <small>{question.unit}</small>}
            </span>
          )}
          {question.type === "text" && (
            <input value={values[question.id] || ""} onChange={(e) => set(question.id, e.target.value)} />
          )}
        </fieldset>
      ))}
      <div className="toolbar-actions">
        <button className="primary" type="submit" disabled={busy}>确认回收并计分</button>
        <button className="secondary" type="button" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}

export function SurveyPanel({ patientId, onChanged, onError }) {
  const [surveys, setSurveys] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sendFor, setSendFor] = useState(null);
  const [fillFor, setFillFor] = useState(null);
  const [manualText, setManualText] = useState("");
  const load = () =>
    api(`/api/patients/${patientId}/followup-surveys`)
      .then((s) => setSurveys(s.surveys || []))
      .catch((e) => onError?.(e.message));
  useEffect(() => {
    setSurveys(null);
    load();
  }, [patientId]);
  const run = async (action) => {
    setBusy(true);
    try {
      await action();
      setSendFor(null);
      setFillFor(null);
      setManualText("");
      await load();
      onChanged?.();
    } catch (e) {
      onError?.(e.message);
    } finally {
      setBusy(false);
    }
  };
  const send = (survey, channel) =>
    run(async () => {
      const result = await api(`/api/patients/${patientId}/followup-surveys/${survey.id}/send`, "POST", { channel, consent: true });
      if (result.text) setManualText(result.text);
    });
  return (
    <section className="survey-panel" aria-label="随访问卷">
      <h3>随访问卷</h3>
      <p className="muted">带问卷的随访到期后在这里下发；患者按题号回复会被自动回收计分，越界即进今日待办。回收与发送都必须由你确认。</p>
      {surveys === null && <p role="status">正在读取问卷…</p>}
      {!!surveys?.length && (
        <ul className="survey-list">
          {surveys.map((survey) => (
            <li key={survey.id} className={`survey-card ${survey.alert ? "alerted" : ""}`}>
              <div className="survey-head">
                <b>{survey.questionnaire.title}</b>
                <span className={`badge survey-status ${survey.status}`}>{STATUS_LABELS[survey.status] || survey.status}</span>
                {survey.score !== null && <span className="badge">得分 {survey.score}</span>}
                {survey.alert && <span className="badge danger">预警：{survey.alert.message}</span>}
              </div>
              <small className="muted">
                {survey.questionnaire.questions.length} 题 · 回收窗口 {survey.replyWindowHours} 小时
                {survey.channel ? ` · ${CHANNEL_LABELS[survey.channel] || survey.channel}` : ""}
                {survey.sentAt ? ` · 发送于 ${fmtTime(survey.sentAt)}` : ""}
                {survey.collectedAt ? ` · 回收于 ${fmtTime(survey.collectedAt)}` : ""}
              </small>
              {survey.status === "collected" && (
                <ol className="survey-answers">
                  {survey.questionnaire.questions.map((question) => {
                    const answer = answerOf(survey, question.id);
                    return (
                      <li key={question.id}>
                        <span className="muted">{question.text}：</span>
                        {answer
                          ? Array.isArray(answer.value)
                            ? answer.value.join("、")
                            : `${answer.value}${question.unit || ""}`
                          : "未作答"}
                      </li>
                    );
                  })}
                </ol>
              )}
              {["pending_send", "sent", "expired"].includes(survey.status) && (
                <div className="toolbar-actions">
                  {!survey.answers?.length && survey.status === "pending_send" && (
                    <button className="secondary" disabled={busy} onClick={() => setSendFor(sendFor === survey.id ? null : survey.id)}>{sendFor === survey.id ? "收起" : "下发问卷"}</button>
                  )}
                  <button className="secondary" disabled={busy} onClick={() => setFillFor(fillFor === survey.id ? null : survey.id)}>{fillFor === survey.id ? "收起" : survey.answers?.length ? "补录 / 代填" : "代填（电话随访）"}</button>
                  <button className="text-button danger" disabled={busy} onClick={() => run(() => api(`/api/patients/${patientId}/followup-surveys/${survey.id}/cancel`, "POST", { revision: survey.revision }))}>取消问卷</button>
                </div>
              )}
              {sendFor === survey.id && (
                <div className="survey-send">
                  {Object.entries(CHANNEL_LABELS).map(([channel, label]) => (
                    <button key={channel} className="secondary" disabled={busy} onClick={() => send(survey, channel)}>{label}</button>
                  ))}
                </div>
              )}
              {manualText && sendFor === survey.id && (
                <div className="survey-manual">
                  <small className="muted">已选择手动渠道：请复制以下内容，粘贴到与该患者的聊天窗口发送：</small>
                  <textarea readOnly rows={8} value={manualText} onFocus={(e) => e.target.select()} />
                </div>
              )}
              {fillFor === survey.id && (
                <CollectForm
                  survey={survey}
                  busy={busy}
                  onCancel={() => setFillFor(null)}
                  onSubmit={(answers) => run(() => api(`/api/patients/${patientId}/followup-surveys/${survey.id}/collect`, "POST", { answers }))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {surveys !== null && !surveys.length && <p className="muted">暂无问卷；给随访计划附加问卷后，到期会出现在这里。</p>}
    </section>
  );
}
