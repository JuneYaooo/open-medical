import { useEffect, useRef, useState } from "react";
import { patientOptionLabel } from "./patient-labels";
import { api } from "./agent-runtime";

const outcomeLabels = {
  completed: "已完成随访",
  unreachable: "未联系上",
  declined: "患者暂不接受",
};
const date = (value) => new Date(value).toLocaleString("zh-CN");

// A reminder firing is a scheduling event. A clinical follow-up is only
// recorded when the doctor submits its outcome, checklist and notes.
export function FollowupRecords({
  patientId,
  onChanged,
  onOpenPatient,
  onOpenTask,
}) {
  const [contactPatients, setContactPatients] = useState([]);
  const [records, setRecords] = useState(null);
  const [history, setHistory] = useState(false);
  const [query, setQuery] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const generation = useRef(0);
  const [addendum, setAddendum] = useState(null);
  const [addendumNote, setAddendumNote] = useState("");
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
    setRecords(null);
    refresh().catch((err) => setError(err.message));
    const timer = setInterval(() => {
      if (!document.hidden) refresh().catch((err) => setError(err.message));
    }, 15000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [patientId, history, offset, query, outcomeFilter]);
  const saveAddendum = async (event) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`/api/reminders/${addendum.id}/addendum`, "POST", {
        expectedRevision: addendum.outcome.revision || 0,
        note: addendumNote,
      });
      setAddendum(null);
      setAddendumNote("");
      setNotice("补充记录已保存，原记录保留。");
      await refresh();
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
    if (inFlight.current) return;
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
          contactedAt: form.contactedAt
            ? new Date(form.contactedAt).toISOString()
            : undefined,
          nextDueAt: form.nextDueAt
            ? new Date(form.nextDueAt).toISOString()
            : undefined,
        },
      );
      setEditing(null);
      setNotice(
        "随访结果已保存，可在随访记录中查看。" +
          (form.nextDueAt ? "下次提醒已安排。" : ""),
      );
      await refresh();
      await onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const begin = (record) => {
    setEditing(record);
    setNotice("");
    setError("");
    setForm({
      requestId: crypto.randomUUID(),
      title: "主动联系记录",
      contactedAt: "",
      status: "completed",
      note: "",
      contactMethod: "unspecified",
      clinical: { symptoms: "", medications: "", results: "", plan: "" },
      checkedItems: [],
      nextDueAt: "",
      nextName: "后续随访",
    });
  };
  return (
    <section className="followup-records" aria-label="随访结果登记">
      <div className="hub-section-head">
        <h3>随访待办与记录</h3>
        <button
          className="secondary"
          disabled={busy || Boolean(editing) || Boolean(addendum)}
          onClick={async () => {
            if (!patientId) {
              try {
                const data = await api("/api/patients?summary=1");
                setContactPatients(data.patients.filter((p) => !p.archived));
              } catch (e) {
                setError(e.message);
                return;
              }
            }
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
          className="text-button"
          disabled={busy || Boolean(editing)}
          onClick={() => refresh().catch((err) => setError(err.message))}
        >
          刷新
        </button>
      </div>
      <p className="muted">
        提醒触发后，请记录实际联系结果。记录留在患者档案中，不会自动发送给患者。
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="form-notice">
          {notice}
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
        <label>
          查找患者或随访主题
          <input
            aria-label="查找患者或随访主题"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
        </label>
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
      {!records && <p role="status">正在读取随访记录…</p>}
      {records && !records.reminders.length && (
        <p className="memory-empty">
          {query || (outcomeFilter && history)
            ? "没有符合筛选条件的记录。"
            : history
              ? "还没有随访记录。"
              : "没有待登记的提醒。计划到期后会出现在这里。"}
        </p>
      )}
      <ul className="job-list">
        {(records?.reminders || []).map((record) => (
          <li key={record.id} className="followup-record-row">
            <div className="job-main">
              <b>
                {record.patientName} · {record.title}
              </b>
              <small>
                {record.kind === "manual-contact"
                  ? "主动联系"
                  : `计划时间：${date(record.dueAt)}`}
              </small>
              {record.outcome ? (
                <>
                  <strong>
                    {outcomeLabels[record.outcome.status]} ·{" "}
                    {date(
                      record.outcome.contactedAt || record.outcome.recordedAt,
                    )}
                  </strong>
                  <p className="followup-note">{record.outcome.note}</p>
                  {record.outcome.contactMethod &&
                    record.outcome.contactMethod !== "unspecified" && (
                      <small>
                        联系方式：
                        {
                          {
                            phone: "电话",
                            in_person: "当面",
                            wechat: "微信",
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
                    setAddendum(record);
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
                      await onOpenTask(record.sessionId, {
                        draft: `请基于本患者随访记录继续整理后续工作，保留来源，结论待医生复核。\n来源：随访记录 ${record.id}，登记时间 ${record.outcome.recordedAt}。\n联系结果：${outcomeLabels[record.outcome.status]}。\n已核对条目：${record.outcome.checkedItems.join("、") || "未勾选"}。\n医生登记原文：\n${record.outcome.note}\n临床反馈（医生登记）：${JSON.stringify(record.outcome.clinical || {})}\n后续补充（最近 3 条，共 ${record.outcome.addenda?.length || 0} 条）：${
                          (record.outcome.addenda || [])
                            .slice(-3)
                            .map(
                              (item) =>
                                `${item.recordedAt}：${item.note.slice(0, 1000)}${item.note.length > 1000 ? "[节选]" : ""}`,
                            )
                            .join("\n") || "无"
                        }\n下次随访：${record.outcome.nextDueAt || "未单独安排"}。`,
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
                  className="secondary"
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
      {addendum && (
        <form className="followup-result-form" onSubmit={saveAddendum}>
          <h3>补充或更正 · {addendum.title}</h3>
          <fieldset disabled={busy}>
            <p className="muted">
              说明补充事实，或指出原记录哪一处有误及正确内容。原始记录会保留。
            </p>
            <label>
              补充或更正内容
              <textarea
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
                onClick={() => setAddendum(null)}
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
          </h3>
          <fieldset disabled={busy}>
            {editing.manual && !patientId && (
              <label>
                联系的患者
                <select
                  required
                  aria-label="联系的患者"
                  value={editing.patientId}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      patientId: e.target.value,
                      patientName:
                        contactPatients.find((p) => p.id === e.target.value)
                          ?.name || "选择患者",
                    })
                  }
                >
                  <option value="">请选择患者</option>
                  {contactPatients.map((p) => (
                    <option value={p.id} key={p.id}>
                      {patientOptionLabel(p, contactPatients)}
                    </option>
                  ))}
                </select>
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
                value={form.status}
                onChange={(e) =>
                  setForm({
                    ...form,
                    status: e.target.value,
                    ...(e.target.value !== "completed"
                      ? {
                          checkedItems: [],
                          clinical: {
                            symptoms: "",
                            medications: "",
                            results: "",
                            plan: "",
                          },
                        }
                      : {}),
                  })
                }
              >
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
              随访记录
              <textarea
                autoFocus
                required
                maxLength={5000}
                rows={4}
                placeholder="记录患者反馈、已核实的信息及后续安排；未联系上时记录尝试情况。"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </label>
            <label>
              下次随访时间（可选；另建单次提醒，原有周期计划保留）
              <input
                type="datetime-local"
                value={form.nextDueAt}
                onChange={(e) =>
                  setForm({ ...form, nextDueAt: e.target.value })
                }
              />
            </label>
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
              <button type="submit" disabled={!form.note.trim()}>
                {busy ? "保存中…" : "保存随访结果"}
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => setEditing(null)}
              >
                取消
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
