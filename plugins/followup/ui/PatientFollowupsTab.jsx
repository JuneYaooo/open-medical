import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { api } from "../../../src/agent-runtime";
import { Slot, usePluginConnected } from "../../../src/plugin-slots.jsx";
import { CampaignPanel } from "./CareInbox.jsx";
import { FollowupModal } from "./FollowupModal.jsx";
import { FollowupRecords } from "./FollowupRecords.jsx";
import { SurveyPanel } from "./FollowupSurveysPanel.jsx";
import { followupDate } from "../../../shared/followup-display.mjs";
import "./followup-clarity.css";

const fmtDate = followupDate;

export default function PatientFollowupsTab({
  patient: detail,
  followups,
  refreshKey,
  onRefreshPanels,
  onChanged,
  onOpenWorkspace,
  onSetError,
  onNotice,
  followupFocus,
  onFocusFollowup,
  followupSource,
  onClearSource,
  surveyFocus,
  setSurveyFocus,
}) {
  // Questionnaires and WeCom campaigns reach the patient; without a connected
  // channel this tab is the doctor's own reminder list only.
  const messaging = usePluginConnected("followup");
  const [editingFollowup, setEditingFollowup] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [source, setSource] = useState(null);
  const [handledSource, setHandledSource] = useState(null);
  const setError = onSetError || (() => {});
  const setSurveyFocusState = setSurveyFocus || (() => {});
  const refreshPatient = onChanged || (async () => {});
  useEffect(() => {
    setModalOpen(false);
    setEditingFollowup(null);
    setSource(null);
    setHandledSource(null);
  }, [detail.id]);
  useEffect(() => {
    if (!followupSource || followupSource === handledSource) return;
    setSource(followupSource);
    setEditingFollowup(null);
    setModalOpen(true);
    setHandledSource(followupSource);
  }, [followupSource, handledSource]);
  useEffect(() => {
    if (!followupFocus) return;
    const element = document.getElementById(`followup-${followupFocus.id}`);
    element?.scrollIntoView({ block: "center" });
    element?.focus({ preventScroll: true });
  }, [followupFocus, followups]);
  const closeModal = () => {
    setModalOpen(false);
    setEditingFollowup(null);
    setSource(null);
    onClearSource?.();
  };
  const created = async (job) => {
    closeModal();
    await refreshPatient();
    if (job) {
      onFocusFollowup?.(job.id);
      onNotice?.(job.reused ? "该复评日期已有提醒，已定位现有计划。" : "随访计划已保存。");
    }
  };
  return <>
            <div className="detail-panel patient-followup-workspace">
              <div className="digest-row followup-tab-head"><div><h2>随访计划</h2><p className="muted">{(() => { const active = followups.filter(job => ["active", "running"].includes(job.status)); const next = active.map(job => job.nextDue).filter(Boolean).sort((a, b) => a - b)[0]; return active.length ? `${active.length} 个提醒计划进行中${next ? ` · 下次 ${fmtDate(next)}` : ""}` : "尚无进行中的提醒计划"; })()} · 先登记到期事项，再安排下一次联系。</p></div>
                <button
                  className="primary"
                  onClick={() => { setSource(null); setEditingFollowup(null); setModalOpen(true); }}
                  disabled={detail.archived}
                >
                  <CalendarClock size={14} /> 新建随访计划
                </button>
              </div>
              {!detail.archived && <Slot name="patient.followupSuggestions" patient={detail} followups={followups} onChanged={async () => { await refreshPatient(); onRefreshPanels?.(); }} />}
              {/* 四个子页合并为单页滚动，减少一层嵌套；企微自动随访折叠到底部。 */}
              <div>
              <FollowupRecords
                key={detail.id}
                patientId={detail.id}
                refreshKey={refreshKey}
                onRefresh={onRefreshPanels}
                onChanged={refreshPatient}
                onOpenTask={onOpenWorkspace}
                onViewSurvey={target => setSurveyFocusState({ ...target, token: Date.now() })}
              />
              </div>
              {messaging && <div>
              <SurveyPanel
                key={`surveys-${detail.id}`}
                focus={surveyFocus}
                onClearFocus={() => setSurveyFocusState(null)}
                patientId={detail.id}
                refreshKey={refreshKey}
                onRefresh={onRefreshPanels}
                onChanged={refreshPatient}
              />
              </div>}
              <h3 className="followup-merged-title">提醒计划 <small>{followups.length} 个 · 到期后在本机生成提醒，不会发送给患者</small></h3>
              <div>
              {followups.map((job) => (
                <div className="followup-card" role="article" aria-label={`提醒计划：${job.name}`} id={`followup-${job.id}`} tabIndex={-1} key={job.id}>
                  <div className="followup-head">
                    <b>{job.name}</b>
                    <span className="badge">{{ active: "计划中", running: "提醒生成中", paused: "已暂停", completed: "提醒已生成" }[job.status] || job.status}</span>
                    {job.questionnaire && <span className="badge">含问卷</span>}
                  </div>
                  <small className="muted">
                    {job.once ? "单次提醒" : `每 ${job.intervalDays} 天`} ·{" "}
                    {job.status === "completed" ? "提醒已触发" : "下次"}{" "}
                    {fmtDate(job.nextDue)}
                    {job.externalConsent
                      ? " · 已授权到期时自动总结新消息"
                      : " · 仅本机提醒，不会发送给患者"}
                    {job.lastError ? ` · 上次错误：${job.lastError}` : ""}
                  </small>
                  {job.source?.kind === "treatment-review" && <p className="muted">来自复评日期 {job.source.reviewDate}{job.source.reviewDate !== detail.treatmentPlan?.reviewDate ? " · 治疗方案复评日期已变更，此提醒仍按原计划执行" : ""}</p>}
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
                        onClick={() => { setSource(null); setEditingFollowup(job); setModalOpen(true); }}
                      >
                        编辑
                      </button>
                    )}
                    {job.status !== "running" && job.status !== "completed" && (
                      <button
                        className="secondary"
                        onClick={async () => {
                          try { setError(""); await api(
                            `/api/patients/${detail.id}/followups/${job.id}`,
                            "PATCH",
                            {
                              revision: job.revision,
                              status:
                                job.status === "active" ? "paused" : "active",
                            },
                          );
                          await refreshPatient(); } catch (err) { setError(err.message); }
                        }}
                      >
                        {job.status === "active" ? "暂停" : "恢复"}
                      </button>
                    )}
                    <button
                      className="text-button followup-delete"
                      onClick={async () => {
                        if (!window.confirm(`删除 ${detail.name} 的「${job.name}」随访计划？`)) return;
                        try { setError(""); await api(
                          `/api/patients/${detail.id}/followups/${job.id}`,
                          "DELETE",
                          { revision: job.revision },
                        );
                        await refreshPatient(); } catch (err) { setError(err.message); }
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
              {!followups.length && <p className="muted">还没有本机提醒计划。点击右上角「新建随访计划」安排。</p>}
              </div>
              {messaging && <details className="followup-auto-collapsed">
                <summary>自动随访（企业微信发送并收集回复，可选）</summary>
                <CampaignPanel key={`campaigns-${detail.id}`} patientId={detail.id} />
              </details>}
            </div>
      {modalOpen && (
        <FollowupModal
          key={`${detail.id}:${editingFollowup?.id || source?.reviewDate || "new"}`}
          source={source?.patientId === detail.id ? source : null}
          existingSourceJob={source && followups.find(job => job.source?.kind === "treatment-review" && job.source.reviewDate === source.reviewDate)}
          onViewExisting={job => { setModalOpen(false); onFocusFollowup?.(job.id); }}
          patientId={detail.id}
          job={editingFollowup}
          onClose={closeModal}
          onCreated={created}
        />
      )}
    </>;
}
