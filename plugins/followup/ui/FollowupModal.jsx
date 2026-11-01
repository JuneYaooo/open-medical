import { followupDate } from "../../../shared/followup-display.mjs";
import { useRef, useState } from "react";
import { Modal } from "../../../src/components";
import { useClinicalDraft } from "../../../src/clinical-drafts";
import { api } from "../../../src/agent-runtime";
import { usePluginConnected } from "../../../src/plugin-slots.jsx";
import { AiConsentNote, useAiConsent } from "../../../src/ai-consent.jsx";
import { QuestionnaireEditor, buildQuestionnaire, emptyQuestionnaire } from "./QuestionnaireEditor.jsx";

export function FollowupModal({ patientId, job, source, existingSourceJob, onViewExisting, onClose, onCreated }) {
  const editing = Boolean(job);
  // Message summaries and questionnaires involve patient messages; without a
  // connected channel a plan is a reminder for the doctor only.
  const messaging = usePluginConnected("followup");
  // 全局已授权 AI 使用患者资料时，新计划默认到期自动生成摘要，不再单独勾选。
  const { granted: aiGranted } = useAiConsent();
  const toLocal = (iso) => {
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  const defaultDue = () => {
    const date = new Date(Date.now() + 86400000);
    // 提醒默认落在工作时段（次日上午 9 点），避免午夜 00:00 的无效提醒。
    date.setHours(9, 0, 0, 0);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  const [storedDraft, setStoredDraft] = useClinicalDraft(patientId, `followupPlan:${job?.id || (source ? `review:${source.reviewDate}` : "new")}`, null);
  const [initialDraft] = useState(() => ({
    form: (
    editing
      ? {
          name: job.name,
          once: job.once === true,
          intervalDays: job.intervalDays || 14,
          firstDueAt: toLocal(job.nextDue),
          checklist: (job.checklist || []).join("\n"),
          externalConsent: Boolean(job.externalConsent),
        }
      : {
          name: source ? `复评：${source.title || "治疗方案"}`.slice(0, 100) : "常规随访",
          once: Boolean(source),
          intervalDays: 14,
          firstDueAt: source ? `${source.reviewDate}T09:00` : defaultDue(),
          checklist: "",
          externalConsent: false,
        }
    ),
    withSurvey: false,
    questionnaire: emptyQuestionnaire(),
    requestId: crypto.randomUUID(),
    revision: job?.revision,
  }));
  const currentDraft = storedDraft || initialDraft;
  const { form, withSurvey, questionnaire } = currentDraft;
  const setForm = value => setStoredDraft({ ...currentDraft, form: value });
  const setWithSurvey = value => setStoredDraft({ ...currentDraft, withSurvey: value });
  const setQuestionnaire = value => setStoredDraft({ ...currentDraft, questionnaire: value });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const set = (key) => (e) =>
    setForm({
      ...form,
      [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value,
    });
  const submit = async (e) => {
    e.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setStoredDraft(currentDraft);
    setSaving(true);
    setError("");
    try {
    if (dueError) throw new Error(dueError);
    const payload = {
      name: form.name,
      ...(form.once ? {} : { intervalDays: Number(form.intervalDays) }),
      firstDueAt: new Date(form.firstDueAt).toISOString(),
      checklist: form.checklist
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
      let saved;
      if (editing) {
        saved = await api(
          `/api/patients/${patientId}/followups/${job.id}`,
          "PATCH",
          { ...payload, revision: currentDraft.revision },
        );
      } else {
        saved = await api(`/api/patients/${patientId}/followups`, "POST", {
          once: form.once === true,
          ...(source ? { source: { kind: "treatment-review", reviewDate: source.reviewDate } } : {}),
          ...payload,
          requestId: currentDraft.requestId,
          externalConsent: messaging && (form.externalConsent || (!editing && aiGranted)),
          ...(messaging && withSurvey
            ? { questionnaire: buildQuestionnaire(questionnaire) }
            : {}),
        });
      }
      setStoredDraft(null);
      await onCreated(saved);
    } catch (err) {
      setError(err.message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  if (existingSourceJob && !editing) return <Modal title="已有复评提醒" onClose={onClose}>
    <p>复评日期 {source.reviewDate} 已有「{existingSourceJob.name}」{existingSourceJob.status === "completed" ? "，提醒已触发" : "的提醒安排"}。如需另一次联系，可返回使用普通新建随访。</p>
    <p>{followupDate(existingSourceJob.nextDue)}</p><button className="primary" onClick={() => onViewExisting(existingSourceJob)}>查看现有计划</button>
  </Modal>;
  const due = Date.parse(form.firstDueAt), latestDue = Date.now() + 366 * 86400000;
  const dueError = !Number.isFinite(due) || due <= Date.now() || (!editing && due > latestDue)
    ? `首次随访须晚于当前时间${!editing ? `，且不晚于 ${followupDate(latestDue)}` : ""}；请核对 ${form.firstDueAt || "未填写的时间"}。` : "";
  return (
    <Modal
      title={editing ? "编辑随访计划" : "新建随访计划"}
      onClose={() => { if (!savingRef.current) onClose(); }}
    >
      <form className="modal-form" onSubmit={submit}>
        <fieldset disabled={saving}>
        {source && <p className="muted">来自已保存复评日期 {source.reviewDate}；09:00 为可修改的工作时段默认值。</p>}
        <label>提醒类型<select aria-label="提醒类型" value={form.once ? "once" : "repeat"} disabled={editing || Boolean(source)} onChange={event => setForm({ ...form, once: event.target.value === "once" })}><option value="once">单次提醒</option><option value="repeat">周期提醒</option></select></label>
        <label>
          计划名称
          <input value={form.name} onChange={set("name")} required autoFocus />
        </label>
        <div className="form-grid">
          {!form.once && <label>
            间隔天数
            <input
              type="number"
              min="1"
              max="3650"
              value={form.intervalDays}
              onChange={set("intervalDays")}
            />
          </label>}
          <label>
            首次随访时间
            <input
              type="datetime-local"
              required
              value={form.firstDueAt}
              onChange={set("firstDueAt")}
            />
          </label>
        </div>
        <label>
          随访要点（每行一条，如：血压记录、用药依从性、不良反应）
          <textarea
            rows={3}
            value={form.checklist}
            onChange={set("checklist")}
          />
        </label>
        {!editing && messaging && aiGranted && (
          <p className="muted">到期时自动用 AI 整理该患者待整理的消息并生成摘要。<AiConsentNote /></p>
        )}
        {!editing && messaging && !aiGranted && (
          <label className="consent">
            <input
              type="checkbox"
              checked={form.externalConsent}
              onChange={set("externalConsent")}
            />
            授权本计划到期时，自动把该患者待整理的消息原文发送给当前模型服务生成摘要（仅本次随访计划生效）
          </label>
        )}
        {!editing && messaging && (
          <label className="consent">
            <input
              type="checkbox"
              checked={withSurvey}
              onChange={(e) => setWithSurvey(e.target.checked)}
            />
            附带结构化随访问卷（到期生成，患者按题号回复自动计分，越界进今日待办）
          </label>
        )}
        {!editing && messaging && withSurvey && (
          <QuestionnaireEditor value={questionnaire} onChange={setQuestionnaire} />
        )}
        {dueError && <p role="alert" className="error-text">{dueError}</p>}
        {error && <p role="alert" className="error-text">{error}</p>}
        <button className="primary" disabled={saving}>
          {editing ? "保存修改" : "创建随访计划"}
        </button>
        <button type="button" className="secondary" onClick={() => { if (window.confirm("放弃本次输入与重试？已经保存的随访计划不会删除，请先核对已有计划。")) { setStoredDraft(null); onClose(); } }}>放弃本次输入与重试</button>
        </fieldset>
      </form>
    </Modal>
  );
}
