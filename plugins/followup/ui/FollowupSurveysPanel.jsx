import { followupDate, contactOutcomeLabels } from "../../../shared/followup-display.mjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { renderQuestionnaire } from "../../../shared/followup-survey-display.mjs";
import { api } from "../../../src/agent-runtime";

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
const CHANNEL_LABELS = { "wecom-contact": "企业微信客户联系", "wecom-kf": "微信客服", aibot: "企微机器人推送", wechat: "微信（已验证发送）", manual: "手动复制发送" };
const fmtTime = followupDate;

function answerOf(survey, questionId) {
  return (survey.answers || []).find((a) => a.questionId === questionId);
}

function CollectForm({ survey, busy, onSubmit, onCancel }) {
  const closed = ["collected", "cancelled"].includes(survey.status);
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
    if (closed) return;
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
      <p className="muted">按实际答案代填。确认回收将新增独立问卷记录，已有电话记录会保留。</p>
      {closed && <p role="status" className="muted">此问卷已结束，以下代填草稿未提交，已保留供你核对。</p>}
      {survey.questionnaire.questions.map((question, index) => (
        <fieldset key={question.id} disabled={busy || closed}>
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
        <button className="primary" type="submit" disabled={busy || closed}>确认回收并计分</button>
        <button className="secondary" type="button" disabled={busy} onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}

export function SurveyPanel(props) {
  return <PatientSurveys key={props.patientId} {...props} />;
}

function PatientSurveys({ patientId, refreshKey = 0, onRefresh, onChanged, focus, onClearFocus }) {
  const scope = JSON.stringify([patientId, focus?.patientId === patientId ? focus.reminderId || "" : "", focus?.patientId === patientId ? focus.surveyId || "" : ""]);
  const [surveyState, setSurveyState] = useState({ scope: "", rows: null });
  const surveys = surveyState.scope === scope ? surveyState.rows : null;
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [sendFor, setSendFor] = useState(null);
  const [fillFor, setFillFor] = useState(null);
  const [manual, setManual] = useState(null);
  const generation = useRef(0);
  const active = useRef(false);
  const panelRef = useRef(null);
  const focusedToken = useRef(null);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (focus?.patientId === patientId && focus.reminderId) params.set("reminderId", focus.reminderId);
      if (focus?.patientId === patientId && focus.surveyId) params.set("surveyId", focus.surveyId);
      const value = await api(`/api/patients/${patientId}/followup-surveys${params.size ? `?${params}` : ""}`);
      if (!active.current || request !== generation.current) return;
      setSurveyState({ scope, rows: value.surveys || [] });
      setLoadError("");
    } catch (error) {
      if (active.current && request === generation.current) setLoadError(error.message);
    } finally {
      if (active.current && request === generation.current) setLoading(false);
    }
  }, [patientId, focus?.patientId, focus?.reminderId, focus?.surveyId, scope]);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; generation.current++; };
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(() => { if (!document.hidden && !inFlight.current) load(); }, 15000);
    return () => { generation.current++; clearInterval(timer); };
  }, [load, refreshKey]);
  useEffect(() => {
    if (focus?.patientId === patientId && surveys !== null && focusedToken.current !== focus) {
      focusedToken.current = focus;
      panelRef.current?.scrollIntoView({ block: "start" }); panelRef.current?.focus({ preventScroll: true });
    }
  }, [focus, patientId, surveys]);
  const refreshPanels = () => onRefresh ? onRefresh() : load();
  const run = async (surveyId, action, { closeFill = false } = {}) => {
    if (inFlight.current) return;
    inFlight.current = true;
    generation.current++;
    setLoading(false);
    setBusy(true);
    setActionError("");
    let saved = false;
    try {
      const result = await action();
      saved = true;
      if (!active.current) return;
      const updated = result.survey || result;
      setSurveyState(current => current.scope === scope ? { ...current, rows: (current.rows || []).map(survey => survey.id === updated.id ? updated : survey) } : current);
      setSendFor(current => current === surveyId ? null : current);
      if (closeFill) setFillFor(current => current === surveyId ? null : current);
      if (result.text) setManual({ id: surveyId, text: result.text });
      else if (closeFill) setManual(current => current?.id === surveyId ? null : current);
      refreshPanels();
      await onChanged?.();
    } catch (error) {
      if (active.current) {
        setActionError(saved ? `操作已保存，但患者概况刷新失败：${error.message}` : error.message);
        if (error.code === "REVISION_CONFLICT") await load();
      }
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };
  const send = (survey, channel) => run(survey.id, () =>
    api(`/api/patients/${patientId}/followup-surveys/${survey.id}/send`, "POST", { channel, consent: true }));
  return (
    <section className="survey-panel" ref={panelRef} tabIndex={-1} aria-label="随访问卷">
      <div className="hub-section-head"><h3>随访问卷</h3><button className="text-button" disabled={busy || loading} onClick={refreshPanels}>刷新问卷</button></div>
      <p className="muted followup-help">到期后生成问卷；下发与代填需确认，收到完整回复后自动计分，超过阈值进入今日待办。</p>
      {focus?.patientId === patientId && <p className="muted">仅显示这次联系关联的问卷。<button className="text-button" onClick={onClearFocus}>查看全部问卷</button></p>}
      {loadError && <p role="alert" className="form-error">问卷读取失败：{loadError} <button className="text-button" disabled={busy || loading} onClick={refreshPanels}>重试读取问卷</button></p>}
      {actionError && <p role="alert" className="form-error">{actionError}</p>}
      {surveys === null && loading && <p role="status">正在读取问卷…</p>}
      {!!surveys?.length && (
        <ul className="survey-list">
          {surveys.map((survey) => (
            <li key={survey.id} data-survey-id={survey.id} className={`survey-card ${survey.alert ? "alerted" : ""}`}>
              <div className="survey-head">
                <b>{survey.questionnaire.title}</b>
                <span className={`badge survey-status ${survey.status}`}>{survey.status === "sent" && survey.channel === "manual" ? "手动渠道待回收" : STATUS_LABELS[survey.status] || survey.status}</span>
                {survey.score !== null && <span className="badge">得分 {survey.score}</span>}
                {survey.alert && <span className="badge danger">预警：{survey.alert.message}</span>}
              </div>
              <small className="muted">
                {survey.questionnaire.questions.length} 题 · 回收窗口 {survey.replyWindowHours} 小时
                {survey.channel ? ` · ${CHANNEL_LABELS[survey.channel] || survey.channel}` : ""}
                {survey.sentAt ? ` · ${survey.channel === "manual" ? "渠道登记于" : "发送于"} ${fmtTime(survey.sentAt)}` : ""}
                {survey.collectedAt ? ` · 回收于 ${fmtTime(survey.collectedAt)}` : ""}
              </small>
              {survey.status === "sent" && survey.channelDetail && <p className="muted">{survey.channelDetail}</p>}
              {["pending_send", "sent", "expired"].includes(survey.status) && survey.linkedReminder?.outcome && <details className="survey-contact-context" open>
                <summary>此轮已登记联系：{contactOutcomeLabels[survey.linkedReminder.outcome.status] || "结果待核对"} · {fmtTime(survey.linkedReminder.outcome.contactedAt || survey.linkedReminder.outcome.recordedAt)}；问卷仍为{STATUS_LABELS[survey.status]}</summary>
                <p className="muted">联系记录与问卷分别保存。可保留问卷、明确取消，或按实际答案代填；代填回收会新增独立的问卷联系记录，不覆盖电话记录。</p>
              </details>}
              {["pending_send", "sent", "expired"].includes(survey.status) && survey.linkedReminder?.status === "done" && !survey.linkedReminder.outcome && <p className="muted">此轮提醒已处理，未登记联系结果；问卷仍为{STATUS_LABELS[survey.status]}。</p>}
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
                  <button className="text-button danger" disabled={busy} onClick={() => run(survey.id, () => api(`/api/patients/${patientId}/followup-surveys/${survey.id}/cancel`, "POST", { revision: survey.revision }), { closeFill: true })}>取消问卷</button>
                </div>
              )}
              {survey.channel === "manual" && survey.sentAt && <div className="toolbar-actions"><button className="text-button" disabled={busy} onClick={() => setManual(current => current?.id === survey.id ? null : { id: survey.id, text: renderQuestionnaire(survey.questionnaire) })}>{manual?.id === survey.id ? "收起手动发送正文" : "查看手动发送正文"}</button></div>}
              {sendFor === survey.id && survey.status === "pending_send" && (
                <div className="survey-send">
                  {Object.entries(CHANNEL_LABELS).map(([channel, label]) => (
                    <button key={channel} className="secondary" disabled={busy} onClick={() => send(survey, channel)}>{label}</button>
                  ))}
                </div>
              )}
              {manual?.id === survey.id && (
                <div className="survey-manual">
                  <small className="muted">{["collected", "cancelled", "expired"].includes(survey.status) ? "以下为已登记问卷正文，仅供核对；重新查看不会重置回收时间。" : "手动渠道未自动发送消息。请自行复制以下正文，核对患者后发送；重新查看不会重置回收时间。"}</small>
                  <textarea aria-label="手动发送正文" readOnly rows={8} value={manual.text} onFocus={(e) => e.target.select()} />
                </div>
              )}
              {fillFor === survey.id && (
                <CollectForm
                  key={survey.id}
                  survey={survey}
                  busy={busy}
                  onCancel={() => setFillFor(null)}
                  onSubmit={(answers) => run(survey.id, () => api(`/api/patients/${patientId}/followup-surveys/${survey.id}/collect`, "POST", { answers }), { closeFill: true })}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {surveys !== null && !surveys.length && <p className="muted">{focus?.patientId === patientId ? "未找到此轮关联问卷，请核对当前患者与联系记录。" : "暂无问卷；给随访计划附加问卷后，到期会出现在这里。"}</p>}
    </section>
  );
}
