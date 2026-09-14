import { useEffect, useState } from "react";
import {
  Bell,
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

const fmtDue = (value) => {
  const diff = value - Date.now();
  const days = Math.floor(Math.abs(diff) / 86400000);
  const hours = Math.floor((Math.abs(diff) % 86400000) / 3600000);
  if (diff <= 0) return days ? `已逾期 ${days} 天` : `已逾期 ${hours} 小时`;
  return days ? `${days} 天后` : `${hours} 小时后`;
};

// Follow-up management across all patients: apply plan templates, track the
// schedule (due / upcoming), and acknowledge fired reminders.
export function FollowupsView({ onOpenPatient }) {
  const [plans, setPlans] = useState([]);
  const [patients, setPatients] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [apply, setApply] = useState({ planId: "", patientId: "", startDate: new Date().toISOString().slice(0, 10) });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", disease: "", nodes: [{ offsetDays: 30, title: "1 个月随访", items: "" }] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    const [planList, patientList, jobList, reminderList] = await Promise.all([
      api("/api/followup-plans"),
      api("/api/patients"),
      api("/api/followups/overview"),
      api("/api/reminders"),
    ]);
    setPlans(planList.plans);
    setPatients(patientList.patients.filter((p) => !p.archived));
    setJobs(jobList.jobs);
    setReminders(reminderList.reminders);
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
      });
    }, "随访模板已应用到患者，节点已排入计划。");
  const createPlan = () =>
    run(async () => {
      await api("/api/followup-plans", "POST", {
        name: form.name,
        disease: form.disease || undefined,
        nodes: form.nodes.map((node) => ({
          offsetDays: Number(node.offsetDays),
          title: node.title,
          items: node.items.split(/[\n,;；]/).map((s) => s.trim()).filter(Boolean),
        })),
      });
      setCreating(false);
      setForm({ name: "", disease: "", nodes: [{ offsetDays: 30, title: "1 个月随访", items: "" }] });
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
      await api(`/api/patients/${job.patientId}/followups/${job.id}`, "DELETE", {
        revision: job.revision,
      });
    }, "随访计划已删除。");
  const ackReminder = (id) =>
    run(async () => {
      await api(`/api/reminders/${id}/ack`, "POST", {});
    }, "提醒已确认。");
  const removePlan = (id) =>
    run(async () => {
      await api(`/api/followup-plans/${id}`, "DELETE");
    }, "模板已删除。");

  const now = Date.now();
  const dueJobs = jobs.filter((job) => job.nextDue <= now && job.status === "active");
  const upcoming = jobs.filter((job) => job.nextDue > now || job.status !== "active");

  return (
    <div className="module-view">
      <section className="module-card followups-view">
        <div className="module-head">
          <div>
            <h1>随访管理</h1>
            <p className="module-phase">模板排程 · 全院患者视图 · 提醒确认</p>
          </div>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="form-notice">{notice}</p>}

        <section className="followups-section">
          <h3>应用随访模板</h3>
          <div className="followup-apply">
            <select
              value={apply.planId}
              onChange={(e) => setApply({ ...apply, planId: e.target.value })}
            >
              <option value="">选择模板…</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}（{plan.nodes.length} 个节点{plan.disease ? ` · ${plan.disease}` : ""}）
                </option>
              ))}
            </select>
            <select
              value={apply.patientId}
              onChange={(e) => setApply({ ...apply, patientId: e.target.value })}
            >
              <option value="">选择患者…</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={apply.startDate}
              onChange={(e) => setApply({ ...apply, startDate: e.target.value })}
            />
            <button
              onClick={applyPlan}
              disabled={busy || !apply.planId || !apply.patientId}
            >
              {busy ? <Loader2 className="spin" size={14} /> : <CalendarClock size={14} />}
              应用
            </button>
          </div>
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
                    onClick={() => removePlan(plan.id)}
                    disabled={busy}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </li>
            ))}
          </ul>
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
                  onChange={(e) => setForm({ ...form, disease: e.target.value })}
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
                          i === index ? { ...n, offsetDays: e.target.value } : n,
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
                      nodes: [...form.nodes, { offsetDays: 90, title: "", items: "" }],
                    })
                  }
                  disabled={form.nodes.length >= 12}
                >
                  <Plus size={13} /> 添加节点
                </button>
                <button onClick={createPlan} disabled={busy || !form.name.trim()}>
                  保存模板
                </button>
                <button className="secondary" onClick={() => setCreating(false)}>
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
                    {fmtDue(job.nextDue)} · {job.once ? "单次" : `每 ${job.intervalDays} 天`}
                    {job.checklist?.length ? ` · ${job.checklist.join("、")}` : ""}
                  </small>
                </div>
                <div className="job-actions">
                  <button className="icon-button" title="打开患者" onClick={() => onOpenPatient?.(job.patientId)}>
                    <Stethoscope size={14} />
                  </button>
                  <button className="icon-button" title="暂停" onClick={() => toggleJob(job)} disabled={busy}>
                    <Pause size={14} />
                  </button>
                  <button className="icon-button danger" title="删除" onClick={() => deleteJob(job)} disabled={busy}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
            {!dueJobs.length && <li className="memory-empty">没有到期随访。</li>}
          </ul>
        </section>

        <section className="followups-section">
          <h3>
            未来与暂停 <em className="count-chip muted">{upcoming.length}</em>
          </h3>
          <ul className="job-list">
            {upcoming.slice(0, 20).map((job) => (
              <li key={job.id}>
                <div className="job-main">
                  <b>{job.patientName}</b> · {job.name}
                  <small>
                    {job.status === "paused" ? "已暂停 · " : ""}
                    {fmtDue(job.nextDue)}
                  </small>
                </div>
                <div className="job-actions">
                  <button
                    className="icon-button"
                    title={job.status === "paused" ? "恢复" : "暂停"}
                    onClick={() => toggleJob(job)}
                    disabled={busy}
                  >
                    {job.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
                  </button>
                  <button className="icon-button danger" title="删除" onClick={() => deleteJob(job)} disabled={busy}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
            {!upcoming.length && <li className="memory-empty">没有未来计划。</li>}
          </ul>
        </section>

        <section className="followups-section">
          <h3>
            <Bell size={14} /> 待处理提醒 <em className="count-chip">{reminders.length}</em>
          </h3>
          <ul className="job-list">
            {reminders.map((reminder) => (
              <li key={reminder.id}>
                <div className="job-main">
                  <b>{reminder.patientName}</b> · {reminder.title}
                  <small>{reminder.detail}</small>
                </div>
                <button className="secondary" onClick={() => ackReminder(reminder.id)} disabled={busy}>
                  确认
                </button>
              </li>
            ))}
            {!reminders.length && <li className="memory-empty">没有待处理提醒。</li>}
          </ul>
        </section>
      </section>
    </div>
  );
}
