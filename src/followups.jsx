import { CampaignPanel } from "./care-inbox";
import { ChatFollowupsPanel } from "./chat-followups";
import { Modal } from "./components";
import { patientOptionLabel } from "./patient-labels";
import { useEffect, useState } from "react";
import {
  CalendarClock,
  Loader2,
  Pause,
  Play,
  Plus,
  Stethoscope,
  Trash2,
  X,
} from "lucide-react";
import { api } from "./agent-runtime";
import { FollowupRecords } from "./followup-records";

const fmtDue = (value) => {
  const diff = value - Date.now();
  const days = Math.floor(Math.abs(diff) / 86400000);
  const hours = Math.floor((Math.abs(diff) % 86400000) / 3600000);
  if (diff <= 0) return days ? `已逾期 ${days} 天` : `已逾期 ${hours} 小时`;
  return days ? `${days} 天后` : `${hours} 小时后`;
};

// Follow-up management across all patients: apply plan templates, track the
// schedule (due / upcoming), and acknowledge fired reminders.
export function FollowupsView({ onOpenPatient, onOpenTask, onSettings }) {
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [visibleUpcoming, setVisibleUpcoming] = useState(20);
  const [deleting, setDeleting] = useState(null);
  const [section, setSection] = useState(() => { const tab = new URLSearchParams(window.location.search).get("followupTab"); return { chat: "chats", auto: "auto" }[tab] || "queue"; });
  const [plans, setPlans] = useState([]);
  const [patients, setPatients] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [apply, setApply] = useState({
    planId: "",
    patientId: "",
    startDate: new Date().toLocaleDateString("en-CA"),
    nodes: [],
    requestId: crypto.randomUUID(),
  });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: "",
    disease: "",
    nodes: [{ offsetDays: 30, title: "1 个月随访", items: "" }],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const [planList, patientList, jobList] = await Promise.all([
        api("/api/followup-plans"),
        api("/api/patients?summary=1"),
        api("/api/followups/overview"),
      ]);
      setPlans(planList.plans);
      setPatients(patientList.patients.filter((p) => !p.archived));
      const allJobs = [...jobList.jobs];
      let page = jobList;
      while (page.hasMore) {
        page = await api(`/api/followups/overview?offset=${allJobs.length}`);
        allJobs.push(...page.jobs);
        if (!page.jobs.length) break;
      }
      setJobs(allJobs);
      setLoadFailed(false);
    } catch (err) { setLoadFailed(true); throw err; }
    finally { setLoading(false); }
  };
  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, []);

  const run = async (action, message) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setDeleting(null);
      if (message) setNotice(message);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const applyPlan = () =>
    run(async () => {
      await api(`/api/patients/${apply.patientId}/followups/apply`, "POST", {
        planId: apply.planId,
        startDate: apply.startDate,
        nodes: apply.nodes.map((n) => ({
          ...n,
          offsetDays: Number(n.offsetDays),
          items: n.items.map((s) => s.trim()).filter(Boolean),
        })),
        requestId: apply.requestId,
      });
      setApply((old) => ({
        ...old,
        patientId: "",
        requestId: crypto.randomUUID(),
      }));
    }, "随访模板已应用到患者，节点已排入计划。");
  const createPlan = () =>
    run(async () => {
      await api("/api/followup-plans", "POST", {
        name: form.name,
        disease: form.disease || undefined,
        nodes: form.nodes.map((node) => ({
          offsetDays: Number(node.offsetDays),
          title: node.title,
          items: node.items
            .split(/[\n,;；]/)
            .map((s) => s.trim())
            .filter(Boolean),
        })),
      });
      setCreating(false);
      setForm({
        name: "",
        disease: "",
        nodes: [{ offsetDays: 30, title: "1 个月随访", items: "" }],
      });
    }, "自定义模板已创建。");
  const toggleJob = (job) =>
    run(async () => {
      await api(`/api/patients/${job.patientId}/followups/${job.id}`, "PATCH", {
        revision: job.revision,
        status: job.status === "active" ? "paused" : "active",
      });
    });
  const deleteJob = (job) =>
    run(async () => {
      await api(
        `/api/patients/${job.patientId}/followups/${job.id}`,
        "DELETE",
        {
          revision: job.revision,
        },
      );
    }, "随访计划已删除。");
  const removePlan = (id) =>
    run(async () => {
      await api(`/api/followup-plans/${id}`, "DELETE");
    }, "模板已删除。");

  const now = Date.now();
  const dueJobs = jobs.filter(
    (job) => job.nextDue <= now && job.status === "active",
  );
  const upcoming = jobs.filter(
    (job) => job.nextDue > now || job.status !== "active",
  );

  return (
    <div className="module-view">
      {deleting && <Modal title={deleting.type === "job" ? "删除随访计划" : "删除随访模板"} onClose={() => { if (!busy) setDeleting(null); }}>
        <p>{deleting.type === "job" ? `${deleting.item.patientName} · ${deleting.item.name}` : deleting.item.name}</p>
        <p>{deleting.type === "job" ? "删除后此计划不再生成提醒。若只是暂时不用，可以取消并选择暂停。" : "此模板删除后不能再用于安排随访，已经创建的患者计划会保留。"}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="toolbar-actions"><button className="secondary" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="danger" disabled={busy} onClick={() => deleting.type === "job" ? deleteJob(deleting.item) : removePlan(deleting.item.id)}>{busy ? "正在删除…" : "确认删除"}</button></div>
      </Modal>}
      <section className="module-card followups-view">
        <div className="module-head">
          <div>
            <h1>随访管理</h1>
            <p className="module-phase">计划排程 · 患者随访 · 结果登记</p>
          </div>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {loading && <p role="status">正在读取随访计划…</p>}
        {loadFailed && <button className="secondary" onClick={() => refresh().then(() => setError("")).catch(err => setError(err.message))}>重新加载随访</button>}
        {notice && <p className="form-notice" role="status">{notice}</p>}

        <nav className="tab-row business-tabs" aria-label="随访工作内容">
          <button
            className={section === "queue" ? "active" : ""}
            onClick={() => setSection("queue")}
          >
            随访待办
          </button>
          <button
            className={section === "plans" ? "active" : ""}
            onClick={() => setSection("plans")}
          >
            计划与模板
          </button>
          <button className={section === "auto" ? "active" : ""} onClick={() => setSection("auto")}>自动随访</button>
          <button className={section === "chats" ? "active" : ""} onClick={() => setSection("chats")}>聊天随访</button>
        </nav>
        {section === "auto" && <section className="followups-section"><p className="muted">自动随访会按计划通过企业微信给患者发送问题，收集回复并写入「随访待办」中的随访记录；「计划与模板」只在本机提醒医生联系患者。</p><CampaignPanel onOpenPatient={onOpenPatient} /></section>}
        {section === "chats" && <ChatFollowupsPanel patients={patients} onSettings={onSettings} />}
        <div hidden={section !== "queue"}>
          <FollowupRecords
            onOpenTask={onOpenTask}
            onChanged={refresh}
            onOpenPatient={onOpenPatient}
          />
        </div>
        <div hidden={section !== "plans"}>
          <section className="followups-section">
            <h3>应用随访模板</h3>
            <div className="followup-apply">
              <select
                value={apply.planId}
                aria-label="选择随访模板"
                onChange={(e) =>
                  setApply({
                    ...apply,
                    planId: e.target.value,
                    nodes: structuredClone(
                      plans.find((p) => p.id === e.target.value)?.nodes || [],
                    ),
                    requestId: crypto.randomUUID(),
                  })
                }
              >
                <option value="">选择模板…</option>
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name}（{plan.nodes.length} 个节点
                    {plan.disease ? ` · ${plan.disease}` : ""}）
                  </option>
                ))}
              </select>
              <select
                value={apply.patientId}
                onChange={(e) =>
                  setApply({
                    ...apply,
                    patientId: e.target.value,
                    requestId: crypto.randomUUID(),
                  })
                }
              >
                <option value="">选择患者…</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {patientOptionLabel(p, patients)}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={apply.startDate}
                onChange={(e) =>
                  setApply({
                    ...apply,
                    startDate: e.target.value,
                    requestId: crypto.randomUUID(),
                  })
                }
              />
              <button
                onClick={applyPlan}
                disabled={busy || !apply.planId || !apply.patientId}
              >
                {busy ? (
                  <Loader2 className="spin" size={14} />
                ) : (
                  <CalendarClock size={14} />
                )}
                应用
              </button>
            </div>
            {apply.planId && (
              <section className="followup-customize">
                <h4>核对这位患者的安排</h4>
                <p className="muted">
                  模板是参考框架，需按病情与已有医嘱调整，不代表指南规定的统一间隔。提醒默认在本机时区上午
                  9 点；应用后各节点独立保存。
                </p>
                {apply.nodes.map((node, index) => (
                  <div className="followup-node-editor" key={index}>
                    <label>
                      开始后第几天
                      <input
                        aria-label={`节点 ${index + 1} 天数`}
                        type="number"
                        min="0"
                        max="3650"
                        value={node.offsetDays}
                        onChange={(e) =>
                          setApply({
                            ...apply,
                            requestId: crypto.randomUUID(),
                            nodes: apply.nodes.map((n, i) =>
                              i === index
                                ? { ...n, offsetDays: e.target.value }
                                : n,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      随访主题
                      <input
                        value={node.title}
                        onChange={(e) =>
                          setApply({
                            ...apply,
                            requestId: crypto.randomUUID(),
                            nodes: apply.nodes.map((n, i) =>
                              i === index ? { ...n, title: e.target.value } : n,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      需要核对什么（每行一项）
                      <textarea
                        value={node.items.join("\n")}
                        onChange={(e) =>
                          setApply({
                            ...apply,
                            requestId: crypto.randomUUID(),
                            nodes: apply.nodes.map((n, i) =>
                              i === index
                                ? { ...n, items: e.target.value.split("\n") }
                                : n,
                            ),
                          })
                        }
                      />
                    </label>
                  </div>
                ))}
              </section>
            )}
            <details>
              <summary>查看全部模板</summary>
              <ul className="plan-list">
                {plans.map((plan) => (
                  <li key={plan.id}>
                    <div>
                      <b>{plan.name}</b>
                      <small>
                        {plan.disease || "通用"} ·{" "}
                        {plan.nodes
                          .map((node) => `+${node.offsetDays}天 ${node.title}`)
                          .join(" · ")}
                      </small>
                    </div>
                    {!plan.builtin && (
                      <button
                        className="icon-button danger"
                        title="删除模板"
                        onClick={() => setDeleting({ type: "template", item: plan })}
                        disabled={busy}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
            {creating ? (
              <div className="plan-form">
                <div className="plan-form-row">
                  <input
                    value={form.name}
                    placeholder="模板名称"
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                  <input
                    value={form.disease}
                    placeholder="适用病种（可选）"
                    onChange={(e) =>
                      setForm({ ...form, disease: e.target.value })
                    }
                  />
                </div>
                {form.nodes.map((node, index) => (
                  <div className="plan-form-row" key={index}>
                    <input
                      type="number"
                      min="0"
                      value={node.offsetDays}
                      title="距开始日期天数"
                      onChange={(e) =>
                        setForm({
                          ...form,
                          nodes: form.nodes.map((n, i) =>
                            i === index
                              ? { ...n, offsetDays: e.target.value }
                              : n,
                          ),
                        })
                      }
                    />
                    <input
                      value={node.title}
                      placeholder="节点标题"
                      onChange={(e) =>
                        setForm({
                          ...form,
                          nodes: form.nodes.map((n, i) =>
                            i === index ? { ...n, title: e.target.value } : n,
                          ),
                        })
                      }
                    />
                    <input
                      value={node.items}
                      placeholder="条目（逗号/分号分隔）"
                      onChange={(e) =>
                        setForm({
                          ...form,
                          nodes: form.nodes.map((n, i) =>
                            i === index ? { ...n, items: e.target.value } : n,
                          ),
                        })
                      }
                    />
                    <button
                      className="icon-button"
                      title="移除节点"
                      onClick={() =>
                        setForm({
                          ...form,
                          nodes: form.nodes.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
                <div className="plan-form-row">
                  <button
                    className="secondary"
                    onClick={() =>
                      setForm({
                        ...form,
                        nodes: [
                          ...form.nodes,
                          { offsetDays: 90, title: "", items: "" },
                        ],
                      })
                    }
                    disabled={form.nodes.length >= 12}
                  >
                    <Plus size={13} /> 添加节点
                  </button>
                  <button
                    onClick={createPlan}
                    disabled={busy || !form.name.trim()}
                  >
                    保存模板
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setCreating(false)}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button className="secondary" onClick={() => setCreating(true)}>
                <Plus size={14} /> 新建自定义模板
              </button>
            )}
          </section>

          <section className="followups-section">
            <h3>
              今日与逾期 <em className="count-chip">{dueJobs.length}</em>
            </h3>
            <ul className="job-list">
              {dueJobs.map((job) => (
                <li key={job.id}>
                  <div className="job-main">
                    <b>{job.patientName}</b> · {job.name}
                    <small>
                      {fmtDue(job.nextDue)} ·{" "}
                      {job.once ? "单次" : `每 ${job.intervalDays} 天`}
                      {job.checklist?.length
                        ? ` · ${job.checklist.join("、")}`
                        : ""}
                    </small>
                  </div>
                  <div className="job-actions">
                    <button
                      className="icon-button"
                      title="打开患者"
                      onClick={() => onOpenPatient?.(job.patientId)}
                    >
                      <Stethoscope size={14} />
                    </button>
                    <button
                      className="icon-button"
                      title="暂停"
                      onClick={() => toggleJob(job)}
                      disabled={busy}
                    >
                      <Pause size={14} />
                    </button>
                    <button
                      className="icon-button danger"
                      title="删除"
                      onClick={() => setDeleting({ type: "job", item: job })}
                      disabled={busy}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              ))}
              {!loading && !loadFailed && !dueJobs.length && (
                <li className="memory-empty">没有到期随访。</li>
              )}
            </ul>
          </section>

          <section className="followups-section">
            <h3>
              未来与暂停 <em className="count-chip muted">{upcoming.length}</em>
            </h3>
            <ul className="job-list">
              {upcoming.slice(0, visibleUpcoming).map((job) => (
                <li key={job.id}>
                  <div className="job-main">
                    <b>{job.patientName}</b> · {job.name}
                    <small>
                      {job.status === "paused" ? "已暂停 · " : ""}
                      {fmtDue(job.nextDue)}
                    </small>
                  </div>
                  <div className="job-actions">
                    <button className="icon-button" title="打开患者" onClick={() => onOpenPatient?.(job.patientId)}><Stethoscope size={14} /></button>
                    <button
                      className="icon-button"
                      title={job.status === "paused" ? "恢复" : "暂停"}
                      onClick={() => toggleJob(job)}
                      disabled={busy || job.status === "running"}
                    >
                      {job.status === "paused" ? (
                        <Play size={14} />
                      ) : (
                        <Pause size={14} />
                      )}
                    </button>
                    <button
                      className="icon-button danger"
                      title="删除"
                      onClick={() => setDeleting({ type: "job", item: job })}
                      disabled={busy}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              ))}
              {!loading && !loadFailed && !upcoming.length && (
                <li className="memory-empty">没有未来计划。</li>
              )}
            </ul>
            {upcoming.length > visibleUpcoming && <button className="secondary" onClick={() => setVisibleUpcoming(count => count + 20)}>显示更多计划（还有 {upcoming.length - visibleUpcoming} 项）</button>}
          </section>
        </div>
      </section>
    </div>
  );
}
