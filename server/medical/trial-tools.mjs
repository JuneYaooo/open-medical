// Chat tools for clinical-trial recruitment. Reading is direct; starting
// batch AI screening (sends patient records to the model) and changing
// enrollment status only file pending actions the doctor confirms.
const definition = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});
const text = { type: "string" };
const STAGE = { type: "string", enum: ["none", "shortlisted", "contacted", "consented", "enrolled", "declined", "ineligible", "withdrawn"] };

export function trialTools(getTrials, pending) {
  const trials = () => {
    const service = getTrials();
    if (!service) throw new Error("临床试验模块未启用");
    return service;
  };
  const propose = (type, patientId, payload, summary) => ({
    ...pending.propose({ type, patientId, payload, summary }),
    note: "已生成待确认提案。请提醒医生在工作台右下角「待确认」面板核对后确认；确认前不会执行。",
  });
  return [
    {
      definition: definition("trial_list", "列出已保存的临床试验方案（名称、注册号、招募状态、条件数）以及各入组阶段人数。"),
      execute: () => ({ trials: trials().trials.list().map((t) => {
        const { counts } = trials().candidates(t.id);
        return { id: t.id, title: t.title, registration: t.registration, recruitment: t.recruitment, criteria: t.criteria.length, stages: counts.stages, awaitingReview: counts.awaitingReview };
      }) }),
    },
    {
      definition: definition("trial_candidates", "某试验的候选患者列表：规则预筛（年龄/性别/诊断，likely/possible/unclear/mismatch 及理由）、AI 初筛结果（冲突/待补）、医生核对结论、入组状态和建议下一步。回答“哪些患者可能适合这个试验”时调用。", {
        trialId: text, stage: { type: "string", description: "入组状态筛选，逗号分隔" }, prefilter: { type: "string", description: "likely,possible,unclear,mismatch，逗号分隔" }, limit: { type: "integer" },
      }, ["trialId"]),
      execute: ({ trialId, stage, prefilter, limit }) => {
        const value = trials().candidates(trialId, { stage, status: prefilter });
        return { ...value, candidates: value.candidates.slice(0, Math.min(limit || 30, 100)) };
      },
    },
    {
      definition: definition("trial_patient_screening", "读取某患者在某试验下的逐项结果：最新 AI 初筛中的冲突与待补项（含理由和出处）、医生保存的核对记录和入组状态。", { trialId: text, patientId: text }, ["trialId", "patientId"]),
      execute: ({ trialId, patientId }) => {
        const t = trials(), trial = t.trials.get(trialId);
        const criterion = (id) => trial.criteria.find((c) => c.id === id);
        const job = t.latestJobs(trial.id).get(patientId);
        const attention = (job?.checks || []).filter((c) => c.value === "unknown" || c.value === (criterion(c.id)?.kind === "include" ? "no" : "yes"));
        return {
          ai: t.aiSummary(job),
          aiAttention: attention.map((c) => ({ kind: criterion(c.id)?.kind, criterion: criterion(c.id)?.text, value: c.value, reason: c.reason, missing: c.missing, citations: (c.citations || []).map((r) => `${r.sourceName} 第${r.startLine}–${r.endLine}行`) })),
          review: t.trials.screening(trial.id, patientId),
          enrollment: t.enrollment(trial.id, patientId),
        };
      },
    },
    {
      definition: definition("trial_batch_screen_propose", "提议对某试验批量做 AI 纳排初筛。不传 patientIds 时自动选择规则预筛可能符合、且还没有有效 AI 结果的患者（最多 50 位）。患者病历会交给当前模型处理，因此只生成待确认提案。", {
        trialId: text, patientIds: { type: "array", items: text }, summary: text,
      }, ["trialId"]),
      execute: ({ trialId, patientIds, summary }) => {
        const value = trials().normalizeBatch(trialId, { patientIds, externalConsent: true });
        return propose("trial-batch", undefined, { trialId, patientIds: value.patientIds }, summary || `批量 AI 初筛「${value.trialTitle.slice(0, 30)}」：${value.patientIds.length} 位患者`);
      },
    },
    {
      definition: definition("trial_enrollment_propose", "提议更新患者在某试验的入组状态：shortlisted 拟邀请、contacted 已联系、consented 已签知情同意（需 consentDate）、enrolled 已入组（需先登记知情同意且医生核对无冲突）、declined、ineligible、withdrawn。医生确认后生效。", {
        trialId: text, patientId: text, stage: STAGE, consentDate: { type: "string", description: "YYYY-MM-DD" }, note: text, summary: text,
      }, ["trialId", "patientId", "stage"]),
      execute: ({ trialId, patientId, stage, consentDate, note, summary }) => {
        const value = trials().normalizeProposal("trial-enrollment", { trialId, patientId, stage, consentDate, note });
        return propose("trial-enrollment", patientId, { trialId, patientId, stage, consentDate, note }, summary || `「${value.trialTitle.slice(0, 30)}」入组状态改为${value.label}`);
      },
    },
  ];
}
