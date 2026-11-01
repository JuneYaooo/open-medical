import { followupDate } from "../../../shared/followup-display.mjs";
import { useCallback, useEffect, useRef, useState } from "react";
import { patientOptionLabel } from "../../../src/patient-labels";
import { useClinicalDraft } from "../../../src/clinical-drafts";
import { api } from "../../../src/agent-runtime";

const outcomeLabels = {
  completed: "已完成随访",
  unreachable: "未联系上",
  declined: "患者暂不接受",
};
const date = followupDate;
// Urgency of a pending reminder relative to now: overdue days or due today.
function dueState(record, now = Date.now()) {
  if (record.outcome || record.kind === "manual-contact" || !record.dueAt) return null;
  const due = new Date(record.dueAt).getTime();
  if (!Number.isFinite(due)) return null;
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startOfToday.getTime() - due) / 86400000) + 1;
  if (due < startOfToday.getTime()) return { tone: "overdue", label: `已逾期 ${Math.max(1, days)} 天` };
  if (due < startOfToday.getTime() + 86400000) return { tone: "due", label: "今天到期" };
  return null;
}
// 下次联系时间快捷选项：从今天上午 9 点起算，填入 datetime-local 格式。
const NEXT_CONTACT_CHIPS = [["+1周", 7, 0], ["+2周", 14, 0], ["+1月", 0, 1], ["+3月", 0, 3]];
const nextContactAt = (days, months, from = new Date()) => {
  const d = new Date(from.getFullYear(), from.getMonth() + months, from.getDate() + days, 9, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
};
// 已完成联系并勾选了核对条目时，文字记录可以不填（服务端同样放行）。
const noteOptional = (form) => form.status === "completed" && form.checkedItems?.length > 0;
const contactForm = (record = {}) => ({ requestId: crypto.randomUUID(), title: "主动联系记录", contactedAt: "", status: record.attempt ? "" : "completed", note: "", contactMethod: "unspecified", clinical: { symptoms: "", medications: "", results: "", plan: "" }, checkedItems: [], nextDueAt: "", nextName: "后续随访", noRetryReason: "" });
const hasContactInput = form => [form.note, form.contactedAt, form.nextDueAt, form.noRetryReason, ...Object.values(form.clinical || {})].some(value => String(value || "").trim()) || form.checkedItems?.length || (form.title && form.title !== "主动联系记录") || (form.contactMethod && form.contactMethod !== "unspecified") || (form.status && form.status !== "completed");

// A reminder firing is a scheduling event. A clinical follow-up is only
// recorded when the doctor submits its outcome, checklist and notes.
export function FollowupRecords({
  patientId,
  refreshKey = 0,
  onRefresh,
  onChanged,
  onOpenPatient,
  onOpenTask,
  onViewSurvey,
}) {
  const [savedSurveyTarget, setSavedSurveyTarget] = useState(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [contactPatients, setContactPatients] = useState(null);
  const [contactsLoading, setContactsLoading] = useState(false), [contactError, setContactError] = useState("");
  const [records, setRecords] = useState(null);
  const [query, setQuery] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const generation = useRef(0);
  const loadedView = useRef("");
  const [addendum, setAddendum] = useClinicalDraft(patientId || "global", "followupAddendum", null);
  const [addendumNote, setAddendumNote] = useClinicalDraft(patientId || "global", "followupAddendumNote", "");
  const [history, setHistory] = useState(Boolean(addendum));
  const [editing, setEditing] = useClinicalDraft(patientId || "global", "followupEditing", null);
  const [form, setForm] = useClinicalDraft(patientId || "global", "followupForm", {});
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loadContacts = useCallback(async () => {
    setContactsLoading(true); setContactError("");
    try {
      const value = await api("/api/patients?summary=1");
      if (mounted.current) setContactPatients(value.patients.filter(patient => !patient.archived));
    } catch (err) { if (mounted.current) setContactError(`联系患者列表读取失败：${err.message}`); }
    finally { if (mounted.current) setContactsLoading(false); }
  }, []);
  const globalContact = Boolean(editing?.manual && !patientId);
  useEffect(() => { if (globalContact) loadContacts(); }, [globalContact, loadContacts]);
  const contactAvailable = !globalContact || (!contactsLoading && !contactError && contactPatients?.some(patient => patient.id === editing.patientId));
  const refresh = async () => {
    const request = ++generation.current;
    const value = await api(
      `/api/reminders?${new URLSearchParams({ status: history ? "done" : "pending", limit: "20", offset: String(offset), q: query, outcome: history ? outcomeFilter : "", ...(patientId ? { patientId } : {}) })}`,
    );
    if (request !== generation.current) return;
    if (!value.reminders.length && offset > 0) {
      setOffset(Math.max(0, offset - 20));
      return;
    }
    setRecords(value);
    setError("");
  };
  useEffect(() => {
    const view = JSON.stringify([patientId, history, offset, query, outcomeFilter]);
    if (loadedView.current !== view) setRecords(null);
    loadedView.current = view;
    refresh().catch((err) => setError(err.message));
    const timer = setInterval(() => {
      if (!document.hidden) refresh().catch((err) => setError(err.message));
    }, 15000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [patientId, history, offset, query, outcomeFilter, refreshKey]);
  const saveAddendum = async (event) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`/api/reminders/${addendum.id}/addendum`, "POST", {
        expectedRevision: addendum.outcome.revision || 0,
        requestId: addendum.requestId,
        note: addendumNote,
      });
      setAddendum(null);
      setAddendumNote("");
      setNotice("补充记录已保存，原记录保留。");
      if (onRefresh) onRefresh(); else await refresh();
      await onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const save = async (event) => {
    event.preventDefault();
    if (inFlight.current || !contactAvailable) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await api(
        editing.manual
          ? `/api/patients/${patientId || editing.patientId}/followup-records`
          : `/api/reminders/${editing.id}/complete`,
        "POST",
        {
          ...form,
          ...(form.status !== "completed" ? { clinical: {}, checkedItems: [] } : {}),
          contactedAt: form.contactedAt
            ? new Date(form.contactedAt).toISOString()
            : undefined,
          nextDueAt: form.nextDueAt
            ? new Date(form.nextDueAt).toISOString()
            : undefined,
        },
      );
      setEditing(null); setForm({});
      if (!mounted.current) return;
      setSavedSurveyTarget(null);
      if (!editing.manual && onViewSurvey) {
        try {
          const linked = await api(`/api/patients/${patientId || editing.patientId}/followup-surveys?reminderId=${encodeURIComponent(editing.id)}`);
          if (!mounted.current) return;
          if (linked.surveys.length) setSavedSurveyTarget({ patientId: patientId || editing.patientId, reminderId: editing.id });
        } catch { if (mounted.current) setError("联系结果已保存；暂未读到此轮问卷，请刷新问卷列表核对。"); }
      }
      if (!mounted.current) return;
      setNotice(
        "随访结果已保存，可在随访记录中查看。" +
          (form.nextDueAt ? "下次提醒已安排。" : ""),
      );
      if (onRefresh) onRefresh(); else await refresh();
      await onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const begin = (record) => {
    setSavedSurveyTarget(null);
    setEditing(record);
    setNotice("");
    setError("");
    setForm(contactForm(record));
  };
  return (
    <section className="followup-records" aria-label="随访结果登记">
      <div className="hub-section-head">
        <h3>随访待办与记录</h3>
        {records?.counts.pending > 0 && !history && <span className="om-chip is-caution">{records.counts.pending} 条待登记</span>}
        <button
          className="secondary"
          disabled={busy || Boolean(editing) || Boolean(addendum)}
          onClick={() => {
            begin({
              manual: true,
              patientId: patientId || "",
              patientName: patientId ? "本患者" : "选择患者",
              title: "记录一次联系",
              checklist: [],
            });
          }}
        >
          记录一次联系
        </button>
        <button
          className="om-link"
          disabled={busy || Boolean(editing)}
          onClick={() => onRefresh ? onRefresh() : refresh().catch((err) => setError(err.message))}
        >
          刷新
        </button>
      </div>
      <p className="muted followup-help">
        提醒到期后登记实际联系结果；记录留在患者档案，不会发送给患者。
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="form-notice">
          {notice}
          {savedSurveyTarget && onViewSurvey && <button className="text-button" onClick={() => onViewSurvey(savedSurveyTarget)}>查看此轮问卷</button>}
        </p>
      )}
      <div className="tab-row">
        <button
          aria-pressed={!history}
          className={!history ? "active" : ""}
          disabled={busy || Boolean(editing) || Boolean(addendum)}
          onClick={() => {
            setHistory(false);
            setOffset(0);
          }}
        >
          待登记 {records?.counts.pending ?? "—"}
        </button>
        <button
          aria-pressed={history}
          className={history ? "active" : ""}
          disabled={busy || Boolean(editing) || Boolean(addendum)}
          onClick={() => {
            setHistory(true);
            setOffset(0);
          }}
        >
          随访记录 {records?.counts.done ?? "—"}
        </button>
      </div>
      <div className="followup-record-filters">
        {!patientId && (
          <label className="followup-search">
            <span className="sr-only">查找患者或随访主题</span>
            <input
              type="search"
              placeholder="查找患者或随访主题"
              aria-label="查找患者或随访主题"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
            />
          </label>
        )}
        {history && (
          <label>
            联系结果
            <select
              aria-label="筛选联系结果"
              value={outcomeFilter}
              onChange={(e) => {
                setOutcomeFilter(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">全部结果</option>
              {Object.entries(outcomeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!records && !error && <p role="status">正在读取随访记录…</p>}
      {records && !records.reminders.length && (
        <p className="memory-empty">
          {query || (outcomeFilter && history)
            ? "没有符合筛选条件的记录。"
            : history
              ? "还没有随访记录。"
              : "没有待登记的提醒。计划到期后会出现在这里。"}
        </p>
      )}
      <div className={`followup-workspace ${editing || addendum ? "is-editing" : ""}`}><div className="followup-queue-column">
      <ul className="job-list">
        {(records?.reminders || []).map((record) => (
          <li key={record.id} className={`followup-record-row${dueState(record) ? ` is-${dueState(record).tone}` : ""}`}>
            <div className="job-main">
              <div className="followup-row-title">
                <b>{record.patientName}</b>
                <span>{record.title}</span>
                {dueState(record) && <em className={`om-chip ${dueState(record).tone === "overdue" ? "is-danger" : "is-caution"}`}>{dueState(record).label}</em>}
              </div>
              <small>
                {record.kind === "manual-contact"
                  ? { campaign: "自动随访收集", chat: "聊天随访归档" }[record.source?.kind] || "主动联系"
                  : `计划时间：${date(record.dueAt)}`}
              </small>
              {record.attempt && <div className="followup-addendum"><b>自动尝试（原始记录）</b><p>{record.attempt.note}</p><small>尝试时间：{date(record.attempt.contactedAt)} · 记录时间：{date(record.attempt.recordedAt)}</small></div>}
              {record.outcome ? (
                <>
                  <strong>
                    {outcomeLabels[record.outcome.status]} ·{" "}
                    {date(
                      record.outcome.contactedAt || record.outcome.recordedAt,
                    )}
                  </strong>
                  <small>录入时间：{date(record.outcome.recordedAt)}</small>
                  <p className="followup-note">{record.outcome.note || (record.outcome.checkedItems?.length ? `已核对：${record.outcome.checkedItems.join("、")}` : "")}{record.outcome.noRetryReason ? `；未另行安排：${record.outcome.noRetryReason}` : ""}</p>
                  {record.outcome.contactMethod &&
                    record.outcome.contactMethod !== "unspecified" && (
                      <small>
                        联系方式：
                        {
                          {
                            phone: "电话",
                            in_person: "当面",
                            wechat: "微信",
                            wecom: "企业微信",
                            other: "其他",
                          }[record.outcome.contactMethod]
                        }
                      </small>
                    )}
                  {Object.entries(record.outcome.clinical || {})
                    .filter(([, value]) => value)
                    .map(([key, value]) => (
                      <p className="followup-note" key={key}>
                        <b>
                          {
                            {
                              symptoms: "症状与近况",
                              medications: "实际用药",
                              results: "检查与结果",
                              plan: "处置与后续安排",
                            }[key]
                          }
                          ：
                        </b>
                        {value}
                      </p>
                    ))}
                  {(record.outcome.addenda || []).map((item) => (
                    <div className="followup-addendum" key={item.id}>
                      <small>补充 / 更正 · {date(item.recordedAt)}</small>
                      <p className="followup-note">{item.note}</p>
                    </div>
                  ))}
                  <small>
                    已核对：
                    {record.outcome.checkedItems.join("、") || "未勾选条目"}
                  </small>
                  {record.outcome.nextDueAt && (
                    <small>下次随访：{date(record.outcome.nextDueAt)}</small>
                  )}
                </>
              ) : (
                <small>
                  {record.status === "done"
                    ? "此前仅确认提醒，尚未登记随访结果。"
                    : record.detail}
                </small>
              )}
            </div>
            <div className="job-actions">
              {onOpenPatient && (
                <button
                  className="text-button"
                  onClick={() => onOpenPatient(record.patientId)}
                >
                  患者档案
                </button>
              )}
              {record.outcome && (
                <button
                  className="text-button"
                  disabled={busy || Boolean(editing) || Boolean(addendum)}
                  onClick={() => {
                    setAddendum({ ...record, requestId: crypto.randomUUID() });
                    setAddendumNote("");
                    setError("");
                  }}
                >
                  补充或更正
                </button>
              )}
              {record.outcome && onOpenTask && (
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      // 输入框只放请求；随访记录内容作为附带上下文随问题发送。
                      await onOpenTask(record.sessionId, {
                        draft: "请基于这条随访记录继续整理后续工作。",
                        context: {
                          kind: "followup-record",
                          label: `随访记录 · ${String(record.outcome.recordedAt || "").slice(0, 10)}`,
                          data: {
                            recordId: record.id,
                            recordedAt: record.outcome.recordedAt,
                            outcome: outcomeLabels[record.outcome.status],
                            checkedItems: record.outcome.checkedItems,
                            note: record.outcome.note,
                            noRetryReason: record.outcome.noRetryReason || undefined,
                            clinical: record.outcome.clinical || {},
                            addenda: (record.outcome.addenda || []).slice(-3).map((item) => ({
                              recordedAt: item.recordedAt,
                              note: item.note.length > 1000 ? `${item.note.slice(0, 1000)}[节选]` : item.note,
                            })),
                            nextDueAt: record.outcome.nextDueAt || "未单独安排",
                          },
                        },
                      });
                    } catch (err) {
                      setError(err.message);
                    }
                  }}
                >
                  基于记录继续任务
                </button>
              )}
              {!record.outcome && (
                <button
                  className="primary"
                  disabled={busy || Boolean(editing) || Boolean(addendum)}
                  onClick={() => begin(record)}
                >
                  登记结果
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {records && records.total > 20 && (
        <div className="agenda-pagination">
          <span>
            第 {offset + 1}–{offset + records.reminders.length} 条，共{" "}
            {records.total} 条
          </span>
          <button
            className="secondary"
            disabled={
              offset === 0 || busy || Boolean(editing) || Boolean(addendum)
            }
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            上一页
          </button>
          <button
            className="secondary"
            disabled={
              !records.hasMore || busy || Boolean(editing) || Boolean(addendum)
            }
            onClick={() => setOffset(offset + 20)}
          >
            下一页
          </button>
        </div>
      )}
      </div>
      {(editing || addendum) && <aside className="followup-editor" aria-label="登记联系结果">
      {addendum && (
        <form className="followup-result-form" onSubmit={saveAddendum}>
          <h3>补充或更正 · {addendum.patientName} · {addendum.title}</h3>
          <p className="followup-note">原记录：{addendum.outcome.note}</p>
          <fieldset disabled={busy}>
            <p className="muted">
              说明补充事实，或指出原记录哪一处有误及正确内容。原始记录会保留。
            </p>
            <label>
              补充或更正内容
              <textarea
                aria-label="补充或更正内容"
                autoFocus
                required
                maxLength={5000}
                rows={4}
                value={addendumNote}
                onChange={(e) => setAddendumNote(e.target.value)}
              />
            </label>
            <div className="toolbar-actions">
              <button className="primary" disabled={!addendumNote.trim()}>
                保存补充记录
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => { setAddendum(null); setAddendumNote(""); }}
              >
                取消
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {editing && (
        <form className="followup-result-form" onSubmit={save}>
          <h3>
            {editing.patientName} · {editing.title}
          </h3><p className="muted">{editing.manual ? "登记实际联系情况" : `原计划：${date(editing.dueAt)}`}</p>
          <fieldset disabled={busy}>
            {editing.manual && !patientId && (
              <label>
                联系的患者
                <select
                  required
                  aria-label="联系的患者"
                  disabled={contactsLoading || Boolean(contactError)}
                  value={editing.patientId}
                  onChange={(e) => {
                    if (e.target.value === editing.patientId) return;
                    if (editing.patientId && hasContactInput(form) && !window.confirm("更换患者会清空本次未保存的联系内容。确认更换患者？")) return;
                    setForm(editing.patientId ? contactForm() : { ...form, requestId: crypto.randomUUID() });
                    setEditing({
                      ...editing,
                      patientId: e.target.value,
                      patientName:
                        contactPatients?.find((p) => p.id === e.target.value)
                          ?.name || "选择患者",
                    });
                  }}
                >
                  <option value="">请选择患者</option>
                  {editing.patientId && !contactPatients?.some(patient => patient.id === editing.patientId) && <option value={editing.patientId}>{editing.patientName} · 待核对档案</option>}
                  {(contactPatients || []).map((p) => (
                    <option value={p.id} key={p.id}>
                      {patientOptionLabel(p, contactPatients)}
                    </option>
                  ))}
                </select>
                {contactsLoading && <span role="status">正在读取可联系的患者…</span>}
                {contactError && <span role="alert">{contactError}<button type="button" onClick={loadContacts}>重试读取患者</button></span>}
                {!contactsLoading && !contactError && editing.patientId && !contactAvailable && <span role="alert">草稿患者不在当前在管列表中，请核对患者档案或更换患者。</span>}
              </label>
            )}
            {editing.manual && (
              <label>
                联系主题
                <input
                  required
                  maxLength={100}
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </label>
            )}
            <label>
              实际联系时间（可选；留空为当前时间）
              <input
                type="datetime-local"
                value={form.contactedAt}
                onChange={(e) =>
                  setForm({ ...form, contactedAt: e.target.value })
                }
              />
            </label>
            <label>
              联系结果
              <select
                aria-label="联系结果"
                required
                value={form.status}
                onChange={(e) =>
                  setForm({
                    ...form,
                    status: e.target.value,

                  })
                }
              >
                <option value="" disabled>请选择实际联系结果</option>
                {Object.entries(outcomeLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {form.status === "completed" && editing.checklist?.length > 0 && (
              <div className="followup-checklist">
                <b>本次已核对的条目</b>
                {editing.checklist.map((item) => (
                  <label key={item}>
                    <input
                      type="checkbox"
                      checked={form.checkedItems.includes(item)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          checkedItems: e.target.checked
                            ? [...form.checkedItems, item]
                            : form.checkedItems.filter(
                                (value) => value !== item,
                              ),
                        })
                      }
                    />
                    {item}
                  </label>
                ))}
              </div>
            )}
            <label>
              联系方式
              <select
                aria-label="联系方式"
                value={form.contactMethod}
                onChange={(e) =>
                  setForm({ ...form, contactMethod: e.target.value })
                }
              >
                <option value="unspecified">未注明</option>
                <option value="phone">电话</option>
                <option value="in_person">当面</option>
                <option value="wechat">微信</option>
                <option value="wecom">企业微信</option>
                <option value="other">其他</option>
              </select>
            </label>
            {form.status === "completed" && (
              <details>
                <summary>补充临床要点（可选）</summary>
                {[
                  ["symptoms", "症状与近况"],
                  ["medications", "实际用药与不适"],
                  ["results", "检查与待回报结果"],
                  ["plan", "处置与后续安排"],
                ].map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <textarea
                      maxLength={1200}
                      value={form.clinical?.[key] || ""}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          clinical: { ...form.clinical, [key]: e.target.value },
                        })
                      }
                    />
                  </label>
                ))}
              </details>
            )}
            <label>
              {noteOptional(form) ? "随访记录（已勾选核对条目，可不填）" : "随访记录"}
              <textarea
                autoFocus
                aria-label="随访记录"
                required={!noteOptional(form)}
                maxLength={5000}
                rows={4}
                placeholder="记录患者反馈、已核实的信息及后续安排；未联系上时记录尝试情况。"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </label>
            <label>
              {form.status === "unreachable" ? "下次联系时间（或填写不再另行安排的原因）" : "下次随访时间（可选；另建单次提醒，原有周期计划保留）"}
              <input
                type="datetime-local"
                value={form.nextDueAt}
                onChange={(e) =>
                  setForm({ ...form, nextDueAt: e.target.value })
                }
              />
              <span className="followup-date-chips" role="group" aria-label="下次联系快捷时间">
                {NEXT_CONTACT_CHIPS.map(([label, days, months]) => {
                  const value = nextContactAt(days, months);
                  return <button key={label} type="button" className="text-button" aria-pressed={form.nextDueAt === value} onClick={() => setForm({ ...form, nextDueAt: value })}>{label}</button>;
                })}
              </span>
            </label>
            {form.status === "unreachable" && !form.nextDueAt && <label>
              不再另行安排的原因
              <textarea required maxLength={1000} value={form.noRetryReason || ""} onChange={e => setForm({ ...form, noRetryReason: e.target.value })} placeholder="例如：由原周期计划继续联系，并说明具体安排" />
            </label>}
            {form.nextDueAt && (
              <label>
                下次随访名称
                <input
                  required
                  maxLength={100}
                  value={form.nextName}
                  onChange={(e) =>
                    setForm({ ...form, nextName: e.target.value })
                  }
                />
              </label>
            )}
            <div className="toolbar-actions">
              <button className="primary" type="submit" disabled={(!form.note.trim() && !noteOptional(form)) || !contactAvailable}>
                {busy ? "保存中…" : "保存随访结果"}
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => { setEditing(null); setForm({}); }}
              >
                取消
              </button>
            </div>
          </fieldset>
        </form>
      )}
      </aside>}
      </div>
    </section>
  );
}
