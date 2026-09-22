import { patientIdentityLabel, patientOptionLabel } from "./patient-labels";
import { FollowupRecords } from "./followup-records";
import { useEffect, useRef, useState } from "react";
import {
  Bell,
  CalendarClock,
  FolderOpen,
  Inbox,
  Loader2,
  MessageSquare,
  Play,
  Search,
  Stethoscope,
  UserPlus,
} from "lucide-react";
import { api, streamTurn } from "./agent-runtime";
import { IconButton, Modal } from "./components";
import { RiskList, Timeline } from "./ui";
import { PatientBriefPanel } from "./patient-brief";
import { PatientIdentityModal } from "./patient-identity";
import { PatientProposalModal } from "./patient-proposal";
import { PatientImportModal } from "./patient-import";
import { CareTasksPanel } from "./care-tasks";
import { ClinicalPanel } from "./patient-clinical";

const ORGANIZE_PROMPT =
  "请整理本患者的病例材料：生成病历时间线、检验数值摘录和用药资料核对，保留来源与行号，标注缺失信息。";
const TREATMENT_PROMPT =
  "请评估本患者的当前治疗方案：先用 read_source 通读所选材料，然后调用 draft_treatment_review 生成参考意见草稿——summary 为治疗现状摘要，concerns 列出材料中提示需要医生关注的点，infoGaps 列出缺失信息，questions 列出建议医生核对的问题。只使用材料内信息，不给出剂量或处方建议，结论待医生复核。";
const EVENT_LABELS = {
  "message.start": "开始执行",
  "message.delta": "正在生成草稿",
  "message.complete": "草稿已保存，待复核",
  "tool.start": "调用工具中",
  "status.update": "执行中",
  "run.cancelled": "已停止",
};
const GENDER = { male: "男", female: "女", unknown: "" };
const eventText = (event) =>
  EVENT_LABELS[event.type] ||
  (event.type === "subagent.started"
    ? `${event.payload?.child?.name}执行中`
    : event.type === "subagent.completed"
      ? `${event.payload?.child?.name}完成`
      : event.type === "subagent.failed"
        ? `${event.payload?.child?.name}失败`
        : event.type === "error"
          ? event.payload?.error
          : "");
const fmtDate = (value) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
// 提案卡明细：渲染结构化字段而非原始 JSON
const proposalDetail = (type, payload = {}) => {
  const parts = [];
  if (payload.name)
    parts.push(
      type === "followup-create"
        ? `计划 ${payload.name}`
        : `姓名 ${payload.name}`,
    );
  if (payload.gender === "male") parts.push("男");
  if (payload.gender === "female") parts.push("女");
  if (payload.birthYear) parts.push(`${payload.birthYear} 年生`);
  if (payload.phone) parts.push(payload.phone);
  if (payload.diagnoses?.length)
    parts.push(
      `诊断 ${payload.diagnoses
        .map((d) => d.name)
        .filter(Boolean)
        .join("、")}`,
    );
  if (payload.diagnosis) parts.push(`诊断 ${payload.diagnosis}`);
  if (payload.medications?.length)
    parts.push(
      `用药 ${payload.medications
        .map((m) => m.name)
        .filter(Boolean)
        .join("、")}`,
    );
  if (payload.allergies?.length)
    parts.push(`过敏 ${payload.allergies.join("、")}`);
  if (payload.labs?.length) parts.push(`检验 ${payload.labs.length} 项待录入`);
  if (payload.visits?.length)
    parts.push(`就诊 ${payload.visits.length} 次待录入`);
  return parts.join(" · ");
};
export function parsePastedMessages(raw) {
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s*[|｜]\s*/);
      let time = new Date().toISOString(),
        direction = "in",
        text = line;
      if (parts.length >= 3) {
        const parsed = Date.parse(parts[0]);
        if (Number.isFinite(parsed)) time = new Date(parsed).toISOString();
        direction = /医生|out/i.test(parts[1]) ? "out" : "in";
        text = parts.slice(2).join(" | ");
      } else if (parts.length === 2) {
        direction = /医生|out/i.test(parts[0]) ? "out" : "in";
        text = parts.slice(1).join(" | ");
      }
      return { direction, time, text };
    });
}
export function PatientsView({
  config,
  onOpenWorkspace,
  onSwitchCurrent,
  onChanged,
  initialPatientId,
  initialTab = "overview",
  initialCreate = false,
  initialImport = false,
}) {
  const [patients, setPatients] = useState([]);
  const patientGeneration = useRef(0);
  const [reminders, setReminders] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState("overview");
  const [messages, setMessages] = useState([]);
  const [followups, setFollowups] = useState([]);
  const [risks, setRisks] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [createProposals, setCreateProposals] = useState([]);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [reviewProposal, setReviewProposal] = useState(null);
  const proposalInFlight = useRef(false);
  const [session, setSession] = useState(null);
  const [query, setQuery] = useState("");
  const [patientPage, setPatientPage] = useState(0);
  const [showAllReminders, setShowAllReminders] = useState(false);
  const [group, setGroup] = useState("");
  const [archiveFilter, setArchiveFilter] = useState("active");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState(initialCreate ? "new-patient" : initialImport ? "import-patients" : null);
  const [consent, setConsent] = useState(false);
  const [paste, setPaste] = useState("");
  const [bridge, setBridge] = useState(null);
  const [reply, setReply] = useState("");
  const groups = [...new Set(patients.flatMap((p) => p.groups || []))].sort();
  const filtered = patients
    .filter((p) => archiveFilter === "archived" ? p.archived : !p.archived)
    .filter((p) => !group || p.groups?.includes(group))
    .filter(
      (p) =>
        !query ||
        p.name.includes(query) ||
        (p.patientNumber || "").includes(query) ||
        p.id.includes(query) ||
        (p.phone || "").includes(query) ||
        (p.tags || []).some((t) => t.includes(query)),
    );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 24));
  const visiblePage = Math.min(patientPage, pageCount - 1);
  const refresh = async () => {
    const [list, todo, box, pending] = await Promise.all([
      api("/api/patients?summary=1&archived=1"),
      api("/api/reminders"),
      api("/api/inbox"),
      api("/api/pending-actions?status=pending").catch(() => ({ actions: [] })),
    ]);
    setPatients(list.patients);
    setReminders(todo.reminders);
    setInbox(box.messages);
    setCreateProposals(
      (pending.actions || []).filter((a) => a.type === "patient-create"),
    );
    onChanged?.();
    return list.patients;
  };
  const openPatient = async (id, nextTab = "overview") => {
    const version = ++patientGeneration.current;
    setError("");
    setTab(nextTab);
    setReviewProposal(null);
    setConsent(false);
    setPaste("");
    onSwitchCurrent?.(id);
    const [one, msgs, jobs, risks, proposals] = await Promise.all([
      api(`/api/patients/${id}`),
      api(`/api/patients/${id}/messages`),
      api(`/api/patients/${id}/followups`),
      api(`/api/risk-alerts?patientId=${id}`),
      api(`/api/pending-actions?patientId=${id}`),
    ]);
    const work = await api(`/api/sessions/${one.sessionId}`);
    if (version !== patientGeneration.current) return;
    setDetail(one);
    setMessages(msgs.messages);
    setFollowups(jobs.jobs);
    setRisks(risks.alerts);
    setProposals(proposals.actions);
    setSession(work);
  };
  const refreshPatient = async () => {
    if (!detail) return;
    await openPatient(detail.id, tab);
    await refresh();
  };
  const resolveProposal = async (proposal, decision) => {
    if (proposalInFlight.current) return;
    proposalInFlight.current = true;
    setProposalBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/pending-actions/${proposal.id}/${decision}`, "POST", {});
      setReviewProposal(null);
      if (detail) await refreshPatient();
      else await refresh();
      setNotice(
        decision === "reject"
          ? "提案已忽略。"
          : proposal.type === "patient-create"
            ? "建档提案已确认，患者已创建。"
            : "提案已确认写入。",
      );
    } catch (err) {
      // A revision conflict leaves the proposal pending and the doctor's edits
      // intact; display the server's recovery instruction instead of dropping it.
      setError(err.message);
    } finally {
      proposalInFlight.current = false;
      setProposalBusy(false);
    }
  };
  useEffect(() => {
    refresh().catch((err) => setError(err.message));
    if (initialPatientId)
      openPatient(initialPatientId, initialTab).catch((err) =>
        setError(err.message),
      );
    api("/api/wechat/status")
      .then(setBridge)
      .catch(() => setBridge(null));
  }, []);
  const refreshBridge = () =>
    api("/api/wechat/status")
      .then(setBridge)
      .catch(() => setBridge(null));
  const syncWechat = async () => {
    if (
      !window.confirm(
        "请先把微信切到该患者的聊天窗口。\n同步会抓取当前微信窗口的可见文本并归档到该患者，继续？",
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api("/api/wechat/read", "POST", {
        patientId: detail.id,
      });
      setNotice(
        `已从微信窗口抓取 ${result.captured} 条文本：新增 ${result.stored} 条，重复跳过 ${result.duplicates} 条。`,
      );
      await refreshPatient();
    } catch (err) {
      setError(err.message);
      refreshBridge();
    } finally {
      setBusy(false);
    }
  };
  const sendWechat = async () => {
    if (
      !window.confirm(
        `将通过本机微信客户端发送给「${detail.name}」：\n\n${reply}\n\n微信会用 ${detail.phone || "姓名"} 搜索并选中第一个结果，请确认搜索词能唯一定位该患者。确认发送？`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api("/api/wechat/send", "POST", {
        patientId: detail.id,
        text: reply,
      });
      setNotice(`已通过微信发送给 ${result.contact}，并记录到消息列表。`);
      setReply("");
      await refreshPatient();
    } catch (err) {
      setError(err.message);
      refreshBridge();
    } finally {
      setBusy(false);
    }
  };
  const runTask = async (prompt, { mode }) => {
    if (busy || !session) return;
    setBusy(true);
    setError("");
    setNotice("");
    setProgress("开始执行");
    try {
      await streamTurn(
        session.id,
        {
          message: prompt,
          mode,
          externalConsent: mode === "model" ? consent : undefined,
          fileIds: session.files.map((f) => f.id),
        },
        (event) => setProgress(eventText(event) || progress),
      );
      setNotice("已生成草稿。请在病例工作区或下方产物列表中复核。");
      await refreshPatient();
    } catch (err) {
      setError(err.message);
      await refreshPatient().catch(() => {});
    } finally {
      setBusy(false);
      setProgress("");
      setConsent(false);
    }
  };
  const digest = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const run = await api(
        `/api/patients/${detail.id}/messages/digest`,
        "POST",
        { externalConsent: true },
      );
      setNotice(
        run.status === "completed"
          ? "消息已由 AI 整理为记录草稿，待复核。"
          : `摘要未完成：${run.error || "请查看执行记录"}`,
      );
      await refreshPatient();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setConsent(false);
    }
  };
  const importMessages = async () => {
    const parsed = parsePastedMessages(paste);
    if (!parsed.length) return;
    try {
      const result = await api(`/api/patients/${detail.id}/messages`, "POST", {
        messages: parsed,
      });
      setPaste("");
      setNotice(`已导入 ${result.stored} 条消息。`);
      await refreshPatient();
    } catch (err) {
      setError(err.message);
    }
  };
  const assign = async (messageId, patientId) => {
    if (!patientId) return;
    try {
      await api(`/api/inbox/${messageId}/assign`, "POST", { patientId });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };
  const archive = async () => {
    try {
      await api(`/api/patients/${detail.id}`, "PATCH", {
        expectedRevision: detail.revision,
        archived: !detail.archived,
      });
      await refresh();
      setDetail(null);
      setSession(null);
      setNotice(detail.archived ? "患者已恢复到在管列表。" : "患者已归档，可在已归档列表中恢复。");
    } catch (err) {
      setError(err.message);
    }
  };
  const remove = async () => {
    if (
      !window.confirm(
        `确认删除患者「${detail.name}」？\n将同时删除病例工作区、消息与随访记录，且不可恢复。`,
      )
    )
      return;
    try {
      await api(`/api/patients/${detail.id}`, "DELETE");
      setDetail(null);
      setSession(null);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };
  const patientCards = (
    <div className="patient-grid">
      {filtered.slice(visiblePage * 24, (visiblePage + 1) * 24).map((p) => (
        <button
          className="patient-card"
          key={p.id}
          onClick={() => {
            onSwitchCurrent?.(p.id);
            openPatient(p.id).catch((err) => setError(err.message));
          }}
        >
          <span className="patient-avatar">
            <Stethoscope size={17} />
          </span>
          <span className="patient-line">
            <b>{p.name}</b>
            <small>
              {[GENDER[p.gender], patientIdentityLabel(p)]
                .filter(Boolean)
                .join(" · ") || "未补充基础信息"}
            </small>
          </span>
          <span className="patient-counts">
            {p.counts.dueFollowups > 0 && (
              <em className="pill warn">{p.counts.dueFollowups} 项随访到期</em>
            )}
            {p.counts.unprocessedMessages > 0 && (
              <em className="pill warn">
                {p.counts.unprocessedMessages} 条新消息
              </em>
            )}
            {p.counts.pendingReminders > 0 && (
              <em className="pill">{p.counts.pendingReminders} 条提醒</em>
            )}
            {p.archived && <em className="pill">已归档</em>}
          </span>
          {(p.tags || []).length > 0 && (
            <span className="patient-tags">
              {p.tags.slice(0, 4).map((t) => (
                <em key={t}>{t}</em>
              ))}
            </span>
          )}
        </button>
      ))}
      {!filtered.length && (
        <p className="sidebar-empty">
          {patients.length ? "没有匹配的患者，请尝试其他姓名、编号或分组。" : "还没有在管患者。点击「新建患者」并导入病例材料开始。"}
        </p>
      )}
    </div>
  );
  return (
    <section id="main" className="patients-view" aria-label="患者档案">
      <div className="patients-toolbar">
        <div>
          <h2>{detail ? detail.name : "患者管理"}</h2>
          <span className="muted">
            {detail
              ? "病例工作区、消息与随访都在本机保存"
              : `本地单机 · ${patients.filter((p) => !p.archived).length} 位在管患者`}
          </span>
        </div>
        {detail ? (
          <div className="toolbar-actions">
            <button
              className="secondary"
              onClick={() => {
                patientGeneration.current++;
                setDetail(null);
                setSession(null);
              }}
            >
              返回列表
            </button>
            <button
              className="primary"
              disabled={!session}
              onClick={() => onOpenWorkspace(detail.sessionId)}
            >
              <FolderOpen size={15} /> 打开病例工作区
            </button>
          </div>
        ) : (
          <div className="toolbar-actions">
            <button className="secondary" onClick={() => setModal("import-patients")}>导入已有患者</button>
            <button className="primary" onClick={() => setModal("new-patient")}>
              <UserPlus size={15} /> 新建患者
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}
      {!detail && createProposals.length > 0 && (
        <div className="patient-risk-list" style={{ marginBottom: 14 }}>
          <p className="muted" style={{ fontSize: 12 }}>
            AI 建档提案（从对话材料中识别的新患者，确认后才真正建档）：
          </p>
          {createProposals.map((proposal) => (
            <div className="hub-risk" key={proposal.id}>
              <div className="hub-risk-main">
                <b>{proposal.summary}</b>
                <small>
                  {proposalDetail(proposal.type, proposal.payload) ||
                    (proposal.payload?.note || "").slice(0, 160)}
                </small>
              </div>
              <div className="hub-risk-actions">
                <button
                  className="text-button"
                  disabled={proposalBusy}
                  onClick={() => resolveProposal(proposal, "confirm")}
                >
                  确认建档
                </button>
                <button
                  className="text-button"
                  disabled={proposalBusy}
                  onClick={() => resolveProposal(proposal, "reject")}
                >
                  忽略
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {busy && (
        <p className="notice running">
          <Loader2 className="spin" size={14} /> {progress || "执行中"}
        </p>
      )}
      {!detail && (
        <>
          {reminders.length > 0 && (
            <div className="todo-panel">
              <b>
                <Bell size={15} /> 待办提醒
              </b>
              {(showAllReminders ? reminders : reminders.slice(0, 3)).map((r) => (
                <div className="todo-row" key={r.id}>
                  <MessageSquare size={14} />
                  <span>
                    <b>{r.patientName}</b> · {r.title}
                    <small>
                      {r.detail} · {fmtDate(r.dueAt)}
                    </small>
                  </span>
                  <button className="secondary" onClick={() => openPatient(r.patientId, "followups").catch((err) => setError(err.message))}>
                    登记随访
                  </button>
                </div>
              ))}
              {reminders.length > 3 && <button className="text-button" onClick={() => setShowAllReminders(!showAllReminders)}>{showAllReminders ? "收起提醒" : `展开已加载的 ${reminders.length} 条提醒`}</button>}
            </div>
          )}
          {inbox.length > 0 && (
            <div className="todo-panel">
              <b>
                <Inbox size={15} /> 待认领消息
              </b>
              {inbox.map((m) => (
                <div className="todo-row" key={m.id}>
                  <span>
                    <small>
                      {m.channel} · {fmtDate(m.time)}
                      {m.patientHint ? ` · 线索：${m.patientHint}` : ""}
                    </small>
                    {m.text.slice(0, 80)}
                  </span>
                  <select
                    defaultValue=""
                    onChange={(e) => assign(m.id, e.target.value)}
                    aria-label="认领到患者"
                  >
                    <option value="">认领到…</option>
                    {patients.filter((p) => !p.archived).map((p) => (
                      <option key={p.id} value={p.id}>
                        {patientOptionLabel(p, patients)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          <div className="patients-filter">
            <select aria-label="患者档案状态" value={archiveFilter} onChange={(e) => { setArchiveFilter(e.target.value); setPatientPage(0); }}><option value="active">在管患者</option><option value="archived">已归档患者</option></select>
            <label className="search">
              <Search size={14} />
              <input
                aria-label="搜索患者"
                placeholder="搜索姓名、编号、电话或标签"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPatientPage(0); }}
              />
            </label>
            <button
              className={`chip ${group === "" ? "active" : ""}`}
              onClick={() => { setGroup(""); setPatientPage(0); }}
            >
              全部
            </button>
            {groups.map((g) => (
              <button
                key={g}
                className={`chip ${group === g ? "active" : ""}`}
                onClick={() => { setGroup(g); setPatientPage(0); }}
              >
                {g}
              </button>
            ))}
          </div>
          {patientCards}
          {filtered.length > 0 && <nav className="patient-pagination" aria-label="患者分页">
            <small>共 {filtered.length} 位 · 第 {visiblePage + 1} / {pageCount} 页</small>
            <button className="secondary" disabled={visiblePage === 0} onClick={() => setPatientPage(visiblePage - 1)}>上一页</button>
            <button className="secondary" disabled={visiblePage + 1 >= pageCount} onClick={() => setPatientPage(visiblePage + 1)}>下一页</button>
          </nav>}
        </>
      )}
      {detail && session && (
        <>
          <div className="detail-head">
            <span className="patient-line">
              <b>
                {detail.name}
                {detail.archived && "（已归档）"}
              </b>
              <small>
                {[
                  detail.patientNumber || detail.id.slice(0, 8),
                  GENDER[detail.gender],
                  detail.birthYear && `${detail.birthYear} 年生`,
                  detail.phone,
                  ...(detail.groups || []),
                ]
                  .filter(Boolean)
                  .join(" · ") || "未补充基础信息"}
              </small>
              {(detail.allergies || []).length > 0 && (
                <em className="pill warn">
                  过敏：
                  {detail.allergies
                    .map((a) =>
                      typeof a === "string"
                        ? a
                        : [a.substance, a.reaction].filter(Boolean).join("（") +
                          (a.reaction ? "）" : ""),
                    )
                    .join("、")}
                </em>
              )}
            </span>
            <div className="toolbar-actions">
              <button className="secondary" onClick={() => setModal("edit-patient")}>编辑信息</button>
              <button
                className="secondary"
                onClick={() => runTask(ORGANIZE_PROMPT, { mode: "model" })}
                disabled={
                  busy ||
                  !config?.modelConfigured ||
                  !session.files.length ||
                  !consent
                }
              >
                <Play size={14} /> 自动整理病例
              </button>
              <button
                className="secondary"
                disabled={
                  busy ||
                  !config?.modelConfigured ||
                  !session.files.length ||
                  !consent
                }
                onClick={() => runTask(TREATMENT_PROMPT, { mode: "model" })}
              >
                <Stethoscope size={14} /> 评估治疗方案
              </button>
              <IconButton title={detail.archived ? "恢复患者" : "归档患者"} onClick={archive}>
                <FolderOpen size={16} />
              </IconButton>
              <IconButton title="删除患者档案" onClick={remove}>
                ×
              </IconButton>
            </div>
          </div>
          {config?.modelConfigured && (
            <label className="consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              允许把该患者的材料与消息原文发送给所配置的模型服务（评估治疗方案、AI
              总结均需勾选）。
            </label>
          )}
          <div className="tab-row">
            {[
              ["overview", "概览"],
              ["clinical", "临床资料"],
              [
                "messages",
                `消息记录${detail.counts.unprocessedMessages ? ` · ${detail.counts.unprocessedMessages} 未处理` : ""}`,
              ],
              ["followups", "随访计划"],
              ["tracking", "检查与转诊"],
            ].map(([id, label]) => (
              <button
                key={id}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "tracking" && <CareTasksPanel key={detail.id} patient={detail} onChanged={onChanged} />}
          {tab === "overview" && (
            <div className="detail-panel">
              <PatientBriefPanel patient={detail} onOpenTask={onOpenWorkspace} onNavigate={setTab} onEditIdentity={() => setModal("edit-patient")} />
              <section className="care-path" aria-label="患者工作流程">
                <h3>继续处理这位患者</h3>
                <div className="care-path-steps">
                  <button onClick={() => setTab("clinical")}>
                    <b>1 · 完善档案</b>
                    <small>诊断、用药、过敏史与检验</small>
                  </button>
                  <button
                    onClick={() =>
                      onOpenWorkspace(session.id, { tab: "materials" })
                    }
                  >
                    <b>2 · 导入与整理</b>
                    <small>{session.files.length} 份材料 · 保留原文</small>
                  </button>
                  <button
                    onClick={() =>
                      onOpenWorkspace(session.id, { tab: "results" })
                    }
                  >
                    <b>3 · 复核成果</b>
                    <small>
                      {
                        session.artifacts.filter((a) => a.status === "draft")
                          .length
                      }{" "}
                      份草稿待复核
                    </small>
                  </button>
                  <button onClick={() => setTab("followups")}>
                    <b>4 · 随访与反馈</b>
                    <small>
                      {detail.counts.pendingReminders} 条提醒待处理 · 登记结果
                    </small>
                  </button>
                </div>
              </section>
              <p className="muted">
                风险提示仅覆盖内置规则；检验名称、单位不匹配时不套用阈值，未提示不代表无风险。
              </p>
              <RiskList
                alerts={[...risks].sort(
                  (a, b) =>
                    (a.status === "active" ? 0 : 1) -
                      (b.status === "active" ? 0 : 1) ||
                    { critical: 0, warning: 1, info: 2 }[a.severity] -
                      { critical: 0, warning: 1, info: 2 }[b.severity],
                )}
                busy={busy}
                onDraft={(r) =>
                  onOpenWorkspace(session.id, {
                    draft: `请针对风险「${r.title}」生成处理建议草稿：${r.message} 只使用本病例材料内信息并保留来源，结论待医生复核。`,
                  })
                }
                onAck={async (r) => {
                  await api(`/api/risk-alerts/${r.id}/ack`, "POST", {});
                  await refreshPatient();
                }}
                onResolve={async (r, reopen = false) => {
                  await api(
                    `/api/risk-alerts/${r.id}/${reopen ? "reopen" : "resolve"}`,
                    "POST",
                    {},
                  );
                  await refreshPatient();
                }}
              />
              {proposals.length > 0 && (
                <div className="patient-risk-list">
                  <p className="muted" style={{ fontSize: 12 }}>
                    AI 提议的档案变更（写入档案的唯一通道，确认后才生效）：
                  </p>
                  {proposals.map((proposal) => (
                    <div className="hub-risk" key={proposal.id}>
                      <div className="hub-risk-main">
                        <b>{proposal.summary}</b>
                        <small>
                          {proposal.type === "patient-update"
                            ? "档案变更"
                            : proposal.type === "followup-create"
                              ? "新建随访"
                              : proposal.type === "patient-create"
                                ? "新建患者"
                                : "收入病例库"}
                          {proposalDetail(proposal.type, proposal.payload)
                            ? ` · ${proposalDetail(proposal.type, proposal.payload)}`
                            : ""}
                        </small>
                      </div>
                      <div className="hub-risk-actions">
                        <button
                          className="text-button"
                          disabled={proposalBusy}
                          onClick={() => proposal.type === "patient-update" ? setReviewProposal(proposal) : resolveProposal(proposal, "confirm")}
                        >
                          {proposal.type === "patient-update" ? "核对变更" : "采纳写入"}
                        </button>
                        <button
                          className="text-button"
                          disabled={proposalBusy}
                          onClick={() => resolveProposal(proposal, "reject")}
                        >
                          忽略
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="pt-sec">
                <div className="s-t">
                  关键事件时间线
                  <span className="s-m">材料 · 产物 · 随访</span>
                </div>
                <Timeline
                  items={[
                    // 无标题且无时间的条目是历史空壳（旧版技能正文快照），时间线上没有可读信息
                    ...session.artifacts
                      .filter(
                        (a) =>
                          (a.title || a.summary || a.payload) && a.createdAt,
                      )
                      .map((a) => ({
                        sort: a.createdAt,
                        date: fmtDate(a.createdAt),
                        text: `${a.title || a.summary || a.type}（v${a.version || 1} · ${
                          a.status === "draft"
                            ? "待复核"
                            : a.status === "approved"
                              ? "已复核"
                              : "需修订"
                        }）`,
                        action: (
                          <button
                            className="mini-btn plain"
                            onClick={() =>
                              onOpenWorkspace(session.id, {
                                tab: "results",
                                artifactId: a.id,
                              })
                            }
                          >
                            查看
                          </button>
                        ),
                      })),
                    ...followups.map((j) => ({
                      sort: j.nextDue,
                      date: fmtDate(j.nextDue),
                      text: `随访：${j.name}（${
                        j.intervalDays ? `每 ${j.intervalDays} 天` : "按需安排"
                      }${j.status !== "active" ? ` · ${j.status === "paused" ? "已暂停" : j.status}` : ""}）`,
                    })),
                  ].sort((a, b) => new Date(b.sort) - new Date(a.sort))}
                />
              </div>
              <div className="count-cards">
                <div>
                  <b>{session.files.length}</b>
                  <span>份病例材料</span>
                </div>
                <div>
                  <b>{session.artifacts.length}</b>
                  <span>份产物</span>
                </div>
                <div>
                  <b>
                    {
                      session.artifacts.filter((a) => a.status === "draft")
                        .length
                    }
                  </b>
                  <span>待人工复核</span>
                </div>
              </div>
              <p className="boundary">
                评估与摘要只是待复核草稿：内置用药与检验规则覆盖有限，不构成诊疗决定。
              </p>
            </div>
          )}
          {tab === "clinical" && (
            <ClinicalPanel
              key={detail.id}
              detail={detail}
              onChanged={refreshPatient}
              onError={setError}
            />
          )}
          {tab === "messages" && (
            <div className="detail-panel">
              <div className="digest-row">
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !config?.modelConfigured ||
                    !detail.counts.unprocessedMessages ||
                    !consent
                  }
                  onClick={digest}
                >
                  AI 总结 {detail.counts.unprocessedMessages} 条未处理消息
                </button>
                <small className="muted">
                  总结会调用模型并把消息标记为已处理；产物进入病例工作区待复核。
                </small>
              </div>
              {bridge && (
                <div className="bridge-panel">
                  <div className="bridge-row">
                    <span
                      className={`connection ${bridge.available ? "" : "offline"}`}
                    >
                      <i />
                      {bridge.enabled
                        ? bridge.available
                          ? "微信桥接已连接"
                          : `微信桥接不可用：${bridge.reason || "未知原因"}`
                        : "微信桥接未启用（.env 设置 MEDICAL_WECHAT_BRIDGE=on）"}
                    </span>
                    <button
                      className="secondary"
                      disabled={!bridge.available || busy}
                      onClick={syncWechat}
                    >
                      同步微信当前聊天窗口
                    </button>
                  </div>
                  <label className="paste-box">
                    <b>回复草稿（通过微信发送）</b>
                    <textarea
                      rows={2}
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      placeholder="写给该患者的消息……每一条都需要你手动点击发送"
                    />
                    <button
                      className="primary"
                      disabled={!bridge.available || !reply.trim() || busy}
                      onClick={sendWechat}
                    >
                      通过微信发送
                    </button>
                    <small className="muted">
                      发送通过本机微信客户端完成（搜索联系人 → 粘贴 →
                      回车），系统不会自动发送任何消息。
                    </small>
                  </label>
                </div>
              )}
              <label className="paste-box">
                <b>粘贴消息记录</b>
                <small className="muted">
                  每行一条：「时间 | 患者/医生 | 内容」，或直接粘贴消息文本。
                </small>
                <textarea
                  rows={4}
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  placeholder="2026-09-07 09:12 | 患者 | 今天血压 150/95，偶有头晕"
                />
                <button
                  className="secondary"
                  disabled={!paste.trim() || busy}
                  onClick={importMessages}
                >
                  导入到该患者
                </button>
              </label>
              <div className="msg-list">
                {messages.map((m) => (
                  <div className="msg-row" key={m.id}>
                    <span className={`msg-dir ${m.direction}`}>
                      {m.direction === "in" ? "患" : "医"}
                    </span>
                    <span>
                      {m.text}
                      <small>
                        {fmtDate(m.time)} · {m.channel}
                        {m.processed ? " · 已整理" : ""}
                      </small>
                    </span>
                    {!m.processed && <em className="pill warn">未处理</em>}
                  </div>
                ))}
                {!messages.length && (
                  <p className="muted">
                    还没有消息。粘贴导入，或让微信 CLI 推送到本地接入接口。
                  </p>
                )}
              </div>
            </div>
          )}
          {tab === "followups" && (
            <div className="detail-panel">
              <div className="digest-row">
                <button
                  className="primary"
                  onClick={() => setModal("followup")}
                  disabled={detail.archived}
                >
                  <CalendarClock size={14} /> 新建随访计划
                </button>
                <small className="muted">
                  随访到期时在本机生成提醒；未配置模型或未授权外发时只提醒不自动总结。
                </small>
              </div>
              <FollowupRecords
                key={detail.id}
                patientId={detail.id}
                onChanged={refreshPatient}
                onOpenTask={onOpenWorkspace}
              />
              {followups.map((job) => (
                <div className="followup-card" key={job.id}>
                  <div className="followup-head">
                    <b>{job.name}</b>
                    <span className="badge">{{ active: "计划中", running: "提醒生成中", paused: "已暂停", completed: "提醒已生成" }[job.status] || job.status}</span>
                  </div>
                  <small className="muted">
                    {job.once ? "单次提醒" : `每 ${job.intervalDays} 天`} ·{" "}
                    {job.status === "completed" ? "提醒已触发" : "下次"}{" "}
                    {fmtDate(job.nextDue)}
                    {job.externalConsent ? " · 已授权自动总结" : " · 仅提醒"}
                    {job.lastError ? ` · 上次错误：${job.lastError}` : ""}
                  </small>
                  {job.checklist.length > 0 && (
                    <ul>
                      {job.checklist.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  )}
                  <div className="toolbar-actions">
                    {job.status !== "running" && job.status !== "completed" && (
                      <button
                        className="secondary"
                        onClick={async () => {
                          await api(
                            `/api/patients/${detail.id}/followups/${job.id}`,
                            "PATCH",
                            {
                              revision: job.revision,
                              status:
                                job.status === "active" ? "paused" : "active",
                            },
                          );
                          await refreshPatient();
                        }}
                      >
                        {job.status === "active" ? "暂停" : "恢复"}
                      </button>
                    )}
                    <button
                      className="secondary"
                      onClick={async () => {
                        await api(
                          `/api/patients/${detail.id}/followups/${job.id}`,
                          "DELETE",
                          { revision: job.revision },
                        );
                        await refreshPatient();
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
              {!followups.length && <p className="muted">还没有随访计划。</p>}
            </div>
          )}
        </>
      )}
      {modal === "new-patient" && (
        <NewPatientModal
          onClose={() => setModal(null)}
          onCreated={async (patient) => {
            setModal(null);
            await refresh();
            await openPatient(patient.id);
          }}
        />
      )}
      {reviewProposal && detail && <PatientProposalModal patient={detail} proposal={reviewProposal} busy={proposalBusy} error={error} onClose={() => setReviewProposal(null)} onConfirm={() => resolveProposal(reviewProposal, "confirm")} />}
      {modal === "import-patients" && <PatientImportModal onClose={() => setModal(null)} onImported={async (result) => { await refresh(); setModal(null); setNotice(`已导入 ${result.count} 位患者，打开档案即可继续补充病例材料。`); }} onOpenPatient={(id) => { setModal(null); openPatient(id).catch((err) => setError(err.message)); }} />}
      {modal === "edit-patient" && detail && <PatientIdentityModal patient={detail} onClose={() => setModal(null)} onSaved={async () => { await refreshPatient(); setModal(null); setNotice("基本信息已保存"); }} />}
      {modal === "followup" && detail && (
        <FollowupModal
          patientId={detail.id}
          onClose={() => setModal(null)}
          onCreated={async () => {
            setModal(null);
            await refreshPatient();
          }}
        />
      )}
    </section>
  );
}
function NewPatientModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    name: "",
    patientNumber: "",
    confirmDistinctPatient: false,
    gender: "",
    birthYear: "",
    phone: "",
    groups: "",
    tags: "",
  });
  const inFlight = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [matches, setMatches] = useState([]);
  useEffect(() => {
    let live = true;
    setMatches([]);
    const timer = setTimeout(() => {
      if (form.name.trim()) api(`/api/patients?summary=1&q=${encodeURIComponent(form.name.trim())}`)
        .then((value) => { if (live) setMatches(value.patients.filter((p) => p.name === form.name.trim())); })
        .catch((err) => { if (live) setError(err.message); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [form.name]);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value, ...(key === "name" ? { confirmDistinctPatient: false } : {}) });
  const submit = async (e) => {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const patient = await api("/api/patients", "POST", {
        requestId: requestId.current,
        name: form.name,
        patientNumber: form.patientNumber.trim() || undefined,
        confirmDistinctPatient: form.confirmDistinctPatient,
        gender: form.gender || undefined,
        birthYear: form.birthYear ? Number(form.birthYear) : undefined,
        phone: form.phone.trim() || undefined,
        groups: form.groups
          ? form.groups
              .split(/[，,]/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        tags: form.tags
          ? form.tags
              .split(/[，,]/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
      });
      await onCreated(patient);
    } catch (err) {
      setError(err.message);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return (
    <Modal title="新建患者" onClose={() => { if (!saving) onClose(); }}>
      <form className="modal-form" onSubmit={submit}>
        <fieldset disabled={saving} className="patient-create-fields">
        <label>
          姓名 *
          <input value={form.name} onChange={set("name")} required autoFocus />
        </label>
        {matches.length > 0 && <section className="identity-matches" aria-label="同名患者核对">
          <b>找到 {matches.length} 位同名患者</b>
          <p>先核对已有档案，避免重复建档。</p>
          {matches.map((patient) => <button key={patient.id} className="secondary" type="button" onClick={() => onCreated(patient)} disabled={saving}>
            {patient.name} · {patient.patientNumber || patient.id.slice(0, 8)} · {patient.birthYear ? `${patient.birthYear} 年生` : "出生年未填"} · {patient.phone ? `尾号 ${patient.phone.slice(-4)}` : "电话未填"} · 打开已有档案
          </button>)}
          <label><input type="checkbox" checked={form.confirmDistinctPatient} onChange={(e) => setForm({ ...form, confirmDistinctPatient: e.target.checked })} />已核对，这是另一位同名患者</label>
        </section>}
        <label>患者编号（可选）<input maxLength={40} value={form.patientNumber} onChange={set("patientNumber")} placeholder="院内编号或自己的患者编号" /></label>
        <div className="form-grid">
          <label>
            性别
            <select value={form.gender} onChange={set("gender")}>
              <option value="">未填</option>
              <option value="male">男</option>
              <option value="female">女</option>
            </select>
          </label>
          <label>
            出生年份
            <input
              type="number"
              min="1900"
              max={new Date().getFullYear()}
              value={form.birthYear}
              onChange={set("birthYear")}
            />
          </label>
          <label>
            联系电话
            <input value={form.phone} onChange={set("phone")} />
          </label>
        </div>
        <label>
          分组（逗号分隔，如：高血压, 随访A组）
          <input value={form.groups} onChange={set("groups")} />
        </label>
        <label>
          标签（逗号分隔，如：2型糖尿病, 胰岛素）
          <input value={form.tags} onChange={set("tags")} />
        </label>
        </fieldset>
        {error && <p className="error-text">{error}</p>}
        <div className="toolbar-actions">
          <button className="primary" disabled={!form.name.trim() || saving || (matches.length > 0 && !form.confirmDistinctPatient)}>
            创建患者档案
          </button>
        </div>
        <small className="muted">
          创建后自动建立病例工作区；在「病例材料」中导入资料即可开始整理。
        </small>
      </form>
    </Modal>
  );
}
function FollowupModal({ patientId, onClose, onCreated }) {
  const defaultDue = () => {
    const date = new Date(Date.now() + 86400000);
    date.setMinutes(0, 0, 0);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  const [form, setForm] = useState({
    name: "常规随访",
    intervalDays: 14,
    firstDueAt: defaultDue(),
    checklist: "",
    externalConsent: false,
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) =>
    setForm({
      ...form,
      [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value,
    });
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/api/patients/${patientId}/followups`, "POST", {
        name: form.name,
        intervalDays: Number(form.intervalDays),
        firstDueAt: new Date(form.firstDueAt).toISOString(),
        checklist: form.checklist
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean),
        externalConsent: form.externalConsent,
      });
      await onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="新建随访计划" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <label>
          计划名称
          <input value={form.name} onChange={set("name")} required autoFocus />
        </label>
        <div className="form-grid">
          <label>
            间隔天数
            <input
              type="number"
              min="1"
              max="3650"
              value={form.intervalDays}
              onChange={set("intervalDays")}
            />
          </label>
          <label>
            首次随访时间
            <input
              type="datetime-local"
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
        <label className="consent">
          <input
            type="checkbox"
            checked={form.externalConsent}
            onChange={set("externalConsent")}
          />
          授权随访到期时自动把未处理消息原文发送给当前模型服务生成记录摘要
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" disabled={saving}>
          创建随访计划
        </button>
      </form>
    </Modal>
  );
}
