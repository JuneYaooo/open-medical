// Structured questionnaire builder for follow-up plans. The editor keeps a
// forgiving local shape; buildQuestionnaire() converts it into the server
// payload and throws a readable error when something required is missing.
export const emptyQuestion = (index) => ({
  key: `${Date.now()}-${index}-${Math.floor(Math.random() * 1e6)}`,
  text: "",
  type: "single",
  required: true,
  options: [
    { label: "没有", score: 0 },
    { label: "偶尔", score: 1 },
    { label: "经常", score: 2 },
  ],
  unit: "",
  alertEnabled: false,
  alertOp: "gt",
  alertValue: "",
});

const TYPE_LABELS = { single: "单选", multi: "多选", number: "数值", text: "简答" };

export function buildQuestionnaire(raw) {
  if (!raw.title.trim()) throw new Error("请填写问卷标题");
  const questions = raw.questions.map((question, index) => {
    if (!question.text.trim()) throw new Error(`第 ${index + 1} 题请填写题干`);
    const row = {
      id: `q${index + 1}`,
      text: question.text.trim(),
      type: question.type,
      required: question.required,
    };
    if (question.type === "single" || question.type === "multi") {
      const options = question.options
        .map((option) => ({ label: option.label.trim(), score: Number(option.score) || 0 }))
        .filter((option) => option.label);
      if (options.length < 2) throw new Error(`第 ${index + 1} 题请至少填写 2 个选项`);
      row.options = options;
    }
    if (question.type === "number") {
      if (question.unit.trim()) row.unit = question.unit.trim();
      if (question.alertEnabled) {
        const value = Number(question.alertValue);
        if (!Number.isFinite(value)) throw new Error(`第 ${index + 1} 题的预警阈值须为数值`);
        row.alertIf = { op: question.alertOp, value };
      }
    }
    return row;
  });
  const payload = { title: raw.title.trim(), questions, replyWindowHours: Number(raw.replyWindowHours) || 72 };
  if (raw.scoreAlertEnabled) {
    const value = Number(raw.scoreAlertValue);
    if (!Number.isFinite(value)) throw new Error("总分预警线须为数值");
    payload.scoring = {
      alert: {
        op: raw.scoreAlertOp,
        value,
        severity: raw.scoreAlertSeverity,
        message: raw.scoreAlertMessage.trim(),
      },
    };
  }
  return payload;
}

export function QuestionnaireEditor({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const setQuestion = (index, patch) =>
    set({ questions: value.questions.map((q, i) => (i === index ? { ...q, ...patch } : q)) });
  return (
    <div className="survey-editor">
      <div className="form-grid">
        <label>
          问卷标题
          <input value={value.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label>
          回收窗口（小时，超时标记过期）
          <input type="number" min="1" max="336" value={value.replyWindowHours} onChange={(e) => set({ replyWindowHours: e.target.value })} />
        </label>
      </div>
      {value.questions.map((question, index) => (
        <fieldset className="survey-question" key={question.key}>
          <legend>第 {index + 1} 题</legend>
          <div className="survey-question-row">
            <input aria-label={`第 ${index + 1} 题题干`} placeholder="题干，如：近一周是否有头晕？" value={question.text} onChange={(e) => setQuestion(index, { text: e.target.value })} />
            <select aria-label={`第 ${index + 1} 题类型`} value={question.type} onChange={(e) => setQuestion(index, { type: e.target.value })}>
              {Object.entries(TYPE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <label className="consent"><input type="checkbox" checked={question.required} onChange={(e) => setQuestion(index, { required: e.target.checked })} />必答</label>
            <button className="icon-button danger" type="button" title="删除本题" disabled={value.questions.length <= 1} onClick={() => set({ questions: value.questions.filter((_, i) => i !== index) })}>✕</button>
          </div>
          {(question.type === "single" || question.type === "multi") && (
            <div className="survey-options">
              {question.options.map((option, optionIndex) => (
                <span className="survey-option-row" key={optionIndex}>
                  <input aria-label={`第 ${index + 1} 题选项 ${optionIndex + 1}`} placeholder={`选项 ${optionIndex + 1}`} value={option.label} onChange={(e) => setQuestion(index, { options: question.options.map((o, i) => (i === optionIndex ? { ...o, label: e.target.value } : o)) })} />
                  <input type="number" step="any" title="该选项计入总分的分值" value={option.score} onChange={(e) => setQuestion(index, { options: question.options.map((o, i) => (i === optionIndex ? { ...o, score: e.target.value } : o)) })} />
                  <button className="icon-button" type="button" title="删除选项" disabled={question.options.length <= 2} onClick={() => setQuestion(index, { options: question.options.filter((_, i) => i !== optionIndex) })}>✕</button>
                </span>
              ))}
              <button className="text-button" type="button" disabled={question.options.length >= 12} onClick={() => setQuestion(index, { options: [...question.options, { label: "", score: 0 }] })}>+ 加选项</button>
              <small className="muted">分值计入总分；不需要计分就保持 0。</small>
            </div>
          )}
          {question.type === "number" && (
            <div className="survey-question-row">
              <input aria-label={`第 ${index + 1} 题单位`} placeholder="单位，如 mmHg" value={question.unit} onChange={(e) => setQuestion(index, { unit: e.target.value })} />
              <label className="consent"><input type="checkbox" checked={question.alertEnabled} onChange={(e) => setQuestion(index, { alertEnabled: e.target.checked })} />越界预警</label>
              {question.alertEnabled && <>
                <select aria-label={`第 ${index + 1} 题预警方向`} value={question.alertOp} onChange={(e) => setQuestion(index, { alertOp: e.target.value })}>
                  <option value="gt">高于</option>
                  <option value="lt">低于</option>
                </select>
                <input type="number" step="any" aria-label={`第 ${index + 1} 题预警阈值`} placeholder="阈值" value={question.alertValue} onChange={(e) => setQuestion(index, { alertValue: e.target.value })} />
              </>}
            </div>
          )}
        </fieldset>
      ))}
      <div className="toolbar-actions">
        <button className="secondary" type="button" disabled={value.questions.length >= 20} onClick={() => set({ questions: [...value.questions, emptyQuestion(value.questions.length)] })}>+ 添加题目</button>
      </div>
      <div className="survey-score-alert">
        <label className="consent"><input type="checkbox" checked={value.scoreAlertEnabled} onChange={(e) => set({ scoreAlertEnabled: e.target.checked })} />总分预警</label>
        {value.scoreAlertEnabled && <>
          <select aria-label="总分预警方向" value={value.scoreAlertOp} onChange={(e) => set({ scoreAlertOp: e.target.value })}>
            <option value="gte">达到</option>
            <option value="lte">低于</option>
          </select>
          <input type="number" step="any" aria-label="总分预警线" placeholder="预警线" value={value.scoreAlertValue} onChange={(e) => set({ scoreAlertValue: e.target.value })} />
          <select aria-label="预警严重度" value={value.scoreAlertSeverity} onChange={(e) => set({ scoreAlertSeverity: e.target.value })}>
            <option value="warning">提醒</option>
            <option value="critical">重要</option>
          </select>
          <input aria-label="预警说明" placeholder="预警说明，如：症状评分偏高，请尽快复核" value={value.scoreAlertMessage} onChange={(e) => set({ scoreAlertMessage: e.target.value })} />
        </>}
      </div>
    </div>
  );
}

export const emptyQuestionnaire = () => ({
  title: "随访问卷",
  replyWindowHours: 72,
  questions: [emptyQuestion(0)],
  scoreAlertEnabled: false,
  scoreAlertOp: "gte",
  scoreAlertValue: "",
  scoreAlertSeverity: "warning",
  scoreAlertMessage: "",
});
