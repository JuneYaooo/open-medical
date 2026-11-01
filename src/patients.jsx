import { followupDate } from "../shared/followup-display.mjs";
import { patientPhone, PATIENT_PHONE_HINT } from "../shared/patient-phone.mjs";
import { parsePastedMessages } from "../shared/message-import.mjs";
import { messageChannelLabel } from "../shared/message-provenance.mjs";
import { PatientDashboard } from "./patient-dashboard";
import { loadPatientCore, loadPatientOptional } from "./patient-detail-data";
import { resolveCommunicationTab } from "./patient-tabs";
import { birthYearFromAge, patientAgeLabel, patientOptionLabel, patientQuickMatch, phoneDigits, rememberRecentPatient } from "./patient-labels";
import { allergyState } from "../shared/patient-list-brief.mjs";
import { FLAG_ARROW } from "../shared/lab-flags.mjs";
import { localCalendarDate } from "../shared/calendar-date.mjs";
import { relativeDay } from "./patient-overview";
import "./patient-list.css";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  FolderOpen,
  Inbox,
  Loader2,
  Search,
  Stethoscope,
  UserPlus,
} from "lucide-react";
import { api, PENDING_REFRESH_EVENT } from "./agent-runtime";
import { useAiConsent } from "./ai-consent";
import { Modal } from "./components";
import { RiskList } from "./ui";
import { requestSettingsTab } from "./extension-center";
import { ClinicalAssistance } from "./clinical-assistance";
import { PatientIdentityModal } from "./patient-identity";
import { PatientProposalBanner, PatientProposalModal, loadPatientUpdateProposals } from "./patient-proposal";
import { PatientIntakeModal } from "./patient-intake";
import { PatientImportModal, restoreArchivedPatient } from "./patient-import";
import { LabImportModal } from "./lab-import";
import { AppointmentsPanel, NewLabsNotice } from "./appointments";
import { SlotItem, findPatientTab, mergePatientTabs, patientTabLabel, useActiveSlot, usePluginActive, usePluginConnected, useSlot } from "./plugin-slots";

// Rough triage order for the list: today's visit, abnormal results, overdue
// follow-ups, unread messages. Only used when the doctor picks that sort.
function attentionScore(p, today) {
  const brief = p.brief || {};
  return (brief.nextAppointment === today ? 8 : 0) +
    Math.min(brief.abnormalLabCount || 0, 3) * 2 +
    (p.counts?.dueFollowups ? 3 : 0) +
    (p.counts?.unprocessedMessages ? 2 : 0);
}
const RECORD_TABS = [["overview", "概览"], ["diagnoses", "诊断与病史"], ["medications", "用药与治疗"], ["labs", "检验结果"], ["visits", "就诊经过"], ["library", "资料库"]];
const isRecordTab = tab => RECORD_TABS.some(([id]) => id === tab) || tab === "clinical";

const GENDER = { male: "男", female: "女", unknown: "" };
// 批量操作对单个患者的 PATCH 内容；无需改动时返回 null。
export function bulkPatientPatch(patient, action, groupName = "") {
  const groups = patient.groups || [];
  const name = String(groupName).trim();
  if (action === "add-group") return name && !groups.includes(name) ? { groups: [...groups, name] } : null;
  if (action === "remove-group") return name && groups.includes(name) ? { groups: groups.filter((g) => g !== name) } : null;
  if (action === "archive") return patient.archived ? null : { archived: true };
  if (action === "restore") return patient.archived ? { archived: false } : null;
  return null;
}
const fmtDate = followupDate;
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
    parts.push(`过敏 ${payload.allergies.map((a) => (typeof a === "string" ? a : a?.substance || "")).filter(Boolean).join("、")}`);
  if (payload.labs?.length) parts.push(`检验 ${payload.labs.length} 项待录入`);
  if (payload.visits?.length)
    parts.push(`就诊 ${payload.visits.length} 次待录入`);
  return parts.join(" · ");
};
export { parsePastedMessages };
export function PatientsView({
  config,
  onOpenWorkspace,
  onView,
  onSwitchCurrent,
  onChanged,
  onLocationChange,
  initialPatientId,
  initialTab = "overview",
  initialCreate = false,
  initialImport = false,
}) {
  const panelRoot = useRef(null);
  const listScroll = useRef(window.history.state?.patientListScroll || 0);
  const [patients, setPatients] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listFailed, setListFailed] = useState(false);
  const patientGeneration = useRef(0);
  const [reminders, setReminders] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState("overview");
  const followupActive = usePluginActive("followup");
  // Unassigned patient messages exist only with a connected WeChat/WeCom channel.
  const messaging = usePluginConnected("followup");
  const riskActive = usePluginActive("risk-rules");
  // Direct patient URLs can render before the lazy UI registration finishes;
  // bootstrap already carries the plugin verdict, so use it for the first
  // request without falling back to a disabled plugin.
  const riskReady =
    riskActive ||
    Boolean(
      config?.plugins?.some(
        (plugin) =>
          plugin.id === "risk-rules" &&
          plugin.status === "ready" &&
          plugin.active !== false,
      ),
    );
  // Bootstrap status is available before the lazy UI module finishes loading,
  // so a direct ?tab=followups link is not mistaken for a disabled plugin.
  const followupReady =
    followupActive ||
    Boolean(config?.plugins?.some((plugin) => plugin.id === "followup" && plugin.active === true));
  const pluginTabs = useActiveSlot("patient.tabs");
  const pluginActions = useSlot("patient.actions");
  const activePluginTab = findPatientTab(pluginTabs, tab);
  const communicationTabs = mergePatientTabs(pluginTabs, {
    area: "communication",
    builtin: [["appointments", "复诊预约", 20]],
  });
  const firstCommunicationTab = communicationTabs[0]?.key || "appointments";
  const [clinicalEditRequest, setClinicalEditRequest] = useState(null);
  useEffect(() => { setClinicalEditRequest(null); }, [detail?.id]);
  // 时间轴「查看原文」跨标签跳转的目标材料：状态放在父级，因为按 tab 切换
  // 会重挂载 PatientDashboard，组件内的 state 活不过那次重挂。
  const [sourceFocus, setSourceFocus] = useState(null);
  const [labFocus, setLabFocus] = useState(null);
  useEffect(() => { if (tab !== "labs") setLabFocus(null); }, [tab]);
  const openRecordTab = (nextTab, opts = {}) => {
    const targetTab = resolveCommunicationTab(communicationTabs, nextTab);
    setTab(targetTab);
    setClinicalEditRequest(opts.edit ? { patientId: detail.id, tab: targetTab } : null);
    if ("focusFile" in opts) setSourceFocus(opts.focusFile);
    if (targetTab === "labs") setLabFocus(opts.focusLab ? { patientId: detail.id, key: opts.focusLab } : null);
    if (targetTab === "followups" && opts.patientId === detail?.id && opts.reviewDate) {
      setFollowupSource({ patientId: detail.id, reviewDate: opts.reviewDate, title: opts.title });
    }
    if (targetTab === "followups" && opts.focusFollowupId) setFollowupFocus({ id: opts.focusFollowupId, token: Date.now() });
  };
  const [patientLoading, setPatientLoading] = useState(false);
  const [optionalVersion, setOptionalVersion] = useState(0);
  useEffect(() => { if (detail) onLocationChange?.(detail.id, tab); }, [detail?.id, tab]);
  useEffect(() => {
    if (detail || !listLoading) panelRoot.current?.scrollTo({ top: detail ? 0 : listScroll.current });
  }, [detail?.id, listLoading]);
  const rememberListScroll = () => {
    if (detail || listLoading || patientLoading || new URLSearchParams(window.location.search).has("patient")) return;
    listScroll.current = panelRoot.current?.scrollTop || 0;
    window.history.replaceState({ ...window.history.state, patientListScroll: listScroll.current }, "", window.location.href);
  };
  const [messages, setMessages] = useState([]);
  const [followups, setFollowups] = useState([]);
  const [followupRefresh, setFollowupRefresh] = useState(0);
  const refreshFollowupPanels = () => setFollowupRefresh(value => value + 1);
  const [risks, setRisks] = useState([]);
  const [createProposals, setCreateProposals] = useState([]);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [reviewProposal, setReviewProposal] = useState(null);
  const [updateProposals, setUpdateProposals] = useState([]);
  const proposalInFlight = useRef(false);
  const locallyResolved = useRef(new Set());
  const [session, setSession] = useState(null);
  const [query, setQuery] = useState("");
  // 摘要里的「今日复诊 / 有异常检验」可点选为快捷筛选，再点一次取消。
  const [quickFilter, setQuickFilter] = useState("");
  const searchInput = useRef(null);
  const [sortBy, setSortBy] = useState("updated");
  const [followupSource, setFollowupSource] = useState(null);
  const [followupFocus, setFollowupFocus] = useState(null);
  const [surveyFocus, setSurveyFocus] = useState(null);
  useEffect(() => { setFollowupSource(null); setFollowupFocus(null); setSurveyFocus(null); }, [detail?.id]);
  useEffect(() => {
    if (tab !== "followups" || !followupFocus) return;
    const element = document.getElementById(`followup-${followupFocus.id}`);
    element?.scrollIntoView({ block: "center" }); element?.focus({ preventScroll: true });
  }, [tab, followupFocus, followups]);
  const [patientPage, setPatientPage] = useState(0);
  const [group, setGroup] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [bulkGroup, setBulkGroup] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [archiveFilter, setArchiveFilter] = useState("active");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState(initialCreate ? "new-patient" : initialImport ? "import-patients" : null);
  // 全局已授权 AI 使用患者资料时不再逐患者勾选；关闭全局授权后才回到逐次询问。
  const { granted: aiGranted } = useAiConsent();
  const [localConsent, setConsent] = useState(false);
  const consent = aiGranted || localConsent;
  const [paste, setPaste] = useState("");
  const groups = [...new Set(patients.flatMap((p) => p.groups || []))].sort();
  const tags = [...new Set(patients.flatMap((p) => p.tags || []))].sort();
  const today = localCalendarDate();
  const isTodayVisit = (p) => p.brief?.nextAppointment === today;
  const hasAbnormalLabs = (p) => p.brief?.abnormalLabCount > 0;
  const q = query.trim().toLowerCase();
  // 内部 ID 只在输入足够长时参与匹配，否则单个字母会命中所有患者。
  const matchesQuery = (p) => !q || patientQuickMatch(p, q) ||
    [p.phone, ...(p.tags || []), p.diagnosisSummary].some((value) => String(value || "").toLowerCase().includes(q)) ||
    (q.length >= 8 && String(p.id).toLowerCase().includes(q));
  const filtered = patients
    .filter((p) => archiveFilter === "archived" ? p.archived : !p.archived)
    .filter((p) => !group || p.groups?.includes(group))
    .filter((p) => !tagFilter || p.tags?.includes(tagFilter))
    .filter((p) => quickFilter === "today" ? isTodayVisit(p) : quickFilter === "abnormal" ? hasAbnormalLabs(p) : true)
    .filter(matchesQuery);
  const sortedFiltered = [...filtered].sort((a, b) => {
    if (sortBy === "name") return String(a.name).localeCompare(String(b.name), "zh-Hans-CN");
    if (sortBy === "visit") return String(b.lastVisitAt || "").localeCompare(String(a.lastVisitAt || ""));
    if (sortBy === "followup")
      return (b.counts.dueFollowups || 0) - (a.counts.dueFollowups || 0);
    if (sortBy === "attention")
      return attentionScore(b, today) - attentionScore(a, today) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
  const activePatients = patients.filter((p) => !p.archived);
  const abnormalCount = activePatients.filter(hasAbnormalLabs).length;
  const todayCount = activePatients.filter(isTodayVisit).length;
  const toggleQuickFilter = (key) => {
    setQuickFilter((current) => current === key ? "" : key);
    setArchiveFilter("active");
    setPatientPage(0);
  };
  const quickChip = (key, count, label) => (count > 0 || quickFilter === key) && <button type="button" className={`chip summary-chip ${quickFilter === key ? "active" : ""}`} aria-pressed={quickFilter === key} title={quickFilter === key ? "再点一次取消筛选" : "只看这些患者"} onClick={() => toggleQuickFilter(key)}>{count} 位{label}{quickFilter === key ? " ✕" : ""}</button>;
  const listSummary = <span className="patient-list-summary">
    <span>{activePatients.length} 位在管</span>
    {quickChip("today", todayCount, "今日复诊")}
    {quickChip("abnormal", abnormalCount, "有异常检验")}
  </span>;
  const filtersActive = Boolean(query || group || tagFilter || quickFilter);
  const clearFilters = () => { setQuery(""); setGroup(""); setTagFilter(""); setQuickFilter(""); setPatientPage(0); };
  // 选择在当前筛选内跨页保留；筛选或搜索变化时清空。
  useEffect(() => { setSelected(new Set()); setBulkConfirm(false); }, [query, group, tagFilter, quickFilter, archiveFilter]);
  // 「/」聚焦搜索框（正在输入或有弹窗时不拦截）。
  useEffect(() => {
    if (detail || modal) return;
    const onKey = (event) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)) return;
      if (!searchInput.current) return;
      event.preventDefault();
      searchInput.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, modal]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 24));
  const visiblePage = Math.min(patientPage, pageCount - 1);
  const pagePatients = sortedFiltered.slice(visiblePage * 24, (visiblePage + 1) * 24);
  const pageAllSelected = pagePatients.length > 0 && pagePatients.every((p) => selected.has(p.id));
  const pageSomeSelected = pagePatients.some((p) => selected.has(p.id));
  const toggleSelected = (id) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const togglePage = () => setSelected((current) => {
    const next = new Set(current);
    for (const p of pagePatients) { if (pageAllSelected) next.delete(p.id); else next.add(p.id); }
    return next;
  });
  const refresh = async () => {
    setListLoading(true);
    try {
      // Reminders and unassigned messages belong to the followup plugin. When
      // it is disabled their routes are gone, so do not call them at all.
      const optional = (promise, fallback) => promise.catch(() => fallback);
      const todoRequest = followupActive
        ? optional(api("/api/reminders"), { reminders: [] })
        : Promise.resolve({ reminders: [] });
      const inboxRequest = messaging
        ? optional(api("/api/inbox"), { messages: [] })
        : Promise.resolve({ messages: [] });
      const [list, todo, box, pending] = await Promise.all([
        api("/api/patients?summary=1&archived=1&brief=1"),
        todoRequest,
        inboxRequest,
        api("/api/pending-actions?status=pending").catch(() => ({ actions: [] })),
      ]);
      setPatients(list.patients);
      setReminders(Array.isArray(todo?.reminders) ? todo.reminders : []);
      setInbox(Array.isArray(box?.messages) ? box.messages : []);
      setCreateProposals(
        (pending.actions || []).filter((a) => a.type === "patient-create"),
      );
      onChanged?.();
      setListFailed(false);
      return list.patients;
    } catch (err) {
      setListFailed(true);
      throw err;
    } finally { setListLoading(false); }
  };
  const openPatient = async (id, nextTab = "overview") => {
    if (!detail) listScroll.current = panelRoot.current?.scrollTop || 0;
    const version = ++patientGeneration.current;
    if (detail?.id !== id) {
      setMessages([]);
      setFollowups([]);
    }
    setError("");
    setNotice("");
    setPatientLoading(true);
    setReviewProposal(null);
    setConsent(false);
    setPaste("");
    try {
      // The fixed record must open even when optional plugin routes are gone.
      const core = await loadPatientCore(api, id, { riskEnabled: riskReady });
      // The messages tab (chat-file import) needs the followup plugin, not a live channel.
      const targetTab =
        (nextTab === "followups" || nextTab === "messages") && !followupReady
          ? firstCommunicationTab
          : nextTab;
      const work = await api(`/api/sessions/${core.patient.sessionId}`);
      if (version !== patientGeneration.current) return;
      setTab(targetTab);
      rememberRecentPatient(id);
      onSwitchCurrent?.(id);
      setDetail(core.patient);
      setRisks(core.risks);
      setSession(work);
      setOptionalVersion((value) => value + 1);
    } finally {
      if (version === patientGeneration.current) setPatientLoading(false);
    }
  };
  const refreshPatient = async () => {
    if (!detail) return;
    await openPatient(detail.id, tab);
    await refresh();
  };
  const resolveProposal = async (proposal, decision, payload) => {
    if (proposalInFlight.current) return;
    proposalInFlight.current = true;
    locallyResolved.current.add(proposal.id);
    setProposalBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/pending-actions/${proposal.id}/${decision}`, "POST", payload ? { payload } : {});
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
    return () => { patientGeneration.current++; };
  }, []);
  // 本患者待确认的档案更新（检验导入等）。托盘里确认/拒绝后同步横幅，
  // 并在提案已从列表消失时重新读取档案，避免展示旧版本。
  const detailId = detail?.id;
  const detailRevision = detail?.revision;
  useEffect(() => {
    if (!detailId) { setUpdateProposals([]); return; }
    let live = true;
    let known = null;
    const load = () => loadPatientUpdateProposals(api, detailId).then((actions) => {
      if (!live) return;
      const gone = known && known.some((id) => !locallyResolved.current.has(id) && !actions.some((action) => action.id === id));
      known = actions.map((action) => action.id);
      setUpdateProposals(actions);
      setReviewProposal((current) => current && !actions.some((action) => action.id === current.id) ? null : current);
      if (gone && !proposalInFlight.current) refreshPatient().catch((err) => setError(err.message));
    }).catch(() => { if (live) setUpdateProposals([]); });
    load();
    window.addEventListener(PENDING_REFRESH_EVENT, load);
    return () => { live = false; window.removeEventListener(PENDING_REFRESH_EVENT, load); };
  }, [detailId, detailRevision, optionalVersion]);
  // Optional followup data arrives after the fixed record. Every open/refresh
  // bumps optionalVersion; disabling the plugin clears the data without
  // touching the patient overview.
  useEffect(() => {
    if (!detail || !followupActive) {
      setMessages([]);
      setFollowups([]);
      return;
    }
    let live = true;
    loadPatientOptional(api, detail.id, { followupEnabled: followupActive }).then((data) => {
      if (!live) return;
      setMessages(data.messages);
      setFollowups(data.followups);
    });
    return () => { live = false; };
  }, [detail?.id, optionalVersion, followupActive]);
  // Bootstrap enables plugin UI after the first render. Reload the list-level
  // optional data when that status flips, without refetching on every render.
  const lastFollowupEnabled = useRef(`${followupActive}:${messaging}`);
  useEffect(() => {
    const key = `${followupActive}:${messaging}`;
    if (lastFollowupEnabled.current === key) return;
    lastFollowupEnabled.current = key;
    let live = true;
    if (!followupActive) {
      setReminders([]);
      setInbox([]);
      return () => { live = false; };
    }
    Promise.all([
      api("/api/reminders").then((todo) => todo?.reminders || []).catch(() => []),
      messaging ? api("/api/inbox").then((box) => box?.messages || []).catch(() => []) : Promise.resolve([]),
    ]).then(([nextReminders, nextInbox]) => {
      if (!live) return;
      setReminders(nextReminders);
      setInbox(nextInbox);
    });
    return () => { live = false; };
  }, [followupActive, messaging]);
  useEffect(() => {
    if (!followupActive && sortBy === "followup") setSortBy("updated");
  }, [followupActive, sortBy]);
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
          ? "消息已整理完成，可在本次任务中查看结果。"
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
      await refreshPatient();
      setNotice(`已导入 ${result.stored} 条消息。${result.duplicates ? `跳过 ${result.duplicates} 条重复消息。` : ""}`);
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
      onLocationChange?.();
      setDetail(null);
      setSession(null);
      setNotice(detail.archived ? "患者已恢复到在管列表。" : "患者已归档，可在已归档列表中恢复。");
    } catch (err) {
      setError(err.message);
    }
  };
  // 批量操作：逐位调用 PATCH（带 revision），完成后汇总结果并刷新列表。
  const runBulk = async (action) => {
    const targets = patients.filter((p) => selected.has(p.id));
    setBulkBusy(true); setError(""); setNotice("");
    let updated = 0;
    const failed = [];
    for (const p of targets) {
      const patch = bulkPatientPatch(p, action, bulkGroup);
      if (!patch) { updated++; continue; }
      try {
        await api(`/api/patients/${p.id}`, "PATCH", { expectedRevision: p.revision, ...patch });
        updated++;
      } catch (err) { failed.push(`${p.name}（${err.message}）`); }
    }
    setBulkConfirm(false);
    setSelected(new Set());
    setNotice(failed.length ? `已更新 ${updated} 位，${failed.length} 位失败：${failed.join("、")}` : `已更新 ${updated} 位。`);
    await refresh().catch((err) => setError(err.message));
    setBulkBusy(false);
  };
  const archiveSelected = () => { if (selected.size > 1) setBulkConfirm(true); else runBulk("archive"); };
  // 永久删除由 DeletePatientModal 确认（需输入姓名）；成功后回到列表。
  const removed = async (name) => {
    setModal(null);
    onLocationChange?.();
    setDetail(null);
    setSession(null);
    setNotice(`已永久删除「${name}」的档案。`);
    await refresh().catch((err) => setError(err.message));
  };
  const patientCards = (
    <div className="patient-grid patient-table" role="list">
      {filtered.length > 0 && <div className="patient-row patient-row-head">
        <label className="patient-select" title="选择本页全部患者"><input type="checkbox" aria-label="全选本页" checked={pageAllSelected} ref={(el) => { if (el) el.indeterminate = pageSomeSelected && !pageAllSelected; }} onChange={togglePage} /></label>
        <div className="patient-table-head" aria-hidden="true"><span>患者</span><span>主要诊断</span><span>需关注</span><span>在用药物</span><span>复诊 / 就诊</span></div>
      </div>}
      {pagePatients.map((p) => {
        const brief = p.brief || {};
        const next = brief.nextAppointment || "";
        const nextRel = next ? relativeDay(next, today) : "";
        const flags = [
          ...(brief.abnormalLabs || []).slice(0, 2).map((lab) => ({ key: `lab-${lab.item}`, tone: lab.flag === "low" ? "is-info" : "is-danger", text: `${lab.item} ${lab.value}${lab.unit ? ` ${lab.unit}` : ""} ${FLAG_ARROW[lab.flag]}` })),
          ...((brief.abnormalLabCount || 0) > 2 ? [{ key: "lab-more", tone: "is-danger", text: `另 ${brief.abnormalLabCount - 2} 项异常` }] : []),
          ...(followupActive && p.counts.dueFollowups > 0 ? [{ key: "due", tone: "is-caution", text: `${p.counts.dueFollowups} 项随访到期` }] : []),
          ...(messaging && p.counts.unprocessedMessages > 0 ? [{ key: "msg", tone: "is-caution", text: `${p.counts.unprocessedMessages} 条新消息` }] : []),
          ...(followupActive && p.counts.pendingReminders > 0 ? [{ key: "rem", tone: "", text: `${p.counts.pendingReminders} 条提醒` }] : []),
        ];
        return (
        <div className={`patient-row ${selected.has(p.id) ? "is-selected" : ""}`} role="listitem" key={p.id}>
        <label className="patient-select"><input type="checkbox" aria-label={`选择 ${p.name}`} checked={selected.has(p.id)} onChange={() => toggleSelected(p.id)} /></label>
        <button
          className="patient-card"
          disabled={patientLoading}
          onClick={() => {
            openPatient(p.id).catch((err) => setError(err.message));
          }}
        >
          <span className="patient-line">
            <b>{p.name}</b>
            <small>
              {[GENDER[p.gender], patientAgeLabel(p).split(" · ")[0], p.patientNumber].filter(Boolean).join(" · ") || "未补充基础信息"}
            </small>
            {brief.allergyStatus === "recorded" && <em className="om-chip is-danger patient-row-allergy">过敏：{brief.allergies.join("、")}</em>}
            {Boolean(p.archived) && <em className="om-chip">已归档</em>}
          </span>
          <span className="patient-col patient-dx">
            {p.diagnosisSummary || <span className="om-meta">未登记诊断</span>}
            {(p.groups || []).length > 0 && <small>{p.groups.slice(0, 2).join(" · ")}</small>}
          </span>
          <span className="patient-col patient-flags">
            {flags.length ? flags.map((flag) => <em key={flag.key} className={`om-chip ${flag.tone}`}>{flag.text}</em>) : <span className="om-meta">—</span>}
          </span>
          <span className="patient-col patient-meds">
            {brief.activeMedications ? <><b>{brief.activeMedications} 种</b><small>{brief.activeMedicationNames.slice(0, 2).join("、")}{brief.activeMedications > 2 ? " 等" : ""}</small></> : <span className="om-meta">—</span>}
          </span>
          <span className="patient-col patient-dates">
            {next ? <b className={nextRel === "今天" ? "is-today" : ""}>复诊 {next.slice(5)}{nextRel && <small> · {nextRel}</small>}</b> : brief.reviewDate ? <b>复评 {brief.reviewDate.slice(5)}</b> : <span className="om-meta">未约复诊</span>}
            <small>{p.lastVisitAt ? `末次就诊 ${p.lastVisitAt}` : "无就诊记录"}</small>
          </span>
        </button>
        </div>
        );
      })}
      {!filtered.length && !listLoading && !listFailed && (
        <div className="patient-empty-state">
          <Stethoscope size={28} />
          <h3>{filtersActive ? "没有匹配的患者" : archiveFilter === "archived" ? "暂无已归档患者" : "建立第一份患者档案"}</h3>
          <p>{filtersActive ? "试试其他姓名、编号或标签，也可以清除筛选查看全部患者。" : archiveFilter === "archived" ? "归档后的患者会保留在这里，随时可以恢复到在管列表。" : "上传病例材料并核对整理结果，或直接填写基本信息。"}</p>
          {filtersActive ? <button className="secondary" onClick={clearFilters}>清除筛选</button> : archiveFilter === "archived" ? <button className="secondary" onClick={() => setArchiveFilter("active")}>查看在管患者</button> : <div className="toolbar-actions"><button className="primary" onClick={() => setModal("new-patient")}>上传第一份病例</button><button className="secondary" onClick={() => setModal("manual-patient")}>手动填写基本信息</button></div>}
        </div>
      )}
    </div>
  );
  const activeArea =
    activePluginTab?.area === "communication" ||
    ["messages", "appointments", "followups", "tracking"].includes(tab)
      ? "communication"
      : "record";
  const recordTabs = mergePatientTabs(pluginTabs, {
    area: "record",
    builtin: RECORD_TABS,
  });
  const patientSectionTabs =
    activeArea === "communication" ? communicationTabs : recordTabs;
  return (
    <section ref={panelRoot} onScroll={rememberListScroll} id="main" className={`patients-view ${detail ? "has-patient" : ""}`} aria-label="患者档案">
      {!detail && <div className="patients-toolbar om-page-head">
        <div><h2>患者</h2><span className="om-page-meta">{listSummary}</span></div>
        <div className="toolbar-actions">
          <details className="patient-more patients-batch"><summary>批量与导入</summary><div>
            <button className="text-button" onClick={(e) => { e.currentTarget.closest("details").open = false; setModal("import-patients"); }}>导入患者表格</button>
            <button className="text-button" onClick={(e) => { e.currentTarget.closest("details").open = false; setModal("import-labs"); }}>导入检验结果</button>
            <button className="text-button" onClick={(e) => { e.currentTarget.closest("details").open = false; setModal("group-suggest"); }}>生成分组建议</button>
          </div></details>
          <button className="secondary" onClick={() => setModal("manual-patient")}>手动建档</button>
          <button className="primary" onClick={() => setModal("new-patient")}><UserPlus size={15}/> 上传资料建档</button>
        </div>
      </div>}
      {listLoading && !detail && <p className="patient-loading" role="status"><Loader2 size={16} className="spin" />正在读取患者列表…</p>}
      {listFailed && <p className="navigation-notice" role="alert">患者列表读取失败，已保留此前读取的数据。<button className="secondary" onClick={() => refresh().then(() => setError("")).catch(err => setError(err.message))}>重新加载患者</button></p>}
      {patientLoading && <p className="patient-loading" role="status"><Loader2 size={16} className="spin" />正在打开患者档案…</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}
      {!detail && createProposals.length > 0 && (
        <div className="patient-risk-list" style={{ marginBottom: 14 }}>
          <p className="muted" style={{ fontSize: "calc(12px * var(--text-scale, 1))" }}>
            AI 建档提案（从对话材料中识别的新患者，确认后才真正建档）：
          </p>
          {createProposals.map((proposal) => {
            // 不同任务提出的同名/互含姓名提案提示疑似同一患者，避免建出重复档案；
            // 同一任务的重复提案已由服务端取代机制合并，这里兜住跨任务的。
            const name = String(proposal.payload?.name || "").trim();
            const twin = name
              ? createProposals.find(p => p.id !== proposal.id && String(p.payload?.name || "").trim() &&
                  (String(p.payload.name).trim().includes(name) || name.includes(String(p.payload.name).trim())))
              : null;
            return <div className="hub-risk" key={proposal.id}>
              <div className="hub-risk-main">
                <b>{proposal.summary}</b>
                <small>
                  {proposalDetail(proposal.type, proposal.payload) ||
                    (proposal.payload?.note || "").slice(0, 160)}
                </small>
                {twin && <small className="error-text">与「{twin.payload?.name}」的另一份提案疑似同一患者，请核对后只确认一份。</small>}
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
            </div>;
          })}
        </div>
      )}
      {busy && (
        <p className="notice running">
          <Loader2 className="spin" size={14} /> 执行中
        </p>
      )}
      {!detail && (
        <>
          {followupActive && reminders.length > 0 && <button className="patient-list-activity" onClick={() => onView("agenda")}><Bell size={15}/>随访事项已汇总到今日待办<span>查看待办 →</span></button>}
          {messaging && inbox.length > 0 && (
            <details className="todo-panel patient-inbox"><summary><Inbox size={15} /> 消息归属 · {inbox.length} 条</summary>
              {inbox.map((m) => (
                <div className="todo-row" key={m.id}>
                  <span>
                    <small>
                      {messageChannelLabel(m.channel)} · {fmtDate(m.time)}
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
            </details>
          )}
          <div className="patients-filter">
            <label className="search">
              <Search size={14} />
              <input
                ref={searchInput}
                aria-label="搜索患者"
                aria-keyshortcuts="/"
                title="按 / 可快速定位到搜索框；只匹配到一位患者时按回车直接打开"
                placeholder="搜索姓名、拼音首字母、编号、电话、标签或诊断（按 / 定位）"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPatientPage(0); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && sortedFiltered.length === 1 && !patientLoading) {
                    e.preventDefault();
                    openPatient(sortedFiltered[0].id).catch((err) => setError(err.message));
                  } else if (e.key === "Escape" && query) { setQuery(""); setPatientPage(0); }
                }}
              />
            </label>
            <select aria-label="患者档案状态" title="切换显示在管患者或已归档患者" value={archiveFilter} onChange={(e) => { setArchiveFilter(e.target.value); setPatientPage(0); }}><option value="active">在管患者</option><option value="archived">已归档患者</option></select>
            <select aria-label="排序方式" title="患者列表排序" value={sortBy} onChange={(e) => { setSortBy(e.target.value); setPatientPage(0); }}>
              <option value="updated">最近更新</option>
              <option value="attention">需关注优先</option>
              <option value="visit">最近就诊</option>
              {followupActive && <option value="followup">随访到期优先</option>}
              <option value="name">按姓名</option>
            </select>
            {tags.length > 0 && <select aria-label="按标签筛选" value={tagFilter} onChange={(e) => { setTagFilter(e.target.value); setPatientPage(0); }}>
              <option value="">全部标签</option>
              {tags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>}
            {groups.length > 6 ? <select aria-label="按分组筛选" value={group} onChange={(e) => { setGroup(e.target.value); setPatientPage(0); }}>
              <option value="">全部分组</option>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select> : <>
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
            </>}
          </div>
          {selected.size > 0 && <div className="patient-bulk-bar" role="region" aria-label="批量操作">
            <b>已选 {selected.size} 位</b>
            <input aria-label="分组名称" placeholder="选择或输入分组" list="bulk-group-options" value={bulkGroup} disabled={bulkBusy} onChange={(e) => setBulkGroup(e.target.value)} />
            <datalist id="bulk-group-options">{groups.map((g) => <option key={g} value={g} />)}</datalist>
            <button className="secondary" disabled={bulkBusy || !bulkGroup.trim()} onClick={() => runBulk("add-group")}>加入分组</button>
            <button className="secondary" disabled={bulkBusy || !bulkGroup.trim()} onClick={() => runBulk("remove-group")}>移出分组</button>
            {archiveFilter === "archived"
              ? <button className="secondary" disabled={bulkBusy} onClick={() => runBulk("restore")}>恢复</button>
              : <button className="secondary" disabled={bulkBusy} onClick={archiveSelected}>归档</button>}
            <button className="text-button" disabled={bulkBusy} onClick={() => setSelected(new Set())}>取消选择</button>
            {bulkBusy && <Loader2 size={15} className="spin" aria-label="正在更新" />}
          </div>}
          {patientCards}
          {!listLoading && <nav className="patient-pagination" aria-label="患者分页">
            <small role="status">共 {filtered.length} 位{pageCount > 1 ? ` · 第 ${visiblePage + 1} / ${pageCount} 页` : ""}</small>
            {pageCount > 1 && <>
              <button className="secondary" disabled={visiblePage === 0} onClick={() => setPatientPage(visiblePage - 1)}>上一页</button>
              <button className="secondary" disabled={visiblePage + 1 >= pageCount} onClick={() => setPatientPage(visiblePage + 1)}>下一页</button>
            </>}
          </nav>}
        </>
      )}
      {detail && session && (
        <>
          <div className="patient-mobile-identity" aria-label="当前患者身份"><b>{detail.name}</b><span>{detail.patientNumber || '未编号'}{detail.archived ? ' · 已归档' : ''}</span></div>
          <div className="detail-head">
            <div className="patient-line"><button className="text-button patient-back" onClick={()=>{patientGeneration.current++;setPatientLoading(false);onLocationChange?.();setDetail(null);setSession(null);}}>← 患者列表</button>
              <div className="patient-title-row">
                <b>{detail.name}</b>
                {detail.archived && <span className="om-chip">已归档</span>}
                {(() => { const allergy = allergyState(detail); return <span className={`om-chip ${allergy.status === "recorded" ? "is-danger" : allergy.status === "unknown" ? "is-caution" : "is-ok"} patient-allergy`} title={allergy.status === "unknown" ? "过敏史尚未核对，用药前请确认" : undefined}>{allergy.status === "recorded" && <AlertTriangle size={13} aria-hidden="true" />}{allergy.label}</span>; })()}
              </div>
              <small>
                {[
                  GENDER[detail.gender],
                  patientAgeLabel(detail),
                  detail.patientNumber ? `编号 ${detail.patientNumber}` : "",
                  detail.phone,
                  ...(detail.groups || []),
                ]
                  .filter(Boolean)
                  .join(" · ") || "未补充基础信息"}
              </small>
            </div>
            <div className="toolbar-actions">
              <button
              className="primary"
              disabled={!session}
              title="可先选中病历中的文字，再提问或要求修改"
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                const selection = window.getSelection();
                const quote = selection && panelRoot.current?.contains(selection.anchorNode) && panelRoot.current?.contains(selection.focusNode) ? selection.toString().trim() : '';
                onOpenWorkspace(detail.sessionId, quote ? { draft: `关于患者记录中的这段内容：\n${quote}\n\n` } : {});
              }}
            >
              <FolderOpen size={15} /> 问 AI
            </button>
              <button className="secondary" onClick={() => setModal("edit-patient")}>编辑信息</button>

              <details className="patient-more"><summary>更多</summary><div>
                <button className="text-button" onClick={archive}>{detail.archived ? "恢复患者" : "归档患者"}</button>
                <button className="text-button danger" onClick={(e) => { e.currentTarget.closest("details").open = false; setModal("delete-patient"); }}>删除患者档案</button>
                {pluginActions.map((action) => <button key={`${action.pluginId}:${action.id}`} className="text-button" onClick={async () => {
                  try { setError(""); await action.run(detail, api); }
                  catch (err) { setError(err.message); }
                }}>{action.label}</button>)}
              </div></details>
            </div>
          </div>
          <PatientProposalBanner proposals={updateProposals} busy={proposalBusy} onReview={(proposal) => { setError(""); setReviewProposal(proposal); }} />
          {config?.modelConfigured && !aiGranted && activePluginTab?.legacyTab === "messages" && (
            <label className="consent">
              <input
                type="checkbox"
                checked={localConsent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              允许 AI 总结使用该患者的材料与消息原文。
            </label>
          )}
          <nav className="tab-row patient-area-tabs" aria-label="患者工作内容">
            <button className={isRecordTab(tab) || activePluginTab?.area === "record" ? "active" : ""} onClick={() => setTab("overview")}>病历</button>
            <button className={tab === "assistance" ? "active" : ""} onClick={() => setTab("assistance")}>诊疗辅助</button>
            <button className={["messages", "followups", "tracking", "appointments"].includes(tab) || activePluginTab?.area === "communication" ? "active" : ""} onClick={() => setTab(firstCommunicationTab)}>沟通与随访</button>
          </nav>
          {tab !== "assistance" && <nav className="tab-row patient-section-tabs" aria-label="患者栏目">
            {patientSectionTabs.map((entry) => {
              const current = tab === entry.key || (tab === "clinical" && entry.id === "diagnoses");
              return <button key={entry.key} aria-current={current ? "page" : undefined} className={current ? "active" : ""} onClick={() => openRecordTab(entry.key)}>{patientTabLabel(entry, { patient: detail, counts: detail?.counts || {} })}</button>;
            })}
          </nav>}
          {activePluginTab && <SlotItem
            key={`${activePluginTab.pluginId}:${activePluginTab.id}`}
            contribution={activePluginTab}
            patient={detail}
            config={config}
            messages={messages}
            paste={paste}
            setPaste={setPaste}
            importMessages={importMessages}
            digest={digest}
            busy={busy}
            consent={consent}
            setConsent={setConsent}
            followups={followups}
            refreshKey={followupRefresh}
            onRefreshPanels={refreshFollowupPanels}
            onChanged={refreshPatient}
            onNavigate={openRecordTab}
            files={session?.files || []}
            onSession={(value) => {
              if (value.id === detail.sessionId) setSession(value);
            }}
            onOpenWorkspace={onOpenWorkspace}
            onSetError={setError}
            onNotice={setNotice}
            followupFocus={followupFocus}
            onFocusFollowup={id => setFollowupFocus({ id, token: Date.now() })}
            followupSource={followupSource}
            onClearSource={() => setFollowupSource(null)}
            surveyFocus={surveyFocus}
            setSurveyFocus={setSurveyFocus}
          />}
          {!activePluginTab && tab === "appointments" && <AppointmentsPanel key={detail.id} patient={detail} />}
          {!activePluginTab && tab === "labs" && <NewLabsNotice key={`${detail.id}-${detail.revision}`} patientId={detail.id} onOpenLabs={null} />}
          {!activePluginTab && isRecordTab(tab) && <div className="detail-panel"><PatientDashboard key={`${detail.id}-${tab}`} patient={detail} session={session} followups={followups} view={tab === "clinical" ? "diagnoses" : tab} focusFile={sourceFocus} focusLab={labFocus?.patientId === detail.id ? labFocus : null} editRequest={clinicalEditRequest} onEditRequestHandled={() => setClinicalEditRequest(null)} onClinical={openRecordTab} onChanged={refreshPatient} onError={setError} onOpenWorkspace={onOpenWorkspace} onView={onView} modelConfigured={Boolean(config?.modelConfigured)} riskPanel={riskActive ? <RiskList
                alerts={[...risks].sort(
                  (a, b) =>
                    (a.status === "active" ? 0 : 1) -
                      (b.status === "active" ? 0 : 1) ||
                    { critical: 0, warning: 1, info: 2 }[a.severity] -
                      { critical: 0, warning: 1, info: 2 }[b.severity],
                )}
                busy={busy}
                draftBlocked={config?.modelConfigured ? "" : "需先连接模型才能生成处理建议草稿"}
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
              /> : null}/></div>}
          {!activePluginTab && tab === "assistance" && <ClinicalAssistance key={detail.id} patient={detail} modelConfigured={Boolean(config?.modelConfigured)} onModelSettings={() => { requestSettingsTab("general"); onView?.("settings"); }} onOpenTask={onOpenWorkspace}/>}
        </>
      )}
      {modal === "new-patient" && <PatientIntakeModal configured={config?.modelConfigured} onClose={() => setModal(null)} onManual={() => setModal("manual-patient")} onOpenWorkspace={(id) => { setModal(null); onOpenWorkspace(id); }} onCreated={async (patient) => { setModal(null); await refresh(); await openPatient(patient.id); }} />}
      {modal === "manual-patient" && (
        <NewPatientModal
          knownPatients={patients}
          existingGroups={groups}
          existingTags={[...new Set(patients.flatMap((x) => x.tags || []))]}
          onClose={() => setModal(null)}
          onCreated={async (patient) => {
            setModal(null);
            await refresh();
            await openPatient(patient.id);
          }}
        />
      )}
      {reviewProposal && detail && <PatientProposalModal patient={detail} proposal={reviewProposal} busy={proposalBusy} error={error} onClose={() => setReviewProposal(null)} onConfirm={(payload) => resolveProposal(reviewProposal, "confirm", payload)} onReject={() => resolveProposal(reviewProposal, "reject")} />}
      {modal === "import-patients" && <PatientImportModal onClose={() => setModal(null)} onImported={async (result) => { await refresh(); setModal(null); setNotice(`已导入 ${result.count} 位患者，打开档案即可继续补充病例材料。`); }} onOpenPatient={(id) => { setModal(null); openPatient(id).catch((err) => setError(err.message)); refresh().catch(() => {}); }} />}
      {modal === "import-labs" && <LabImportModal onClose={() => setModal(null)} onImported={async (result) => { await refresh(); setNotice(`已为 ${result.proposals.length} 位患者生成检验提案。打开患者档案点「核对」确认写入，或在「待确认」中逐条处理。`); }} />}
      {modal === "edit-patient" && detail && <PatientIdentityModal patient={detail} onClose={() => setModal(null)} onSaved={async () => { await refreshPatient(); setModal(null); setNotice("基本信息已保存"); }} />}
      {bulkConfirm && <Modal title={`归档 ${selected.size} 位患者`} onClose={() => { if (!bulkBusy) setBulkConfirm(false); }}>
        <div className="modal-form">
          <p>归档后这些患者会从在管列表移走，资料完整保留，可在「已归档患者」中恢复。</p>
          <div className="toolbar-actions">
            <button type="button" className="primary" disabled={bulkBusy} onClick={() => runBulk("archive")}>{bulkBusy ? "正在归档…" : "确认归档"}</button>
            <button type="button" className="secondary" disabled={bulkBusy} onClick={() => setBulkConfirm(false)}>取消</button>
          </div>
        </div>
      </Modal>}
      {modal === "delete-patient" && detail && <DeletePatientModal patient={detail} onClose={() => setModal(null)} onArchive={async () => { setModal(null); await archive(); }} onDeleted={() => removed(detail.name)} />}
      {modal === "group-suggest" && (
        <GroupSuggestModal
          onClose={() => setModal(null)}
          onProposed={async (message) => {
            setModal(null);
            setNotice(message);
          }}
        />
      )}
    </section>
  );
}
function NewPatientModal({ knownPatients = [], existingGroups = [], existingTags = [], onClose, onCreated }) {
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
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(null);
  const phone = patientPhone(form.phone);
  // 同号码核对：只比较数字，至少 7 位才比，避免输入一半就误报。
  const typedDigits = phoneDigits(form.phone);
  const phoneMatches = typedDigits.length >= 7 ? knownPatients.filter((p) => phoneDigits(p.phone) === typedDigits) : [];
  const needsDistinctConfirm = matches.length > 0 || phoneMatches.length > 0;
  // 打开已有档案；已归档的先恢复到在管列表。恢复失败时提示原因，仍可直接打开。
  const openExisting = async (patient) => {
    if (inFlight.current) return;
    setError(""); setRestoreFailed(null);
    if (patient.archived) {
      inFlight.current = true; setSaving(true);
      try { await restoreArchivedPatient(patient.id); }
      catch (err) { setError(`恢复档案未成功：${err.message}`); setRestoreFailed(patient); return; }
      finally { inFlight.current = false; setSaving(false); }
    }
    await onCreated(patient);
  };
  const existingLabel = (patient) => `${patient.name} · ${patient.patientNumber || "未编号"} · ${patientAgeLabel(patient) || "出生年未填"} · ${patient.phone ? `尾号 ${patient.phone.slice(-4)}` : "电话未填"} · ${patient.archived ? "已归档 · 打开并恢复档案" : "打开已有档案"}`;
  useEffect(() => {
    let live = true;
    setMatches([]);
    const timer = setTimeout(() => {
      if (form.name.trim()) api(`/api/patients?summary=1&archived=1&q=${encodeURIComponent(form.name.trim())}`)
        .then((value) => { if (live) setMatches(value.patients.filter((p) => p.name === form.name.trim())); })
        .catch((err) => { if (live) setError(err.message); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [form.name]);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value, ...(key === "name" || key === "phone" ? { confirmDistinctPatient: false } : {}) });
  const submit = async (e) => {
    e.preventDefault();
    if (inFlight.current) return;
    setPhoneTouched(true);
    if (phone.error || (needsDistinctConfirm && !form.confirmDistinctPatient)) return;
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
        phone: phone.value || undefined,
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
          {matches.map((patient) => <button key={patient.id} className="secondary" type="button" onClick={() => openExisting(patient)} disabled={saving}>
            {existingLabel(patient)}
          </button>)}
          {phoneMatches.length === 0 && <label><input type="checkbox" checked={form.confirmDistinctPatient} onChange={(e) => setForm({ ...form, confirmDistinctPatient: e.target.checked })} />已核对，确为另一人（不是上面的同名患者）</label>}
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
              onChange={(e) => setForm({ ...form, birthYear: e.target.value, ageText: "" })}
            />
          </label>
          <label>
            按年龄估算出生年（岁）
            <input
              type="number"
              min="0"
              max="120"
              value={form.ageText || ""}
              onChange={(e) => {
                const age = e.target.value;
                const year = age ? birthYearFromAge(age) : "";
                setForm({
                  ...form,
                  ageText: age,
                  birthYear: year === "" ? "" : year,
                });
              }}
              placeholder="填写年龄，估算出生年"
            />
          </label>
          <label>
            联系电话
            <input type="tel" aria-label="联系电话" autoComplete="tel" maxLength={20} aria-invalid={phoneTouched && !!phone.error} aria-describedby="create-phone-help" value={form.phone} onBlur={() => setPhoneTouched(true)} onChange={set("phone")} />
            <small id="create-phone-help" className={phoneTouched && phone.error ? "error-text" : "muted"}>{phoneTouched && phone.error ? phone.error : PATIENT_PHONE_HINT}</small>
          </label>
        </div>
        {form.ageText !== undefined && form.ageText !== "" && <p className={form.birthYear === "" ? "error-text" : "muted"}>{form.birthYear === "" ? "年龄请填写 0–120 的整数。" : `按${form.ageText}岁估算为${form.birthYear}年，请核对出生年。`}</p>}
        {phoneMatches.length > 0 && <section className="identity-matches" aria-label="电话相同患者核对">
          <b>电话相同的患者：{phoneMatches.map((patient) => patient.name).join("、")}</b>
          <p>同一号码可能是同一位患者，也可能是家属代留的电话，请先核对。</p>
          {phoneMatches.map((patient) => <button key={patient.id} className="secondary" type="button" onClick={() => openExisting(patient)} disabled={saving}>
            {existingLabel(patient)}
          </button>)}
          <label><input type="checkbox" checked={form.confirmDistinctPatient} onChange={(e) => setForm({ ...form, confirmDistinctPatient: e.target.checked })} />已核对，确为另一人（不是上面{matches.length ? "的同名或" : ""}电话相同的患者）</label>
        </section>}
        <label>
          分组（逗号分隔，输入时可参考已有分组）
          <input value={form.groups} onChange={set("groups")} list="existing-group-options" />
        </label>
        <label>
          标签（逗号分隔）
          <input value={form.tags} onChange={set("tags")} list="existing-tag-options" />
        </label>
        <datalist id="existing-group-options">
          {existingGroups.map((g) => <option key={g} value={g} />)}
        </datalist>
        <datalist id="existing-tag-options">
          {existingTags.map((t) => <option key={t} value={t} />)}
        </datalist>
        </fieldset>
        {error && <p className="error-text" role="alert">{error}{restoreFailed && <> <button type="button" className="text-button" disabled={saving} onClick={() => { const patient = restoreFailed; setRestoreFailed(null); onCreated(patient); }}>仍然打开档案</button></>}</p>}
        <div className="toolbar-actions">
          <button className="primary" disabled={!form.name.trim() || saving || (needsDistinctConfirm && !form.confirmDistinctPatient)}>
            创建患者档案
          </button>
        </div>
        <small className="muted">
          保存后打开患者档案，可继续补充资料或进入问诊工作台。
        </small>
      </form>
    </Modal>
  );
}
// 永久删除确认：先推荐归档（可恢复）；要删除须输入患者姓名，避免误点。
function DeletePatientModal({ patient, onClose, onArchive, onDeleted }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameMatches = typed.trim() === String(patient.name || "").trim();
  const remove = async () => {
    if (busy || !nameMatches) return;
    setBusy(true); setError("");
    try {
      await api(`/api/patients/${patient.id}`, "DELETE");
      await onDeleted();
    } catch (err) { setError(err.message); setBusy(false); }
  };
  return <Modal title="删除患者档案" onClose={() => { if (!busy) onClose(); }}>
    <div className="modal-form delete-patient">
      <p>永久删除会同时清除「{patient.name}」的病历、问诊工作台、消息和随访记录，<b>无法恢复</b>。</p>
      {!patient.archived && <p className="notice">不再随访的患者建议<b>归档</b>：档案会从在管列表移走，资料完整保留，随时可以恢复。</p>}
      <div className="toolbar-actions">
        {!patient.archived && <button type="button" className="primary" disabled={busy} onClick={onArchive}>改为归档</button>}
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button>
      </div>
      <label>如确需永久删除，请输入患者姓名「{patient.name}」
        <input value={typed} disabled={busy} onChange={(e) => setTyped(e.target.value)} autoComplete="off" aria-label="输入患者姓名以确认永久删除" />
      </label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="toolbar-actions">
        <button type="button" className="danger" disabled={busy || !nameMatches} onClick={remove}>{busy ? "正在删除…" : "永久删除"}</button>
      </div>
    </div>
  </Modal>;
}
// 患者分组建议:按结构化诊断(ICD-10/名称)与常用药名确定性派生,
// 生成待确认提案;确认前不改任何档案,确认时逐患者乐观更新并报告冲突。
function GroupSuggestModal({ onClose, onProposed }) {
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState([]);
  const [checked, setChecked] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api("/api/patients/group-suggestions", "POST", {})
      .then((data) => {
        setSuggestions(data.suggestions || []);
        setChecked(Object.fromEntries((data.suggestions || []).map((s) => [s.patientId, true])));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  const selected = suggestions.filter((s) => checked[s.patientId]);
  const propose = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/patients/group-suggestions/propose", "POST", {
        assignments: selected.map((s) => ({ patientId: s.patientId, addTags: s.addTags })),
      });
      window.dispatchEvent(new Event(PENDING_REFRESH_EVENT));
      await onProposed(`已创建分组建议提案（${selected.length} 位患者），请到「待确认」托盘核对后确认执行。`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="生成分组建议" onClose={onClose}>
      <p className="muted">本机按诊断与用药规则生成，不调用模型。核对依据后可创建待确认提案。</p>
      {loading && <p role="status">正在按诊断与用药扫描全部在管患者…</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {!loading && !error && !suggestions.length && <p className="muted">没有可建议的分组：全部患者都没有可推断的诊断依据，或已有对应分组。</p>}
      {!!suggestions.length && (
        <>
          <p className="muted">依据结构化诊断（ICD-10 编码或诊断名称）推断；无诊断命中的患者按常用药给出「待核对」分组。确认前不会修改任何档案。</p>
          <table className="group-suggest-table">
            <thead>
              <tr><th aria-label="选择"></th><th>患者</th><th>建议分组</th><th>依据</th></tr>
            </thead>
            <tbody>
              {suggestions.map((s) => (
                <tr key={s.patientId}>
                  <td><input type="checkbox" checked={Boolean(checked[s.patientId])} onChange={(e) => setChecked({ ...checked, [s.patientId]: e.target.checked })} aria-label={`选择 ${s.name}`} /></td>
                  <td><b>{s.name}</b>{s.currentGroups?.length ? <small className="muted"> 现有：{s.currentGroups.join("、")}</small> : null}</td>
                  <td>{s.addTags.join("、")}</td>
                  <td><small className="muted">{s.matched.map((m) => `${m.name || m.code || "诊断"}→${m.tag}`).join("；")}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="toolbar-actions">
            <button className="primary" disabled={busy || !selected.length} onClick={propose}>{busy ? "创建中…" : `创建提案（${selected.length} 位患者）`}</button>
            <button className="secondary" onClick={onClose}>取消</button>
          </div>
        </>
      )}
    </Modal>
  );
}
